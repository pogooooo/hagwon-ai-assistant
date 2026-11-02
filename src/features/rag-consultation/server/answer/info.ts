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

function targetClassIds(ctx: AnswerContext): string[] {
  if (ctx.frame.classIds.length > 0) return ctx.frame.classIds;
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
  },
): Promise<Part> {
  const facts = await loadFacts(ctx, [options.factType], effective.at);
  const part = emptyPart('ok');
  const explicitClasses = ctx.frame.classIds.length > 0;
  for (const classId of targetClassIds(ctx)) {
    const current = currentFor(facts, classId, effective.at);
    const name = className(ctx.catalog, classId);
    if (current.length === 0) {
      if (explicitClasses) part.missing.push(`${name} ${options.label}`);
      continue;
    }
    if (hasConflict(current))
      return emptyPart('conflict', [`${name} ${options.label}`]);
    const fact = current[0];
    part.lines.push(
      `${options.datePrefixed ? datePrefix(effective) : ''}${options.render(fact, name)}`,
    );
    part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
    part.usedFacts.push(fact);
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
  const explicitClasses = ctx.frame.classIds.length > 0;
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
      : flags.cancelSchedule && !ctx.frame.compact.includes('보강')
        ? ['cancel']
        : ['cancel', 'makeup'];
  const classIds = ctx.frame.classIds;
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
  if (range) {
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
  if (hasConflict(facts)) return emptyPart('conflict', ['보강 규정']);
  const fact = facts[0];
  const part = emptyPart('ok');
  part.lines.push(
    `등록된 운영 규정에 따른 보강 기준: ${textOf(fact)}.`.replace(/\.\.$/, '.'),
  );
  part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
  part.usedFacts.push(fact);
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
  const matchingFact = facts.find((fact) => {
    const text = textOf(fact);
    return containsAny(text, evidenceTerms) && !isDataAbsenceStatement(text);
  });
  const part = emptyPart('ok');
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

/** 운영 문서의 해당 절을 찾아 인용한다(여러 블록이면 같은 절끼리 이어 붙임). */
async function answerSection(
  ctx: AnswerContext,
  topic: TopicDefinition,
): Promise<Part> {
  const evidenceTerms = topic.evidenceTerms ?? topic.terms;
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      ...evidenceTerms,
      ...topic.terms,
      ...contentWords(ctx.question),
    ].join(' '),
    limit: ctx.config.searchLimit * 2,
  });
  recordChunks(
    ctx.trace,
    results.map((result) => result.chunk),
  );
  const scored = results
    .map(({ chunk, score }) => {
      const sentences = splitSentences(chunk.text).filter(
        (sentence) => !isDataAbsenceStatement(sentence),
      );
      const evidenceCount = sentences.filter((sentence) =>
        containsAny(sentence, evidenceTerms),
      ).length;
      const sectionMatch = chunk.location.section
        ? containsAny(chunk.location.section, evidenceTerms)
        : false;
      return { chunk, score, evidenceCount, sectionMatch };
    })
    .filter((entry) => entry.evidenceCount > 0 || entry.sectionMatch);
  if (scored.length === 0) return emptyPart('missing', [topic.label]);
  // 질문 단어 일치(BM25)를 우선하고, 절 제목 일치·근거 문장 수를 보조 점수로 더한다.
  const maxScore = Math.max(...scored.map((entry) => entry.score), 1e-9);
  const rank = (entry: (typeof scored)[number]) =>
    entry.score / maxScore +
    (entry.sectionMatch ? 0.5 : 0) +
    Math.min(entry.evidenceCount, 3) * 0.1;
  scored.sort((a, b) => rank(b) - rank(a));
  const best = scored[0].chunk;
  const order = (chunk: RagChunk) => Number(chunk.chunkId.split('#').pop());
  const sameSection = (
    best.location.section
      ? scored.filter(
          (entry) =>
            entry.chunk.sourceId === best.sourceId &&
            entry.chunk.location.section === best.location.section,
        )
      : [scored[0]]
  )
    .map((entry) => entry.chunk)
    .sort((a, b) => order(a) - order(b));

  const lines: string[] = [];
  let length = 0;
  const used: RagChunk[] = [];
  for (const chunk of sameSection) {
    const sentences = splitSentences(chunk.text).filter(
      (sentence) => !isDataAbsenceStatement(sentence),
    );
    for (const sentence of sentences) {
      if (length + sentence.length > SECTION_MAX_CHARS && lines.length > 0)
        break;
      lines.push(sentence);
      length += sentence.length;
    }
    used.push(chunk);
    if (length >= SECTION_MAX_CHARS) break;
  }
  const part = emptyPart('ok');
  const heading = best.location.section ?? topic.label;
  part.lines.push(
    `[${heading}] ${best.title} 기준 안내입니다.\n${lines.join('\n')}`,
  );
  part.citations.push(
    ...used.map((chunk) => ({ kind: 'chunk' as const, chunk })),
  );
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

  let selectedTopics: TopicDefinition[] = [...topics];
  if (selectedTopics.length === 0) {
    if (ctx.frame.classIds.length === 0) return answerGeneric(ctx);
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
