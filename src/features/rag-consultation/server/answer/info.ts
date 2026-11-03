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

/** 질문이 특정한 반(반 이름 또는 학생의 반). 없으면 빈 배열. */
export function explicitClassIds(ctx: AnswerContext): string[] {
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

/** 그 말이 승인 자료의 표 머리글이나 절 제목으로 쓰였는지(“정원” 열이 있는 과정 구성 표 등). */
async function definedAsLabel(
  ctx: AnswerContext,
  term: string,
): Promise<boolean> {
  const needle = compactText(term);
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: term,
    limit: 10,
  });
  return results.some(
    ({ chunk }) =>
      (chunk.location.header ?? []).some((h) =>
        compactText(h).includes(needle),
      ) || compactText(chunk.location.section ?? '').includes(needle),
  );
}

/** 두 글자 묶음이 하나라도 겹치는지(“재료비” ↔ “실험 재료비(월)”). */
function sharesBigram(a: string, b: string): boolean {
  const x = compactText(a);
  const y = compactText(b);
  for (let i = 0; i + 2 <= x.length; i += 1)
    if (y.includes(x.slice(i, i + 2))) return true;
  return false;
}

/**
 * 금액 사실의 원문 이름: 사실이 나온 문서의 표에서 그 금액이 든 칸의 머리글(예: "실험 재료비(월)" → "실험 재료비").
 * 원문에서 찾지 못한 사실은 이름을 비워 두고 주제 이름을 쓴다.
 */
async function sourceLabels(
  ctx: AnswerContext,
  factType: FactType,
  at: number,
): Promise<Map<string, string>> {
  const facts = (await loadFacts(ctx, [factType], at)).filter(
    (fact) => fact.value.kind === 'money',
  );
  const labels = new Map<string, string>();
  if (facts.length === 0) return labels;
  const amounts = [...new Set(facts.map((fact) => formatKrw(amountOf(fact))))];
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: amounts.join(' '),
    limit: 40,
  });
  for (const fact of facts) {
    const amount = compactText(formatKrw(amountOf(fact)));
    for (const { chunk } of results) {
      if (chunk.documentId !== fact.documentId) continue;
      const cells = chunk.location.cells ?? [];
      const header = chunk.location.header ?? [];
      const index = cells.findIndex(
        (cell, i) => i > 0 && compactText(cell).includes(amount),
      );
      const name = index > 0 ? header[index] : undefined;
      if (!name) continue;
      const label = name
        .replace(/\(.*?\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (label.length >= 2 && !/^\d/.test(label)) {
        labels.set(fact.factId, label);
        break;
      }
    }
  }
  return labels;
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
      // 정형 시간표가 없는 반: 승인된 시간표 문서의 표에서 그 반 이름이 든 칸을 찾는다(요일×교시 격자 포함).
      const seen = { offDay: false };
      const table =
        explicitClasses && options.factType === 'schedule'
          ? await classTableRows(ctx, classId, ['schedule'], effective, seen)
          : [];
      if (table.length > 0) {
        for (const { chunk, line, tableColumns } of table) {
          part.lines.push(
            `${effective.explicitDay !== null ? datePrefix(effective) : ''}${name} 수업(시간표 표 기준): ${line}`,
          );
          part.citations.push({ kind: 'chunk', chunk, tableColumns });
        }
        continue;
      }
      // 시간표에는 있지만 묻는 요일에 수업이 없는 반(자녀가 듣는 다른 반)은 빠진 정보로 보지 않는다.
      if (seen.offDay) continue;
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
  if (part.usedFacts.length === 0 && part.lines.length === 0) {
    return emptyPart(
      'missing',
      part.missing.length ? part.missing : [options.label],
    );
  }
  if (part.missing.length > 0) part.outcome = 'partial';
  return part;
}

/**
 * 표에서 반 이름이 든 칸 찾기: 행의 첫 칸(교시·시간) + 그 반이 있는 칸의 머리글(요일)을 한 줄로.
 * 셀 안 공백("중2 내신B 반")은 무시하고 비교한다.
 */

const WEEKDAY_AXIS = /^[월화수목금토일](요일)?$/;
const CLASS_COLUMN = /^(대상|수강)?(반|강좌|과정)(명|이름|구분)?$/;
const WEEKDAY_TOKEN =
  /(?<![가-힣a-z0-9])(평일|주말|매일|[월화수목금토일]+(?:요일)?)(?:에는|에서|에도|은|는|이|가|에|도|과|와)?(?![가-힣a-z0-9])/gi;
const DAY_GROUPS: Record<string, string> = {
  평일: '월화수목금',
  주말: '토일',
  매일: '월화수목금토일',
};

function weekdayTokens(text: string): Set<string> {
  const days = new Set<string>();
  const tokens = [...text.matchAll(WEEKDAY_TOKEN)];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const value = token[1].replace(/요일$/, '');
    const next = tokens[i + 1];
    const end = next?.[1].replace(/요일$/, '');
    if (
      value.length === 1 &&
      end?.length === 1 &&
      /^\s*[~\-–]\s*$/.test(
        text.slice(token.index + token[0].length, next.index),
      )
    ) {
      const startIndex = WEEKDAYS.indexOf(value);
      const endIndex = WEEKDAYS.indexOf(end);
      for (let index = startIndex; ; index = (index + 1) % WEEKDAYS.length) {
        days.add(WEEKDAYS[index]);
        if (index === endIndex) break;
      }
      i += 1;
      continue;
    }
    for (const day of DAY_GROUPS[value] ?? value) days.add(day);
  }
  return days;
}

/** 요일 목록과 예외 문구를 분리해 일정을 확인한다. */
function weekdayAvailability(
  word: string,
  day: string,
  explicitDay?: number | null,
  holiday = false,
): boolean | undefined {
  const included = new Set<string>();
  const excluded = new Set<string>();
  const expression = normalizeText(word).replace(
    /\s+(?=(?:공휴일|휴일)\s*(?:제외|휴강|수업\s*없))/g,
    ';',
  );
  for (const clause of expression.split(/[()[\]／/;,\n]+/)) {
    if (/미정|추후\s*공지|확인\s*필요/.test(clause)) return false;
    const negative =
      /휴강|제외|수업\s*(?:없|안\s*함|미실시)|미운영|^없음$/.test(
        clause.trim(),
      );
    const datePattern = /(?:(\d{4})년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    const dates = [...clause.matchAll(datePattern)];
    if (negative && dates.length > 0) {
      if (explicitDay != null) {
        const { year, month, day: date } = toKstDate(explicitDay);
        if (
          dates.some(
            (match) =>
              (!match[1] || Number(match[1]) === year) &&
              Number(match[2]) === month &&
              Number(match[3]) === date,
          )
        )
          return false;
      }
      continue;
    }
    const holidayClause = /공휴일|휴일/.test(clause);
    if (negative && holidayClause && holiday) return false;
    const days = weekdayTokens(clause.replace(datePattern, ' '));
    if (negative && days.size === 0 && !holidayClause) return false;
    for (const value of days) (negative ? excluded : included).add(value);
  }
  if (excluded.has(day)) return false;
  return included.has(day) ? true : undefined;
}

function dayWordCovers(word: string, day: string): boolean {
  return weekdayAvailability(word, day) === true;
}

function rowMatchesWeekday(
  cells: string[],
  header: string[],
  weekday: string,
  ctx?: AnswerContext,
  effective?: EffectiveTime,
): boolean {
  const dayColumns = header
    .map((h, index) =>
      /요일|수업일/.test(h) && !/^[월화수목금토일](요일)?$/.test(compactText(h))
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const holiday = /공휴일|휴일/.test(ctx?.question ?? '');
  const allowed =
    dayColumns.length === 0 ||
    dayColumns.some(
      (i) =>
        weekdayAvailability(
          cells[i] ?? '',
          weekday,
          effective?.explicitDay,
          holiday,
        ) === true,
    );
  return (
    allowed &&
    header.every(
      (label, index) =>
        !/^(비고|예외|휴강일)$/.test(compactText(label)) ||
        weekdayAvailability(
          cells[index] ?? '',
          weekday,
          effective?.explicitDay,
          holiday,
        ) !== false,
    )
  );
}

/** 질문이 가리킨 요일(“토요일”, 명시 날짜의 요일). 없으면 null. */
function askedWeekday(
  ctx: AnswerContext,
  effective?: EffectiveTime,
): string | null {
  const named = ctx.frame.normalized.match(
    /(?<![가-힣a-z0-9])([월화수목금토일])요일(?:에는|에서|에도|은|는|이|가|에|도|과|와)?(?![가-힣a-z0-9])/i,
  );

  // “21일부터”처럼 기간의 시작을 말한 날짜는 특정 요일을 묻는 것이 아니다.
  if (
    effective?.explicitDay != null &&
    ctx.frame.explicitDates[0]?.operator === 'at'
  ) {
    const { year, month, day } = toKstDate(effective.explicitDay);
    const actual =
      WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    return named && named[1] !== actual ? '불일치' : actual;
  }
  return named?.[1] ?? null;
}

/** "1교시 (평일 16:40~18:10 / 토 13:00~14:30)"처럼 요일별 시각이 함께 든 칸에서 묻는 요일의 시각만 남긴다. */
function focusDay(label: string, day: string): string {
  const pairs = [
    ...label.matchAll(
      /(평일|주말|[월화수목금토일](?:요일)?)\s*(\d{1,2}:\d{2}\s*[~\-]\s*\d{1,2}:\d{2})/g,
    ),
  ];
  if (pairs.length < 2) return label;
  const hit = pairs.find((pair) => dayWordCovers(pair[1], day));
  if (!hit) return label;
  const prefix = label.split('(')[0].trim();
  return `${prefix} (${hit[1]} ${hit[2]})`;
}

/** 행에 적힌 기간("11월 23일~12월 4일")이 있고 묻는 날짜가 그 밖이면 false. */
function rowCoversDay(text: string, day: number): boolean {
  const { year } = toKstDate(day);
  const ranges = [
    ...text.matchAll(
      /(\d{1,2})월\s*(\d{1,2})일[^~\-\d]{0,6}[~\-–]\s*(?:(\d{1,2})월\s*)?(\d{1,2})일/g,
    ),
  ];
  if (ranges.length === 0) return true;
  return ranges.some((m) => {
    const startMonth = Number(m[1]);
    const endMonth = m[3] ? Number(m[3]) : startMonth;
    const start = kstStartOfDay({ year, month: startMonth, day: Number(m[2]) });
    const end = kstStartOfDay({
      year: endMonth < startMonth ? year + 1 : year,
      month: endMonth,
      day: Number(m[4]),
    });
    return day >= start && day <= end;
  });
}

export async function classTableRows(
  ctx: AnswerContext,
  classId: string,
  documentTypes: readonly string[],
  effective?: EffectiveTime,
  seen: { offDay: boolean } = { offDay: false },
): Promise<EvidenceLine[]> {
  effective ??= resolveEffectiveTime(ctx.frame, ctx.asOf);
  const weekday = askedWeekday(ctx, effective);
  const klass = ctx.catalog.classes.find((c) => c.classId === classId);
  if (!klass) return [];
  const names = [klass.name, ...klass.aliases]
    .map(compactText)
    .filter((n) => n.length >= 3);
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [klass.name, ...klass.aliases].join(' '),
    limit: 40,
    documentTypes,
  });
  recordChunks(
    ctx.trace,
    results.map((result) => result.chunk),
  );
  const out: EvidenceLine[] = [];
  for (const { chunk } of results) {
    const cells = chunk.location.cells;
    const header = chunk.location.header;
    if (
      chunk.location.kind !== 'table_row' ||
      !cells ||
      !header ||
      !chunkMatchesClass(ctx, chunk) ||
      !isValidAt(chunk.validFrom, chunk.validTo, effective.at)
    )
      continue;

    const key = classColumn(header, cells, names);
    const grid = key < 0;
    if (!grid && !matchesClassCell(cells[key] ?? '', names)) continue;
    if (!header.some((h) => /시간|요일|교시/.test(h) || WEEKDAY_AXIS.test(h)))
      continue;
    if (
      !rowCoversDay(
        cells.join(' '),
        kstStartOfDay(toKstDate(effective?.at ?? ctx.asOf)),
      )
    )
      continue;
    if (grid && !cells.slice(1).some((cell) => matchesClassCell(cell, names)))
      continue;
    const selected = grid
      ? gridColumns(
          header,
          cells,
          names,
          weekday ? [weekday] : [],
          ctx,
          effective,
        )
      : [];
    if (
      weekday &&
      (weekday === '불일치' ||
        (grid
          ? selected.length === 0
          : !rowMatchesWeekday(cells, header, weekday, ctx, effective)))
    ) {
      seen.offDay = true;
      continue;
    }
    const label = weekday ? focusDay(cells[0] ?? '', weekday) : cells[0];
    const weekdayGrid =
      grid &&
      selected.every((index) =>
        WEEKDAY_AXIS.test(compactText(header[index] ?? '')),
      );
    const indices = grid ? [0, ...selected] : header.map((_, index) => index);
    const line = weekdayGrid
      ? header[0] +
        ': ' +
        label +
        ' / ' +
        selected.map((i) => header[i]).join('·')
      : formatCells(header, cells, indices);
    if (!out.some((entry) => entry.line === line))
      out.push({ chunk, line, tableColumns: grid ? selected : indices });
  }
  return out.slice(0, 6);
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
      : flags.cancelSchedule &&
          !flags.makeupSchedule &&
          !ctx.frame.compact.includes('보강')
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
    // 휴강 대상 반: 반 휴강이면 그 반, 학원 전체 휴강이면 질문한 반(없으면 모든 반)
    const academyWide = cancels.some((fact) => fact.subjectType !== 'class');
    const cancelClasses = new Set([
      ...cancels
        .filter((fact) => fact.subjectType === 'class')
        .map((fact) => fact.subjectId),
      ...(academyWide
        ? classIds.length > 0
          ? classIds
          : ctx.catalog.classes.map((klass) => klass.classId)
        : []),
    ]);
    const later = candidates.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        fact.value.changeType === 'makeup' &&
        dayOf(fact.value.date) >= day &&
        dayOf(fact.value.date) < day + 31 * DAY_MS,
    );
    // 공지에 그 휴강 날짜("11월 10일 휴강분")가 적힌 보강을 우선하고, 없을 때만 각 보강을
    // "그 반에 적용되는 가장 가까운 이전 휴강(반 휴강 또는 학원 전체 휴강)"의 보강으로 본다(다른 휴강분 보강이 섞이지 않게).
    const mentioned = later.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        compactText(fact.value.text).includes(mention) &&
        (fact.subjectType !== 'class' || cancelClasses.has(fact.subjectId)),
    );
    const allCancels = facts.filter(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        fact.value.changeType === 'cancel',
    );
    // 같은 공지 안에서 그 반의 휴강과 보강을 날짜순으로 짝짓는다(첫 휴강 ↔ 첫 보강 …).
    // 같은 공지에 휴강이 없으면 그 반에 적용되는 가장 가까운 이전 휴강의 보강으로 본다.
    const changeDay = (fact: ApprovedFact) =>
      fact.value.kind === 'schedule_change' ? dayOf(fact.value.date) : 0;
    const applies = (cancel: ApprovedFact, makeup: ApprovedFact) =>
      cancel.subjectType !== 'class' || cancel.subjectId === makeup.subjectId;
    const ownerDay = (makeup: ApprovedFact): number | null => {
      if (makeup.value.kind !== 'schedule_change') return null;
      const makeupDay = changeDay(makeup);
      const sameNotice = allCancels.filter(
        (cancel) =>
          cancel.documentId === makeup.documentId &&
          cancel.subjectType === 'class' &&
          applies(cancel, makeup),
      );
      if (sameNotice.length > 0) {
        const cancelDays = [...new Set(sameNotice.map(changeDay))].sort(
          (a, b) => a - b,
        );
        const siblings = facts
          .filter(
            (fact) =>
              fact.value.kind === 'schedule_change' &&
              fact.value.changeType === 'makeup' &&
              fact.documentId === makeup.documentId &&
              fact.subjectId === makeup.subjectId,
          )
          .sort((a, b) => changeDay(a) - changeDay(b));
        const index = siblings.findIndex(
          (fact) => fact.factId === makeup.factId,
        );
        if (
          index >= 0 &&
          index < cancelDays.length &&
          cancelDays[index] <= makeupDay
        )
          return cancelDays[index];
      }
      const prior = allCancels
        .filter(
          (cancel) => applies(cancel, makeup) && changeDay(cancel) <= makeupDay,
        )
        .map(changeDay);
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

export function contentWords(question: string): string[] {
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

const SECTION_MAX_CHARS = 900;

interface SectionCandidate {
  chunk: RagChunk;
  score: number;
  wordHits: number;
  sectionMatch: boolean;
}

/**
 * 질문 대상 반이 정해져 있으면 다른 반 이름만 언급하는 문장·행은 빼고(반 사이 값 혼동 방지),
 * 대상 반이나 반 이름이 없는 문장은 남긴다.
 */
export function chunkMatchesClass(
  ctx: AnswerContext,
  chunk: RagChunk,
): boolean {
  const targets = explicitClassIds(ctx);
  return (
    !chunk.classId || targets.length === 0 || targets.includes(chunk.classId)
  );
}

export function classFilter(ctx: AnswerContext): (text: string) => boolean {
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

const GRADE_GROUP_WORDS: Record<string, string[]> = {
  초: ['초등', '초'],
  중: ['중등', '중학'],
  고: ['고등', '고교'],
};

/**
 * 반 이름과 표 행 이름이 정확히 같지 않을 때(예: "중2 심화반" ↔ "중등 2학년 심화")의 유사도.
 * 학년(또는 초·중·고 구분)이 맞으면 1, 학년을 뺀 핵심 이름의 두 글자 묶음이 겹치는 비율을 더한다.
 */
export function classSimilarity(className: string, text: string): number {
  const name = compactText(className);
  const target = compactText(text);
  const grade = name.match(/^(초|중|고)([1-6])/);
  const rowGrade = target.match(/^(초|중|고)([1-6])/);
  if (grade && rowGrade && grade[0] !== rowGrade[0]) return 0;
  let score = 0;
  if (grade) {
    const [token, group, year] = grade;
    const groupHit = GRADE_GROUP_WORDS[group].some((w) => target.includes(w));
    if (
      target.includes(token) ||
      (groupHit && new RegExp(`${year}(학년)?`).test(target))
    )
      score += 1;
    else if (groupHit && !/[1-6]학년/.test(target)) score += 0.5;
  }
  const core = name.replace(/^(초|중|고)[1-6]/, '').replace(/반$/, '');
  const grams: string[] = [];
  for (let i = 0; i + 2 <= core.length; i += 1)
    grams.push(core.slice(i, i + 2));
  if (grams.length > 0)
    score += grams.filter((g) => target.includes(g)).length / grams.length;
  return score;
}

function matchesClassCell(cell: string, names: readonly string[]): boolean {
  const value = compactText(cell);
  return names.some(
    (name) =>
      value === name ||
      (value.startsWith(name) && /^[([:·,/\-]/.test(value.slice(name.length))),
  );
}

function classColumn(
  header: string[],
  cells: string[],
  names: readonly string[],
): number {
  const index = header.findIndex((label) =>
    CLASS_COLUMN.test(compactText(label)),
  );
  if (index >= 0) return index;
  return matchesClassCell(cells[0] ?? '', names) ? 0 : -1;
}

function gridColumns(
  header: string[],
  cells: string[],
  names: readonly string[],
  days: string[],
  ctx?: AnswerContext,
  effective?: EffectiveTime,
): number[] {
  const weekdayGrid = header
    .slice(1)
    .some((label) => WEEKDAY_AXIS.test(compactText(label)));
  return cells.flatMap((cell, index) =>
    index > 0 &&
    matchesClassCell(cell, names) &&
    (days.length === 0 ? [''] : days).some(
      (day) =>
        weekdayAvailability(
          cell,
          day,
          effective?.explicitDay,
          /공휴일|휴일/.test(ctx?.question ?? ''),
        ) !== false,
    ) &&
    (!weekdayGrid ||
      days.length === 0 ||
      days.some((day) => dayWordCovers(header[index] ?? '', day)))
      ? [index]
      : [],
  );
}

function formatCells(
  header: string[],
  cells: string[],
  indices: number[],
): string {
  return indices
    .map((index) => header[index] + ': ' + (cells[index] ?? ''))
    .join(' / ');
}

interface EvidenceLine {
  line: string;
  chunk: RagChunk;
  tableColumns?: readonly number[];
}

/** 표 행 청크에서 질문과 관련된 행·열만 골라 "헤더: 값" 형태로 만든다(다른 칸 값이 섞이지 않게). */
export function selectTableRows(
  chunks: RagChunk[],
  words: string[],
  evidenceTerms: readonly string[],
  keepText: (text: string) => boolean,
  targetNames: readonly string[] = [],
  ctx?: AnswerContext,
): EvidenceLine[] {
  const has = (text: string) =>
    words.filter((word) => compactText(text).includes(compactText(word)))
      .length;
  const effective = ctx ? resolveEffectiveTime(ctx.frame, ctx.asOf) : undefined;
  const weekday = ctx
    ? askedWeekday(ctx, effective)
    : words
        .map((word) => word.match(/([월화수목금토일])요일/)?.[1])
        .find(Boolean);
  const rows = chunks.filter(
    (chunk) =>
      chunk.location.cells &&
      chunk.location.header &&
      (!ctx || chunkMatchesClass(ctx, chunk)) &&
      keepText((chunk.location.cells ?? []).join(' ')) &&
      (chunk.documentType !== 'schedule' ||
        (weekday !== '불일치' &&
          (!effective ||
            rowCoversDay(
              (chunk.location.cells ?? []).join(' '),
              kstStartOfDay(toKstDate(effective.at)),
            )) &&
          (!weekday ||
            rowMatchesWeekday(
              chunk.location.cells ?? [],
              chunk.location.header ?? [],
              weekday,
              ctx,
              effective,
            )))),
  );
  // 행이 적으면 모두 보여 주고, 많으면 질문 단어·근거어와 가장 많이 맞는 행만 고른다.
  const rowScore = (chunk: RagChunk) => {
    const cells = (chunk.location.cells ?? []).join(' ');
    return has(cells) + (containsAny(cells, evidenceTerms) ? 2 : 0);
  };
  const targets = targetNames.map(compactText).filter((n) => n.length >= 2);
  // 반마다 따로 선택해 비교 질문에서도 각 대상의 정확·유사 행을 모두 유지한다.
  const matches = new Set<RagChunk>();
  for (const name of targets) {
    const exact = rows.filter((chunk) =>
      (chunk.location.cells ?? []).some((cell, index, cells) => {
        const key = classColumn(chunk.location.header ?? [], cells, targets);
        return (key < 0 || key === index) && matchesClassCell(cell, [name]);
      }),
    );
    if (exact.length > 0) {
      exact.forEach((chunk) => matches.add(chunk));
      continue;
    }
    const similarity = (chunk: RagChunk) =>
      classSimilarity(
        name,
        chunk.location.cells?.[
          Math.max(
            0,
            classColumn(
              chunk.location.header ?? [],
              chunk.location.cells ?? [],
              targets,
            ),
          )
        ] ?? '',
      );
    const best = Math.max(0, ...rows.map(similarity));
    if (best >= 1.3)
      rows
        .filter((chunk) => similarity(chunk) === best)
        .forEach((chunk) => matches.add(chunk));
  }
  const knownNames = [
    ...targets,
    ...(ctx?.catalog.classes ?? []).flatMap((klass) =>
      [klass.name, ...klass.aliases].map(compactText),
    ),
  ].filter((name) => name.length >= 2);
  const tableKey = (chunk: RagChunk) =>
    chunk.sourceId + '#' + (chunk.location.tableIndex ?? chunk.chunkId);
  const classTables = new Set(
    rows
      .filter(
        ({ location }) =>
          location.header?.some((label) =>
            CLASS_COLUMN.test(compactText(label)),
          ) ||
          location.cells?.some(
            (cell) =>
              /^(초|중|고)[1-6]/.test(compactText(cell)) ||
              matchesClassCell(cell, knownNames),
          ),
      )
      .map(tableKey),
  );
  const boundRows =
    targets.length === 0
      ? rows
      : rows.filter(
          (chunk) => matches.has(chunk) || !classTables.has(tableKey(chunk)),
        );
  const bestRow = Math.max(0, ...boundRows.map(rowScore));
  const selectedRows = (
    matches.size > 0 || boundRows.length <= 4 || bestRow === 0
      ? boundRows
      : boundRows.filter((chunk) => rowScore(chunk) === bestRow)
  ).slice(0, 8);
  const askedDays = [
    ...new Set([
      ...(weekday ? [weekday] : []),
      ...words.flatMap((word) =>
        [...word.matchAll(/([월화수목금토일])요일/g)].map((m) => m[1]),
      ),
    ]),
  ];
  // 요일×교시 격자처럼 한 행에 여러 반이 있는 표: 대상 반 이름이 든 칸(과 첫 칸)만 보여 준다.
  return selectedRows.flatMap((chunk) => {
    const cells = chunk.location.cells ?? [];
    const header = chunk.location.header ?? [];
    const headerScores = header.map((name) => has(name));
    const best = Math.max(0, ...headerScores.slice(1));
    const keep = header.map(
      (_, index) => index === 0 || best === 0 || headerScores[index] === best,
    );

    const key = classColumn(header, cells, targets);
    const grid =
      key < 0 &&
      targets.length > 0 &&
      cells.slice(1).some((cell) => matchesClassCell(cell, targets));
    const selected = grid
      ? gridColumns(header, cells, targets, askedDays, ctx, effective)
      : [];
    if (grid && selected.length === 0) return [];
    const indices = grid
      ? [0, ...selected]
      : header.flatMap((_, index) =>
          keep[index] || index === key ? [index] : [],
        );
    const line = formatCells(header, cells, indices);
    return [
      {
        line,
        chunk,
        tableColumns: grid ? selected : indices,
      },
    ];
  });
}

export function renderTableRows(
  ...args: Parameters<typeof selectTableRows>
): string[] {
  return selectTableRows(...args).map(({ line }) => line);
}

/** 문단 청크에서 질문 단어·근거어가 들어간 문장을 고른다(없으면 앞 3문장). */
export function renderParagraphs(
  chunks: RagChunk[],
  words: string[],
  evidenceTerms: readonly string[],
  keepText: (text: string) => boolean,
): EvidenceLine[] {
  const sentences = chunks
    .flatMap((chunk) =>
      splitSentences(chunk.text).map((line) => ({ line, chunk })),
    )
    .filter(
      ({ line: sentence }) =>
        !isDataAbsenceStatement(sentence) && keepText(sentence),
    );
  const relevant = sentences.filter(
    ({ line: sentence }) =>
      containsAny(sentence, evidenceTerms) ||
      words.some((word) => compactText(sentence).includes(compactText(word))),
  );
  return (relevant.length > 0 ? relevant : sentences.slice(0, 3)).filter(
    ({ line: sentence }) => !/^\d+\.?$/.test(sentence.trim()),
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
  const words = contentWords(ctx.question).filter(
    (word) => !topic.terms.some((term) => compactText(term) === word),
  );
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
    }));
  if (candidates.length === 0) return emptyPart('missing', [topic.label]);

  const maxScore = Math.max(...candidates.map((entry) => entry.score), 1e-9);
  const rank = (entry: SectionCandidate) =>
    entry.score / maxScore +
    entry.wordHits * 0.15 +
    (entry.sectionMatch ? 0.3 : 0);
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
    const explicit = explicitClassIds(ctx);
    const targetNames = ctx.catalog.classes
      .filter((klass) => explicit.includes(klass.classId))
      .map((klass) => klass.name);
    const paragraphLines = renderParagraphs(
      paragraphChunks,
      words,
      evidenceTerms,
      keepText,
    );
    const tableLines = selectTableRows(
      tableChunks,
      words,
      evidenceTerms,
      keepText,
      targetNames,
      ctx,
    );
    // 질문 단어가 표 행에 있으면 표를 먼저 보여 준다(길이 제한에 표가 잘리지 않게).
    const tableFirst = tableLines.some(({ line }) =>
      words.some((word) => compactText(line).includes(compactText(word))),
    );
    for (const { line: text, chunk, tableColumns } of tableFirst
      ? [...tableLines, ...paragraphLines]
      : [...paragraphLines, ...tableLines]) {
      if (length + text.length > SECTION_MAX_CHARS && lines.length > 0) break;
      lines.push(text);
      part.citations.push({ kind: 'chunk', chunk, tableColumns });
      length += text.length;
    }
    if (lines.length === 0) continue;
    const source =
      (tableFirst ? tableLines : paragraphLines)[0]?.chunk ??
      tableLines[0].chunk;
    // 원문 Markdown 강조 기호는 인용할 때 뺀다.
    for (let i = 0; i < lines.length; i += 1)
      lines[i] = lines[i].replace(/\*\*|__/g, '');
    part.lines.push(
      `[${source.location.section ?? topic.label}] ${source.title} 기준 안내입니다.\n${lines.join('\n')}`,
    );
  }
  return part.lines.length > 0 ? part : emptyPart('missing', [topic.label]);
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

  let selectedTopics: TopicDefinition[] = [...topics];
  if (selectedTopics.length === 0) {
    if (explicitClassIds(ctx).length === 0) return answerGeneric(ctx);
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
      case 'material': {
        // 같은 사실 유형이라도 학원마다 원문 이름이 다르다(교재비 / 실험 재료비). 원문 표 머리글을 이름으로 쓰고,
        // 질문이 가리킨 비용 이름과 원문 이름이 다르면(교재비를 물었는데 원문은 실험 재료비) 정형 값으로 답하지 않는다.
        const labels = await sourceLabels(ctx, 'material_fee', effective.at);
        const asked = topic.terms.filter((term) =>
          ctx.frame.compact.includes(compactText(term)),
        );
        const known = [...labels.values()];
        // 원문 이름과 겹치지 않는 비용 이름 중 승인 자료에 따로 나오는 말(예: "교재비" 절)이 있으면 다른 비용을 물은 것이다.
        // 자료에 없는 구어 표현(“책값”)은 원문 이름과 달라도 같은 비용으로 본다.
        const unmatched = asked.filter(
          (term) => !known.some((label) => sharesBigram(term, label)),
        );
        let otherCost = false;
        if (known.length > 0 && unmatched.length === asked.length) {
          for (const term of unmatched) {
            if (
              await ctx.documents.corpusContains?.({
                access: ctx.access,
                studentIds: [],
                asOf: ctx.asOf,
                term,
              })
            )
              otherCost = true;
          }
        }
        if (otherCost) {
          parts.push(emptyPart('missing', [topic.label]));
          break;
        }
        parts.push(
          await answerClassFacts(ctx, effective, {
            factType: 'material_fee',
            label: topic.label,
            render: (fact, name) =>
              `${name} ${labels.get(fact.factId) ?? topic.label}는 ${formatKrw(amountOf(fact))}입니다(${formatValidity(fact.validFrom, fact.validTo)}).`,
          }),
        );
        break;
      }
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
      case 'enrollment': {
        // 모집 현황 사실에 없는 항목(정원 등)을 물었고 그 말이 자료의 표 머리글·절 제목으로 따로 있으면
        // 모집 현황 대신 그 문서 근거로 답한다.
        const generic = topic.genericTerms ?? [];
        const asked = topic.terms.filter(
          (term) =>
            !generic.includes(term) &&
            ctx.frame.compact.includes(compactText(term)),
        );
        const vocabulary = `${topic.label} 모집 마감 대기 접수 잔여 석 자리`;
        const outside = asked.filter((term) => !sharesBigram(term, vocabulary));
        if (asked.length > 0 && outside.length === asked.length) {
          let labelled = false;
          for (const term of outside)
            if (await definedAsLabel(ctx, term)) labelled = true;
          if (labelled) {
            parts.push(emptyPart('missing', [topic.label]));
            break;
          }
        }
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
      }
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
      previousFrame: {
        domain: 'info',
        units: [],
        periods: [],
        topicIds: selectedTopics.map((topic) => topic.id),
        classIds: explicitClassIds(ctx),
      },
    },
  };
}
