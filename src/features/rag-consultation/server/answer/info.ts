/**
 * 학원 정보 답변: 수강료·교재비·시간표·강사·모집 현황·휴보강·보강 규정(정형 사실),
 * 시설 속성(문장 인용), 환불·셔틀·운영 시간 등 운영 문서의 절(절 인용).
 * 모두 생성 API 0회. 자료로 확인되지 않으면 지어내지 않고 보류한다.
 */
import type { TopicDefinition } from '../config.ts';
import {
  compactText,
  containsAny,
  isDataAbsenceStatement,
  normalizeText,
  splitSentences,
} from '../text/normalize.ts';
import {
  formatIsoDate,
  formatKstDate,
  formatValidity,
  isValidAt,
  kstStartOfDay,
  toKstDate,
} from '../text/time.ts';
import type { ApprovedFact, FactType, RagChunk } from '../types.ts';
import {
  abstain,
  className,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type CitationRequest,
  type EffectiveTime,
} from './context.ts';
import { formatKrw, josa } from './format.ts';

interface Part {
  outcome: 'ok' | 'partial' | 'missing' | 'conflict';
  lines: string[];
  citations: CitationRequest[];
  usedFacts: ApprovedFact[];
  missing: string[];
  derived: number[];
  instants: number[];
}

const emptyPart = (outcome: Part['outcome'], missing: string[] = []): Part => ({
  outcome,
  lines: [],
  citations: [],
  usedFacts: [],
  missing,
  derived: [],
  instants: [],
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 질문이 주제 안에서 "무엇"을 묻는지(비용·하원·등원 등). 같은 주제의 여러 문장·행 중 그 측면을 다루는 쪽을 고른다.
 * (dev 실패에서 보강: "자습하는 방 돈 따로 내야 됨?", "학원 버스 한 달에 얼마?", "수업 끝나고 봉고 몇 시 출발?")
 */
interface Aspect {
  /** 표 행·열 선택에 더할 단어 */
  words: string[];
  /** 근거 문장이 이 측면을 다루는지 */
  matches: (text: string) => boolean;
}

const ASPECTS: ReadonlyArray<{ question: RegExp; aspect: Aspect }> = [
  {
    question: /돈|비용|얼마|유료|무료|요금|이용료|따로\s*내/,
    aspect: {
      words: ['비용', '이용료', '요금'],
      matches: (text) => /\d[\d,]*\s*원|비용|무료|유료|요금|이용료/.test(text),
    },
  },
  {
    question: /끝나고|끝나면|마치고|마치면|끝날\s*때|집에\s*갈|하원/,
    aspect: { words: ['하원'], matches: (text) => /하원/.test(text) },
  },
  {
    question: /출발/,
    aspect: { words: ['출발'], matches: (text) => /출발/.test(text) },
  },
];

function aspectsOf(question: string): Aspect[] {
  const normalized = normalizeText(question);
  return ASPECTS.filter((entry) => entry.question.test(normalized)).map(
    (entry) => entry.aspect,
  );
}

/** "문가람쌤", "다니엘 선생님"처럼 이름으로 특정 강사를 가리키는지(역할·과목·반 표현은 제외). */
const NON_NAME_WORDS = new Set([
  '담당',
  '담임',
  '우리',
  '저희',
  '원장',
  '부원장',
  '원어민',
  '영어',
  '수학',
  '국어',
  '과학',
  '사회',
  '논술',
  '학원',
  '학교',
  '과외',
  '다른',
  '어떤',
  '무슨',
  '어느',
  '새로',
  '새로운',
  '남자',
  '여자',
  '외국인',
  '스피킹',
  '문법',
  '독해',
  '리딩',
  '회화',
  '실장',
  '상담',
  '조교',
  '보조',
  '전임',
  '전담',
]);

function namedTeacher(normalized: string): string | null {
  for (const match of normalized.matchAll(
    /(?:^|[^가-힣a-z])([가-힣]{2,4}|[a-z]{3,})\s*(?:쌤|샘|선생님|강사님|강사)/g,
  )) {
    const word = match[1];
    if (NON_NAME_WORDS.has(word) || /반$|[0-9]/.test(word)) continue;
    return word;
  }
  return null;
}

/** 강사 "누구/담당/어느 반" 질문인지(이름·담당 반 외 속성 질문과 구분). */
const TEACHER_WHO =
  /누구|누가|담당|담임|이름|성함|맡|무슨\s*반|어느\s*반|어떤\s*반|바뀌|바뀐|교체/;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

async function loadFacts(
  ctx: AnswerContext,
  factTypes: FactType[],
  effectiveAt: number,
  includeHistory = false,
): Promise<ApprovedFact[]> {
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes,
    asOf: ctx.asOf,
    effectiveAt,
    includeHistory,
  });
  recordFacts(ctx.trace, facts);
  return facts;
}

/** 질문이 특정한 반(반 이름 또는 학생의 반). 없으면 빈 배열. */
function explicitClassIds(ctx: AnswerContext): string[] {
  if (ctx.frame.classIds.length > 0) return ctx.frame.classIds;
  return ctx.studentClassIds.filter(
    (id) => !ctx.frame.negatedClassIds.includes(id),
  );
}

function targetClassIds(ctx: AnswerContext): string[] {
  const explicit = explicitClassIds(ctx);
  if (explicit.length > 0) return explicit;
  return ctx.catalog.classes
    .map((klass) => klass.classId)
    .filter((id) => !ctx.frame.negatedClassIds.includes(id));
}

function currentFor(
  facts: ApprovedFact[],
  subjectId: string,
  at: number,
): ApprovedFact[] {
  return facts.filter(
    (fact) =>
      fact.subjectId === subjectId &&
      isValidAt(fact.validFrom, fact.validTo, at),
  );
}

function hasConflict(facts: ApprovedFact[]): boolean {
  // 모집 현황은 문구가 달라도 상태·정원·잔여석이 같으면 같은 사실로 본다.
  if (facts.every((fact) => fact.value.kind === 'enrollment')) {
    const values = facts.map(
      (fact) =>
        fact.value as Extract<ApprovedFact['value'], { kind: 'enrollment' }>,
    );
    const differs = (pick: (v: (typeof values)[number]) => number | null) => {
      const known = values.map(pick).filter((v): v is number => v !== null);
      return new Set(known).size > 1;
    };
    return (
      new Set(values.map((v) => v.status)).size > 1 ||
      differs((v) => v.capacity) ||
      differs((v) => v.remaining)
    );
  }
  return new Set(facts.map((fact) => JSON.stringify(fact.value))).size > 1;
}

function datePrefix(effective: EffectiveTime): string {
  return `${formatKstDate(effective.at)} 기준 `;
}

function amountOf(fact: ApprovedFact): number {
  return fact.value.kind === 'money' ? fact.value.amount : 0;
}

function textOf(fact: ApprovedFact): string {
  switch (fact.value.kind) {
    case 'text':
    case 'schedule':
    case 'enrollment':
    case 'schedule_change':
      return fact.value.text;
    default:
      return '';
  }
}

/** 반 단위 정형 사실(교재비·시간표·강사·모집 현황) 공통 처리. */
async function answerClassFacts(
  ctx: AnswerContext,
  effective: EffectiveTime,
  options: {
    factType: FactType;
    label: string;
    render: (fact: ApprovedFact, name: string) => string;
    datePrefixed?: boolean;
    /** 한 반에 여러 값이 정상인 사실(정규·원어민 시간표, 담당 강사 여러 명) */
    multiValued?: boolean;
  },
): Promise<Part> {
  const facts = await loadFacts(ctx, [options.factType], effective.at);
  const part = emptyPart('ok');
  const explicitClasses = explicitClassIds(ctx).length > 0;
  for (const classId of targetClassIds(ctx)) {
    const current = currentFor(facts, classId, effective.at);
    const name = className(ctx.catalog, classId);
    if (current.length === 0) {
      if (explicitClasses) part.missing.push(`${name} ${options.label}`);
      continue;
    }
    if (
      (!options.multiValued || options.factType === 'enrollment_status') &&
      hasConflict(current)
    )
      return emptyPart('conflict', [`${name} ${options.label}`]);
    for (const fact of options.multiValued ? current : current.slice(0, 1)) {
      part.lines.push(
        `${options.datePrefixed ? datePrefix(effective) : ''}${options.render(fact, name)}`,
      );
      part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
      part.usedFacts.push(fact);
    }
  }
  if (part.usedFacts.length === 0) {
    return emptyPart(
      'missing',
      part.missing.length ? part.missing : [options.label],
    );
  }
  if (part.missing.length > 0) part.outcome = 'partial';
  return part;
}

async function answerFee(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const wantsPrevious =
    ctx.frame.flags.previousRevision && ctx.access.canViewPublicHistory;
  const facts = (
    await loadFacts(ctx, ['monthly_fee'], effective.at, wantsPrevious)
  ).filter((fact) => fact.value.kind === 'money');
  const explicitClasses = explicitClassIds(ctx).length > 0;
  const part = emptyPart('ok');

  const rows: Array<{
    classId: string;
    current: ApprovedFact;
    previous?: ApprovedFact;
  }> = [];
  for (const classId of targetClassIds(ctx)) {
    const current = currentFor(facts, classId, effective.at);
    if (current.length === 0) {
      if (explicitClasses)
        part.missing.push(`${className(ctx.catalog, classId)} 수강료`);
      continue;
    }
    if (hasConflict(current))
      return emptyPart('conflict', [
        `${className(ctx.catalog, classId)} 수강료`,
      ]);
    const previous = wantsPrevious
      ? facts
          .filter(
            (fact) =>
              fact.subjectId === classId &&
              fact.validTo !== null &&
              fact.validTo <= current[0].validFrom,
          )
          .sort((a, b) => b.validFrom - a.validFrom)[0]
      : undefined;
    rows.push({ classId, current: current[0], previous });
  }

  if (wantsPrevious) {
    const withHistory = rows.filter((row) => row.previous);
    const selected = explicitClasses ? rows : withHistory;
    if (withHistory.length === 0) part.missing.push('개정 전 수강료');
    for (const row of selected) {
      const name = className(ctx.catalog, row.classId);
      const now = amountOf(row.current);
      if (!row.previous) {
        part.lines.push(
          `${name}의 현재 월 수강료는 ${formatKrw(now)}입니다(${formatValidity(row.current.validFrom, row.current.validTo)}). 이전 수강료 기록은 확인되지 않습니다.`,
        );
        part.citations.push({
          kind: 'fact',
          fact: row.current,
          effectiveAt: effective.at,
        });
        part.usedFacts.push(row.current);
        continue;
      }
      const before = amountOf(row.previous);
      const diff = Math.abs(now - before);
      part.derived.push(diff);
      part.lines.push(
        `${name} 월 수강료는 개정 전 ${formatKrw(before)}(${formatValidity(row.previous.validFrom, row.previous.validTo)})에서 ${datePrefix(effective)}${formatKrw(now)}(${formatValidity(row.current.validFrom, row.current.validTo)})입니다. 차이는 ${formatKrw(diff)}입니다.`,
      );
      part.citations.push(
        {
          kind: 'fact',
          fact: row.previous,
          effectiveAt: effective.at,
          includeHistory: true,
        },
        { kind: 'fact', fact: row.current, effectiveAt: effective.at },
      );
      part.usedFacts.push(row.previous, row.current);
    }
  } else {
    for (const row of rows) {
      const name = className(ctx.catalog, row.classId);
      part.lines.push(
        `${datePrefix(effective)}${name} 월 수강료는 ${formatKrw(amountOf(row.current))}입니다(${formatValidity(row.current.validFrom, row.current.validTo)}).`,
      );
      part.citations.push({
        kind: 'fact',
        fact: row.current,
        effectiveAt: effective.at,
      });
      part.usedFacts.push(row.current);
    }
    if (ctx.frame.flags.compare && rows.length >= 2) {
      const sorted = [...rows].sort(
        (a, b) => amountOf(b.current) - amountOf(a.current),
      );
      const diff =
        amountOf(sorted[0].current) -
        amountOf(sorted[sorted.length - 1].current);
      part.derived.push(diff);
      if (diff === 0) {
        part.lines.push('비교한 반들의 월 수강료는 같습니다.');
      } else {
        const top = className(ctx.catalog, sorted[0].classId);
        const bottom = className(
          ctx.catalog,
          sorted[sorted.length - 1].classId,
        );
        part.lines.push(
          `${top}${josa(top, '이', '가')} ${bottom}보다 ${formatKrw(diff)} 더 비쌉니다.`,
        );
      }
    }
  }

  for (const amount of ctx.frame.amountsKrw) {
    part.derived.push(amount);
    const match = rows.find((row) => amountOf(row.current) === amount);
    part.lines.push(
      match
        ? `문의하신 금액(${formatKrw(amount)})은 ${className(ctx.catalog, match.classId)}의 승인된 수강료와 같습니다.`
        : `문의하신 금액(${formatKrw(amount)})은 승인된 현재 수강료 자료에서 확인되지 않습니다.`,
    );
  }

  if (part.usedFacts.length === 0)
    return emptyPart(
      'missing',
      part.missing.length ? part.missing : ['수강료'],
    );
  if (part.missing.length > 0) part.outcome = 'partial';
  return part;
}

/** 질문의 날짜·주·달 표현을 [start, end) 범위로 바꾼다. 없으면 null. */
function requestedRange(
  ctx: AnswerContext,
  effective: EffectiveTime,
): { start: number; end: number; label: string } | null {
  const { frame, asOf } = ctx;
  const today = kstStartOfDay(toKstDate(asOf));
  if (effective.explicitDay !== null) {
    return {
      start: effective.explicitDay,
      end: effective.explicitDay + DAY_MS,
      label: formatKstDate(effective.explicitDay),
    };
  }
  if (frame.relativeDay !== null) {
    const start = today + frame.relativeDay * DAY_MS;
    return { start, end: start + DAY_MS, label: formatKstDate(start) };
  }
  if (frame.relativeWeek !== null) {
    const weekday = new Date(today + 9 * 60 * 60 * 1000).getUTCDay();
    const monday = today - ((weekday + 6) % 7) * DAY_MS;
    const offset =
      frame.relativeWeek === 'this_week'
        ? 0
        : frame.relativeWeek === 'next_week'
          ? 7
          : -7;
    const start = monday + offset * DAY_MS;
    const label =
      frame.relativeWeek === 'this_week'
        ? '이번 주'
        : frame.relativeWeek === 'next_week'
          ? '다음 주'
          : '지난주';
    return {
      start,
      end: start + 7 * DAY_MS,
      label: `${label}(${formatKstDate(start)}~)`,
    };
  }
  const { year, month } = toKstDate(asOf);
  const targetMonth =
    frame.months[0] ??
    (frame.relativePeriod === 'this_month'
      ? month
      : frame.relativePeriod === 'last_month'
        ? month - 1
        : null);
  if (targetMonth !== null) {
    const y = targetMonth < 1 ? year - 1 : year;
    const m = targetMonth < 1 ? 12 : targetMonth;
    const start = kstStartOfDay({ year: y, month: m, day: 1 });
    const end =
      m === 12
        ? kstStartOfDay({ year: y + 1, month: 1, day: 1 })
        : kstStartOfDay({ year: y, month: m + 1, day: 1 });
    return { start, end, label: `${y}년 ${m}월` };
  }
  return null;
}

function dayOf(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  return kstStartOfDay({ year, month, day });
}

async function answerScheduleChange(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  // 공지 자체는 "지금(asOf) 유효한" 승인 공지만 사용한다.
  const facts = (await loadFacts(ctx, ['schedule_change'], ctx.asOf)).filter(
    (fact) => fact.value.kind === 'schedule_change',
  );
  const { flags } = ctx.frame;
  const types: Array<'cancel' | 'makeup'> =
    flags.makeupSchedule && !flags.cancelSchedule
      ? ['makeup']
      : flags.cancelSchedule && !/보강|보충/.test(ctx.frame.compact)
        ? ['cancel']
        : ['cancel', 'makeup'];
  const classIds = explicitClassIds(ctx);
  let candidates = facts.filter((fact) => {
    if (fact.value.kind !== 'schedule_change') return false;
    if (!types.includes(fact.value.changeType)) return false;
    if (
      classIds.length > 0 &&
      fact.subjectType === 'class' &&
      !classIds.includes(fact.subjectId)
    )
      return false;
    return true;
  });

  const range = requestedRange(ctx, effective);
  const today = kstStartOfDay(toKstDate(ctx.asOf));
  const linkedMakeup =
    flags.makeupSchedule &&
    flags.cancelSchedule &&
    effective.explicitDay !== null;
  if (range && linkedMakeup) {
    // "11월 12일 휴강분 보강은 언제?": 그날 휴강 + 그 휴강과 연결된(같은 반 또는 날짜를 언급한) 이후 보강
    const day = effective.explicitDay as number;
    const cancels = candidates.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        fact.value.changeType === 'cancel' &&
        dayOf(fact.value.date) === day,
    );
    const { month, day: dom } = toKstDate(day);
    const mention = `${month}월${dom}일`;
    const cancelClasses = new Set(
      cancels
        .filter((fact) => fact.subjectType === 'class')
        .map((fact) => fact.subjectId),
    );
    const later = candidates.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        fact.value.changeType === 'makeup' &&
        dayOf(fact.value.date) >= day &&
        dayOf(fact.value.date) < day + 31 * DAY_MS,
    );
    // 공지에 그 휴강 날짜("11월 10일 휴강분")가 적힌 보강을 우선하고, 없을 때만 같은 반의 이후 보강을 쓴다
    // (같은 반의 다른 휴강분 보강이 섞이지 않게).
    const mentioned = later.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        compactText(fact.value.text).includes(mention),
    );
    // 공지에 휴강 날짜가 없으면, 각 보강을 "그 반에 적용되는 가장 가까운 이전 휴강(반 휴강 또는 학원 전체 휴강)"의 보강으로 본다.
    const appliesTo = (cancel: ApprovedFact, classId: string) =>
      cancel.subjectType !== 'class' || cancel.subjectId === classId;
    const allCancels = facts.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        fact.value.changeType === 'cancel',
    );
    const ownerDay = (makeup: ApprovedFact): number | null => {
      if (makeup.value.kind !== 'schedule_change') return null;
      const makeupDay = dayOf(makeup.value.date);
      const prior = allCancels
        .filter(
          (cancel) =>
            cancel.value.kind === 'schedule_change' &&
            appliesTo(cancel, makeup.subjectId) &&
            dayOf(cancel.value.date) <= makeupDay,
        )
        .map((cancel) =>
          cancel.value.kind === 'schedule_change'
            ? dayOf(cancel.value.date)
            : 0,
        );
      return prior.length > 0 ? Math.max(...prior) : null;
    };
    const makeups =
      mentioned.length > 0
        ? mentioned
        : later.filter(
            (fact) =>
              fact.subjectType === 'class' &&
              cancelClasses.has(fact.subjectId) &&
              ownerDay(fact) === day,
          );
    candidates = [...cancels, ...makeups];
  } else if (range) {
    candidates = candidates.filter((fact) => {
      const day =
        fact.value.kind === 'schedule_change' ? dayOf(fact.value.date) : 0;
      return day >= range.start && day < range.end;
    });
  } else {
    // 날짜 표현이 없으면 질문 단어(예: 수능, 기말)가 공지 문구에 있는 것 → 없으면 앞으로의 일정
    const words = normalizeText(ctx.question)
      .split(/[^0-9a-z가-힣]+/)
      .map((word) => word.replace(/(날|일|에|은|는|이|가|도|때)$/, ''))
      .filter(
        (word) =>
          word.length >= 2 &&
          ![
            '휴강',
            '보강',
            '수업',
            '일정',
            '있어요',
            '있나요',
            '언제',
            '하나요',
          ].includes(word),
      );
    const keyed = candidates.filter((fact) =>
      words.some((word) => compactText(textOf(fact)).includes(word)),
    );
    candidates =
      keyed.length > 0
        ? keyed
        : candidates.filter(
            (fact) =>
              fact.value.kind === 'schedule_change' &&
              dayOf(fact.value.date) >= today,
          );
  }

  if (candidates.length === 0) {
    const what =
      types.length === 1
        ? types[0] === 'cancel'
          ? '휴강'
          : '보강'
        : '휴강·보강';
    return emptyPart('missing', [
      `${range ? `${range.label} ` : ''}${what} 공지`,
    ]);
  }
  const part = emptyPart('ok');
  candidates.sort((a, b) =>
    a.value.kind === 'schedule_change' && b.value.kind === 'schedule_change'
      ? a.value.date.localeCompare(b.value.date)
      : 0,
  );
  for (const fact of candidates.slice(0, 8)) {
    if (fact.value.kind !== 'schedule_change') continue;
    const day = dayOf(fact.value.date);
    const weekday = WEEKDAYS[new Date(day + 9 * 60 * 60 * 1000).getUTCDay()];
    const scope =
      fact.subjectType === 'class'
        ? className(ctx.catalog, fact.subjectId)
        : '학원 전체';
    const kind = fact.value.changeType === 'cancel' ? '휴강' : '보강';
    part.lines.push(
      `${formatIsoDate(fact.value.date)}(${weekday})${fact.value.time ? ` ${fact.value.time}` : ''} [${scope} · ${kind}] ${fact.value.text}`,
    );
    part.citations.push({ kind: 'fact', fact });
    part.usedFacts.push(fact);
    part.instants.push(day);
  }
  return part;
}

async function answerMakeupPolicy(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const facts = await loadFacts(ctx, ['makeup_policy'], effective.at);
  if (facts.length === 0) return emptyPart('missing', ['보강 규정']);
  // 보강 규정은 여러 조항(대상·신청 방법 등)으로 나뉠 수 있으므로 모두 안내한다.
  const part = emptyPart('ok');
  part.lines.push('등록된 운영 규정에 따른 보강 기준:');
  for (const fact of facts) {
    part.lines.push(`- ${textOf(fact)}`);
    part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
    part.usedFacts.push(fact);
  }
  // 정형 사실로 뽑히지 않은 세부 조항(당일 질병 결석, 원어민 수업 결석 등)은 질문 단어가 들어간 규정 문장을 덧붙인다.
  // (dev 실패에서 보강: "어제 아파서 못 갔는데 보충 받을 수 있어요?", "원어민 수업 빠졌는데 보충 해줘요?")
  const clauseWords = [
    ...contentWords(ctx.question).filter(
      (word) =>
        !/^(보강|보충|학원|수업|결석|이것|이거|따로|오늘|어제|받을|해줘|빠지|빠졌|못|갔는데)/.test(
          word,
        ),
    ),
    ...(/아파|아프|병원|감기|질병|다쳐/.test(ctx.frame.normalized)
      ? ['질병', '진료']
      : []),
    ...(/갑자기|당일|오늘|어제/.test(ctx.frame.normalized)
      ? ['당일', '갑작스러운']
      : []),
  ];
  if (clauseWords.length > 0) {
    const results = await ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      query: ['보강', '결석', ...clauseWords].join(' '),
      limit: ctx.config.searchLimit,
    });
    recordChunks(
      ctx.trace,
      results.map((result) => result.chunk),
    );
    const known = facts.map((fact) => compactText(textOf(fact)));
    const extra: Array<{ chunk: RagChunk; sentence: string }> = [];
    for (const { chunk } of results) {
      if (
        chunk.documentType !== 'policy' &&
        chunk.documentType !== 'academy_info'
      )
        continue;
      for (const sentence of splitSentences(chunk.text)) {
        const compact = compactText(sentence);
        if (
          /보강|결석/.test(sentence) &&
          clauseWords.some((word) => compact.includes(compactText(word))) &&
          !known.some(
            (text) => text.includes(compact) || compact.includes(text),
          ) &&
          !isDataAbsenceStatement(sentence) &&
          !extra.some((entry) => entry.sentence === sentence)
        )
          extra.push({ chunk, sentence });
      }
    }
    for (const { chunk, sentence } of extra.slice(0, 2)) {
      part.lines.push(`관련 규정: "${sentence.replace(/^\d+\.\s*/, '')}"`);
      part.citations.push({ kind: 'chunk', chunk });
    }
  }
  if (ctx.frame.flags.unconditional) {
    part.lines.push(
      '규정에 무조건(자동) 승인한다는 내용은 없으므로, 구체적인 가능 여부는 담당자에게 확인해 주세요.',
    );
  }
  if (ctx.frame.flags.countLimit) {
    const evidence = await findSentence(
      ctx,
      ['보강', '횟수', '회', '번'],
      (sentence) =>
        /보강/.test(sentence) && /횟수|\d+\s*(회|번)/.test(sentence),
    );
    if (evidence) {
      part.lines.push(`관련 규정: "${evidence.sentence}"`);
      part.citations.push({ kind: 'chunk', chunk: evidence.chunk });
    } else {
      part.outcome = 'partial';
      part.missing.push('보강 횟수 기준');
      part.lines.push('보강 가능 횟수는 등록된 규정에서 확인되지 않습니다.');
    }
  }
  return part;
}

/** 승인 문서에서 조건을 만족하는 "자료 없음"이 아닌 문장을 찾는다. */
async function findSentence(
  ctx: AnswerContext,
  queryTerms: readonly string[],
  predicate: (sentence: string) => boolean,
): Promise<{ chunk: RagChunk; sentence: string } | null> {
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: queryTerms.join(' '),
    limit: ctx.config.searchLimit,
  });
  recordChunks(
    ctx.trace,
    results.map((result) => result.chunk),
  );
  for (const { chunk } of results) {
    for (const sentence of splitSentences(chunk.text)) {
      if (!isDataAbsenceStatement(sentence) && predicate(sentence))
        return { chunk, sentence };
    }
  }
  return null;
}

async function answerAttribute(
  ctx: AnswerContext,
  topic: TopicDefinition,
  effective: EffectiveTime,
): Promise<Part> {
  const evidenceTerms = topic.evidenceTerms ?? topic.terms;
  const facts = await loadFacts(ctx, [...topic.factTypes], effective.at);
  const matchingFacts = facts.filter((fact) => {
    const text = textOf(fact);
    return containsAny(text, evidenceTerms) && !isDataAbsenceStatement(text);
  });
  const part = emptyPart('ok');
  const aspects = aspectsOf(ctx.question);
  if (aspects.length > 0) {
    // 질문이 묻는 측면(예: 비용)을 다루는 사실 → 같은 절(근거어가 제목·절·문장에 있는 청크)의 문장 순으로 찾는다.
    const covers = (text: string) => aspects.every((a) => a.matches(text));
    const aspectFact = matchingFacts.find((fact) => covers(textOf(fact)));
    if (aspectFact) {
      part.lines.push(`등록된 안내 자료에 따르면: ${textOf(aspectFact)}`);
      part.citations.push({
        kind: 'fact',
        fact: aspectFact,
        effectiveAt: effective.at,
      });
      part.usedFacts.push(aspectFact);
      return part;
    }
    const results = await ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      query: [...evidenceTerms, ...aspects.flatMap((a) => a.words)].join(' '),
      limit: ctx.config.searchLimit,
    });
    recordChunks(
      ctx.trace,
      results.map((result) => result.chunk),
    );
    for (const { chunk } of results) {
      const inTopic =
        containsAny(chunk.location.section ?? '', evidenceTerms) ||
        containsAny(chunk.text, evidenceTerms);
      if (!inTopic) continue;
      const sentence = splitSentences(chunk.text).find(
        (candidate) => !isDataAbsenceStatement(candidate) && covers(candidate),
      );
      if (sentence) {
        part.lines.push(`등록된 안내 자료에 따르면: "${sentence}"`);
        part.citations.push({ kind: 'chunk', chunk });
        part.usedFacts.push(
          ...facts.filter((fact) => fact.sourceId === chunk.sourceId),
        );
        return part;
      }
    }
  }
  const matchingFact = matchingFacts[0];
  if (matchingFact) {
    part.lines.push(`등록된 안내 자료에 따르면: ${textOf(matchingFact)}`);
    part.citations.push({
      kind: 'fact',
      fact: matchingFact,
      effectiveAt: effective.at,
    });
    part.usedFacts.push(matchingFact);
    return part;
  }
  const evidence = await findSentence(
    ctx,
    [...evidenceTerms, ...topic.terms],
    (sentence) => containsAny(sentence, evidenceTerms),
  );
  if (!evidence) return emptyPart('missing', [topic.label]);
  part.lines.push(`등록된 안내 자료에 따르면: "${evidence.sentence}"`);
  part.citations.push({ kind: 'chunk', chunk: evidence.chunk });
  part.usedFacts.push(
    ...facts.filter((fact) => fact.sourceId === evidence.chunk.sourceId),
  );
  return part;
}

const STOPWORDS = new Set([
  '알려줘',
  '알려주세요',
  '알려',
  '주세요',
  '있나요',
  '있어요',
  '있습니까',
  '뭐예요',
  '무엇',
  '무엇인가요',
  '어떻게',
  '어디',
  '인가요',
  '되나요',
  '해주세요',
  '궁금해요',
  '궁금합니다',
  '문의',
  '혹시',
  '정보',
  '학원',
  '관련',
  '대해',
  '대한',
  '그',
  '이',
  '저',
  '어떤가요',
  '어떻게',
  '되는지',
  '하는지',
  '건가요',
  '거예요',
]);

function contentWords(question: string): string[] {
  const words = normalizeText(question)
    .split(/[^0-9a-z가-힣]+/)
    .map((word) =>
      word.replace(
        /(에서는|에서|으로|에게|까지|부터|이나|이랑|하고|은|는|이|가|을|를|의|에|도|만|요)$/,
        '',
      ),
    )
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

const SECTION_MAX_CHARS = 600;

interface SectionCandidate {
  chunk: RagChunk;
  score: number;
  wordHits: number;
  sectionMatch: boolean;
  aspectMatch: boolean;
  /** "우리 반 교실"처럼 대상 반이 정해졌을 때 그 반 이름이 들어간 행/문장 */
  classMatch: boolean;
}

/**
 * 질문 대상 반이 정해져 있으면 다른 반 이름만 언급하는 문장·행은 빼고(반 사이 값 혼동 방지),
 * 대상 반이나 반 이름이 없는 문장은 남긴다.
 */
function classFilter(ctx: AnswerContext): (text: string) => boolean {
  const targets = explicitClassIds(ctx);
  if (targets.length === 0) return () => true;
  const names = (classId: string) => {
    const klass = ctx.catalog.classes.find((c) => c.classId === classId);
    return klass
      ? [klass.name, ...klass.aliases]
          .map(compactText)
          .filter((n) => n.length >= 3)
      : [];
  };
  const targetNames = targets.flatMap(names);
  const otherNames = ctx.catalog.classes
    .filter((c) => !targets.includes(c.classId))
    .flatMap((c) => names(c.classId));
  return (text: string) => {
    const compact = compactText(text);
    if (targetNames.some((name) => compact.includes(name))) return true;
    return !otherNames.some((name) => compact.includes(name));
  };
}

/** 표 행 청크에서 질문과 관련된 행·열만 골라 "헤더: 값" 형태로 만든다(다른 칸 값이 섞이지 않게). */
function renderTableRows(
  chunks: RagChunk[],
  words: string[],
  evidenceTerms: readonly string[],
  keepText: (text: string) => boolean,
): string[] {
  const has = (text: string) =>
    words.filter((word) => compactText(text).includes(compactText(word)))
      .length;
  const rows = chunks.filter(
    (chunk) =>
      chunk.location.cells &&
      chunk.location.header &&
      keepText((chunk.location.cells ?? []).join(' ')),
  );
  // 행이 적으면 모두 보여 주고, 많으면 질문 단어·근거어와 가장 많이 맞는 행만 고른다.
  const rowScore = (chunk: RagChunk) => {
    const cells = (chunk.location.cells ?? []).join(' ');
    return has(cells) + (containsAny(cells, evidenceTerms) ? 2 : 0);
  };
  const bestRow = Math.max(0, ...rows.map(rowScore));
  const selectedRows = (
    rows.length <= 4 || bestRow === 0
      ? rows
      : rows.filter((chunk) => rowScore(chunk) === bestRow)
  ).slice(0, 8);
  const header = selectedRows[0]?.location.header ?? [];
  const headerScores = header.map(
    (name) => has(name) + (containsAny(name, evidenceTerms) ? 1 : 0),
  );
  const best = Math.max(0, ...headerScores.slice(1));
  const keep = header.map(
    (_, index) => index === 0 || best === 0 || headerScores[index] === best,
  );
  return selectedRows.map((chunk) =>
    (chunk.location.header ?? [])
      .map((name, index) =>
        keep[index] ? `${name}: ${chunk.location.cells?.[index] ?? ''}` : null,
      )
      .filter(Boolean)
      .join(' / '),
  );
}

/** 문단 청크에서 질문 단어·근거어가 들어간 문장을 고른다(없으면 앞 3문장). */
function renderParagraphs(
  chunks: RagChunk[],
  words: string[],
  evidenceTerms: readonly string[],
  keepText: (text: string) => boolean,
): string[] {
  const sentences = chunks
    .flatMap((chunk) => splitSentences(chunk.text))
    .filter(
      (sentence) => !isDataAbsenceStatement(sentence) && keepText(sentence),
    );
  const relevant = sentences.filter(
    (sentence) =>
      containsAny(sentence, evidenceTerms) ||
      words.some((word) => compactText(sentence).includes(compactText(word))),
  );
  return (relevant.length > 0 ? relevant : sentences.slice(0, 3)).filter(
    (sentence) => !/^\d+\.?$/.test(sentence.trim()),
  );
}

/**
 * 운영 문서의 해당 절을 찾아 인용한다(생성 0회).
 * - 근거어는 문서 제목·절 제목·본문 중 어디에 있어도 된다(표 행에는 근거어가 없을 수 있음).
 * - 표는 질문한 행·열만, 문단은 관련 문장만 인용한다.
 * - 질문이 두 문서에 걸치면(예: 셔틀 시각 + 셔틀 이용료) 첫 절이 다루지 않는 단어를 가진 두 번째 절을 덧붙인다.
 */
async function answerSection(
  ctx: AnswerContext,
  topic: TopicDefinition,
): Promise<Part> {
  const evidenceTerms = topic.evidenceTerms ?? topic.terms;
  const aspects = aspectsOf(ctx.question);
  const targetNames = explicitClassIds(ctx).flatMap((classId) => {
    const klass = ctx.catalog.classes.find((c) => c.classId === classId);
    return klass
      ? [klass.name, ...klass.aliases]
          .map(compactText)
          .filter((n) => n.length >= 3)
      : [];
  });
  const mentionsTargetClass = (text: string) =>
    targetNames.some((name) => compactText(text).includes(name));
  const words = [
    ...contentWords(ctx.question).filter(
      (word) => !topic.terms.some((term) => compactText(term) === word),
    ),
    ...aspects.flatMap((aspect) => aspect.words),
  ].filter((word, index, list) => list.indexOf(word) === index);
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [...evidenceTerms, ...topic.terms, ...words].join(' '),
    limit: ctx.config.searchLimit * 3,
  });
  recordChunks(
    ctx.trace,
    results.map((result) => result.chunk),
  );
  const candidates: SectionCandidate[] = results
    .filter(({ chunk }) => {
      const hasText = splitSentences(chunk.text).some(
        (sentence) => !isDataAbsenceStatement(sentence),
      );
      const evidence =
        containsAny(chunk.title, evidenceTerms) ||
        containsAny(chunk.location.section ?? '', evidenceTerms) ||
        splitSentences(chunk.text).some(
          (sentence) =>
            !isDataAbsenceStatement(sentence) &&
            containsAny(sentence, evidenceTerms),
        );
      return hasText && evidence;
    })
    .map(({ chunk, score }) => ({
      chunk,
      score,
      wordHits: words.filter((word) =>
        compactText(chunk.contextualText).includes(compactText(word)),
      ).length,
      sectionMatch: containsAny(chunk.location.section ?? '', evidenceTerms),
      aspectMatch:
        aspects.length > 0 &&
        aspects.every((aspect) => aspect.matches(chunk.contextualText)),
      classMatch: mentionsTargetClass(chunk.text),
    }));
  if (candidates.length === 0) return emptyPart('missing', [topic.label]);

  const maxScore = Math.max(...candidates.map((entry) => entry.score), 1e-9);
  const rank = (entry: SectionCandidate) =>
    entry.score / maxScore +
    entry.wordHits * 0.15 +
    (entry.sectionMatch ? 0.3 : 0) +
    (entry.aspectMatch ? 0.5 : 0) +
    (entry.classMatch ? 0.4 : 0);
  candidates.sort((a, b) => rank(b) - rank(a));

  const groupKey = (chunk: RagChunk) =>
    `${chunk.sourceId}§${chunk.location.section ?? chunk.chunkId}`;
  const groups: Array<{
    key: string;
    best: SectionCandidate;
    chunks: RagChunk[];
  }> = [];
  for (const entry of candidates) {
    const key = groupKey(entry.chunk);
    const group = groups.find((g) => g.key === key);
    if (group) group.chunks.push(entry.chunk);
    else groups.push({ key, best: entry, chunks: [entry.chunk] });
  }
  const order = (chunk: RagChunk) => Number(chunk.chunkId.split('#').pop());
  const first = groups[0];
  const chosen = [first];
  const covered = (group: (typeof groups)[number]) =>
    new Set(
      words.filter((word) =>
        group.chunks.some((chunk) =>
          compactText(chunk.contextualText).includes(compactText(word)),
        ),
      ),
    );
  const firstCovered = covered(first);
  const second = groups
    .slice(1)
    .find(
      (group) =>
        rank(group.best) >= rank(first.best) * 0.35 &&
        [...covered(group)].some((word) => !firstCovered.has(word)),
    );
  if (second) chosen.push(second);

  const part = emptyPart('ok');
  for (const group of chosen) {
    const chunks = group.chunks.sort((a, b) => order(a) - order(b));
    const tableChunks = chunks.filter(
      (chunk) => chunk.location.kind === 'table_row',
    );
    const paragraphChunks = chunks.filter(
      (chunk) => chunk.location.kind !== 'table_row',
    );
    const lines: string[] = [];
    let length = 0;
    const keepText = classFilter(ctx);
    for (const text of [
      ...renderParagraphs(paragraphChunks, words, evidenceTerms, keepText),
      ...renderTableRows(tableChunks, words, evidenceTerms, keepText),
    ]) {
      if (length + text.length > SECTION_MAX_CHARS && lines.length > 0) break;
      lines.push(text);
      length += text.length;
    }
    const best = group.best.chunk;
    // 원문 Markdown 강조 기호는 인용할 때 뺀다.
    for (let i = 0; i < lines.length; i += 1)
      lines[i] = lines[i].replace(/\*\*|__/g, '');
    part.lines.push(
      `[${best.location.section ?? topic.label}] ${best.title} 기준 안내입니다.\n${lines.join('\n')}`,
    );
    part.citations.push(
      ...chunks.map((chunk) => ({ kind: 'chunk' as const, chunk })),
    );
  }
  return part;
}

async function answerGeneric(ctx: AnswerContext): Promise<AnswerDraft> {
  const words = contentWords(ctx.question);
  if (words.length === 0) {
    return abstain(
      '질문하신 내용을 등록된 자료에서 확인할 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  }
  const evidence = await findSentence(ctx, words, (sentence) => {
    const compact = compactText(sentence);
    return words.every((word) => compact.includes(compactText(word)));
  });
  if (!evidence) {
    return abstain(
      '질문하신 내용을 등록된 승인 자료에서 확인할 수 없어 답변드리기 어렵습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  }
  return {
    status: 'answered',
    text: `등록된 자료에 따르면: "${evidence.sentence}"`,
    citations: [{ kind: 'chunk', chunk: evidence.chunk }],
    usedFacts: [],
  };
}

export async function answerInfo(ctx: AnswerContext): Promise<AnswerDraft> {
  const effective = resolveEffectiveTime(ctx.frame, ctx.asOf);
  const topics = ctx.frame.topics;
  ctx.trace.intent =
    topics.length > 0
      ? topics.map((topic) => topic.id).join('+')
      : 'general_info';

  // 카탈로그에 없는 프로그램(예: 겨울방학 특강)의 수강료·일정은 승인 자료로 확인할 수 없다(초안 수치를 쓰지 않음).
  // 반 이름에 포함되지 않은 프로그램 지칭(캠프·패키지 등)이 남아 있으면 승인 자료에 없는 프로그램이다.
  if (ctx.frame.unknownPrograms.length > 0) {
    const label = ctx.frame.unknownPrograms.join(', ');
    return abstain(
      `문의하신 ${label} 관련 내용은 현재 승인된 안내 자료에서 확인되지 않아 안내해 드릴 수 없습니다. 개설 여부와 비용은 담당자에게 확인해 주세요.`,
      'INSUFFICIENT_EVIDENCE',
      [`${label} 정보`],
      ['INSUFFICIENT_EVIDENCE'],
    );
  }

  // 이름으로 특정 강사를 가리키는 질문(dev 실패에서 보강)
  // - 개인 연락처(카톡·번호)는 안내하지 않는다.
  // - "누구/담당 반"이 아닌 속성(국적·학력 등)은 정형 "담당 강사" 사실로 답할 수 없으므로 문장 근거가 있을 때만 답한다.
  const teacherName = namedTeacher(ctx.frame.normalized);
  if (teacherName && topics.some((topic) => topic.id === 'contact')) {
    return abstain(
      '강사 개인 연락처는 안내해 드리지 않습니다. 학원 대표 연락처로 문의해 주시면 전달해 드립니다.',
      'INSUFFICIENT_EVIDENCE',
      ['강사 개인 연락처'],
      ['INSUFFICIENT_EVIDENCE'],
    );
  }
  if (
    teacherName &&
    topics.length === 1 &&
    topics[0].id === 'teacher' &&
    !TEACHER_WHO.test(ctx.frame.normalized)
  ) {
    return answerGeneric(ctx);
  }

  let selectedTopics: TopicDefinition[] = [...topics];
  if (selectedTopics.length === 0) {
    // 주제어 없이 반만 말한 경우("중2 심화반은요?", "우리 반 알려줘")에만 반 요약을 준다.
    // 원생 계정이라도 반을 말하지 않은 질문(예: "매점 있어?")은 반 요약으로 대신하지 않는다.
    const namesClass =
      ctx.frame.classIds.length > 0 ||
      /반(?=$|[\s은는이가에의도요?])/.test(ctx.frame.normalized);
    if (!namesClass || explicitClassIds(ctx).length === 0)
      return answerGeneric(ctx);
    // 반만 언급된 경우 해당 반의 수강료·시간표·강사를 함께 안내한다.
    selectedTopics = ctx.config.topics.filter((topic) =>
      ['fee', 'schedule', 'teacher'].includes(topic.id),
    );
  }

  // 1) 속성 주제(시설·연락처 등)가 하나라도 확인되지 않으면 전체 보류(그 속성이 실제 질문 대상이므로)
  const parts: Part[] = [];
  const missingAttributes: string[] = [];
  for (const topic of selectedTopics.filter((t) => t.kind === 'attribute')) {
    const part = await answerAttribute(ctx, topic, effective);
    if (part.outcome === 'missing') missingAttributes.push(topic.label);
    else parts.push(part);
  }
  if (missingAttributes.length > 0) {
    return abstain(
      `${missingAttributes.join(', ')} 관련 내용은 등록된 승인 자료에서 확인되지 않아 안내해 드릴 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.`,
      'INSUFFICIENT_EVIDENCE',
      missingAttributes,
      ['INSUFFICIENT_EVIDENCE'],
    );
  }

  // 2) 정형 주제
  for (const topic of selectedTopics.filter((t) => t.kind === 'structured')) {
    switch (topic.id) {
      case 'fee':
        parts.push(await answerFee(ctx, effective));
        break;
      case 'material':
        parts.push(
          await answerClassFacts(ctx, effective, {
            factType: 'material_fee',
            label: '교재비',
            render: (fact, name) =>
              `${name} 교재비는 ${formatKrw(amountOf(fact))}입니다(${formatValidity(fact.validFrom, fact.validTo)}).`,
          }),
        );
        break;
      case 'schedule':
        parts.push(
          await answerClassFacts(ctx, effective, {
            factType: 'schedule',
            label: '수업 시간표',
            datePrefixed: true,
            multiValued: true,
            render: (fact, name) =>
              `${name} 수업은 ${textOf(fact)}입니다(${formatValidity(fact.validFrom, fact.validTo)}).`,
          }),
        );
        break;
      case 'teacher':
        parts.push(
          await answerClassFacts(ctx, effective, {
            factType: 'teacher',
            label: '담당 강사',
            multiValued: true,
            render: (fact, name) =>
              `${name} 담당 강사는 ${textOf(fact)}입니다.`,
          }),
        );
        break;
      case 'enrollment':
        parts.push(
          await answerClassFacts(ctx, effective, {
            factType: 'enrollment_status',
            label: '모집 현황',
            multiValued: true,
            render: (fact, name) =>
              `${name} 모집 현황: ${textOf(fact)} (${formatKstDate(fact.validFrom)} 공지 기준)`,
          }),
        );
        break;
      case 'schedule_change':
        parts.push(await answerScheduleChange(ctx, effective));
        break;
      case 'makeup':
        parts.push(await answerMakeupPolicy(ctx, effective));
        break;
      default:
        parts.push(emptyPart('missing', [topic.label]));
    }
  }

  // 3) 운영 문서 절(환불·셔틀·운영 시간 등)
  for (const topic of selectedTopics.filter((t) => t.kind === 'section')) {
    parts.push(await answerSection(ctx, topic));
  }

  if (parts.some((part) => part.outcome === 'conflict')) {
    return abstain(
      '승인된 자료끼리 내용이 서로 달라 정확한 안내가 어렵습니다. 담당자에게 확인 후 안내해 드리겠습니다.',
      'CONFLICTING_EVIDENCE',
      parts.flatMap((part) =>
        part.outcome === 'conflict' ? part.missing : [],
      ),
      ['CONTRADICTION'],
    );
  }

  const answered = parts.filter(
    (part) => part.outcome === 'ok' || part.outcome === 'partial',
  );
  const missing = parts.flatMap((part) => part.missing);
  if (answered.length === 0) {
    const label =
      missing.length > 0
        ? `요청하신 내용(${missing.join(', ')})`
        : '요청하신 내용';
    return abstain(
      `${label}은 등록된 승인 자료에서 확인되지 않아 안내해 드릴 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.`,
      'INSUFFICIENT_EVIDENCE',
      missing,
      ['INSUFFICIENT_EVIDENCE'],
    );
  }

  const isPartial =
    missing.length > 0 || answered.some((part) => part.outcome === 'partial');
  const lines = answered.flatMap((part) => part.lines);
  if (isPartial) lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  return {
    status: isPartial ? 'partial' : 'answered',
    text: lines.join('\n'),
    citations: answered.flatMap((part) => part.citations),
    usedFacts: answered.flatMap((part) => part.usedFacts),
    missingFields: isPartial ? missing : undefined,
    reasonCode: isPartial ? 'PARTIAL_EVIDENCE' : undefined,
    derivedNumbers: answered.flatMap((part) => part.derived),
    instants: [
      effective.at,
      effective.explicitDay,
      ctx.asOf,
      ...answered.flatMap((part) => part.instants),
    ].filter((v): v is number => v !== null),
    conversationUpdate: {
      previousFrame: { domain: 'info', units: [], periods: [] },
    },
  };
}
