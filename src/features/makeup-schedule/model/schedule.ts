/**
 * 휴·보강 일정 등록·변경·취소·조회 규칙(순수 함수).
 * 상태를 직접 바꾸지 않고 새 상태를 돌려준다. 대상자·충돌은 코드로 계산한다.
 */
import {
  attendanceOf,
  candidateStarts,
  formatWindows,
  namesOf,
} from './availability.ts';
import { classOnDate, classesOnDate, eventClass } from './timetable.ts';
import { classOf, noticeText, studentOf } from './notice.ts';
import {
  addDays,
  dayName,
  dayOfWeek,
  fromMinutes,
  isDate,
  isTime,
  overlaps,
  shortDate,
  toMinutes,
} from './time.ts';
import type {
  AcademyConfig,
  Attendance,
  ClassDefinition,
  EventScope,
  HistoryAction,
  MakeupSlot,
  MakeupSuggestion,
  NoticeKind,
  OutboxNotice,
  ScheduleEvent,
  ScheduleIssue,
  ScheduleResult,
  ScheduleState,
  StudentSession,
} from './types.ts';

export function emptyState(): ScheduleState {
  return { events: [], outbox: [], seq: 0 };
}

const active = (event: ScheduleEvent) => event.status !== 'withdrawn';
const confirmedEvents = (state: ScheduleState) =>
  state.events.filter((event) => event.status === 'confirmed');

function fail(error: string, issues: ScheduleIssue[] = []): ScheduleResult {
  return { ok: false, error, issues };
}

/** 안내 대상 원생: 반 휴강이면 그 반 원생 전체, 결석이면 그 학생 한 명 */
export function recipientsOf(
  academy: AcademyConfig,
  event: Pick<ScheduleEvent, 'scope' | 'classId' | 'studentId'>,
): string[] {
  if (event.scope === 'student')
    return event.studentId ? [event.studentId] : [];
  return academy.students
    .filter((student) => student.classIds.includes(event.classId))
    .map((student) => student.studentId);
}

interface OccupiedSlot {
  label: string;
  classId: string;
  studentIds: string[];
  start: number;
  end: number;
  teacher: string;
  room: string;
}

/** 그날 이미 잡혀 있는 수업(정규 수업 + 확정 보강) */
function occupiedSlots(
  academy: AcademyConfig,
  state: ScheduleState,
  date: string,
  excludeEventId: string | null,
): OccupiedSlot[] {
  const slots: OccupiedSlot[] = [];
  const confirmed = confirmedEvents(state);
  for (const klass of classesOnDate(academy, date)) {
    if (!klass.days.includes(dayOfWeek(date))) continue;
    const canceled = confirmed.some(
      (event) =>
        event.scope === 'class' &&
        event.classId === klass.classId &&
        event.date === date,
    );
    if (canceled) continue;
    const absent = new Set(
      confirmed
        .filter(
          (event) =>
            event.scope === 'student' &&
            event.classId === klass.classId &&
            event.date === date,
        )
        .map((event) => event.studentId),
    );
    slots.push({
      label: `${klass.name} 정규 수업`,
      classId: klass.classId,
      studentIds: recipientsOf(academy, {
        scope: 'class',
        classId: klass.classId,
        studentId: null,
      }).filter((id) => !absent.has(id)),
      start: toMinutes(klass.start),
      end: toMinutes(klass.end),
      teacher: klass.teacher,
      room: klass.room,
    });
  }
  for (const event of confirmed) {
    if (event.eventId === excludeEventId || !event.makeup) continue;
    if (event.makeup.date !== date) continue;
    const klass = eventClass(academy, event);
    const who =
      event.scope === 'student'
        ? `${studentOf(academy, event.studentId ?? '').name} 결석 보강`
        : `${klass.name} 보강`;
    slots.push({
      label: who,
      classId: klass.classId,
      studentIds: recipientsOf(academy, event),
      start: toMinutes(event.makeup.start),
      end: toMinutes(event.makeup.end),
      teacher: klass.teacher,
      room: event.makeup.room,
    });
  }
  return slots;
}

export interface MakeupRequest {
  scope: EventScope;
  classId: string;
  studentId: string | null;
  date: string;
  start: string;
  room: string;
  /** 변경 중인 일정(자기 자신의 보강은 충돌에서 뺀다) */
  eventId?: string | null;
  classSnapshot?: ClassDefinition;
}

/** 보강 후보 시간 검사. end 는 정규 수업 길이로 계산한다. */
export function checkMakeup(
  academy: AcademyConfig,
  state: ScheduleState,
  request: MakeupRequest,
): {
  issues: ScheduleIssue[];
  slot: MakeupSlot | null;
  attendance: Attendance | null;
} {
  const issues: ScheduleIssue[] = [];
  const block = (type: ScheduleIssue['type'], message: string) =>
    issues.push({ type, message, blocking: true });
  if (!isDate(request.date)) block('입력', '보강 날짜를 확인하세요.');
  if (!isTime(request.start)) block('입력', '보강 시작 시각을 확인하세요.');
  if (!academy.rooms.includes(request.room))
    block('입력', '보강 교실을 선택하세요.');
  if (issues.length > 0) return { issues, slot: null, attendance: null };

  const sourceEvent = state.events.find((e) => e.eventId === request.eventId);
  const klass =
    request.classSnapshot ??
    (sourceEvent
      ? eventClass(academy, sourceEvent)
      : classOf(academy, request.classId));
  const duration = toMinutes(klass.end) - toMinutes(klass.start);
  const start = toMinutes(request.start);
  const end = start + duration;
  const slot: MakeupSlot = {
    date: request.date,
    start: request.start,
    end: fromMinutes(end),
    room: request.room,
  };
  const targets = recipientsOf(academy, request);

  if (end > toMinutes(academy.closeTime))
    block(
      '시간',
      `종료 ${slot.end}가 교습 가능 시각 ${academy.closeTime}을 넘습니다(지역 조례 설정값).`,
    );
  const occupied = occupiedSlots(
    academy,
    state,
    request.date,
    request.eventId ?? null,
  );
  // Count distinct people at interval boundaries, not the sum of every overlapping lesson.
  // Half-open intervals allow one lesson to start when another ends.
  const boundaries = new Set([
    start,
    ...occupied
      .filter((other) => overlaps(start, end, other.start, other.end))
      .map((other) => Math.max(start, other.start)),
  ]);
  const peak = Math.max(
    ...[...boundaries].map(
      (at) =>
        new Set([
          ...targets,
          ...occupied
            .filter((other) => other.start <= at && at < other.end)
            .flatMap((other) => other.studentIds),
        ]).size,
    ),
  );
  if (peak > academy.capacity)
    block(
      '정원',
      `해당 시간 학원 전체 동시 인원 ${peak}명이 동시 정원 ${academy.capacity}명을 넘습니다.`,
    );
  const holiday = academy.holidays[request.date];
  if (holiday)
    issues.push({
      type: '공휴일',
      message: `${shortDate(request.date)}은 ${holiday}입니다. 보강해도 되는지 확인하세요.`,
      blocking: false,
    });

  for (const other of occupied) {
    if (!overlaps(start, end, other.start, other.end)) continue;
    const range = `${fromMinutes(other.start)}~${fromMinutes(other.end)}`;
    if (other.teacher === klass.teacher)
      block('강사', `${klass.teacher} 일정 겹침: ${other.label} ${range}`);
    if (other.room === request.room)
      block('교실', `${request.room} 겹침: ${other.label} ${range}`);
    const both = targets.filter((id) => other.studentIds.includes(id));
    if (both.length > 0)
      block(
        '원생',
        `원생 ${both.length}명 겹침: ${other.label} ${range} (${both
          .map((id) => studentOf(academy, id).name)
          .join(', ')})`,
      );
  }

  // 학생이 등록한 보강 가능 시간. 결석 보강(학생 1명)은 막고, 반 보강은 몇 명이 못 오는지 알린다.
  const attendance = attendanceOf(
    state,
    targets,
    slot.date,
    slot.start,
    slot.end,
  );
  if (attendance.unavailable.length > 0) {
    const names = namesOf(academy, attendance.unavailable);
    if (request.scope === 'student') {
      const windows = state.availability?.[attendance.unavailable[0]] ?? [];
      block(
        '가능시간',
        `${names} 학생이 올 수 있는 시간이 아닙니다(등록: ${formatWindows(windows)}).`,
      );
    } else {
      issues.push({
        type: '가능시간',
        message: `${targets.length}명 중 ${attendance.unavailable.length}명이 올 수 없는 시간입니다: ${names}`,
        blocking: false,
      });
    }
  }
  return { issues, slot, attendance };
}

const blocking = (issues: ScheduleIssue[]) =>
  issues.filter((issue) => issue.blocking);

/** 충돌 없는 보강 후보(하루에 하나씩, 평일 16시 이후·주말 10시 이후) */
/** 더 많은 학생이 올 수 있는 후보가 앞선다. 같으면 빠른 날짜·시각. */
function compareSuggestions(a: MakeupSuggestion, b: MakeupSuggestion): number {
  return (
    a.attendance.unavailable.length - b.attendance.unavailable.length ||
    b.attendance.available.length - a.attendance.available.length ||
    a.slot.date.localeCompare(b.slot.date) ||
    toMinutes(a.slot.start) - toMinutes(b.slot.start)
  );
}

/**
 * 보강 추천: 이후 14일 안에서 확정을 막는 충돌이 없는 시간 중,
 * 등록된 가능 시간 기준으로 올 수 있는 학생이 가장 많은 시간을 날짜마다 하나씩 골라 순위를 매긴다.
 * 후보 시각은 기본 시간대(평일 16시·주말 10시 이후)와 대상 학생이 등록한 가능 시간에서 만든다.
 */
export function suggestMakeups(
  academy: AcademyConfig,
  state: ScheduleState,
  request: Omit<MakeupRequest, 'date' | 'start'> & { after: string },
  limit = 3,
): MakeupSuggestion[] {
  if (!isDate(request.after)) return [];
  const sourceEvent = state.events.find((e) => e.eventId === request.eventId);
  const klass =
    request.classSnapshot ??
    (sourceEvent
      ? eventClass(academy, sourceEvent)
      : classOf(academy, request.classId));
  const duration = toMinutes(klass.end) - toMinutes(klass.start);
  const targets = recipientsOf(academy, request);
  const perDay: MakeupSuggestion[] = [];
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = addDays(request.after, offset);
    if (academy.holidays[date]) continue;
    const day = dayOfWeek(date);
    const weekend = day === 0 || day === 6;
    const registered = targets.flatMap((id) =>
      (state.availability?.[id] ?? []).filter((w) => w.day === day),
    );
    const starts = candidateStarts(academy, date, duration).filter((start) => {
      const m = toMinutes(start);
      const inDefault = m >= toMinutes(weekend ? '10:00' : '16:00');
      const inRegistered = registered.some(
        (w) => toMinutes(w.start) <= m && m + duration <= toMinutes(w.end),
      );
      return inDefault || inRegistered;
    });
    let best: MakeupSuggestion | null = null;
    for (const start of starts) {
      const { issues, slot, attendance } = checkMakeup(academy, state, {
        ...request,
        date,
        start,
      });
      if (!slot || !attendance || issues.some((issue) => issue.blocking))
        continue;
      const candidate = { slot, attendance };
      if (!best || compareSuggestions(candidate, best) < 0) best = candidate;
    }
    if (best) perDay.push(best);
  }
  return perDay.sort(compareSuggestions).slice(0, limit);
}

export interface CreateEventInput {
  scope: EventScope;
  classId: string;
  studentId?: string | null;
  date: string;
  reason?: string;
  makeup?: { date: string; start: string; room: string } | null;
  /** true: 원장 확정(상담 자료 반영) / false: 임시 저장 */
  confirm: boolean;
  classSnapshot?: ClassDefinition;
}

function validateTarget(
  academy: AcademyConfig,
  state: ScheduleState,
  input: CreateEventInput,
): string | null {
  const klass =
    input.classSnapshot ?? classOnDate(academy, input.classId, input.date);
  if (!klass) return '반을 선택하세요.';
  if (!isDate(input.date)) return '날짜를 입력하세요.';
  if (!klass.days.includes(dayOfWeek(input.date)))
    return `${klass.name}은 ${shortDate(input.date)}에 수업이 없습니다. 수업일: ${klass.days
      .map(dayName)
      .join('·')}요일`;
  const same = state.events.filter(
    (event) =>
      active(event) &&
      event.classId === klass.classId &&
      event.date === input.date,
  );
  if (input.scope === 'class') {
    if (same.some((event) => event.scope === 'student'))
      return '같은 수업에 개인 결석이 등록되어 있습니다. 결석 일정을 취소·정리한 뒤 반 전체 휴강을 등록하세요.';
    if (same.some((event) => event.scope === 'class'))
      return `${klass.name} ${shortDate(input.date)} 휴강은 이미 등록되어 있습니다.`;
    return null;
  }
  const student = academy.students.find((s) => s.studentId === input.studentId);
  if (!student) return '원생을 선택하세요.';
  if (!student.classIds.includes(klass.classId))
    return `${student.name} 학생은 ${klass.name} 소속이 아닙니다.`;
  if (
    same.some(
      (event) => event.scope === 'class' && event.status === 'confirmed',
    )
  )
    return `${shortDate(input.date)}은 ${klass.name} 전체 휴강이라 결석 보강을 따로 등록하지 않습니다.`;
  if (
    same.some(
      (event) =>
        event.scope === 'student' && event.studentId === student.studentId,
    )
  )
    return `${student.name} 학생의 ${shortDate(input.date)} 결석은 이미 등록되어 있습니다.`;
  return null;
}

function nextEventId(state: ScheduleState): { id: string; seq: number } {
  const seq = state.seq + 1;
  return { id: `EV-${String(seq).padStart(3, '0')}`, seq };
}

function withNotice(
  academy: AcademyConfig,
  state: ScheduleState,
  event: ScheduleEvent,
  kind: NoticeKind,
  now: string,
): OutboxNotice[] {
  const notice: OutboxNotice = {
    noticeId: `${event.eventId}-N${state.outbox.filter((n) => n.eventId === event.eventId).length + 1}`,
    eventId: event.eventId,
    kind,
    text: noticeText(academy, event, kind),
    recipientStudentIds: recipientsOf(academy, event),
    createdAt: now,
    status: 'pending',
  };
  return [notice, ...state.outbox];
}

function firstNotice(event: ScheduleEvent): NoticeKind {
  return event.scope === 'student' ? '결석 보강 안내' : '휴강 안내';
}

function replaceEvent(
  state: ScheduleState,
  event: ScheduleEvent,
): ScheduleEvent[] {
  return state.events.map((current) =>
    current.eventId === event.eventId ? event : current,
  );
}

function record(
  event: ScheduleEvent,
  action: HistoryAction,
  now: string,
): ScheduleEvent['history'] {
  return [...event.history, { at: now, action, makeup: event.makeup }];
}

/** 휴강(반 전체) 또는 결석(학생 한 명) 등록 */
export function createEvent(
  academy: AcademyConfig,
  state: ScheduleState,
  input: CreateEventInput,
  now: string,
): ScheduleResult {
  const error = validateTarget(academy, state, input);
  if (error) return fail(error);
  const { id, seq } = nextEventId(state);
  const classSnapshot = structuredClone(
    classOnDate(academy, input.classId, input.date)!,
  );
  let makeup: MakeupSlot | null = null;
  if (input.makeup) {
    const { issues, slot } = checkMakeup(academy, state, {
      classSnapshot,
      scope: input.scope,
      classId: input.classId,
      studentId: input.studentId ?? null,
      ...input.makeup,
      eventId: id,
    });
    if (!slot || (input.confirm && blocking(issues).length > 0))
      return fail('충돌을 해결한 뒤 확정하세요.', issues);
    makeup = slot;
  }
  const base: ScheduleEvent = {
    eventId: id,
    classSnapshot,
    scope: input.scope,
    classId: input.classId,
    studentId: input.scope === 'student' ? (input.studentId ?? null) : null,
    date: input.date,
    reason: input.reason?.trim() ?? '',
    status: input.confirm ? 'confirmed' : 'draft',
    makeup,
    revision: input.confirm ? 1 : 0,
    confirmedAt: input.confirm ? now : null,
    updatedAt: now,
    history: [],
  };
  const event: ScheduleEvent = {
    ...base,
    history: [
      { at: now, action: 'created', makeup },
      ...(input.confirm
        ? [{ at: now, action: 'confirmed' as const, makeup }]
        : []),
    ],
  };
  const next: ScheduleState = {
    ...state,
    events: [...state.events, event],
    outbox: state.outbox,
    seq,
  };
  return {
    ok: true,
    event,
    state: input.confirm
      ? {
          ...next,
          outbox: withNotice(academy, next, event, firstNotice(event), now),
        }
      : next,
  };
}

function findEvent(state: ScheduleState, eventId: string) {
  return state.events.find((event) => event.eventId === eventId) ?? null;
}

/** 임시 저장 일정 확정 */
export function confirmEvent(
  academy: AcademyConfig,
  state: ScheduleState,
  eventId: string,
  now: string,
): ScheduleResult {
  const current = findEvent(state, eventId);
  if (!current || current.status !== 'draft')
    return fail('임시 저장된 일정만 확정할 수 있습니다.');
  const duplicate = validateTarget(
    academy,
    { ...state, events: state.events.filter((e) => e.eventId !== eventId) },
    { ...current, confirm: true },
  );
  if (duplicate) return fail(duplicate);
  if (current.makeup) {
    const { issues } = checkMakeup(academy, state, {
      ...current,
      ...current.makeup,
      eventId,
    });
    if (blocking(issues).length > 0)
      return fail('충돌을 해결한 뒤 확정하세요.', issues);
  }
  const confirmed: ScheduleEvent = {
    ...current,
    status: 'confirmed',
    revision: 1,
    confirmedAt: now,
    updatedAt: now,
  };
  const event = { ...confirmed, history: record(confirmed, 'confirmed', now) };
  const next = { ...state, events: replaceEvent(state, event) };
  return {
    ok: true,
    event,
    state: {
      ...next,
      outbox: withNotice(academy, next, event, firstNotice(event), now),
    },
  };
}

/** 보강 지정·변경(makeup) 또는 보강 취소(null) */
export function changeMakeup(
  academy: AcademyConfig,
  state: ScheduleState,
  eventId: string,
  makeup: { date: string; start: string; room: string } | null,
  now: string,
): ScheduleResult {
  const current = findEvent(state, eventId);
  if (!current || current.status === 'withdrawn')
    return fail('변경할 수 있는 일정이 아닙니다.');
  let slot: MakeupSlot | null = null;
  if (makeup) {
    const checked = checkMakeup(academy, state, {
      ...current,
      ...makeup,
      eventId,
    });
    if (
      !checked.slot ||
      (current.status === 'confirmed' && blocking(checked.issues).length > 0)
    )
      return fail('충돌을 해결한 뒤 확정하세요.', checked.issues);
    slot = checked.slot;
  } else if (!current.makeup) {
    return fail('취소할 보강이 없습니다.');
  }
  const same =
    slot &&
    current.makeup &&
    slot.date === current.makeup.date &&
    slot.start === current.makeup.start &&
    slot.room === current.makeup.room;
  if (same) return fail('기존 보강과 같은 일정입니다.');

  const isConfirmed = current.status === 'confirmed';
  const updated: ScheduleEvent = {
    ...current,
    makeup: slot,
    revision: isConfirmed ? current.revision + 1 : 0,
    confirmedAt: isConfirmed ? now : null,
    updatedAt: now,
  };
  const event = {
    ...updated,
    history: record(updated, slot ? 'makeup_changed' : 'makeup_cleared', now),
  };
  const next = { ...state, events: replaceEvent(state, event) };
  if (!isConfirmed) return { ok: true, event, state: next };
  const kind: NoticeKind = !slot
    ? '보강 취소 안내'
    : current.makeup
      ? '보강 변경 안내'
      : '보강 안내';
  return {
    ok: true,
    event,
    state: { ...next, outbox: withNotice(academy, next, event, kind, now) },
  };
}

/** 휴강·결석 취소. 확정 일정은 취소 상태로 남기고(이력), 임시 저장은 지운다. */
export function withdrawEvent(
  academy: AcademyConfig,
  state: ScheduleState,
  eventId: string,
  now: string,
): ScheduleResult {
  const current = findEvent(state, eventId);
  if (!current || current.status === 'withdrawn')
    return fail('취소할 수 있는 일정이 아닙니다.');
  if (current.status === 'draft') {
    return {
      ok: true,
      event: { ...current, status: 'withdrawn', updatedAt: now },
      state: {
        ...state,
        events: state.events.filter((event) => event.eventId !== eventId),
      },
    };
  }
  const updated: ScheduleEvent = {
    ...current,
    status: 'withdrawn',
    revision: current.revision + 1,
    updatedAt: now,
  };
  const event = { ...updated, history: record(updated, 'withdrawn', now) };
  const next = { ...state, events: replaceEvent(state, event) };
  // Restoring a regular lesson can collide with a makeup placed in its freed slot.
  // Compare before/after so unrelated pre-existing warnings do not block a withdrawal.
  for (const other of confirmedEvents(next)) {
    if (!other.makeup || other.makeup.date !== current.date) continue;
    const request = { ...other, ...other.makeup, eventId: other.eventId };
    const before = new Set(
      blocking(checkMakeup(academy, state, request).issues).map(
        (i) => i.message,
      ),
    );
    const added = blocking(checkMakeup(academy, next, request).issues).filter(
      (i) => !before.has(i.message),
    );
    if (added.length)
      return fail(
        '정규 수업 복구 시 보강과 충돌합니다. 해당 보강을 조정한 뒤 휴강·결석을 취소하세요.',
        added,
      );
  }
  return {
    ok: true,
    event,
    state: {
      ...next,
      outbox: withNotice(academy, next, event, '휴강 취소 안내', now),
    },
  };
}

/** 학생별 일정 조회: 기간 안의 정규 수업·휴강·결석·보강(확정분만) */
export function studentSchedule(
  academy: AcademyConfig,
  state: ScheduleState,
  studentId: string,
  from: string,
  to: string,
): StudentSession[] {
  const student = studentOf(academy, studentId);
  const confirmed = confirmedEvents(state);
  const sessions: StudentSession[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const classId of student.classIds) {
      const event =
        confirmed.find(
          (e) =>
            e.scope === 'class' && e.classId === classId && e.date === date,
        ) ??
        confirmed.find(
          (e) =>
            e.scope === 'student' &&
            e.studentId === studentId &&
            e.classId === classId &&
            e.date === date,
        ) ??
        null;
      const klass = event
        ? eventClass(academy, event)
        : classOnDate(academy, classId, date);
      if (!klass || (!event && !klass.days.includes(dayOfWeek(date)))) continue;
      sessions.push({
        date,
        start: klass.start,
        end: klass.end,
        classId,
        className: klass.name,
        kind: !event
          ? 'regular'
          : event.scope === 'class'
            ? 'canceled'
            : 'absent',
        room: klass.room,
        eventId: event?.eventId ?? null,
        makeupPending: !!event && !event.makeup,
        makeupFor: null,
      });
    }
  }
  for (const event of confirmed) {
    if (!event.makeup || event.makeup.date < from || event.makeup.date > to)
      continue;
    if (!recipientsOf(academy, event).includes(studentId)) continue;
    sessions.push({
      date: event.makeup.date,
      start: event.makeup.start,
      end: event.makeup.end,
      classId: event.classId,
      className: eventClass(academy, event).name,
      kind: 'makeup',
      room: event.makeup.room,
      eventId: event.eventId,
      makeupPending: false,
      makeupFor: event.date,
    });
  }
  return sessions.sort(
    (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
  );
}

/** Detect actual resource conflicts on a date, including regular and makeup lessons. */
export function resourceConflicts(
  academy: AcademyConfig,
  state: ScheduleState,
  date: string,
): string[] {
  const slots = occupiedSlots(academy, state, date, null);
  const issues: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i];
    for (const b of slots.slice(i + 1)) {
      if (!overlaps(a.start, a.end, b.start, b.end)) continue;
      const label = [a.label, b.label].sort().join(' / ');
      if (a.teacher === b.teacher) issues.push('강사 시간 겹침: ' + label);
      if (a.room === b.room) issues.push('교실 시간 겹침: ' + label);
      if (a.studentIds.some((id) => b.studentIds.includes(id)))
        issues.push('원생 시간 겹침: ' + label);
    }
    const count = new Set(
      slots
        .filter((s) => s.start <= a.start && a.start < s.end)
        .flatMap((s) => s.studentIds),
    ).size;
    if (count > academy.capacity)
      issues.push('학원 동시 정원 초과: ' + count + '명');
  }
  return [...new Set(issues)];
}
