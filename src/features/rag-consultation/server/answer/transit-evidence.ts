import { isAssistantDirective } from '../ingest/validation.ts';
import {
  compactText,
  normalizeText,
  splitSentences,
} from '../text/normalize.ts';
import { gradeBand } from '../query/grade-band.ts';
import {
  isValidAt,
  kstStartOfDay,
  toIsoDate,
  toKstDate,
} from '../text/time.ts';
import type { ApprovedFact, RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { dayWordCovers, explicitClassIds } from './info.ts';
import {
  tableDateAt,
  tablePeriodContains,
  weekdayAt,
  weekdayInNamedWeek,
} from './table-dates.ts';
import { supportsExcerpt } from './verify.ts';

const isTrusted = (chunk: RagChunk) =>
  chunk.visibility === 'academy_public' &&
  !chunk.suspicious &&
  !isAssistantDirective(chunk.text) &&
  !chunk.extraction?.needsReview &&
  !chunk.extraction?.uncertainTokens.length;

const clock = /\b\d{1,2}:\d{2}\b/;
const timeCell = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;

function transitRow(chunk: RagChunk, at: number) {
  const { header, cells, kind } = chunk.location;
  if (
    !isTrusted(chunk) ||
    !isValidAt(chunk.validFrom, chunk.validTo, at) ||
    kind !== 'table_row' ||
    !header ||
    !cells ||
    header.length !== cells.length
  )
    return;
  const labels = header.map(compactText);
  const column = (name: RegExp) =>
    labels.findIndex((label) => name.test(label));
  const value = (name: RegExp) => cells[column(name)] ?? '';
  const project = (tableColumns: number[], leading = false) => {
    if (tableColumns.some((index) => index < 0)) return;
    const line = [...new Set(leading ? [0, ...tableColumns] : tableColumns)]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt) ? excerpt : undefined;
  };
  return { column, value, project };
}

const VEHICLE = /^(?:차량|차량번호|호차)$/;
const TRIP = /^(?:구분|운행구분|회차)$/;
const STOP = /^(?:정류장|정류장명|승하차장소)$/;
const TIME = /^(?:시각|시간|도착시각|도착시간)$/;
const SCHOOL = /^(?:학교|학교명)$/;
const GRADE = /^(?:학년|대상학년)$/;
const DAYS = /^(?:요일|운행요일|적용요일)$/;
const PICKUP = /^(?:픽업|픽업회차|픽업차량·회차|차량·회차|등원차량·회차)$/;
const DISMISSAL = /^(?:하교시각|하교시간)$/;
const SCHOOL_NAME = /(?<![가-힣])([가-힣]{2,}초)(?:등학교)?(?=\s|$)/;
const GATE = /(?:정문|후문|동문|서문|남문|북문)/;

function gradeApplies(text: string, grade: number): boolean {
  const value = compactText(text).replace(/학년/g, '');
  const range = /^([1-6])[~–-]([1-6])$/.exec(value);
  if (range) return grade >= Number(range[1]) && grade <= Number(range[2]);
  return (
    /^[1-6](?:[·,/][1-6])*$/.test(value) &&
    value.split(/[·,/]/).includes(String(grade))
  );
}

async function answerSchoolPickup(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { explicitDates, relativeDay, relativeWeek } = ctx.frame;
  // General query normalization abbreviates "초 3학년" and can merge it into a school name.
  const normalized = ctx.question.normalize('NFKC');
  const school = SCHOOL_NAME.exec(normalized)?.[1];
  const grades = [...normalized.matchAll(/(?<!\d)([1-6])\s*학년/g)];
  const weekdays = [
    ...new Set(
      [...normalized.matchAll(/([월화수목금토일])요일/g)].map((m) => m[1]),
    ),
  ];
  if (
    !school ||
    grades.length !== 1 ||
    weekdays.length > 1 ||
    explicitDates.length ||
    relativeDay !== null ||
    relativeWeek !== null ||
    !/픽업|데리러|통학차/.test(normalized) ||
    !/몇\s*시|몇\s*호차|하교\s*시각/.test(normalized) ||
    ctx.frame.months.length ||
    ctx.frame.relativePeriod !== null ||
    /변경|바뀌|공사|방학|휴일|휴강|하원|대신|비교|각각|[·,]\s*[1-6]\s*학년|\d+\s*호차|(?:학교|초)(?:랑|와|하고)\s/.test(
      normalized,
    )
  )
    return;

  const [weekday] = weekdays;
  const grade = Number(grades[0][1]);
  const dismissal = /몇\s*시(?:에|쯤)?\s*하교|하교\s*시각/;
  const asksDismissal = dismissal.test(normalized);
  const asksPickupTime =
    /픽업.{0,30}몇\s*시|몇\s*시.{0,12}(?:와|오|도착|데리러)|정류장.{0,12}몇\s*시/.test(
      normalized.replace(dismissal, ''),
    );
  const gate = GATE.exec(normalized)?.[0];
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      school,
      school + '등학교',
      '하교 학년 픽업 회차 정류장 등원 차량 시각',
    ].join(' '),
    documentTypes: ['schedule', 'facility'],
    limit: 140,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const rows = found.flatMap(({ chunk }) => {
    const row =
      chunk.classId === null ? transitRow(chunk, ctx.asOf) : undefined;
    return row ? [{ chunk, row }] : [];
  });
  const byDay = new Map<
    string,
    Map<string, { assignment: EvidenceExcerpt; stop?: EvidenceExcerpt }>
  >();
  for (const { chunk, row } of rows) {
    const assignmentFields = [
      SCHOOL,
      DAYS,
      GRADE,
      ...(asksDismissal ? [DISMISSAL] : []),
      PICKUP,
    ];
    const assignment = row.project(assignmentFields.map(row.column));
    if (
      !assignment ||
      compactText(row.value(SCHOOL)).replace(/초등학교$/, '초') !== school ||
      !gradeApplies(row.value(GRADE), grade) ||
      (asksDismissal && !timeCell.test(row.value(DISMISSAL)))
    )
      continue;
    const trip = /^(\d+호차)(등원\d+회차)$/.exec(
      compactText(row.value(PICKUP)),
    );
    if (!trip) continue;
    const days = (weekday ?? '월화수목금토일')
      .split('')
      .filter((day) => dayWordCovers(row.value(DAYS), day));
    if (!days.length) continue;
    const stops = asksPickupTime
      ? rows.flatMap(({ chunk: stopChunk, row: stopRow }) => {
          const stop = compactText(stopRow.value(STOP)).replace(
            /초등학교(?=정문|후문|동문|서문|남문|북문|앞|$)/,
            '초',
          );
          if (
            stopChunk.sourceId !== chunk.sourceId ||
            compactText(stopRow.value(VEHICLE)) !== trip[1] ||
            compactText(stopRow.value(TRIP)) !== trip[2] ||
            !(gate
              ? stop === school + gate
              : [
                  school,
                  ...['정문', '후문', '동문', '서문', '남문', '북문', '앞'].map(
                    (name) => school + name,
                  ),
                ].includes(stop)) ||
            !timeCell.test(stopRow.value(TIME)) ||
            (stopRow.column(DAYS) >= 0 &&
              !days.every((day) => dayWordCovers(stopRow.value(DAYS), day))) ||
            /제외|미정차|정차하지|정차\s*안|변경|운행\s*없|만\s*정차/.test(
              stopRow.value(/^(?:비고|특이사항)$/),
            )
          )
            return [];
          const stopFields = [
            VEHICLE,
            TRIP,
            STOP,
            TIME,
            ...(stopRow.column(DAYS) >= 0 ? [DAYS] : []),
          ];
          const excerpt = stopRow.project(stopFields.map(stopRow.column));
          return excerpt ? [excerpt] : [];
        })
      : [];
    const uniqueStops = new Map(
      stops.map((stop) => [compactText(stop.line), stop]),
    );
    if (uniqueStops.size > 1)
      return abstain(
        '같은 학교 등원 회차의 정류장 또는 시각이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    const stop = [...uniqueStops.values()][0];
    const signature = [
      asksDismissal ? row.value(DISMISSAL) : '',
      trip[0],
      stop?.line,
    ].join('|');
    for (const day of days) {
      const choices = byDay.get(day) ?? new Map();
      choices.set(signature, { assignment, stop });
      byDay.set(day, choices);
    }
  }
  if (!byDay.size)
    return abstain(
      '요청하신 학교·학년의 등원 차량을 승인 운행표에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if ([...byDay.values()].some((choices) => choices.size !== 1))
    return abstain(
      '같은 학교·학년과 요일의 승인 운행표가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );

  const matches = [...byDay.values()].flatMap((choices) => [
    ...choices.values(),
  ]);
  const excerpts = [
    ...new Set(
      matches.flatMap(({ assignment, stop }) =>
        stop ? [assignment, stop] : [assignment],
      ),
    ),
  ];
  const missing = asksPickupTime && matches.some(({ stop }) => !stop);
  ctx.trace.intent = 'school_pickup';
  return {
    status: missing ? 'partial' : 'answered',
    reasonCode: missing ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing ? ['정류장 도착 시각'] : undefined,
    text: [
      ...excerpts.map(({ line }) => line),
      ...(missing ? ['확인되지 않은 항목: 일부 회차의 정류장 도착 시각'] : []),
    ].join('\n'),
    excerpts,
    citations: excerpts.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    usedFacts: [],
  };
}

function fromExcerpt(excerpt: EvidenceExcerpt, at: number): AnswerDraft {
  return {
    status: 'answered',
    text: excerpt.line,
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
        effectiveAt: at,
      },
    ],
    excerpts: [excerpt],
    usedFacts: [],
  };
}

const changeWords = /바뀌|바뀐|변경|공사\s*기간|없어졌|없어진|대체|임시/;
const routeVehicle = /(?<!\d)(\d+)\s*호차/g;
const departureStop = /^학원출발$/;
const routeException =
  /제외|미정차|정차하지|정차\s*안|변경|운행\s*없|운휴|만\s*정차/;

const transitUnavailable = () =>
  abstain(
    '요청하신 조건의 차량 운행을 승인 자료에서 확인할 수 없습니다.',
    'INSUFFICIENT_EVIDENCE',
  );

async function approvedRouteNotices(
  ctx: AnswerContext,
  vehicle: string,
  at: number,
) {
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: ['notice'],
    asOf: ctx.asOf,
    effectiveAt: at,
  });
  recordFacts(ctx.trace, facts);
  return (
    await Promise.all(
      facts.flatMap((fact) => {
        if (
          fact.subjectType !== 'academy' ||
          fact.value.kind !== 'text' ||
          isAssistantDirective(fact.value.text)
        )
          return [];
        const body = fact.value.text;
        return [
          ctx.documents
            .getCitableSource({
              access: ctx.access,
              studentIds: [],
              sourceId: fact.sourceId,
              asOf: ctx.asOf,
              effectiveAt: at,
            })
            .then((source) => {
              const title = source?.title ?? '';
              const vehicles = new Set(
                [...(title + ' ' + body).matchAll(routeVehicle)].map(
                  (match) => match[1],
                ),
              );
              return vehicles.size === 1 &&
                vehicles.has(vehicle) &&
                /노선|운행|차량|셔틀|통학|호차/.test(title) &&
                changeWords.test(title + ' ' + body)
                ? { fact, title, body }
                : undefined;
            }),
        ];
      }),
    )
  ).filter((notice) => notice !== undefined);
}

async function regularTrips(
  ctx: AnswerContext,
  vehicle: string,
  direction: string,
  at: number,
) {
  const limit = 150;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: vehicle + '호차 ' + direction + ' 회차 학원 출발 정류장 시각',
    documentTypes: ['schedule', 'facility'],
    limit,
    upcomingUntil: at > ctx.asOf ? at : undefined,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const rows = found.flatMap(({ chunk }) => {
    const row = chunk.classId === null && transitRow(chunk, at);
    if (
      !row ||
      ![vehicle, vehicle + '호차'].includes(compactText(row.value(VEHICLE)))
    )
      return [];
    const trip = /^(등원|하원)(\d+)회차$/.exec(compactText(row.value(TRIP)));
    const stop = compactText(row.value(STOP));
    const time = row.value(TIME).trim();
    if (trip?.[1] !== direction || !stop || !timeCell.test(time)) return [];
    const fields = [
      VEHICLE,
      TRIP,
      STOP,
      TIME,
      ...(row.column(DAYS) >= 0 ? [DAYS] : []),
    ];
    const excerpt = row.project(fields.map(row.column));
    if (!excerpt) return [];
    return [
      {
        excerpt,
        stop,
        time,
        round: Number(trip[2]),
        days: row.value(DAYS),
        note: row.value(/^(?:비고|특이사항)$/),
      },
    ];
  });
  return { rows, exhaustive: found.length < limit };
}

function fromTransitFact(
  fact: ApprovedFact,
  excerpts: EvidenceExcerpt[],
  at: number,
  lines: string[],
): AnswerDraft {
  return {
    status: 'answered',
    text: lines.join('\n'),
    citations: [
      { kind: 'fact', fact, effectiveAt: at },
      ...excerpts.map(({ chunk, tableColumns }) => ({
        kind: 'chunk' as const,
        chunk,
        tableColumns,
        effectiveAt: at,
      })),
    ],
    excerpts,
    usedFacts: [fact],
  };
}

async function answerChangedArrival(
  ctx: AnswerContext,
  vehicle: string,
  direction: string,
  trip: string,
  at: number,
): Promise<AnswerDraft> {
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: at > ctx.asOf ? at : undefined,
    query: [
      ctx.question,
      vehicle + '호차',
      direction,
      trip + '회차',
      '변경 도착 정류장 시각',
    ].join(' '),
    documentTypes: ['announcement', 'schedule'],
    limit: 85,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const matches = found.flatMap(({ chunk }) => {
    const row = chunk.classId === null ? transitRow(chunk, at) : undefined;
    const heading = chunk.title + ' ' + (chunk.location.section ?? '');
    if (
      !row ||
      !/변경|임시|우회/.test(heading) ||
      /변경\s*전|기존\s*노선|정규\s*운행/.test(
        chunk.location.section ?? chunk.title,
      ) ||
      routeException.test(row.value(/^(?:비고|특이사항)$/))
    )
      return [];
    const days = row.value(DAYS).trim();
    const weekday = /([월화수목금토일])요일/.exec(ctx.frame.normalized)?.[1];
    const requestedDay =
      ctx.frame.explicitDates.length || ctx.frame.relativeWeek
        ? weekdayAt(at)
        : weekday;
    if (
      days &&
      (!requestedDay ||
        !dayWordCovers(days, requestedDay) ||
        /공휴일|휴일|제외|예외/.test(days))
    )
      return [];
    const dayColumn = days ? [row.column(DAYS)] : [];
    const trips = compactText(row.value(TRIP));
    if (trips !== direction + trip + '회차' && trips !== trip + '회차')
      return [];
    const { header, cells } = chunk.location;
    if (!header || !cells) return [];
    const byVehicle = row.column(VEHICLE);
    const byStop = row.column(STOP);
    const byTime = row.column(TIME);
    if ([byVehicle, byStop, byTime].every((column) => column >= 0)) {
      const stop = compactText(cells[byStop]);
      const time = cells[byTime].trim();
      if (
        compactText(cells[byVehicle]) !== vehicle + '호차' ||
        (trips === trip + '회차' && !heading.includes(direction)) ||
        stop.length < 3 ||
        departureStop.test(stop) ||
        !ctx.frame.compact.includes(stop) ||
        !timeCell.test(time)
      )
        return [];
      const excerpt = row.project([
        byVehicle,
        row.column(TRIP),
        byStop,
        byTime,
        ...dayColumn,
      ]);
      return excerpt ? [{ excerpt, stop, time }] : [];
    }
    const vehicles = [...heading.matchAll(routeVehicle)].map(
      (match) => match[1],
    );
    if (
      !vehicles.length ||
      !vehicles.every((entry) => entry === vehicle) ||
      !heading.includes(direction) ||
      row.column(/^(?:학원출발|출발시각)$/) < 0
    )
      return [];
    return header.flatMap((label, index) => {
      const stop = compactText(label);
      const time = cells[index].trim();
      if (
        stop.length < 3 ||
        /학원출발|시각|시간|비고|요일|회차/.test(stop) ||
        !ctx.frame.compact.includes(stop) ||
        !timeCell.test(time)
      )
        return [];
      const excerpt = row.project([row.column(TRIP), index, ...dayColumn]);
      return excerpt ? [{ excerpt, stop, time }] : [];
    });
  });
  if (!matches.length) return transitUnavailable();
  const length = Math.max(...matches.map(({ stop }) => stop.length));
  const candidates = matches.filter(({ stop }) => stop.length === length);
  if (new Set(candidates.map(({ stop, time }) => stop + '|' + time)).size !== 1)
    return abstain(
      '승인된 임시 운행표의 도착 시각이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'changed_transit_arrival';
  return fromExcerpt(candidates[0].excerpt, at);
}

async function answerRouteChange(
  ctx: AnswerContext,
  vehicle: string,
  direction: string | undefined,
  last: boolean,
  trip: string | undefined,
): Promise<AnswerDraft | undefined> {
  const {
    normalized,
    compact,
    relativeWeek,
    relativeDay,
    explicitDates,
    months,
    relativePeriod,
  } = ctx.frame;
  const stopChange =
    /정류장/.test(normalized) &&
    /어디|없어|없어졌|없어진|대신/.test(normalized);
  const departureChange =
    direction &&
    /출발/.test(normalized) &&
    /몇\s*시|시각|시간/.test(normalized) &&
    (last || trip);
  const arrivalChange =
    direction &&
    trip &&
    /도착|정차|몇\s*시|시각/.test(normalized) &&
    !/출발|언제\s*부터|어디\s*서\s*타/.test(normalized);
  if (!stopChange && !departureChange && !arrivalChange) return;
  if (
    relativeDay !== null ||
    explicitDates.length > 1 ||
    months.length > 1 ||
    explicitDates.some(({ operator }) => operator !== 'at') ||
    relativePeriod === 'last_month'
  )
    return transitUnavailable();
  const date = weekdayInNamedWeek(ctx.frame, ctx.asOf);
  if (relativeWeek && date === undefined) return transitUnavailable();
  const at = date ?? resolveEffectiveTime(ctx.frame, ctx.asOf).at;
  if (arrivalChange && !stopChange && !departureChange)
    return answerChangedArrival(ctx, vehicle, direction, trip, at);
  const notices = await approvedRouteNotices(ctx, vehicle, at);
  if (stopChange) {
    const candidates = notices.flatMap((notice) => {
      if (
        direction &&
        !notice.title.includes(direction) &&
        !notice.body.includes(direction)
      )
        return [];
      const match =
        /['"‘“]([^'"’”]+)['"’”]\s*정류장(?:을|은|는|에는|에)?[^.!?]*(?:쓰지\s*않|사용하지\s*않|정차하지\s*않|미정차|운영\s*중단)[^.!?]*?['"‘“]([^'"’”]+)['"’”]\s*(?:임시\s*)?정류장[^.!?]*(?:정차|이용)/.exec(
          notice.body,
        );
      return match && compact.includes(compactText(match[1]))
        ? [{ ...notice, replacement: compactText(match[2]) }]
        : [];
    });
    if (!candidates.length) return transitUnavailable();
    if (new Set(candidates.map(({ replacement }) => replacement)).size !== 1)
      return abstain(
        '승인 공지의 임시 정류장이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    ctx.trace.intent = 'transit_detour_notice';
    const selected = candidates[0];
    return fromTransitFact(selected.fact, [], at, [selected.body]);
  }
  if (!direction) return;
  const candidates = notices.flatMap((notice) => {
    const match =
      /(?<!\d)(\d+)\s*호차\s*(등원|하원)\s*(\d+)\s*회차\s*(?:학원\s*)?출발(?:은|이|시간은|시각은)?\s*((?:[01]?\d|2[0-3]):[0-5]\d)\b/.exec(
        notice.body,
      );
    return match &&
      match[1] === vehicle &&
      match[2] === direction &&
      (!trip || match[3] === trip) &&
      !/취소|운휴|없음|검토|미정/.test(notice.body)
      ? [{ ...notice, round: Number(match[3]), time: match[4] }]
      : [];
  });
  if (!candidates.length) return transitUnavailable();
  const excerpts: EvidenceExcerpt[] = [];
  const round = Math.max(...candidates.map((candidate) => candidate.round));
  if (last) {
    const { rows, exhaustive } = await regularTrips(
      ctx,
      vehicle,
      direction,
      at,
    );
    const departures = rows.filter((row) => departureStop.test(row.stop));
    const largest = Math.max(...departures.map((row) => row.round));
    const lastRows = departures.filter((row) => row.round === largest);
    if (
      !exhaustive ||
      largest !== round ||
      new Set(departures.map(({ excerpt }) => excerpt.chunk.sourceId)).size !==
        1 ||
      new Set(lastRows.map(({ time }) => time)).size !== 1 ||
      departures.some(({ days, note }) => days || routeException.test(note)) ||
      notices.some(({ body }) =>
        /(?:회차|운행).{0,10}(?:추가|폐지|취소|중단)|막차.{0,10}운휴/.test(
          body,
        ),
      )
    )
      return transitUnavailable();
    const row = transitRow(lastRows[0].excerpt.chunk, at);
    const proof = row?.project([VEHICLE, TRIP, STOP].map(row.column));
    if (!proof) return transitUnavailable();
    excerpts.push(proof);
  }
  const selected = candidates.filter((candidate) => candidate.round === round);
  if (new Set(selected.map(({ time }) => time)).size !== 1)
    return abstain(
      '승인 공지의 변경 출발 시각이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'transit_departure_notice';
  return fromTransitFact(selected[0].fact, excerpts, at, [selected[0].body]);
}

async function answerAfterClassTransit(
  ctx: AnswerContext,
  vehicle: string,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    !/(?:끝나고|끝난\s*(?:뒤|후)|수업\s*후)/.test(frame.normalized) ||
    !/타면|타고|하원/.test(frame.normalized) ||
    !/도착|내려/.test(frame.normalized) ||
    !/몇\s*시|시각|시간/.test(frame.normalized) ||
    /비교|각각|방학|등원|휴강|공휴일/.test(frame.normalized)
  )
    return;
  const classIds = explicitClassIds(ctx);
  if (classIds.length !== 1) return;
  const [classId] = classIds;
  const explicit = resolveEffectiveTime(frame, ctx.asOf);
  const at =
    weekdayInNamedWeek(frame, ctx.asOf) ??
    (frame.explicitDates.length === 1 &&
    frame.explicitDates[0].operator === 'at'
      ? explicit.explicitDay
      : null);
  if (at === null) return;
  const weekday = weekdayAt(at);
  if (
    [...frame.normalized.matchAll(/([월화수목금토일])요일/g)].some(
      (match) => match[1] !== weekday,
    )
  )
    return transitUnavailable();
  const [facts, notices, { rows, exhaustive }] = await Promise.all([
    ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      factTypes: ['schedule', 'schedule_change'],
      asOf: ctx.asOf,
      effectiveAt: at,
    }),
    approvedRouteNotices(ctx, vehicle, at),
    regularTrips(ctx, vehicle, '하원', at),
  ]);
  recordFacts(ctx.trace, facts);
  if (
    notices.length ||
    !exhaustive ||
    facts.some(
      (fact) =>
        fact.value.kind === 'schedule_change' &&
        fact.value.date === toIsoDate(toKstDate(at)) &&
        (fact.subjectType === 'academy' || fact.subjectId === classId),
    )
  )
    return transitUnavailable();
  const schedules = facts.flatMap((fact) => {
    if (
      fact.subjectType !== 'class' ||
      fact.subjectId !== classId ||
      fact.value.kind !== 'schedule' ||
      isAssistantDirective(fact.value.text)
    )
      return [];
    const match =
      /^(.+?)\s+((?:[01]?\d|2[0-3]):[0-5]\d)\s*[~–-]\s*((?:[01]?\d|2[0-3]):[0-5]\d)$/.exec(
        fact.value.text.trim(),
      );
    return match &&
      dayWordCovers(match[1], weekday) &&
      !/공휴일|휴일|예외|제외/.test(match[1])
      ? [{ fact, body: fact.value.text, start: match[2], end: match[3] }]
      : [];
  });
  if (
    !schedules.length ||
    new Set(schedules.map(({ start, end }) => start + '|' + end)).size !== 1
  )
    return transitUnavailable();
  const minutes = (time: string) => {
    const [hours, mins] = time.split(':').map(Number);
    return 60 * hours + mins;
  };
  const [{ start, end }] = schedules;
  if (minutes(start) >= minutes(end)) return transitUnavailable();
  const applicable = rows.filter(
    ({ days }) => !days || dayWordCovers(days, weekday),
  );
  const departures = applicable.filter(({ stop }) => departureStop.test(stop));
  if (
    new Set(departures.map(({ excerpt }) => excerpt.chunk.sourceId)).size !==
      1 ||
    departures.some(({ note }) => routeException.test(note))
  )
    return transitUnavailable();
  const next = departures
    .filter(({ time }) => minutes(time) > minutes(end))
    .sort((a, b) => minutes(a.time) - minutes(b.time))[0];
  if (!next) return transitUnavailable();
  const stops = applicable.filter(
    ({ stop }) =>
      stop.length >= 3 &&
      !departureStop.test(stop) &&
      frame.compact.includes(stop),
  );
  if (!stops.length) return transitUnavailable();
  const maxLength = Math.max(...stops.map(({ stop }) => stop.length));
  const arrivals = stops.filter(
    ({ excerpt, stop, round }) =>
      stop.length === maxLength &&
      round === next.round &&
      excerpt.chunk.sourceId === next.excerpt.chunk.sourceId,
  );
  if (
    !arrivals.length ||
    new Set(arrivals.map(({ stop, time }) => stop + '|' + time)).size !== 1 ||
    arrivals.some(
      ({ time, note }) =>
        minutes(time) < minutes(next.time) || routeException.test(note),
    ) ||
    departures.some(
      ({ round, time }) => (round === next.round) !== (time === next.time),
    )
  )
    return transitUnavailable();
  ctx.trace.intent = 'transit_after_class';
  const [arrival] = arrivals;
  return fromTransitFact(
    schedules[0].fact,
    [next.excerpt, arrival.excerpt],
    at,
    ['수업 시간 ' + schedules[0].body, next.excerpt.line, arrival.excerpt.line],
  );
}

async function answerVehicleRegistration(
  ctx: AnswerContext,
  vehicle: string,
): Promise<AnswerDraft> {
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: vehicle + '호차 차량 등록번호 번호판',
    documentTypes: ['facility', 'academy_info', 'schedule'],
    limit: 40,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const key = /^(?:차량|호차|운행차량)$/;
  const plate = /^(?:차량등록번호|등록번호|차량번호|번호판)$/;
  const options = found.flatMap(({ chunk }) => {
    const row = chunk.classId === null && transitRow(chunk, ctx.asOf);
    if (
      !row ||
      ![vehicle, vehicle + '호차'].includes(compactText(row.value(key))) ||
      !/^\d{2,3}\s*[가-힣]\s*\d{4}$/.test(row.value(plate))
    )
      return [];
    const excerpt = row.project([key, plate].map(row.column));
    return excerpt
      ? [{ excerpt, registration: compactText(row.value(plate)) }]
      : [];
  });
  if (!options.length)
    return abstain(
      '해당 차량의 등록번호를 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (new Set(options.map(({ registration }) => registration)).size !== 1)
    return abstain(
      '승인 자료에 기록된 차량 등록번호가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'vehicle_registration';
  return fromExcerpt(options[0].excerpt, ctx.asOf);
}

/** A stop-by-trip table can identify a unique arrival without a vehicle number. */
async function answerStopByTrip(
  ctx: AnswerContext,
  direction: string,
  trip: string,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    !/셔틀|통학|정류장|차량|버스/.test(frame.normalized) ||
    !/몇\s*시|도착|시각/.test(frame.normalized) ||
    /비교|각각|출발|방학|휴일|[월화수목금토일]요일|주말|주중|평일/.test(
      frame.normalized,
    ) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    [...frame.normalized.matchAll(/(?<!\d)\d+\s*회차/g)].length !== 1
  )
    return;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question + ' 셔틀 정류장 운행 회차',
    documentTypes: ['schedule', 'facility'],
    limit: 65,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const labels = [direction + trip + '회차', trip + '회차' + direction];
  let applicable = false;
  const matches = found.flatMap(({ chunk }) => {
    const row =
      chunk.classId === null ? transitRow(chunk, ctx.asOf) : undefined;
    const { header, cells } = chunk.location;
    if (
      !row ||
      !header ||
      !cells ||
      !/셔틀|통학|차량|버스/.test(
        chunk.title + ' ' + (chunk.location.section ?? ''),
      ) ||
      row.column(VEHICLE) >= 0 ||
      /변경|우회|임시/.test(chunk.title + ' ' + (chunk.location.section ?? ''))
    )
      return [];
    const key = row.column(STOP);
    const cols = header.flatMap((label, index) =>
      labels.includes(compactText(label)) ? [index] : [],
    );
    if (key < 0 || !cols.length) return [];
    applicable = true;
    const stop = compactText(cells[key]);
    if (
      cols.length !== 1 ||
      stop.length < 3 ||
      !frame.compact.includes(stop) ||
      routeException.test(row.value(/^(?:비고|특이사항)$/))
    )
      return [];
    const [timeColumn] = cols;
    const time = cells[timeColumn].trim();
    if (!timeCell.test(time)) return [];
    const excerpt = row.project([key, timeColumn]);
    return excerpt ? [{ excerpt, stop, time }] : [];
  });
  if (!applicable) return;
  if (!matches.length) return transitUnavailable();
  const longest = Math.max(...matches.map(({ stop }) => stop.length));
  const candidates = matches.filter(({ stop }) => stop.length === longest);
  if (new Set(candidates.map(({ stop, time }) => stop + '|' + time)).size !== 1)
    return abstain(
      '승인된 운행표에서 해당 회차의 도착 시각이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = candidates;
  const conditions = found.flatMap(({ chunk }) =>
    chunk.sourceId === selected.excerpt.chunk.sourceId &&
    chunk.location.section === selected.excerpt.chunk.location.section &&
    chunk.location.kind === 'paragraph' &&
    isTrusted(chunk) &&
    isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf) &&
    /(?:평일|주말|[월화수목금토일]요일).{0,20}운행/.test(chunk.text) &&
    !/얼마|이용료|전화|상담/.test(chunk.text)
      ? [{ chunk, line: chunk.text }]
      : [],
  );
  if (new Set(conditions.map(({ line }) => compactText(line))).size > 1)
    return abstain(
      '같은 운행표의 운영 조건이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'transit_stop_by_trip';
  const draft = fromExcerpt(selected.excerpt, ctx.asOf);
  const [condition] = conditions;
  if (!condition) return draft;
  return {
    ...draft,
    text: draft.text + '\n' + condition.line,
    excerpts: [selected.excerpt, condition],
    citations: [...draft.citations, { kind: 'chunk', chunk: condition.chunk }],
  };
}

const shuttleSubject =
  /셔틀|통학\s*(?:차량|버스|차)|학원\s*(?:차(?!감|이|수)|버스)|등하원\s*(?:차|버스)|[등하]원차|봉고/;
const routeLabel = /(?:^|[\s.])([a-z]|\d{1,2})\s*노선(?=$|[\s(을은이의도])/i;
const matrixColumn =
  /^(등원|하원)(\d+)회차\((초등|중등|고등)(?:학생|부|학교)?\)$/;
const matrixTime = /^((?:[01]?\d|2[0-3]):[0-5]\d)\s*(출발|도착)?$/;
const matrixCondition = /^(?:구분|적용대상|적용조건)$/;
const matrixChange = /^(?:변경내용|운행변경|변경시각)$/;
const matrixDates =
  /(?:\d{4}년)?\d{1,2}월\d{1,2}일[~–—](?:\d{4}년)?\d{1,2}월\d{1,2}일/;
const closureCondition = /^(?:전반)?(?:휴강일|휴원일|공휴일)$/;

function shuttleStopInQuestion(stop: string, question: string): boolean {
  // A conventional school abbreviation may omit "학교"; retain the gate.
  const normalizeStop = (text: string) =>
    normalizeText(text).replace(
      /(?:초등|중|고등)학교(?=\s*(?:정문|후문|동문|서문|남문|북문))/g,
      (word) => word[0],
    );
  const pieces = normalizeStop(stop).split(/\s+/);
  if (pieces.join('').length < 3) return false;
  const literal = pieces
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  return new RegExp(
    '(?<![\\p{L}\\p{N}])' + literal + '(?=$|[\\s,.?]|에서|까지|으로|에|은|는)',
    'u',
  ).test(normalizeStop(question));
}

function matrixStage(ctx: AnswerContext, infer: boolean) {
  const stated = [
    ...new Set(
      [
        ...ctx.frame.normalized.matchAll(
          /(?<![가-힣])(초등|중등|고등)(?:학생|부)?(?=\s|$|[,.?!]|[은는이도](?:\s|$))/g,
        ),
      ].map((match) => match[1]),
    ),
  ];
  if (stated.length) return stated.length === 1 ? stated[0] : undefined;
  if (!infer) return;
  const classes = new Set(explicitClassIds(ctx));
  const grades = ctx.catalog.classes
    .filter(({ classId }) => classes.has(classId))
    .flatMap(({ grade }) => (grade ? gradeBand(grade) : []));
  const stages = new Set(
    grades.map((grade) => (grade <= 6 ? '초등' : grade <= 9 ? '중등' : '고등')),
  );
  return stages.size === 1 ? [...stages][0] : undefined;
}

/** Match a specific stage/direction column in an approved stop-by-trip table. */
async function answerStageTransitMatrix(
  ctx: AnswerContext,
  vehicle: string | undefined,
  direction: string | undefined,
  trip: string | undefined,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  if (
    vehicle ||
    !shuttleSubject.test(q) ||
    !/몇\s*시(?!간)|시각/.test(q) ||
    /비교|각각|방학|공휴일|휴강|변경|바뀌|공사\s*기간|막차|마지막|요금|이용료|비용/.test(
      q,
    ) ||
    (q.includes('등원') && q.includes('하원')) ||
    frame.explicitDates.length > 1 ||
    frame.explicitDates.some(({ operator }) => operator !== 'at') ||
    frame.months.length > 1 ||
    frame.relativePeriod ||
    (frame.relativeWeek && !weekdayInNamedWeek(frame, ctx.asOf))
  )
    return;
  const fromAcademy =
    /출발/.test(q) &&
    /학원에서|학원\s*출발|끝나고|끝난\s*(?:뒤|후)|수업\s*후/.test(q);
  const requestedDirection =
    direction ??
    (fromAcademy
      ? '하원'
      : /(?:에서|정류장).{0,16}타(?:요|나요|는지|죠|는)|(?:에서|정류장).{0,16}탑승/.test(
            q,
          )
        ? '등원'
        : undefined);
  if (!requestedDirection || (fromAcademy && requestedDirection !== '하원'))
    return;
  const stage = matrixStage(ctx, !trip);
  const named = routeLabel.exec(q)?.[1];
  const { at: effective, explicitDay } = resolveEffectiveTime(frame, ctx.asOf);
  const today = toKstDate(ctx.asOf);
  const relativeDay =
    frame.relativeDay === null
      ? undefined
      : kstStartOfDay({ ...today, day: today.day + frame.relativeDay });
  const at =
    explicitDay === null
      ? (weekdayInNamedWeek(frame, ctx.asOf) ?? relativeDay ?? effective)
      : effective;
  const weekday = weekdayAt(at);
  const day = kstStartOfDay(toKstDate(at));
  const mentionedDays = [...q.matchAll(/([월화수목금토일])요일/g)].map(
    (match) => match[1],
  );
  const limit = 90;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query:
      '셔틀버스 통학차량 운행표 정류장 회차' +
      (named ? ' ' + named + '노선' : ''),
    documentTypes: ['academy_info', 'schedule', 'facility', 'announcement'],
    limit,
    upcomingUntil: at > ctx.asOf ? at : undefined,
  });
  const publicChunks = found
    .map(({ chunk }) => chunk)
    .filter(
      (chunk) =>
        chunk.classId === null && isValidAt(chunk.validFrom, chunk.validTo, at),
    );
  recordChunks(ctx.trace, publicChunks);

  let recognized = false;
  const matches = publicChunks.flatMap((chunk) => {
    const row = transitRow(chunk, at);
    const { header, cells, section } = chunk.location;
    if (
      !row ||
      !header ||
      !cells ||
      !/셔틀|통학|차량|버스/.test(chunk.title + ' ' + (section ?? '')) ||
      changeWords.test(chunk.title + ' ' + (section ?? ''))
    )
      return [];
    const key = row.column(STOP);
    const routeColumn = row.column(/^(?:노선|노선명)$/);
    const route = (
      routeColumn >= 0
        ? /^([a-z]|\d{1,2})(?:노선)?$/.exec(
            compactText(cells[routeColumn]),
          )?.[1]
        : routeLabel.exec(section ?? chunk.title)?.[1]
    )?.toLowerCase();
    if (
      key < 0 ||
      !header.some((label) => matrixColumn.test(compactText(label)))
    )
      return [];
    recognized = true;
    if ((named && named.toLowerCase() !== route) || (!stage && !trip))
      return [];
    const operatingDays = row.value(DAYS);
    if (operatingDays && !dayWordCovers(operatingDays, weekday)) return [];
    const station = cells[key];
    if (fromAcademy) {
      if (
        ![
          ctx.catalog.displayName,
          ...ctx.catalog.aliases,
          '학원',
          '학원 출발',
        ].some((label) => compactText(label) === compactText(station))
      )
        return [];
    } else if (!shuttleStopInQuestion(station, q)) return [];
    if (routeException.test(row.value(/^(?:비고|특이사항)$/))) return [];
    return header.flatMap((heading, column) => {
      const selected = matrixColumn.exec(compactText(heading));
      const time = matrixTime.exec(cells[column]);
      if (
        !selected ||
        !time ||
        selected[1] !== requestedDirection ||
        (trip && selected[2] !== trip) ||
        (stage && selected[3] !== stage) ||
        (fromAcademy &&
          time[2] !== '출발' &&
          !departureStop.test(compactText(station))) ||
        (!fromAcademy && time[2])
      )
        return [];
      const excerpt = row.project([
        ...(routeColumn >= 0 ? [routeColumn] : []),
        key,
        column,
      ]);
      return excerpt
        ? [
            {
              excerpt,
              station: compactText(station),
              time: time[1],
              route,
              trip: selected[2],
              stage: selected[3],
              operatingDays,
            },
          ]
        : [];
    });
  });
  if (!recognized) return;
  if (
    !matches.length ||
    found.length === limit ||
    mentionedDays.some((day) => day !== weekday) ||
    (relativeDay !== undefined &&
      explicitDay !== null &&
      relativeDay !== explicitDay) ||
    (frame.months.length > 0 && !frame.explicitDates.length)
  )
    return transitUnavailable();
  if (
    new Set(
      matches.map(({ station, time, trip, stage }) =>
        [station, time, trip, stage].join('|'),
      ),
    ).size !== 1
  )
    return abstain(
      '조건에 맞는 승인 운행표의 시각 또는 회차가 서로 다릅니다. 노선과 회차를 확인해 주세요.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = matches;
  const sources = new Set(matches.map(({ excerpt }) => excerpt.chunk.sourceId));
  const routes = new Set(matches.map(({ route }) => route));
  const scopedChanges = publicChunks.flatMap((chunk) => {
    if (!sources.has(chunk.sourceId)) return [];
    const row = transitRow(chunk, at);
    if (!row) return [];
    const key = row.column(matrixCondition);
    const value = row.column(matrixChange);
    if (key < 0 || value < 0) return [];
    const rawLabel = row.value(matrixCondition);
    const label = compactText(rawLabel);
    const route = routeLabel.exec(rawLabel)?.[1]?.toLowerCase();
    if (route && !routes.has(route)) return [];
    const tripKey = /(?:등원|하원)\d+회차/.exec(label)?.[0];
    if (tripKey && tripKey !== requestedDirection + selected.trip + '회차')
      return [];
    const days = [...label.matchAll(/([월화수목금토일])요일/g)].map(
      (match) => match[1],
    );
    if (days.length && !days.includes(weekday)) return [];
    const range = matrixDates.exec(label)?.[0];
    const dates = range
      ?.split(/[~–—]/)
      .every((part) => tableDateAt(part, toKstDate(day).year) !== undefined)
      ? range
      : undefined;
    if (dates && !tablePeriodContains(dates, day)) return [];
    const excerpt = row.project([key, value]);
    return excerpt
      ? [
          {
            excerpt,
            tripKey,
            dates,
            days,
            body: row.value(matrixChange),
            closure: closureCondition.test(label),
            route,
          },
        ]
      : [];
  });
  const outsideNotice = publicChunks.some(
    (chunk) =>
      !sources.has(chunk.sourceId) &&
      chunk.documentType === 'announcement' &&
      shuttleSubject.test(chunk.title) &&
      changeWords.test(chunk.title),
  );
  if (outsideNotice) return transitUnavailable();
  const closureRules = scopedChanges.filter(({ closure }) => closure);
  if (closureRules.length) {
    const changes = await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      factTypes: ['schedule_change'],
      asOf: ctx.asOf,
      effectiveAt: at,
    });
    recordFacts(ctx.trace, changes);
    const date = toIsoDate(toKstDate(at));
    if (
      changes.some(
        (fact) =>
          fact.subjectType === 'academy' &&
          fact.value.kind === 'schedule_change' &&
          fact.value.changeType === 'cancel' &&
          fact.value.date === date,
      )
    )
      return transitUnavailable();
  }
  const activeChanges = scopedChanges.filter(({ closure }) => !closure);
  if (activeChanges.length) {
    const [change] = activeChanges;
    if (
      !fromAcademy ||
      activeChanges.length !== 1 ||
      sources.size !== 1 ||
      !change.tripKey ||
      (change.route && routes.size > 1) ||
      (!change.dates && !change.days.length) ||
      [...change.body.matchAll(/\b\d{1,2}:\d{2}\b/g)].length !== 1 ||
      !/\d{1,2}:\d{2}\s*출발/.test(change.body)
    )
      return transitUnavailable();
    ctx.trace.intent = 'transit_stage_matrix_change';
    return fromExcerpt(change.excerpt, at);
  }
  if ((weekday === '토' || weekday === '일') && !selected.operatingDays)
    return transitUnavailable();
  ctx.trace.intent = 'transit_stage_matrix';
  return fromExcerpt(selected.excerpt, at);
}

async function answerShuttleOperation(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const q = ctx.frame.normalized;
  if (
    !shuttleSubject.test(q) ||
    !/다녀|다니|운행|있나요|있어요|데리러|오나요|와요/.test(q) ||
    /몇\s*시|시각|시간표|요금|비용|이용료|가격|신청|출발|변경|[월화수목금토일]요일|방학|휴강/.test(
      q,
    ) ||
    ctx.frame.explicitDates.length ||
    ctx.frame.relativeWeek ||
    ctx.frame.relativeDay !== null
  )
    return;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question + ' 셔틀버스 차량 운행',
    documentTypes: ['academy_info', 'schedule', 'announcement', 'facility'],
    limit: 35,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const doorstep = /집\s*앞|자택|개별\s*픽업/;
  const namedStop = /까지|에서|정류장/.test(q) || routeLabel.test(q);
  const noService =
    /^(?:[-*]\s*)?(?:학원\s*)?(?:셔틀(?:버스)?|통학\s*(?:차량|버스)|차량|학원차)(?:\s*\(셔틀(?:버스)?\))?(?:은|는|을|를)?\s*(?:운행|운영)\s*하지\s*않(?:습니다|아요)[.!]?$/;
  const statements = hits.flatMap(({ chunk }) => {
    if (
      !isTrusted(chunk) ||
      chunk.location.kind !== 'paragraph' ||
      !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
    )
      return [];
    return splitSentences(chunk.text).flatMap((line) => {
      if (!shuttleSubject.test(line)) return [];
      const absent = noService.test(line);
      const operates = /(?:운행|운영)\s*(?:합니다|중입니다)/.test(line);
      return absent || operates ? [{ chunk, line, absent }] : [];
    });
  });
  if (new Set(statements.map(({ absent }) => absent)).size > 1)
    return abstain(
      '승인된 차량 운행 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const explicitAbsence = statements.find(({ absent }) => absent);
  if (explicitAbsence) {
    ctx.trace.intent = 'transit_operation';
    return fromExcerpt(explicitAbsence, ctx.asOf);
  }
  const excerpts = statements.filter(({ line }) =>
    doorstep.test(q) ? doorstep.test(line) : !namedStop,
  );
  if (new Set(excerpts.map(({ line }) => compactText(line))).size !== 1)
    return transitUnavailable();
  ctx.trace.intent = 'transit_operation';
  return fromExcerpt(excerpts[0], ctx.asOf);
}

export async function answerTransitEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, compact } = ctx.frame;
  const vehicle = /(?<!\d)(\d+)\s*호차/.exec(normalized)?.[1];
  const direction = /등원|하원/.exec(normalized)?.[0];
  const trip = /(?<!\d)(\d+)\s*회차/.exec(normalized)?.[1];
  const last = /마지막|막차/.test(normalized);
  const change = /바뀌|바뀐|바뀐다|변경|공사\s*기간/.test(normalized);
  if (
    ctx.engine === 'planned' &&
    vehicle &&
    new Set([...normalized.matchAll(routeVehicle)].map((match) => match[1]))
      .size === 1 &&
    !(normalized.includes('등원') && normalized.includes('하원'))
  ) {
    if (
      /차량\s*(?:등록)?\s*번호|번호판/.test(normalized) &&
      !/연락처|전화|배정|예약|비교|바뀌|변경/.test(normalized) &&
      !ctx.frame.explicitDates.length &&
      !ctx.frame.relativeWeek &&
      ctx.frame.relativeDay === null
    )
      return answerVehicleRegistration(ctx, vehicle);
    const result = changeWords.test(normalized)
      ? await answerRouteChange(ctx, vehicle, direction, last, trip)
      : await answerAfterClassTransit(ctx, vehicle);
    if (result) return result;
  }
  if (ctx.engine === 'planned' && !change) {
    const pickup = await answerSchoolPickup(ctx);
    if (pickup) return pickup;
    const matrix = await answerStageTransitMatrix(
      ctx,
      vehicle,
      direction,
      trip,
    );
    if (matrix) return matrix;
    const operation = await answerShuttleOperation(ctx);
    if (operation) return operation;
    if (
      !vehicle &&
      direction &&
      trip &&
      !last &&
      !(normalized.includes('등원') && normalized.includes('하원'))
    ) {
      const grid = await answerStopByTrip(ctx, direction, trip);
      if (grid) return grid;
    }
  }

  if (ctx.engine === 'planned' && change && /픽업|통학/.test(normalized)) {
    const weekday = /[월화수목금토일]요일/.exec(normalized)?.[0];
    const school = /([가-힣]{2,}초)(?:등학교)?(?=\s|$)/.exec(normalized)?.[1];
    if (
      !weekday ||
      !school ||
      !/언제\s*부터|몇\s*호차|몇\s*시/.test(normalized)
    )
      return;
    const found = await ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      query: [school, weekday, '픽업 변경 등원'].join(' '),
      documentTypes: ['announcement', 'schedule'],
      limit: 25,
    });
    recordChunks(
      ctx.trace,
      found.map(({ chunk }) => chunk),
    );
    const matches = found.flatMap(({ chunk }) => {
      const heading = compactText(chunk.location.section ?? '');
      const body = compactText(chunk.text);
      if (
        !isTrusted(chunk) ||
        chunk.location.kind !== 'paragraph' ||
        !heading.includes(school) ||
        !heading.includes(weekday) ||
        !/픽업|통학/.test(heading) ||
        !/변경|조정/.test(heading) ||
        !body.includes(school) ||
        !body.includes(weekday) ||
        !/\d+호차/.test(body) ||
        !clock.test(chunk.text) ||
        !/\d{1,2}월\d{1,2}일(?:\([월화수목금토일]\))?부터/.test(body)
      )
        return [];
      const excerpt = { chunk, line: chunk.text };
      return supportsExcerpt(excerpt) ? [excerpt] : [];
    });
    if (new Set(matches.map(({ line }) => compactText(line))).size !== 1)
      return;
    ctx.trace.intent = 'transit_change_notice';
    return fromExcerpt(matches[0], ctx.asOf);
  }

  if (
    !vehicle ||
    !direction ||
    (!trip && !(last && ctx.engine === 'planned')) ||
    change ||
    (normalized.includes('등원') && normalized.includes('하원')) ||
    /[월화수목금토일]요일|공휴일|주말|주중|평일/.test(normalized) ||
    !/도착|정차|몇\s*시/.test(normalized) ||
    /출발|방학|수업\s*(?:끝|후)|운행\s*여부/.test(normalized)
  )
    return;
  const { at } = resolveEffectiveTime(ctx.frame, ctx.asOf);
  const limit = last && !trip ? 160 : 70;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question + ' 정류장 시각',
    documentTypes: ['schedule', 'facility'],
    limit,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const matches = found.flatMap(({ chunk }) => {
    const row = transitRow(chunk, at);
    if (!row) return [];
    const tripMatch = /^(등원|하원)(\d+)회차$/.exec(
      compactText(row.value(TRIP)),
    );
    const stop = compactText(row.value(STOP));
    const time = row.value(TIME);
    if (
      ![vehicle, vehicle + '호차'].includes(compactText(row.value(VEHICLE))) ||
      tripMatch?.[1] !== direction ||
      (trip && tripMatch[2] !== trip) ||
      stop.length < 3 ||
      !compact.includes(stop) ||
      !timeCell.test(time)
    )
      return [];
    const excerpt = row.project(
      [VEHICLE, TRIP, STOP, TIME].map(row.column),
      true,
    );
    return excerpt
      ? [
          {
            excerpt,
            stop,
            number: Number(tripMatch[2]),
            time,
          },
        ]
      : [];
  });
  if (!matches.length) return;
  if (last && !trip && found.length === limit)
    return abstain(
      '검색된 차량 운행표에서 마지막 회차를 확정할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const stopSize = Math.max(...matches.map(({ stop }) => stop.length));
  const stops = matches.filter(({ stop }) => stop.length === stopSize);
  const number = Math.max(...stops.map((row) => row.number));
  const selected = stops.filter((row) => row.number === number);
  if (new Set(selected.map(({ stop, time }) => stop + '|' + time)).size !== 1)
    return abstain(
      '승인된 차량 운행 시각이 서로 달라 확인이 필요합니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'transit_schedule_row';
  return fromExcerpt(selected[0].excerpt, at);
}
