import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText } from '../text/normalize.ts';
import {
  formatKstDate,
  isValidAt,
  kstStartOfDay,
  toIsoDate,
  toKstDate,
} from '../text/time.ts';
import {
  abstain,
  className,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { classTableRows, explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

const CLOCK_TIME =
  /(?:[01]?\d|2[0-3]):[0-5]\d|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/;
const WEEKDAY = /[월화수목금토일]요일/;
const ROOM = /강의실|교실|몇\s*호/;
const CLOCK_QUERY = /몇\s*시(?!간)|시작\s*시간/;
const CONDITIONAL =
  /휴강|휴원|보강|특강|시험|방학|연기|변경|대체|공휴일|안\s*하|없음|미정|제외/;

interface ScheduleSlot {
  classId: string;
  excerpts: EvidenceExcerpt[];
}

async function collectScheduleSlots(
  ctx: AnswerContext,
  classIds: readonly string[],
  effective: ReturnType<typeof resolveEffectiveTime>,
): Promise<ScheduleSlot[]> {
  const asksClockTime =
    ctx.plannedRequest?.requiredFields.includes('startTime') ||
    CLOCK_QUERY.test(ctx.frame.normalized);

  const asksRoom = ROOM.test(ctx.frame.normalized);
  return Promise.all(
    classIds.map(async (classId) => {
      const rows = await classTableRows(ctx, classId, ['schedule'], effective);
      const excerpts = rows.flatMap(({ chunk, tableColumns }) => {
        if (
          !tableColumns?.length ||
          !canReadRecord(ctx.access, chunk, []) ||
          chunk.suspicious ||
          isAssistantDirective(chunk.text) ||
          chunk.extraction?.needsReview ||
          chunk.extraction?.uncertainTokens.length
        )
          return [];
        const { cells, header } = chunk.location;
        if (!cells || !header) return [];
        const indices = [...new Set([0, ...tableColumns])];
        if (
          indices.some(
            (index) =>
              index < 0 || index >= cells.length || index >= header.length,
          )
        )
          return [];
        // A shared grid axis may contain separate weekday and weekend times.
        // The existing renderer can project a sub-cell by weekday.
        if (
          WEEKDAY.test(ctx.frame.normalized) &&
          indices.some(
            (index) =>
              /평일/.test(cells[index]) &&
              /주말|토|일요일/.test(cells[index]) &&
              [
                ...cells[index].matchAll(
                  /\d{1,2}:\d{2}\s*[~～–-]\s*\d{1,2}:\d{2}/g,
                ),
              ].length > 1,
          )
        )
          return [];
        const values = indices.map((index) => cells[index]).join(' ');
        if (
          asksRoom &&
          !indices.some(
            (index) => ROOM.test(header[index]) && cells[index].trim(),
          )
        )
          return [];
        if (
          CONDITIONAL.test(values) ||
          (asksClockTime && !CLOCK_TIME.test(values))
        )
          return [];

        const excerpt = {
          chunk,
          tableColumns,
          line: indices
            .map((index) => header[index] + ': ' + cells[index])
            .join(' / '),
        };
        return supportsExcerpt(excerpt) ? [excerpt] : [];
      });
      return { classId, excerpts };
    }),
  );
}

/** Carry a school/grade anchor across explicitly enumerated sibling classes. */
function expandNumberedClasses(
  ctx: AnswerContext,
  ids: readonly string[],
): string[] | undefined {
  if (ids.length !== 1 || !ctx.frame.classIds.includes(ids[0]))
    return undefined;
  const anchor = ctx.catalog.classes.find((entry) => entry.classId === ids[0]);
  const series = anchor?.name.match(/^(.*?)([1-9]\d*)반$/);
  if (!series || !anchor?.grade) return undefined;

  const query = ctx.frame.normalized;
  if (/말고|제외|빼고|아니라|아닌/.test(query)) return undefined;
  const ordinals = [...query.matchAll(/(?<!\d)([1-9]\d*)\s*반/g)].map(
    ([, number]) => number,
  );
  if (
    ordinals.length !== 2 ||
    ordinals[0] === ordinals[1] ||
    !ordinals.includes(series[2]) ||
    !/이랑|랑|하고|및|,/.test(query)
  )
    return undefined;
  const grades = [...query.matchAll(/[초중고]\s*[1-6]|[1-6]\s*학년/g)];
  if (grades.length !== 1) return undefined;

  const classes = ordinals.map((number) =>
    ctx.catalog.classes.filter(
      (entry) =>
        entry.grade === anchor.grade &&
        !ctx.frame.negatedClassIds.includes(entry.classId) &&
        compactText(entry.name) === compactText(series[1] + number + '반'),
    ),
  );
  return classes.every((matches) => matches.length === 1)
    ? classes.map(([entry]) => entry.classId)
    : undefined;
}
function resolveScheduleClasses(ctx: AnswerContext): string[] {
  const ids = explicitClassIds(ctx);
  const expanded = expandNumberedClasses(ctx, ids);
  if (expanded) return expanded;
  if (
    ids.length < 2 ||
    /(?:이랑|랑|하고|및|각각|둘\s*다|두\s*반)/.test(ctx.frame.normalized)
  )
    return ids;

  const grades = [
    ...ctx.frame.normalized.matchAll(
      /(?<!\d)([초중고])?([1-6](?:\s*[,·]\s*[1-6])*)\s*학년/g,
    ),
  ];
  if (grades.length !== 1) return ids;
  const [, school, gradeList] = grades[0];
  const requestedGrades = gradeList.match(/[1-6]/g) ?? [];
  const candidates = ctx.catalog.classes.filter((entry) => {
    if (!ids.includes(entry.classId) || !entry.grade) return false;
    const labels = [entry.name, ...entry.aliases].map((name) =>
      compactText(name).replace(/\([초중고][1-6].*?\)$/, ''),
    );
    const courseMention =
      labels.some(
        (label) => label.length >= 3 && ctx.frame.compact.includes(label),
      ) ||
      labels.some((label) => {
        const course = label.match(/([가-힣]{2,}반)$/)?.[1];
        return course && ctx.frame.compact.includes(course);
      });
    const catalogGrades = [...entry.grade.matchAll(/([초중고])([1-6])/g)];
    const gradeMatch = requestedGrades.every((grade) =>
      catalogGrades.some(
        ([, level, number]) =>
          (!school || school === level) && grade === number,
      ),
    );
    return courseMention && gradeMatch;
  });
  return candidates.length === 1 ? [candidates[0].classId] : ids;
}

async function findScheduleChanges(
  ctx: AnswerContext,
  classId: string,
  isoDate: string,
) {
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: ['schedule_change'],
    asOf: ctx.asOf,
    effectiveAt: ctx.asOf,
  });
  recordFacts(ctx.trace, facts);
  const names = ctx.catalog.classes
    .filter((entry) => entry.classId === classId)
    .flatMap((entry) => [entry.name, ...entry.aliases])
    .map(compactText)
    .filter((name) => name.length >= 3);
  return facts.filter((fact) => {
    if (fact.value.kind !== 'schedule_change' || fact.value.date !== isoDate)
      return false;
    if (fact.subjectType === 'class') return fact.subjectId === classId;
    if (fact.subjectType !== 'academy') return false;
    const text = compactText(fact.value.text);
    return (
      /학원전체|전수업|모든수업|전체휴강|휴원/.test(text) ||
      names.some((name) => text.includes(name))
    );
  });
}
/** Answers bounded schedule questions directly from verified table projections. */
export async function answerFromScheduleEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const classIds = resolveScheduleClasses(ctx);
  const targetCount = explicitClassIds(ctx).length;
  const narrowedCourse = classIds.length < targetCount;
  const expandedCourse = classIds.length > targetCount;
  const intentIds = frame.topics.map(({ id }) => id);
  const asksClassArrival =
    classIds.length === 1 &&
    ctx.studentClassIds.includes(classIds[0]) &&
    frame.relativeDay !== null &&
    frame.explicitDates.length === 0 &&
    CLOCK_QUERY.test(frame.normalized) &&
    /(?:학원|수업)(?:에|은|에는)?\s*(?:가|오|도착)|등원/.test(
      frame.normalized,
    ) &&
    intentIds.every((id) => id === 'hours' || id === 'schedule') &&
    !/상담|설명회|체험|방문|셔틀|차량/.test(frame.normalized);
  const asksRoomAndSchedule =
    intentIds.includes('schedule') &&
    intentIds.every((id) => id === 'schedule' || id === 'location') &&
    ROOM.test(frame.normalized) &&
    !/오시는\s*길|주소|위치|역에서|주차/.test(frame.normalized);
  // A question can ask for the regular class time and a separate lesson type.
  // The regular timetable cannot confirm an unlisted lesson type.
  const asksTimeAndNativeLesson =
    classIds.length === 1 &&
    intentIds.includes('native') &&
    intentIds.every(
      (id) =>
        id === 'schedule' ||
        id === 'hours' ||
        id === 'native' ||
        id === 'teacher',
    ) &&
    /수업(?:은|이|을)?\s*몇\s*시/.test(frame.normalized) &&
    !/담임|담당|누구|누가|성함/.test(frame.normalized);
  const asksNarrowedSchedule =
    narrowedCourse &&
    intentIds.length === 0 &&
    /시간\s*(?:알려|궁금|어떻게|좀|언제)/.test(frame.normalized);
  if (
    classIds.length === 0 ||
    (!asksClassArrival &&
      !asksRoomAndSchedule &&
      !asksNarrowedSchedule &&
      !asksTimeAndNativeLesson &&
      (intentIds.length !== 1 ||
        intentIds[0] !== 'schedule' ||
        !/시간표|몇\s*시(?!간)|수업\s*시간|요일/.test(frame.normalized))) ||
    CONDITIONAL.test(frame.normalized) ||
    /평일|주말|[월화수목금토일]욜/.test(frame.normalized) ||
    /몇\s*분|몇\s*시간|동안|언제\s*부터|몇\s*번/.test(frame.normalized) ||
    (!asksClassArrival && /까지/.test(frame.normalized)) ||
    frame.flags.compare ||
    frame.flags.previousRevision
  )
    return undefined;

  let scheduleContext = expandedCourse
    ? { ...ctx, frame: { ...frame, classIds } }
    : ctx;
  if (asksClassArrival && frame.relativeDay !== null) {
    const today = toKstDate(ctx.asOf);
    const date = toKstDate(
      kstStartOfDay({ ...today, day: today.day + frame.relativeDay }),
    );
    scheduleContext = {
      ...ctx,
      frame: { ...frame, explicitDates: [{ ...date, operator: 'at' }] },
    };
  }
  const effective = resolveEffectiveTime(scheduleContext.frame, ctx.asOf);
  const datedRequest =
    scheduleContext.frame.explicitDates[0]?.operator === 'at' &&
    effective.explicitDay !== null &&
    classIds.length === 1;
  if (datedRequest && effective.explicitDay !== null) {
    const date = toKstDate(effective.explicitDay);
    const namedDay = /([월화수목금토일])요일/.exec(frame.normalized)?.[1];
    const actualDay = '일월화수목금토'[
      new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    ];
    if (namedDay && namedDay !== actualDay)
      return abstain(
        '질문에 적힌 날짜와 요일이 일치하지 않습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
    const changes = await findScheduleChanges(
      ctx,
      classIds[0],
      toIsoDate(date),
    );
    if (changes.length) {
      if (
        asksClassArrival ||
        CLOCK_QUERY.test(frame.normalized) ||
        ROOM.test(frame.normalized)
      ) {
        return abstain(
          '해당 날짜에 수업 변경 공지가 있어 정규 시각이나 장소를 안내하기 어렵습니다.',
          'INSUFFICIENT_EVIDENCE',
        );
      }
      const statements = changes.flatMap(({ value }) =>
        value.kind === 'schedule_change' ? [value.text] : [],
      );
      ctx.trace.intent = 'schedule_override';
      return {
        status: 'answered',
        text: [...new Set(statements)].join('\n'),
        citations: changes.map((fact) => ({ kind: 'fact', fact })),
        usedFacts: changes,
        instants: [effective.explicitDay],
      };
    }
  }
  const expectsQualifiedClass = ctx.catalog.classes.some(
    (entry) =>
      classIds.includes(entry.classId) && /\([초중고][1-6]/.test(entry.name),
  );
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: ['schedule'],
    asOf: ctx.asOf,
    effectiveAt: effective.at,
  });
  recordFacts(ctx.trace, facts);
  const currentFacts = facts.filter(
    (fact) =>
      fact.subjectType === 'class' &&
      classIds.includes(fact.subjectId) &&
      isValidAt(fact.validFrom, fact.validTo, effective.at),
  );
  const prefersStructured =
    (!expectsQualifiedClass && /(?:무슨|어느)\s*요일/.test(frame.normalized)) ||
    (!WEEKDAY.test(frame.normalized) &&
      !ROOM.test(frame.normalized) &&
      !CLOCK_QUERY.test(frame.normalized));
  if (
    prefersStructured &&
    currentFacts.length &&
    !narrowedCourse &&
    !expandedCourse &&
    !asksClassArrival
  )
    return undefined;

  const slots = (
    await collectScheduleSlots(scheduleContext, classIds, effective)
  ).map((slot) => {
    // Schedule documents can cover multiple terms. When the approved facts pin
    // a class to a source for this date, another document must not override it.
    const sources = new Set(
      currentFacts
        .filter((fact) => fact.subjectId === slot.classId)
        .map((fact) => fact.sourceId),
    );
    return sources.size === 0
      ? slot
      : {
          ...slot,
          excerpts: slot.excerpts.filter(({ chunk }) =>
            sources.has(chunk.sourceId),
          ),
        };
  });
  if (!slots.some(({ excerpts }) => excerpts.length)) {
    return asksClassArrival
      ? abstain(
          '해당 날짜의 등원 시각을 시간표에서 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        )
      : undefined;
  }
  if (!frame.classIds.length && slots.some(({ excerpts }) => !excerpts.length))
    return undefined;
  const missingFields = slots
    .filter(({ excerpts }) => excerpts.length === 0)
    .map(({ classId }) => className(ctx.catalog, classId) + ' 시간표');
  const excerpts = slots.flatMap((slot) => slot.excerpts);
  if (
    asksTimeAndNativeLesson &&
    !excerpts.some(({ chunk, tableColumns }) =>
      tableColumns?.some(
        (index) =>
          /원어민\s*(?:수업|강의|회화)/.test(
            chunk.location.header?.[index] ?? '',
          ) &&
          !/^(?:\s*|[-–—]+|미정|미확인)$/.test(
            chunk.location.cells?.[index]?.trim() ?? '',
          ),
      ),
    )
  )
    missingFields.push('원어민 수업');
  const prefix =
    effective.explicitDay === null
      ? ''
      : formatKstDate(effective.at) + ' 기준 ';
  const lines = slots.flatMap(({ classId, excerpts }) =>
    excerpts.map(
      ({ line }) => prefix + className(ctx.catalog, classId) + ' 수업: ' + line,
    ),
  );
  if (missingFields.length)
    lines.push('확인되지 않은 항목: ' + missingFields.join(', '));

  if (expandedCourse) ctx.frame = scheduleContext.frame;
  ctx.trace.intent = 'schedule_evidence';
  return {
    status: missingFields.length ? 'partial' : 'answered',
    reasonCode: missingFields.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missingFields.length ? missingFields : undefined,
    text: lines.join('\n'),
    excerpts,
    citations: excerpts.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    usedFacts: [],
    instants: [effective.at],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        units: [],
        periods: [],
        topicIds: ['schedule'],
        classIds,
      },
    },
  };
}
