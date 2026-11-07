import { isAssistantDirective } from '../ingest/validation.ts';
import type { RagChunk } from '../types.ts';
import { gradeBand } from '../query/grade-band.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import {
  formatKstDate,
  isValidAt,
  kstStartOfDay,
  toKstDate,
} from '../text/time.ts';
import {
  abstain,
  className,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type CitationRequest,
  type EvidenceExcerpt,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';
import { tableDateAt } from './table-dates.ts';
import { extractNumbers, supportsExcerpt } from './verify.ts';

const events = /골든벨|독서\s*대회|독서\s*행사/;
const closureEvent = (text: string) =>
  compactText(text)
    .replace(/크리스마스/g, '성탄절')
    .replace(/대학수학능력시험/g, '수능');

function closureRowFor(
  ctx: AnswerContext,
  chunk: RagChunk,
  sourceId: string,
  classId: string,
) {
  if (
    chunk.sourceId !== sourceId ||
    (chunk.classId !== null && chunk.classId !== classId) ||
    !isCleanPublicEvidence(chunk, ctx.asOf)
  )
    return;
  const row = readEvidenceRow(chunk);
  if (!row) return;
  let key = row.column(/^(?:강좌|과정|반|반명|대상반)$/);
  const cancelled = row.column(/^(?:휴강|휴강일|휴강일시)$/);
  if (key < 0 && cancelled >= 0 && chunk.extraction?.method === 'ocr') {
    const missing = chunk.location.header?.flatMap((label, index) =>
      label.trim() ? [] : [index],
    );
    if (missing?.length === 1) key = missing[0];
  }
  if (key < 0) return;
  const name = compactText(row.cells[key] ?? '');
  const matches = ctx.catalog.classes.filter((entry) =>
    [entry.name, ...entry.aliases].some((label) => compactText(label) === name),
  );
  if (matches.length !== 1 || matches[0].classId !== classId) return;
  return { row, key, cancelled };
}

async function findMakeupRows(
  ctx: AnswerContext,
  classId: string,
): Promise<RagChunk[]> {
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return [];
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: klass.name + ' 휴강 보강',
    documentTypes: ['announcement', 'schedule'],
    limit: 55,
  });
  const chunks = found.map(({ chunk }) => chunk);
  recordChunks(ctx.trace, chunks);
  return chunks;
}

function pairedMakeupRow(
  ctx: AnswerContext,
  chunks: readonly RagChunk[],
  sourceId: string,
  classId: string,
  closureDay: number,
  makeupDay: number,
  time: string,
  scope?: { holiday: string; lesson: RegExp | undefined },
): EvidenceExcerpt | undefined {
  const at = (text: string, year: number) => {
    const date = eventDate.exec(text)?.[0];
    return date ? tableDateAt(date, year) : undefined;
  };
  const matches = chunks.flatMap((chunk) => {
    const closure = closureRowFor(ctx, chunk, sourceId, classId);
    if (!closure) return [];
    const { row, key } = closure;
    const cancelled =
      scope && closure.cancelled < 0
        ? row.column(/^(?:휴강수업|기존수업|휴강강좌)$/)
        : closure.cancelled;
    const makeup = row.column(/^(?:보강|보강일|보강일시|보강일정)$/);
    const replaced = row.cells[cancelled] ?? '';
    const scheduled = row.cells[makeup] ?? '';
    const statedDate = at(replaced, toKstDate(closureDay).year);
    const heading = closureEvent(chunk.location.section ?? '');
    const eventRow =
      scope &&
      statedDate === undefined &&
      heading.includes(scope.holiday) &&
      /휴강|휴원/.test(heading) &&
      /보강|대체/.test(heading);
    if (
      (statedDate !== closureDay && !eventRow) ||
      (scope?.lesson &&
        (!scope.lesson.test(replaced) || !scope.lesson.test(scheduled))) ||
      at(scheduled, toKstDate(makeupDay).year) !== makeupDay ||
      !compactText(scheduled).includes(compactText(time))
    )
      return [];
    const excerpt = row.project(key, cancelled, makeup);
    return excerpt ? [excerpt] : [];
  });
  return new Set(matches.map(({ line }) => compactText(line))).size === 1
    ? matches[0]
    : undefined;
}

async function answerClosurePeriodMakeup(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = closureEvent(frame.normalized);
  const named = /연말연시|연말|연초|설날|추석/.exec(q)?.[0];
  const periodName = /언제부터.{0,18}언제까지|휴원기간/.test(q)
    ? named
    : undefined;
  const anchoredDates =
    frame.explicitDates.length === 2 &&
    frame.explicitDates.every(
      ({ operator, month }) => operator === 'at' && month !== 0,
    ) &&
    /휴원|휴강/.test(q) &&
    /(?:휴원|휴강).{0,40}\d{1,2}월\d{1,2}일.{0,15}(?:수업|휴강분).{0,6}보강/.test(
      q,
    );
  if (
    !/보강.{0,10}(?:언제|몇시|일정)/.test(q) ||
    (!periodName && !anchoredDates) ||
    /재보강|또보강|못가|환불|수강료/.test(q) ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.unboundProgram ||
    frame.unknownPrograms.length
  )
    return;

  const classIds = explicitClassIds(ctx);
  const [classId] = classIds.length === 1 ? classIds : [];
  const { year } = toKstDate(ctx.asOf);
  const today = kstStartOfDay(toKstDate(ctx.asOf));
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['schedule_change'],
  });
  recordFacts(ctx.trace, facts);
  const changes = facts.flatMap((fact) => {
    if (
      fact.value.kind !== 'schedule_change' ||
      (fact.subjectType !== 'academy' &&
        (fact.subjectType !== 'class' || fact.subjectId !== classId)) ||
      isAssistantDirective(fact.value.text)
    )
      return [];
    const at = tableDateAt(fact.value.date, year);
    return at === undefined ? [] : [{ fact, value: fact.value, at }];
  });
  const dateMatches = (
    at: number,
    date: (typeof frame.explicitDates)[number],
  ) => {
    const actual = toKstDate(at);
    return (
      actual.month === date.month &&
      actual.day === date.day &&
      (Number.isNaN(date.year) || actual.year === date.year)
    );
  };
  const groups = new Map<string, typeof changes>();
  for (const change of changes) {
    if (
      change.value.changeType !== 'cancel' ||
      (periodName
        ? change.fact.subjectType !== 'academy' ||
          !closureEvent(change.value.text).includes(periodName)
        : !frame.explicitDates.some((date) => dateMatches(change.at, date)))
    )
      continue;
    const list = groups.get(change.fact.sourceId) ?? [];
    list.push(change);
    groups.set(change.fact.sourceId, list);
  }
  const periods = [...groups].flatMap(([sourceId, members]) => {
    const days = [...new Set(members.map(({ at }) => at))].sort(
      (a, b) => a - b,
    );
    const start = days[0];
    const end = days.at(-1);
    const requestedYear = /(?<!\d)(20\d{2})년/.exec(q)?.[1];
    if (
      end === undefined ||
      (periodName &&
        (end < today ||
          (requestedYear &&
            toKstDate(start).year !== Number(requestedYear)))) ||
      days.length < 2 ||
      days.some(
        (day, index) => index > 0 && day - days[index - 1] !== 86_400_000,
      )
    )
      return [];
    const targetDays = anchoredDates
      ? days.filter((day) => dateMatches(day, frame.explicitDates[1]))
      : days;
    if (anchoredDates && (targetDays.length !== 1 || days.length !== 2))
      return [];
    return [{ sourceId, members, days, start, end, targetDays }];
  });
  const missing = (fields: string[]) =>
    abstain(
      '문의하신 휴원일과 연결된 확정 보강 일정을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      fields,
    );
  if (!periods.length) return missing(['확정 휴원 및 보강 일정']);
  if (new Set(periods.map(({ days }) => days.join(','))).size !== 1)
    return abstain(
      '같은 휴원 기간의 승인 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );

  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [ctx.question, '학원 휴원 기간 시작 종료'].join(' '),
    documentTypes: ['announcement', 'schedule'],
    limit: 55,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const range = new RegExp(
    '(' +
      eventDate.source +
      ')\\s*(?:[~–—〜]|부터)\\s*(' +
      eventDate.source +
      ')',
  );
  const confirmed = periods.flatMap((period) => {
    const witnesses = found.flatMap(({ chunk }) => {
      if (
        chunk.sourceId !== period.sourceId ||
        !isCleanPublicEvidence(chunk, ctx.asOf)
      )
        return [];
      return splitSentences(chunk.text).flatMap((line) => {
        const dates = range.exec(line);
        const excerpt = { chunk, line };
        return dates &&
          /휴원|휴강/.test(line) &&
          (!periodName || closureEvent(line).includes(periodName)) &&
          tableDateAt(dates[1], toKstDate(period.start).year) ===
            period.start &&
          tableDateAt(dates[2], toKstDate(period.end).year) === period.end &&
          supportsExcerpt(excerpt)
          ? [excerpt]
          : [];
      });
    });
    return witnesses.length ? [{ ...period, witness: witnesses[0] }] : [];
  });
  if (!confirmed.length) return missing(['확정 휴원 및 보강 일정']);

  const rows = classId ? await findMakeupRows(ctx, classId) : [];
  const possible = classId
    ? confirmed.flatMap((period) =>
        changes.flatMap(({ fact, value, at }) => {
          if (
            fact.subjectType !== 'class' ||
            value.changeType !== 'makeup' ||
            fact.sourceId !== period.sourceId ||
            at <= period.end
          )
            return [];
          const time = makeupTime(value.text, value.time);
          if (!time) return [];
          const paired = period.targetDays
            .map((day) =>
              pairedMakeupRow(ctx, rows, fact.sourceId, classId, day, at, time),
            )
            .find((row) => row !== undefined);
          return paired ? [{ fact, at, time, paired, period }] : [];
        }),
      )
    : [];
  if (new Set(possible.map(({ at, time }) => at + '|' + time)).size > 1)
    return abstain(
      '같은 휴강의 승인 보강 일정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const makeup = possible[0];
  if (!makeup && !periodName) return missing(['확정 보강 일정']);

  const period = makeup?.period ?? confirmed[0];
  const closureFacts = period.members.map(({ fact }) => fact);
  const closureText = periodName
    ? formatKstDate(period.start) +
      ' ~ ' +
      formatKstDate(period.end) +
      ' 학원 휴원'
    : undefined;
  ctx.trace.intent = 'closure_period_makeup';
  return {
    status: makeup ? 'answered' : 'partial',
    reasonCode: makeup ? undefined : 'PARTIAL_EVIDENCE',
    missingFields: makeup ? undefined : ['확정 보강 일정'],
    text: [
      closureText,
      makeup
        ? className(ctx.catalog, classId) +
          ' 보강 ' +
          formatKstDate(makeup.at) +
          ' ' +
          makeup.time
        : '해당 휴원에 연결된 보강 일정은 승인 자료에서 확인되지 않습니다.',
    ]
      .filter(Boolean)
      .join('\n'),
    citations: [
      ...closureFacts.map((fact) => ({ kind: 'fact' as const, fact })),
      { kind: 'chunk', chunk: period.witness.chunk },
      ...(makeup
        ? [
            { kind: 'fact' as const, fact: makeup.fact },
            {
              kind: 'chunk' as const,
              chunk: makeup.paired.chunk,
              tableColumns: makeup.paired.tableColumns,
            },
          ]
        : []),
    ],
    excerpts: [period.witness, ...(makeup ? [makeup.paired] : [])],
    usedFacts: makeup ? [...closureFacts, makeup.fact] : closureFacts,
    instants: [...period.days, ...(makeup ? [makeup.at] : [])],
  };
}

function makeupTime(text: string, time: string | null): string | undefined {
  const ranges = [
    ...text.matchAll(
      /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d\s*[~–-]\s*(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/g,
    ),
  ];
  return time ?? (ranges.length === 1 ? ranges[0][0] : undefined);
}

/** A missed replacement is governed by the same incident notice, not the ordinary absence policy. */
async function answerMissedIncidentMakeup(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = compactText(frame.normalized);
  const cause = /공사|정전|시설점검/.exec(q)?.[0];
  if (
    !cause ||
    !/보강(?:날짜|날|일|수업|일정).{0,35}(?:못가|못오|불참|결석|참석하지못|참여하지못)/.test(
      q,
    ) ||
    /비용|환불|취소해|대신등록|다른학원/.test(q) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.relativeDay !== null ||
    frame.unboundProgram ||
    frame.unknownPrograms.length
  )
    return;
  const ids = explicitClassIds(ctx);
  const missing = () =>
    abstain(
      '해당 휴강 공지에서 보강 불참 시의 확정 대체 일정을 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['보강 불참 시 대체 일정'],
    );
  if (ids.length !== 1) return missing();
  const [classId] = ids;
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  const school = /^(초|중|고)/.exec(klass?.grade ?? '')?.[1];
  const year = toKstDate(ctx.asOf).year;
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['schedule_change'],
  });
  recordFacts(ctx.trace, facts);
  const cancellations = facts.flatMap((fact) => {
    if (
      fact.subjectType !== 'class' ||
      fact.subjectId !== classId ||
      fact.value.kind !== 'schedule_change' ||
      fact.value.changeType !== 'cancel' ||
      !compactText(fact.value.text).includes(cause) ||
      isAssistantDirective(fact.value.text)
    )
      return [];
    const day = tableDateAt(fact.value.date, year);
    return day === undefined ? [] : [{ day, sourceId: fact.sourceId }];
  });
  const makeupDays = new Map<string, number>();
  for (const fact of facts) {
    if (
      fact.subjectType !== 'class' ||
      fact.subjectId !== classId ||
      fact.value.kind !== 'schedule_change' ||
      fact.value.changeType !== 'makeup' ||
      isAssistantDirective(fact.value.text)
    )
      continue;
    const at = tableDateAt(fact.value.date, year);
    if (
      at !== undefined &&
      cancellations.some(
        ({ sourceId, day }) => sourceId === fact.sourceId && at > day,
      )
    )
      makeupDays.set(
        fact.sourceId,
        Math.max(makeupDays.get(fact.sourceId) ?? 0, at),
      );
  }
  if (!makeupDays.size) return missing();
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      cause,
      klass?.name,
      '보강 날짜 참석하지 못하는 개별 보강 시간',
    ].join(' '),
    documentTypes: ['announcement'],
    limit: 48,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const matches = hits.flatMap(({ chunk }) => {
    const prior = makeupDays.get(chunk.sourceId);
    if (
      prior === undefined ||
      chunk.visibility !== 'academy_public' ||
      chunk.location.kind !== 'paragraph' ||
      (chunk.classId && chunk.classId !== classId) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
    )
      return [];
    const uncertain = new Set(
      extractNumbers(chunk.extraction?.uncertainTokens.join(' ') ?? ''),
    );
    const lines = chunk.text.split(/(?:^|\s)[*•]\s+/).flatMap(splitSentences);
    return lines.flatMap((line) => {
      const text = compactText(line);
      if (
        !/보강(?:날짜|날|일|수업|일정)에.{0,20}(?:참석|참여)하지못/.test(
          text,
        ) ||
        !/개별보강(?:합니다|진행|을제공)/.test(text) ||
        /미정|예정|검토|별도문의|취소|확인중/.test(text) ||
        extractNumbers(line).some((number) => uncertain.has(number))
      )
        return [];
      const level = /([초중고])등/.exec(text)?.[1];
      if (level && school !== level) return [];
      const date = eventDate.exec(text)?.[0];
      const at = date && tableDateAt(date, toKstDate(prior).year);
      const time = makeupTime(text, null);
      const excerpt = { chunk, line };
      return typeof at === 'number' &&
        at > prior &&
        at >= kstStartOfDay(toKstDate(ctx.asOf)) &&
        time &&
        supportsExcerpt(excerpt)
        ? [{ at, time, excerpt }]
        : [];
    });
  });
  if (!matches.length) return missing();
  if (new Set(matches.map(({ at, time }) => at + '|' + time)).size > 1)
    return abstain(
      '보강 불참 시의 승인 대체 일정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = matches;
  ctx.trace.intent = 'missed_incident_makeup';
  return {
    ...fromPublicExcerpts([selected.excerpt]),
    text:
      '해당 보강에 참석하지 못하는 원생은 ' +
      formatKstDate(selected.at) +
      ' ' +
      selected.time +
      '에 개별 보강한다고 공지되어 있습니다.',
    instants: [selected.at],
  };
}

export async function answerClosureMakeup(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const missed = await answerMissedIncidentMakeup(ctx);
  if (missed) return missed;
  const period = await answerClosurePeriodMakeup(ctx);
  if (period) return period;
  const { frame } = ctx;
  const q = closureEvent(frame.normalized);
  const asksRepeat =
    /또보강|재보강|보강날.{0,12}못가|보강일.{0,12}못가|보강.{0,12}결석/.test(q);
  const holiday = /성탄절|수능(?:날|일)|신정|설날|추석|어린이날|광복절|한글날/
    .exec(q)?.[0]
    ?.replace(/^수능(?:날|일)$/, '수능');
  const asksReplacementTime =
    Boolean(holiday) &&
    /(?:언제|몇시)(?:에)?다시(?:해|하|수업|듣|열|진행)|대체수업.{0,8}(?:언제|몇시)/.test(
      q,
    );
  const wantsNative = /원어민|스피킹/.test(q);
  const wantsRegular = /정규(?:수업|강좌)/.test(q);
  const lesson = wantsNative
    ? /원어민|스피킹/
    : wantsRegular
      ? /정규/
      : undefined;
  if (
    (!/보강/.test(q) && !asksReplacementTime) ||
    (!holiday && frame.explicitDates.length !== 1) ||
    !/휴강|휴원|쉬|수업|없으면/.test(q) ||
    (asksReplacementTime &&
      frame.topics.some(
        ({ id }) =>
          ![
            'schedule',
            'schedule_change',
            'makeup',
            'native',
            'attendance',
            'hours',
          ].includes(id),
      )) ||
    /몇회|환불|취소해/.test(q) ||
    (/못가/.test(q) && !asksRepeat) ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.explicitDates.some(({ operator }) => operator !== 'at')
  )
    return;
  const classIds = explicitClassIds(ctx);
  if (classIds.length > 1 || frame.unresolvedRelationWords.length) return;
  const [classId] = classIds;
  const missingReplacement = () =>
    abstain(
      '해당 휴강에 연결된 반별 보강 일정을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['확정된 보강 일정'],
    );
  if (
    asksReplacementTime &&
    (!classId || frame.unboundProgram || (wantsNative && wantsRegular))
  )
    return missingReplacement();
  const { explicitDay } = resolveEffectiveTime(frame, ctx.asOf);
  const today = kstStartOfDay(toKstDate(ctx.asOf));
  const matchesDate = (date: string) => {
    const at = tableDateAt(date, toKstDate(ctx.asOf).year);
    return (
      at !== undefined &&
      at >= today &&
      (explicitDay === null || at === explicitDay)
    );
  };
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['schedule_change'],
  });
  recordFacts(ctx.trace, facts);
  const changes = facts.flatMap((fact) =>
    fact.value.kind === 'schedule_change' &&
    !isAssistantDirective(fact.value.text) &&
    (fact.subjectType === 'academy' ||
      (fact.subjectType === 'class' && fact.subjectId === classId))
      ? [{ fact, change: fact.value }]
      : [],
  );
  const cancels = changes.filter(
    ({ change }) =>
      change.changeType === 'cancel' &&
      matchesDate(change.date) &&
      ((!asksReplacementTime && explicitDay !== null) ||
        (holiday && closureEvent(change.text).includes(holiday))),
  );
  if (!cancels.length)
    return asksReplacementTime ? missingReplacement() : undefined;
  if (new Set(cancels.map(({ change }) => change.date)).size !== 1)
    return abstain(
      '같은 휴원일의 승인 일정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const cancellation =
    cancels.find(({ fact }) => fact.subjectType === 'class') ?? cancels[0];
  const start = tableDateAt(cancellation.change.date, toKstDate(ctx.asOf).year);
  if (start === undefined) return;
  const sameNotice = changes.filter(
    ({ fact }) => fact.sourceId === cancellation.fact.sourceId,
  );
  const possibleMakeups = sameNotice.flatMap(({ fact, change }) => {
    const at = tableDateAt(change.date, toKstDate(ctx.asOf).year);
    if (
      !classId ||
      fact.subjectType !== 'class' ||
      change.changeType !== 'makeup' ||
      (asksReplacementTime && lesson && !lesson.test(change.text)) ||
      at === undefined ||
      at <= start ||
      (!asksReplacementTime &&
        (at - start > 7 * 86_400_000 ||
          sameNotice.some(
            ({ change: other }) =>
              other.changeType === 'cancel' &&
              other.date > cancellation.change.date &&
              other.date <= change.date,
          )))
    )
      return [];
    const time = makeupTime(change.text, change.time);
    return time ? [{ fact, change, at, time }] : [];
  });
  const rows = possibleMakeups.length ? await findMakeupRows(ctx, classId) : [];
  const pairedRows = new Map<string, EvidenceExcerpt>();
  const makeups =
    asksReplacementTime && holiday
      ? possibleMakeups.filter((makeup) => {
          const row = pairedMakeupRow(
            ctx,
            rows,
            makeup.fact.sourceId,
            classId,
            start,
            makeup.at,
            makeup.time,
            { holiday, lesson },
          );
          if (!row) return false;
          pairedRows.set(makeup.fact.factId, row);
          return true;
        })
      : possibleMakeups;
  if (asksReplacementTime && !makeups.length) return missingReplacement();
  if (
    new Set(makeups.map(({ change, time }) => change.date + '|' + time)).size >
    1
  )
    return abstain(
      '같은 반의 승인 보강 일정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const lines = [formatKstDate(start) + ' ' + cancellation.change.text];
  const makeup = makeups[0];
  if (makeup) {
    const makeupDay = makeup.at;
    const paired =
      pairedRows.get(makeup.fact.factId) ??
      pairedMakeupRow(
        ctx,
        rows,
        makeup.fact.sourceId,
        classId,
        start,
        makeupDay,
        makeup.time,
      );
    lines.push(
      className(ctx.catalog, classId) +
        (asksReplacementTime && lesson
          ? wantsNative
            ? ' 원어민 수업 보강 '
            : ' 정규 수업 보강 '
          : ' 보강 ') +
        formatKstDate(makeupDay) +
        ' ' +
        makeup.time,
    );
    const repeatRules = asksRepeat
      ? await ctx.documents.searchApprovedChunks({
          access: ctx.access,
          studentIds: [],
          asOf: ctx.asOf,
          documentTypes: ['announcement', 'policy'],
          query: '보강일 결석 재보강 추가 보강',
          limit: 45,
        })
      : [];
    recordChunks(
      ctx.trace,
      repeatRules.map(({ chunk }) => chunk),
    );
    const options = repeatRules.flatMap(({ chunk }) => {
      if (
        chunk.sourceId !== makeup.fact.sourceId ||
        chunk.location.kind !== 'paragraph' ||
        !isCleanPublicEvidence(chunk, ctx.asOf)
      )
        return [];
      return splitSentences(chunk.text)
        .filter(
          (line) =>
            /보강(?:일|수업)?(?:에|을|에\s*도)?.{0,15}(?:결석|참석하지|참여하지|못\s*오)/.test(
              line,
            ) && /재보강|추가\s*보강|다시\s*보강/.test(line),
        )
        .map((line) => ({ chunk, line }));
    });
    const repeat =
      new Set(options.map(({ line }) => compactText(line))).size === 1
        ? options[0]
        : undefined;
    const missing = asksRepeat && !repeat;
    if (repeat) lines.push(repeat.line);
    if (missing)
      lines.push(
        '해당 보강에 참석하지 못한 경우의 재보강 여부는 승인 자료에서 확인되지 않습니다.',
      );
    ctx.trace.intent = 'closure_makeup';
    return {
      status: missing ? 'partial' : 'answered',
      reasonCode: missing ? 'PARTIAL_EVIDENCE' : undefined,
      missingFields: missing ? ['재보강 여부'] : undefined,
      text: lines.join('\n'),
      citations: [
        { kind: 'fact', fact: cancellation.fact },
        { kind: 'fact', fact: makeup.fact },
        ...(paired
          ? [
              {
                kind: 'chunk' as const,
                chunk: paired.chunk,
                tableColumns: paired.tableColumns,
              },
            ]
          : []),
        ...(repeat ? [{ kind: 'chunk' as const, chunk: repeat.chunk }] : []),
      ],
      excerpts: [...(paired ? [paired] : []), ...(repeat ? [repeat] : [])],
      usedFacts: [cancellation.fact, makeup.fact],
    };
  }
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['announcement', 'policy'],
    query: ctx.question + ' 휴원일 수업 보강하지',
    limit: 50,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const noMakeupRows =
    classId && !asksRepeat
      ? hits.flatMap(({ chunk }) => {
          const closure = closureRowFor(
            ctx,
            chunk,
            cancellation.fact.sourceId,
            classId,
          );
          if (!closure) return [];
          const { row, key, cancelled } = closure;
          if (
            tableDateAt(row.cells[cancelled] ?? '', toKstDate(start).year) !==
            start
          )
            return [];
          const column = row.column(/^(?:처리방법|보강|보강여부|보강안내)$/);
          const outcome = row.cells[column];
          const excerpt = outcome && row.project(key, cancelled, column);
          return excerpt ? [{ outcome: compactText(outcome), excerpt }] : [];
        })
      : [];
  const outcomes = new Set(noMakeupRows.map(({ outcome }) => outcome));
  if (outcomes.size > 1)
    return abstain(
      '같은 반의 휴강 처리 내용이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const matchingRow = noMakeupRows[0];
  const noMakeupOutcome = matchingRow?.outcome.match(
    /^보강(?:없음(?:[.!]|$)|하지않(?:습니다|음)(?:[.!]|$)|없이)(.*)$/,
  );
  const noMakeupRow =
    noMakeupOutcome &&
    !/보강|대체수업|경우|검토|가능|아니|아님/.test(noMakeupOutcome[1])
      ? matchingRow.excerpt
      : undefined;
  const noMakeup: EvidenceExcerpt[] = hits.flatMap(({ chunk }) => {
    if (
      chunk.sourceId !== cancellation.fact.sourceId ||
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      chunk.location.kind !== 'paragraph'
    )
      return [];
    return splitSentences(chunk.text)
      .filter((line) =>
        /휴원일\s*수업은?\s*보강하지\s*않|(?:성탄절|수능일|신정|설날|추석)\s*(?:수업은?|휴강은?)\s*보강하지\s*않/.test(
          line,
        ),
      )
      .map((line) => ({ chunk, line }));
  });
  if (!noMakeupRow && !noMakeup.length) {
    if (!holiday || !classId || asksRepeat) return;
    ctx.trace.intent = 'closure_makeup';
    return {
      status: 'partial',
      reasonCode: 'PARTIAL_EVIDENCE',
      missingFields: ['해당 반의 보강 여부'],
      text: [
        ...lines,
        '해당 반의 보강 여부는 승인 자료에서 확인되지 않습니다.',
      ].join('\n'),
      citations: [{ kind: 'fact', fact: cancellation.fact }],
      usedFacts: [cancellation.fact],
    };
  }
  const excerpt = noMakeupRow ?? noMakeup[0];
  ctx.trace.intent = 'closure_makeup';
  return {
    status: 'answered',
    text: [...lines, excerpt.line].join('\n'),
    excerpts: [excerpt],
    citations: [
      { kind: 'fact', fact: cancellation.fact },
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
      },
    ],
    usedFacts: [cancellation.fact],
  };
}
const eventDate =
  /(?<!\d)(?:\d{4}년\s*)?\d{1,2}월\s*\d{1,2}일(?:\s*\([월화수목금토일]\))?/;

type RegistrationField = '참관 인원' | '참관 신청 마감일';

/** Capacity and deadline are separate claims within one approved event notice. */
export async function answerEventRegistration(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const event = /발표회|공개\s*수업|설명회|전시회|학예회/.exec(q)?.[0];
  const fields: RegistrationField[] = [];
  if (/몇\s*명|몇\s*가정|인원\s*제한/.test(q)) fields.push('참관 인원');
  if (/신청|접수/.test(q) && /언제\s*까지|마감|기한/.test(q))
    fields.push('참관 신청 마감일');
  if (
    !event ||
    !fields.length ||
    !/부모|보호자|참관|관람/.test(q) ||
    /작년|취소|연기|변경\s*전|비교|수강료|환불/.test(q) ||
    frame.explicitDates.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.months.length
  )
    return;
  const [facts, found] = await Promise.all([
    ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      factTypes: ['notice'],
    }),
    ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      documentTypes: ['announcement'],
      query: [event, '보호자 참관 인원 신청 마감'].join(' '),
      limit: 65,
    }),
  ]);
  recordFacts(ctx.trace, facts);
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const eventKey = compactText(event);
  const groups = new Map<
    string,
    Map<
      RegistrationField,
      Array<{
        line: string;
        key: string;
        citation: CitationRequest;
        excerpt?: EvidenceExcerpt;
      }>
    >
  >();
  const requestedUnit = /몇\s*(명|가정)/.exec(q)?.[1];
  const slotsOf = (line: string) => {
    if (!/참관|관람/.test(line)) return [];
    const slots: Array<[RegistrationField, string]> = [];
    const capacity = /(?<!\d)(\d+)\s*(명|가정)\s*까지/.exec(line);
    const deadline =
      /(?:신청|접수).{0,25}?(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일\s*(\([월화수목금토일]\))?\s*까지/.exec(
        line,
      );
    if (
      capacity &&
      (!requestedUnit || capacity[2] === requestedUnit) &&
      fields.includes('참관 인원')
    )
      slots.push(['참관 인원', compactText(capacity[0])]);
    if (
      deadline &&
      /(?:참관|관람).{0,14}(?:신청|접수)/.test(line) &&
      fields.includes('참관 신청 마감일')
    ) {
      const date = [
        deadline[1] ? deadline[1] + '년' : '',
        deadline[2] + '월',
        deadline[3] + '일',
        deadline[4] ?? '',
      ].join(' ');
      const instant = tableDateAt(date, toKstDate(ctx.asOf).year);
      if (instant !== undefined)
        slots.push(['참관 신청 마감일', String(instant)]);
    }
    return slots;
  };
  const add = (
    source: string,
    line: string,
    citation: CitationRequest,
    excerpt?: EvidenceExcerpt,
  ) => {
    const slots = slotsOf(line);
    if (!slots.length) return;
    const group = groups.get(source) ?? new Map();
    for (const [field, key] of slots)
      group.set(field, [
        ...(group.get(field) ?? []),
        { line, key, citation, excerpt },
      ]);
    groups.set(source, group);
  };
  for (const fact of facts) {
    if (
      fact.subjectType !== 'academy' ||
      fact.value.kind !== 'text' ||
      !slotsOf(fact.value.text).length ||
      isAssistantDirective(fact.value.text)
    )
      continue;
    const source = await ctx.documents.getCitableSource({
      access: ctx.access,
      studentIds: [],
      sourceId: fact.sourceId,
      asOf: ctx.asOf,
    });
    if (
      source &&
      compactText(source.title).includes(eventKey) &&
      !/게시판|문의\s*모음/.test(source.title)
    )
      add(fact.sourceId, fact.value.text, { kind: 'fact', fact });
  }
  for (const { chunk } of found) {
    if (
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      chunk.classId !== null ||
      chunk.location.kind !== 'paragraph' ||
      /게시판|문의\s*모음/.test(chunk.title) ||
      !compactText(chunk.title + ' ' + (chunk.location.section ?? '')).includes(
        eventKey,
      )
    )
      continue;
    for (const line of splitSentences(chunk.text))
      add(chunk.sourceId, line, { kind: 'chunk', chunk }, { chunk, line });
  }
  const options = [...groups.values()];
  if (!options.length)
    return abstain(
      '요청한 행사 참관 조건을 승인 공지에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (
    fields.some(
      (field) =>
        new Set(
          options.flatMap((option) =>
            (option.get(field) ?? []).map(({ key }) => key),
          ),
        ).size > 1,
    )
  )
    return abstain(
      '행사 참관에 관한 승인 공지가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [best] = options.sort((a, b) => b.size - a.size);
  const selected = [...best.values()].map(([claim]) => claim);
  const missingFields = fields.filter((field) => !best.has(field));
  ctx.trace.intent = 'event_registration_slots';
  return {
    status: missingFields.length ? 'partial' : 'answered',
    reasonCode: missingFields.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missingFields.length ? missingFields : undefined,
    text: [
      ...new Set(selected.map(({ line }) => line)),
      ...(missingFields.length
        ? ['확인되지 않은 항목 ' + missingFields.join(', ')]
        : []),
    ].join('\n'),
    citations: selected.map(({ citation }) => citation),
    excerpts: selected.flatMap(({ excerpt }) => (excerpt ? [excerpt] : [])),
    usedFacts: selected.flatMap(({ citation }) =>
      citation.kind === 'fact' ? [citation.fact] : [],
    ),
  };
}

/** Match a reading event and the chosen learner's grade against the same notice. */
export async function answerEventReading(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const event = events.exec(frame.normalized)?.[0];
  if (
    !event ||
    !/무슨\s*책|어떤\s*책|대상\s*도서|필독\s*도서|읽어야/.test(
      frame.normalized,
    ) ||
    frame.explicitDates.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.months.length ||
    /작년|지난|바뀌|변경/.test(frame.normalized)
  )
    return;
  const explicit = [
    ...frame.normalized.matchAll(/(?<![가-힣\d])([초중고][1-6])(?!\d)/g),
  ].flatMap((match) => gradeBand(match[1]));
  const bands = ctx.catalog.classes
    .filter(
      ({ classId }) =>
        ctx.studentClassIds.includes(classId) &&
        !frame.negatedClassIds.includes(classId),
    )
    .map(({ grade }) => gradeBand(grade ?? ''))
    .filter((band) => band.length > 0);
  const candidateGrades = explicit.length
    ? [...new Set(explicit)]
    : (bands[0] ?? []).filter((grade) =>
        bands.every((band) => band.includes(grade)),
      );
  const unavailable = () =>
    abstain(
      '요청한 행사와 학년에 해당하는 지정 도서를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (!candidateGrades.length || frame.matchedStudentIds.length > 1)
    return unavailable();

  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['announcement'],
    query: event + ' 지정 도서 학년별 필독 도서 행사 일정',
    limit: 45,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const today = kstStartOfDay(toKstDate(ctx.asOf));
  const candidates = found.flatMap(({ chunk }) => {
    if (
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      chunk.classId !== null ||
      chunk.location.kind !== 'paragraph' ||
      !compactText(chunk.location.section ?? chunk.title).includes(
        compactText(event),
      )
    )
      return [];
    const lines = splitSentences(chunk.text);
    const dateLine = lines.find(
      (line) =>
        compactText(line).includes(compactText(event)) &&
        eventDate.test(line) &&
        /엽니다|열립니다|진행|개최/.test(line) &&
        !/취소|연기|미정/.test(line),
    );
    const date = dateLine && eventDate.exec(dateLine)?.[0];
    const at = date && tableDateAt(date, toKstDate(ctx.asOf).year);
    if (!dateLine || !at || at < today) return [];
    const books = lines
      .filter((line) => /대상\s*도서|필독\s*도서|지정\s*도서/.test(line))
      .flatMap((line) =>
        [
          ...line.matchAll(
            /([초중고][1-6](?:[·~–-](?:[초중고])?[1-6])*)\s*[『「“"]([^』」”"\n]+)[』」”"]/g,
          ),
        ].flatMap((match) =>
          candidateGrades.every((grade) => gradeBand(match[1]).includes(grade))
            ? [{ chunk, line: match[0], book: match[2] }]
            : [],
        ),
      );
    return books.map(({ book, line }) => ({
      key: at + '|' + compactText(book),
      excerpts: [
        ...(/언제|며칠|몇\s*일/.test(frame.normalized)
          ? [{ chunk, line: dateLine }]
          : []),
        { chunk, line },
      ],
    }));
  });
  if (!candidates.length) return unavailable();
  if (new Set(candidates.map(({ key }) => key)).size > 1)
    return abstain(
      '해당 행사와 학년의 승인 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'event_reading';
  return fromPublicExcerpts(candidates[0].excerpts);
}
