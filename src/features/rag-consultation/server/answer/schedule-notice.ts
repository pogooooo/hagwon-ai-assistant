import { resolveSubjects } from '../query/resolve-subjects.ts';
import { isAssistantDirective } from '../ingest/validation.ts';
import { formatKstDate, kstStartOfDay, toKstDate } from '../text/time.ts';
import type { ApprovedFact, FactValue } from '../types.ts';
import {
  abstain,
  deny,
  studentLabel,
  className,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import {
  scheduleChangeInterval,
  tableDateAt,
  weekdayAt,
  weekdayInNamedWeek,
} from './table-dates.ts';

type ScheduleChange = Extract<FactValue, { kind: 'schedule_change' }>;
type ChangeFact = ApprovedFact & { value: ScheduleChange };

const dayMs = 24 * 60 * 60 * 1000;
const scheduleTopics = new Set([
  'schedule',
  'schedule_change',
  'hours',
  'makeup',
]);

function requestedDay(ctx: AnswerContext): number | undefined {
  const { asOf, frame } = ctx;
  if (
    frame.explicitDates.length > 1 ||
    frame.explicitDates.some(({ operator }) => operator !== 'at')
  )
    return;
  const { explicitDay } = resolveEffectiveTime(frame, asOf);
  const day =
    explicitDay ??
    (frame.relativeDay === null
      ? weekdayInNamedWeek(frame, asOf)
      : kstStartOfDay(toKstDate(asOf)) + frame.relativeDay * dayMs);
  const weekdays = [...frame.normalized.matchAll(/([월화수목금토일])요일/g)];
  if (
    day === undefined ||
    weekdays.some(([, weekday]) => weekday !== weekdayAt(day))
  )
    return;
  return day;
}

function appliesOn(fact: ChangeFact, day: number) {
  const range = scheduleChangeInterval(fact.value);
  return !!range && range.start < day + dayMs && day < range.end;
}

function relatedMakeup(
  cancellation: ChangeFact,
  makeup: ChangeFact,
  allChanges: ChangeFact[],
) {
  if (
    makeup.subjectType !== cancellation.subjectType ||
    makeup.subjectId !== cancellation.subjectId
  )
    return false;
  const cancelRange = scheduleChangeInterval(cancellation.value);
  const makeupRange = scheduleChangeInterval(makeup.value);
  if (!cancelRange || !makeupRange || makeupRange.start < cancelRange.end)
    return false;
  const closureEvent = cancellation.value.event;
  const makeupEvent = makeup.value.event;
  if (closureEvent || makeupEvent)
    return !!closureEvent && closureEvent.id === makeupEvent?.id;
  // Old notices without an incident ID can cite an exact closure day in the makeup notice.
  const priorDates = [
    ...makeup.value.text.matchAll(
      /((?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일)(?:\s*[월화수목금토일]요일)?\s*(?:휴강|휴원)/g,
    ),
  ];
  if (priorDates.length)
    return priorDates.every(
      ([, text]) =>
        tableDateAt(text, toKstDate(cancelRange.start).year) ===
        kstStartOfDay(toKstDate(cancelRange.start)),
    );
  // Within a shared source, one unambiguous cancellation can own a makeup.
  return (
    cancellation.sourceId === makeup.sourceId &&
    allChanges.filter(
      (fact) =>
        fact.value.changeType === 'cancel' &&
        fact.sourceId === makeup.sourceId &&
        fact.subjectType === makeup.subjectType &&
        fact.subjectId === makeup.subjectId,
    ).length === 1
  );
}

function distinctTimes(facts: ChangeFact[]) {
  return new Set(
    facts.map(({ value }) =>
      value.event
        ? [value.event.id, value.event.startsAt, value.event.endsAt].join('|')
        : [value.date, value.time].join('|'),
    ),
  ).size;
}

function changeLine(
  ctx: AnswerContext,
  { value, subjectType, subjectId }: ChangeFact,
) {
  const date = tableDateAt(value.date, 0);
  const scope =
    subjectType === 'class'
      ? className(ctx.catalog, subjectId)
      : subjectType === 'student'
        ? studentLabel(ctx.access, subjectId) + ' 학생'
        : '학원 전체';
  const kind =
    value.changeType === 'cancel'
      ? subjectType === 'student'
        ? '결석'
        : '휴강'
      : '보강';
  return value.event && !value.time
    ? scope + ' ' + value.text
    : [
        scope,
        date === undefined ? undefined : formatKstDate(date),
        value.time,
        kind,
      ]
        .filter(Boolean)
        .join(' ');
}

function fromChanges(
  ctx: AnswerContext,
  day: number,
  facts: ChangeFact[],
  makeupUnconfirmed = false,
): AnswerDraft {
  ctx.trace.intent = 'dated_schedule_notice';
  const lines = facts.map((fact) => changeLine(ctx, fact));
  if (makeupUnconfirmed)
    lines.push(
      '해당 휴강의 보강 일정은 승인 자료에서 확정되지 않았습니다. 담당자에게 확인해 주세요.',
    );
  else if (facts[0].value.event?.makeupStatus === 'none')
    lines.push('해당 휴강은 보강이 없습니다.');
  return {
    status: makeupUnconfirmed ? 'partial' : 'answered',
    reasonCode: makeupUnconfirmed ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: makeupUnconfirmed ? ['확정 보강 일정'] : undefined,
    text: lines.join('\n'),
    citations: facts.map((fact) => ({ kind: 'fact', fact })),
    usedFacts: facts,
    instants: [
      day,
      ...facts.flatMap(({ value }) => {
        const date = tableDateAt(value.date, 0);
        return date === undefined ? [] : [date];
      }),
    ],
    conversationUpdate:
      facts[0].subjectType === 'class'
        ? {
            previousFrame: {
              domain: 'info',
              classIds: [facts[0].subjectId],
              topicIds: ['schedule_change'],
              units: [],
              periods: [],
              eventDay: day,
            },
          }
        : undefined,
  };
}

const conflicting = () =>
  abstain(
    '같은 대상의 승인 휴강·보강 일정이 서로 달라 담당자의 확인이 필요합니다.',
    'CONFLICTING_EVIDENCE',
  );

async function answerImportedClassNotice(
  ctx: AnswerContext,
  day: number,
  cancellation: ChangeFact,
  makeups: ChangeFact[],
  asksLinkedMakeup: boolean,
) {
  // An imported single-class notice supplies its scope explicitly. Broader
  // notices can include holidays, rooms and conditions handled by other routes.
  if (
    cancellation.subjectType !== 'class' ||
    cancellation.classId !== cancellation.subjectId
  )
    return;
  if (distinctTimes(makeups) > 1) return conflicting();
  if (makeups[0]) return fromChanges(ctx, day, [cancellation, makeups[0]]);
  if (!asksLinkedMakeup) return;

  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['announcement'],
    query:
      className(ctx.catalog, cancellation.subjectId) +
      ' 휴강 보강 일정 아직 확정',
    limit: 20,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const pending = hits.some(
    ({ chunk }) =>
      chunk.sourceId === cancellation.sourceId &&
      !chunk.suspicious &&
      !chunk.extraction?.needsReview &&
      !chunk.extraction?.uncertainTokens.length &&
      !isAssistantDirective(chunk.text) &&
      /보강\s*일정.{0,24}(?:확정되지\s*않|미정)/.test(chunk.text),
  );
  if (pending) return fromChanges(ctx, day, [cancellation], true);
}

export async function answerDatedScheduleNotice(ctx: AnswerContext) {
  const { access, frame } = ctx;
  const q = frame.normalized;
  if (
    !(frame.flags.cancelSchedule || frame.flags.makeupSchedule) ||
    frame.topics.some(({ id }) => !scheduleTopics.has(id)) ||
    /결석|재보강|또\s*보강|못\s*(?:가|오)|공사|정전|시설\s*점검|강사\s*연수|원어민|스피킹|정규\s*수업|몇\s*회|신청/.test(
      q,
    ) ||
    frame.flags.compare ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.groupReference ||
    frame.unresolvedRelationWords.length
  )
    return;
  const day = requestedDay(ctx);
  if (day === undefined) return;
  const ids = explicitClassIds(ctx);
  const ownClasses =
    access.role === 'guardian' || access.role === 'student'
      ? [...new Set(access.studentRefs.flatMap((ref) => ref.classIds ?? []))]
      : [];
  const scoped = ids.length ? ids : ownClasses;
  const [classId] = scoped;
  if (scoped.length > 1 || frame.negatedClassIds.includes(classId)) return;
  const facts = await ctx.facts.queryApprovedFacts({
    access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['schedule_change'],
  });
  recordFacts(ctx.trace, facts);
  const changes = facts.filter(
    (fact): fact is ChangeFact =>
      fact.value.kind === 'schedule_change' &&
      !isAssistantDirective(fact.value.text) &&
      (fact.subjectType === 'academy' ||
        (fact.subjectType === 'class' && fact.subjectId === classId)),
  );
  const hasOperationalNotices = changes.some(({ value }) => !!value.event);
  const asksLinkedMakeup =
    frame.flags.makeupSchedule &&
    (frame.flags.cancelSchedule ||
      /(?:휴강|휴원|수업)(?:한|된|분|의)?\s*(?:에\s*대한\s*)?보강/.test(q));
  const asksMakeup = frame.flags.makeupSchedule && !asksLinkedMakeup;
  const candidates = changes.filter(
    (fact) =>
      fact.value.changeType === (asksMakeup ? 'makeup' : 'cancel') &&
      appliesOn(fact, day),
  );
  if (!candidates.length) {
    if (hasOperationalNotices && /휴강|휴원|보강/.test(q))
      return abstain(
        '요청하신 날짜와 대상에 해당하는 승인 휴강·보강 일정을 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
        ['해당 날짜의 일정'],
      );
    return;
  }
  const structured = candidates.filter(({ value }) => !!value.event);
  if (distinctTimes(structured) > 1) return conflicting();
  if (asksMakeup)
    return structured[0] && fromChanges(ctx, day, [structured[0]]);
  if (!structured.length && candidates.length !== 1) return;
  const cancellation = structured[0] ?? candidates[0];
  const makeups = changes.filter(
    (fact) =>
      fact.value.changeType === 'makeup' &&
      relatedMakeup(cancellation, fact, changes),
  );
  if (!cancellation.value.event)
    return answerImportedClassNotice(
      ctx,
      day,
      cancellation,
      makeups,
      asksLinkedMakeup,
    );
  if (distinctTimes(makeups) > 1) return conflicting();
  const makeup = makeups[0];
  return fromChanges(
    ctx,
    day,
    makeup ? [cancellation, makeup] : [cancellation],
    asksLinkedMakeup &&
      !makeup &&
      cancellation.value.event?.makeupStatus !== 'none',
  );
}

/** A policy can explain who confirms a refund without supplying an amount. */
export async function answerClosureRefundAmount(ctx: AnswerContext) {
  const { normalized } = ctx.frame;
  if (
    !/휴강|휴원/.test(normalized) ||
    !/환불/.test(normalized) ||
    !/얼마|금액|몇\s*퍼센트|몇\s*%/.test(normalized) ||
    ctx.frame.topics.some(
      ({ id }) => !['schedule_change', 'refund'].includes(id),
    )
  )
    return;
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['makeup_policy'],
  });
  recordFacts(ctx.trace, facts);
  const policy = facts.find(
    ({ subjectType, value }) =>
      subjectType === 'academy' &&
      value.kind === 'text' &&
      !isAssistantDirective(value.text) &&
      /휴강|휴원/.test(value.text) &&
      /환불/.test(value.text) &&
      /담당자.{0,24}(?:확인|안내)/.test(value.text) &&
      /판단하지\s*않|금액.{0,20}(?:담당자|확인)/.test(value.text) &&
      !/\d/.test(value.text),
  );
  if (policy?.value.kind !== 'text') return;
  ctx.trace.intent = 'closure_refund_amount';
  return {
    status: 'partial',
    reasonCode: 'PARTIAL_EVIDENCE',
    missingFields: ['확정 환불 금액'],
    text: policy.value.text,
    citations: [{ kind: 'fact', fact: policy }],
    usedFacts: [policy],
  } satisfies AnswerDraft;
}

/** Student absences are queried only after server-scoped subject resolution. */
export async function answerStudentAbsence(
  ctx: AnswerContext,
  studentIdHint?: string,
): Promise<AnswerDraft | undefined> {
  if (
    !ctx.frame.flags.makeupSchedule ||
    ctx.frame.flags.countLimit ||
    !/결석/.test(ctx.frame.normalized) ||
    !/보강|일정|언제/.test(ctx.frame.normalized) ||
    /규정|정책|신청|환불|가능|방법|재보강/.test(ctx.frame.normalized) ||
    ctx.frame.topics.some((t) => !scheduleTopics.has(t.id))
  )
    return;
  const resolution = resolveSubjects({
    access: ctx.access,
    frame: ctx.frame,
    state: ctx.state,
    studentIdHint,
  });
  if (resolution.kind === 'denied') return deny('ACCESS_DENIED');
  if (resolution.kind === 'clarify' || resolution.studentIds.length !== 1)
    return {
      status: 'clarify',
      text: '어느 학생의 결석 보강인지 학생을 선택해 주세요.',
      reasonCode: 'AMBIGUOUS_SUBJECT',
      citations: [],
      usedFacts: [],
      clarifyOptionStudentIds:
        resolution.kind === 'clarify'
          ? resolution.optionStudentIds
          : resolution.studentIds,
    };
  const [studentId] = resolution.studentIds;
  ctx.trace.targetStudentIds = [studentId];
  ctx.trace.intent = 'student_absence_makeup';
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [studentId],
    factTypes: ['schedule_change'],
    asOf: ctx.asOf,
  });
  recordFacts(ctx.trace, facts);
  const changes = facts.filter(
    (f): f is ChangeFact =>
      f.subjectType === 'student' &&
      f.subjectId === studentId &&
      f.value.kind === 'schedule_change' &&
      !!f.value.event &&
      !isAssistantDirective(f.value.text) &&
      (!ctx.frame.classIds.length ||
        (f.classId !== null && ctx.frame.classIds.includes(f.classId))),
  );
  const day = requestedDay(ctx);
  if (
    (ctx.frame.explicitDates.length ||
      ctx.frame.relativeDay !== null ||
      ctx.frame.relativeWeek) &&
    day === undefined
  )
    return abstain(
      '날짜와 요일을 정확히 지정해 주세요.',
      'INSUFFICIENT_EVIDENCE',
    );
  const events = new Map<string, ChangeFact[]>();
  for (const f of changes) {
    const id = f.value.event!.id;
    events.set(id, [...(events.get(id) ?? []), f]);
  }
  const candidates = [...events.values()].filter(
    (group) => day === undefined || group.some((f) => appliesOn(f, day)),
  );
  if (!candidates.length)
    return abstain(
      '요청한 학생과 날짜의 확정 결석 보강 일정이 없습니다. 담당자에게 확인해 주세요.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (candidates.length !== 1)
    return {
      status: 'clarify',
      text: '결석 일정이 여러 건입니다. 결석한 날짜를 알려 주세요.',
      reasonCode: 'AMBIGUOUS_SUBJECT',
      citations: [],
      usedFacts: [],
    };
  const group = candidates[0];
  const cancel = group.filter((f) => f.value.changeType === 'cancel');
  const makeup = group.filter((f) => f.value.changeType === 'makeup');
  if (cancel.length !== 1 || makeup.length > 1) return conflicting();
  const pending = !makeup.length;
  const lines = group.map((f) => changeLine(ctx, f));
  if (pending)
    lines.push(
      '이 결석의 보강 일정은 아직 확정되지 않았습니다. 담당자에게 확인해 주세요.',
    );
  return {
    status: pending ? 'partial' : 'answered',
    reasonCode: pending ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: pending ? ['확정 보강 일정'] : undefined,
    text: lines.join('\n'),
    citations: group.map((fact) => ({ kind: 'fact', fact })),
    usedFacts: group,
    instants: group.map((f) => f.value.event!.startsAt),
    conversationUpdate: { selectedStudentId: studentId },
  };
}
