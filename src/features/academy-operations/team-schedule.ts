import type { DatabaseSync } from 'node:sqlite';
import { assertUnifiedSchedule } from './schedule-conflicts.ts';
import { z } from 'zod';
import {
  createEvent,
  confirmEvent,
  changeMakeup,
  withdrawEvent,
  emptyState,
  studentSchedule,
  resourceConflicts,
} from '../makeup-schedule/model/schedule.ts';
import {
  setAvailability,
  formatWindows,
} from '../makeup-schedule/model/availability.ts';
import { scheduleEventToIndexInputs } from '../makeup-schedule/server/rag-sync.ts';
import type {
  AcademyConfig,
  ScheduleState,
  ScheduleEvent,
} from '../makeup-schedule/model/types.ts';
import { classOnDate } from '../makeup-schedule/model/timetable.ts';
import { addDays, isDate } from '../makeup-schedule/model/time.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import {
  escapeHtml as h,
  field,
  required,
  one,
  rows,
  transaction,
  OperationError,
  type PageContext,
  type OperationModule,
} from './shared.ts';

interface Stored {
  version: number;
  state: string;
  config: string;
}
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const windows = z
  .array(
    z.object({ day: z.number().int().min(0).max(6), start: time, end: time }),
  )
  .max(50);
const periodSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: time,
  end: time,
  teacher: z.string().min(1).max(128),
  room: z.string().min(1).max(60),
  effectiveFrom: z.string().optional(),
  effectiveUntil: z.string().optional(),
});
const configSchema = z.object({
  capacity: z.number().int().positive().max(1000),
  closeTime: time,
  rooms: z.array(z.string().trim().min(1).max(60)).min(1).max(50),
  classes: z
    .array(
      z.object({
        classId: z.string(),
        effectiveFrom: z.string().optional(),
        effectiveUntil: z.string().optional(),
        history: z.array(periodSchema).optional(),
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        start: time,
        end: time,
        teacher: z.string().min(1).max(128),
        room: z.string().min(1).max(60),
      }),
    )
    .min(1)
    .max(200),
  holidays: z
    .record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().max(80))
    .default({}),
});
type Config = z.infer<typeof configSchema>;
const initial: Config = {
  capacity: 9,
  closeTime: '22:00',
  rooms: ['1강의실'],
  classes: [],
  holidays: {},
};
const staff = (ctx: PageContext) =>
  ['admin', 'teacher'].includes(ctx.actor.role);

export function setupTeamSchedule(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_team_schedule (academy_id TEXT PRIMARY KEY, version INTEGER NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS op_team_schedule_history (academy_id TEXT NOT NULL, version INTEGER NOT NULL, actor_id TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(academy_id, version));`);
}
function stored(db: DatabaseSync, academy: string): Stored {
  return (
    one<Stored>(
      db,
      'SELECT * FROM op_team_schedule WHERE academy_id = ?',
      academy,
    ) ?? {
      version: 0,
      config: JSON.stringify(initial),
      state: JSON.stringify(emptyState()),
    }
  );
}
function academyConfig(
  db: DatabaseSync,
  id: string,
  config: Config,
): AcademyConfig {
  const classes = rows<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM classes WHERE academy_id = ?',
    id,
  );
  return {
    academyId: id,
    name: one<{ name: string }>(
      db,
      'SELECT name FROM academies WHERE id = ?',
      id,
    )!.name,
    capacity: config.capacity,
    closeTime: config.closeTime,
    rooms: config.rooms,
    holidays: config.holidays,
    classes: config.classes.flatMap((c) => {
      const live = classes.find((x) => x.id === c.classId);
      return live ? [{ ...c, name: live.name }] : [];
    }),
    students: rows<{ id: string; name: string; class_id: string | null }>(
      db,
      'SELECT id, name, class_id FROM students WHERE academy_id = ?',
      id,
    ).map((s) => ({
      studentId: s.id,
      name: s.name,
      classIds: rows<{ class_id: string }>(
        db,
        'SELECT class_id FROM student_class_memberships WHERE student_id=? AND academy_id=? AND ended_at IS NULL',
        s.id,
        id,
      ).map((m) => m.class_id),
    })),
  };
}
function visible(ctx: PageContext, event: ScheduleEvent) {
  if (ctx.actor.role === 'admin') return true;
  if (event.status === 'draft' && !staff(ctx)) return false;
  if (!accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === event.classId))
    return false;
  return (
    event.scope === 'class' ||
    accessibleStudents(ctx.db, ctx.actor).some((s) => s.id === event.studentId)
  );
}
function dateTime(date: string, time: string) {
  return Date.parse(`${date}T${time}:00+09:00`);
}
export function teamScheduleEvidence(db: DatabaseSync, academyId: string) {
  const row = stored(db, academyId);
  const state = JSON.parse(row.state) as ScheduleState;
  const academy = academyConfig(db, academyId, JSON.parse(row.config));
  return state.events.flatMap((event) => {
    const klass =
      event.classSnapshot ?? classOnDate(academy, event.classId, event.date);
    if (
      !klass ||
      (event.studentId &&
        !academy.students.some(
          (s) =>
            s.studentId === event.studentId &&
            s.classIds.includes(event.classId),
        ))
    )
      return [];
    return scheduleEventToIndexInputs(academy, event).map((input) => ({
      ...input,
      facts: input.facts.map((fact) => ({
        ...fact,
        value:
          fact.value.kind === 'schedule_change'
            ? {
                ...fact.value,
                event: {
                  id: `${academyId}:${event.eventId}`,
                  startsAt:
                    fact.value.changeType === 'makeup' && event.makeup
                      ? dateTime(event.makeup.date, event.makeup.start)
                      : dateTime(event.date, klass.start),
                  endsAt:
                    fact.value.changeType === 'makeup' && event.makeup
                      ? dateTime(event.makeup.date, event.makeup.end)
                      : dateTime(event.date, klass.end),
                  makeupStatus: event.makeup
                    ? ('scheduled' as const)
                    : ('pending' as const),
                },
              }
            : fact.value,
      })),
    }));
  });
}

function submit(ctx: PageContext, form: FormData) {
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const old = stored(ctx.db, ctx.actor.academyId);
    if (field(form, 'version') !== String(old.version))
      throw new OperationError(
        '일정이 변경되었습니다. 새로 열고 다시 저장해 주세요.',
        409,
      );
    const action = required(form, 'action', '작업');
    let state = JSON.parse(old.state) as ScheduleState;
    let config = JSON.parse(old.config) as Config;
    const academy = academyConfig(ctx.db, ctx.actor.academyId, config);
    if (action === 'config' || action === 'class-config') {
      if (ctx.actor.role !== 'admin')
        throw new OperationError(
          '시간표 설정은 관리자만 변경할 수 있습니다.',
          403,
        );
      let raw: unknown;
      if (action === 'class-config') {
        const classId = required(form, 'classId', '반');
        const room = required(form, 'room', '교실', 60);
        raw = {
          ...config,
          capacity: Number(required(form, 'capacity', '동시 수용 인원')),
          closeTime: required(form, 'closeTime', '수업 종료 한도'),
          rooms: [...new Set([...config.rooms, room])],
          classes: [
            ...config.classes.filter((c) => c.classId !== classId),
            {
              classId,
              days: form.getAll('days').map(Number),
              start: required(form, 'start', '시작 시각'),
              end: required(form, 'end', '종료 시각'),
              teacher: required(form, 'teacher', '강사'),
              room,
            },
          ],
        };
      } else {
        try {
          raw = JSON.parse(required(form, 'config', '시간표 설정', 50000));
        } catch {
          throw new OperationError('설정 JSON을 확인해 주세요.', 422);
        }
      }
      const parsed = configSchema.safeParse(raw);
      if (!parsed.success)
        throw new OperationError('시간표 설정 형식을 확인해 주세요.', 422);
      const next = parsed.data;
      const available = accessibleClasses(ctx.db, ctx.actor);
      const ids = new Set<string>();
      for (const c of next.classes) {
        if (
          ids.has(c.classId) ||
          !available.some((x) => x.id === c.classId) ||
          c.end <= c.start ||
          c.end > next.closeTime ||
          !next.rooms.includes(c.room) ||
          !one(
            ctx.db,
            "SELECT 1 FROM accounts WHERE academy_id = ? AND id = ? AND role IN ('admin','teacher')",
            ctx.actor.academyId,
            c.teacher,
          )
        )
          throw new OperationError(
            '반, 강사 계정, 교실 또는 수업 시간을 확인해 주세요.',
            422,
          );
        ids.add(c.classId);
      }
      // History is derived from stored data, never trusted from a submitted config.
      const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
      const effectiveFrom = field(form, 'effectiveFrom');
      const comparable = (c: Config['classes'][number]) =>
        JSON.stringify([
          c.days.slice().sort(),
          c.start,
          c.end,
          c.teacher,
          c.room,
        ]);
      for (const c of next.classes) {
        const previous = config.classes.find(
          (oldClass) => oldClass.classId === c.classId,
        );
        c.history = previous?.history;
        c.effectiveFrom = previous?.effectiveFrom;
        c.effectiveUntil = previous?.effectiveUntil;
        if (previous && comparable(previous) !== comparable(c)) {
          if (
            !isDate(effectiveFrom) ||
            effectiveFrom < today ||
            (previous.effectiveFrom && effectiveFrom <= previous.effectiveFrom)
          )
            throw new OperationError(
              '시간표 변경 적용일을 오늘 이후이며 기존 개정판보다 나중인 날짜로 지정해 주세요.',
              422,
            );
          const { history: oldHistory, classId: _id, ...period } = previous;
          void _id;
          c.history = [
            ...(oldHistory ?? []),
            { ...period, effectiveUntil: effectiveFrom },
          ];
          c.effectiveFrom = effectiveFrom;
          c.effectiveUntil = undefined;
        } else if (!previous) {
          if (effectiveFrom && !isDate(effectiveFrom))
            throw new OperationError('적용일을 확인해 주세요.', 422);
          c.effectiveFrom = effectiveFrom || undefined;
        }
      }
      if (
        config.classes.some(
          (c) => !next.classes.some((n) => n.classId === c.classId),
        )
      )
        throw new OperationError(
          '기존 반 시간표는 삭제할 수 없습니다. 원본 보존을 위해 개정해 주세요.',
          409,
        );
      state = {
        ...state,
        events: state.events.map((e) => ({
          ...e,
          classSnapshot:
            e.classSnapshot ?? classOnDate(academy, e.classId, e.date),
        })),
      };
      const nextAcademy = academyConfig(ctx.db, ctx.actor.academyId, next);
      const dates = new Set<string>(
        state.events.flatMap((e) => [
          e.date,
          ...(e.makeup ? [e.makeup.date] : []),
        ]),
      );
      for (const c of next.classes)
        for (const period of [...(c.history ?? []), c]) {
          const start = period.effectiveFrom ?? today;
          for (let offset = 0; offset < 7; offset++)
            dates.add(addDays(start, offset));
        }
      for (const date of dates) {
        const before = new Set(resourceConflicts(academy, state, date));
        const added = resourceConflicts(nextAcademy, state, date).filter(
          (issue) => !before.has(issue),
        );
        if (added.length)
          throw new OperationError(date + ' ' + added.join(' / '), 409);
      }
      // Existing consultation slots also constrain new regular lessons.
      const slots = rows<{
        staff_id: string;
        starts_at: number;
        ends_at: number;
      }>(
        ctx.db,
        'SELECT staff_id,starts_at,ends_at FROM ops_consultation_slots WHERE academy_id=? AND revoked_at IS NULL',
        ctx.actor.academyId,
      );
      for (const slot of slots) {
        const startDay = new Date(slot.starts_at + 32400000)
          .toISOString()
          .slice(0, 10);
        const endDay = new Date(slot.ends_at + 32400000)
          .toISOString()
          .slice(0, 10);
        for (let day = startDay; day <= endDay; day = addDays(day, 1))
          for (const c of next.classes) {
            const period = classOnDate(nextAcademy, c.classId, day);
            if (
              !period ||
              period.teacher !== slot.staff_id ||
              !period.days.includes(new Date(day + 'T00:00:00Z').getUTCDay())
            )
              continue;
            if (
              state.events.some(
                (e) =>
                  e.status === 'confirmed' &&
                  e.scope === 'class' &&
                  e.classId === c.classId &&
                  e.date === day,
              )
            )
              continue;
            if (
              Date.parse(day + 'T' + period.start + ':00+09:00') <
                slot.ends_at &&
              slot.starts_at < Date.parse(day + 'T' + period.end + ':00+09:00')
            )
              throw new OperationError(
                '시간표가 기존 상담 예약 시간과 겹칩니다.',
                409,
              );
          }
      }
      config = next;
    } else if (action === 'availability') {
      const studentId = required(form, 'studentId', '학생');
      if (
        !accessibleStudents(ctx.db, ctx.actor).some((s) => s.id === studentId)
      )
        throw new OperationError('학생 접근 권한이 없습니다.', 403);
      let raw: unknown;
      if (field(form, 'windows')) {
        try {
          raw = JSON.parse(field(form, 'windows', 10000));
        } catch {
          throw new OperationError('가능 시간 형식을 확인해 주세요.', 422);
        }
      } else if (field(form, 'clearAvailability') === 'yes') raw = [];
      else
        raw = form.getAll('days').map((day) => ({
          day: Number(day),
          start: required(form, 'start', '시작'),
          end: required(form, 'end', '종료'),
        }));
      if (
        !field(form, 'windows') &&
        field(form, 'clearAvailability') !== 'yes' &&
        !form.getAll('days').length
      )
        throw new OperationError('가능 요일을 선택해 주세요.', 422);
      const parsed = windows.safeParse(raw);
      if (!parsed.success)
        throw new OperationError('가능 시간 형식을 확인해 주세요.', 422);
      const result = setAvailability(academy, state, studentId, parsed.data);
      if (!result.ok) throw new OperationError(result.error, 422);
      state = result.state;
    } else {
      if (!staff(ctx))
        throw new OperationError('일정 관리 권한이 없습니다.', 403);
      const eventId = field(form, 'eventId');
      const event = state.events.find((e) => e.eventId === eventId);
      if (eventId && (!event || !visible(ctx, event)))
        throw new OperationError('일정을 찾을 수 없습니다.', 404);
      const classId = event?.classId ?? required(form, 'classId', '반');
      if (!accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === classId))
        throw new OperationError('반 관리 권한이 없습니다.', 403);
      const confirm = field(form, 'confirm') === 'yes';
      if (
        ctx.actor.role !== 'admin' &&
        (confirm || action === 'confirm' || event?.status === 'confirmed')
      )
        throw new OperationError(
          '일정 확정·확정 일정 변경은 관리자만 할 수 있습니다.',
          403,
        );
      const now = new Date().toISOString();
      const makeupDate = field(form, 'makeupDate');
      if (action === 'change' && !makeupDate)
        throw new OperationError(
          '변경할 보강일을 입력해 주세요. 취소하려면 보강 취소를 선택해 주세요.',
          422,
        );
      const makeup = makeupDate
        ? {
            date: makeupDate,
            start: required(form, 'makeupStart', '보강 시작'),
            room: required(form, 'room', '교실'),
          }
        : null;
      let result;
      if (action === 'create') {
        const scope = required(form, 'scope', '대상');
        if (scope !== 'class' && scope !== 'student')
          throw new OperationError('대상을 확인해 주세요.');
        result = createEvent(
          academy,
          state,
          {
            scope,
            classId,
            studentId:
              scope === 'student' ? required(form, 'studentId', '학생') : null,
            date: required(form, 'date', '날짜'),
            reason: field(form, 'reason', 500),
            makeup,
            confirm,
          },
          now,
        );
      } else if (action === 'confirm')
        result = confirmEvent(academy, state, eventId, now);
      else if (action === 'change' || action === 'clear')
        result = changeMakeup(
          academy,
          state,
          eventId,
          action === 'clear' ? null : makeup,
          now,
        );
      else if (action === 'withdraw')
        result = withdrawEvent(academy, state, eventId, now);
      else throw new OperationError('지원하지 않는 작업입니다.');
      if (!result.ok)
        throw new OperationError(
          [result.error, ...result.issues.map((i) => i.message)].join(' '),
          422,
        );
      state = result.state;
    }
    if (action !== 'availability')
      assertUnifiedSchedule(
        ctx.db,
        ctx.actor.academyId,
        state,
        academyConfig(ctx.db, ctx.actor.academyId, config),
      );
    ctx.db
      .prepare(
        'INSERT INTO op_team_schedule VALUES (?, ?, ?, ?) ON CONFLICT(academy_id) DO UPDATE SET version=excluded.version, config=excluded.config, state=excluded.state',
      )
      .run(
        ctx.actor.academyId,
        old.version + 1,
        JSON.stringify(config),
        JSON.stringify(state),
      );
    ctx.db
      .prepare('INSERT INTO op_team_schedule_history VALUES (?, ?, ?, ?, ?)')
      .run(
        ctx.actor.academyId,
        old.version + 1,
        ctx.actor.id,
        JSON.stringify({ config, state }),
        new Date().toISOString(),
      );
  });
}

function render(ctx: PageContext) {
  const row = stored(ctx.db, ctx.actor.academyId);
  const config = JSON.parse(row.config) as Config;
  const state = JSON.parse(row.state) as ScheduleState;
  const academy = academyConfig(ctx.db, ctx.actor.academyId, config);
  const students = accessibleStudents(ctx.db, ctx.actor);
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const hidden = `<input type="hidden" name="version" value="${row.version}">`;
  const options = (list: { id: string; name: string }[]) =>
    list
      .map((x) => `<option value="${h(x.id)}">${h(x.name)}</option>`)
      .join('');
  const eventCard = (
    event: ScheduleEvent,
  ) => `<article class="panel"><div class="panel-heading"><h2>${h(academy.classes.find((c) => c.classId === event.classId)?.name)} ${event.scope === 'student' ? h(students.find((s) => s.id === event.studentId)?.name) + ' 결석' : '휴강'}</h2><span class="pill">${{ draft: '임시 저장', confirmed: '확정', withdrawn: '취소' }[event.status]}</span></div><p>${h(event.date)} · ${event.makeup ? `${h(event.makeup.date)} ${h(event.makeup.start)}~${h(event.makeup.end)} ${h(event.makeup.room)} 보강` : '보강 미정'}</p>
    ${staff(ctx) && event.status !== 'withdrawn' && (ctx.actor.role === 'admin' || event.status === 'draft') ? `<form method="post">${hidden}<input type="hidden" name="eventId" value="${h(event.eventId)}"><div class="fields"><label>새 보강일<input type="date" name="makeupDate"></label><label>시작<input type="time" name="makeupStart"></label><label>교실<select name="room">${config.rooms.map((r) => `<option>${h(r)}</option>`).join('')}</select></label></div><div class="actions"><button name="action" value="change">보강 지정·변경</button>${event.status === 'draft' && ctx.actor.role === 'admin' ? '<button name="action" value="confirm">일정 확정</button>' : ''}${event.makeup ? '<button class="secondary" name="action" value="clear">보강 취소</button>' : ''}<button class="secondary" name="action" value="withdraw">휴강·결석 취소</button></div></form>` : ''}</article>`;
  const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.now() + 31 * 86400000 + 32400000)
    .toISOString()
    .slice(0, 10);
  const configuredStudents = students.filter((s) =>
    academy.students
      .find((x) => x.studentId === s.id)
      ?.classIds.some((id) => academy.classes.some((c) => c.classId === id)),
  );
  const sessions = staff(ctx)
    ? ''
    : configuredStudents
        .map(
          (s) =>
            `<section class="panel"><h2>${h(s.name)} · 앞으로 한 달</h2><ul class="item-list">${studentSchedule(
              academy,
              state,
              s.id,
              today,
              monthEnd,
            )
              .map(
                (x) =>
                  `<li>${h(x.date)} · ${h(x.start)}~${h(x.end)} ${h(x.className)} <span class="pill">${{ regular: '정규 수업', canceled: '휴강', absent: '결석', makeup: '보강' }[x.kind]}</span></li>`,
              )
              .join('')}</ul></section>`,
        )
        .join('');
  const teachers = rows<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM accounts WHERE academy_id = ? AND role IN ('admin','teacher') ORDER BY name",
    ctx.actor.academyId,
  );
  return `<div class="page-heading"><p class="eyebrow">ACADEMY CALENDAR</p><h1>휴·보강 일정</h1><p class="muted">원장이 확정한 일정이 상담에 반영됩니다.</p></div>
    ${ctx.actor.role === 'admin' ? `<details class="panel" ${config.classes.length ? '' : 'open'}><summary>정규 시간표 설정 · ${config.classes.length}개 반 등록</summary><p class="muted">모든 반의 정규 수업을 등록하면 강사·교실·원생의 시간 겹침을 함께 확인할 수 있습니다.</p><ul>${academy.classes.map((c) => `<li>${h(c.name)} · ${c.days.map((d) => '일월화수목금토'[d]).join('·')} · ${h(c.start)}~${h(c.end)} · ${h(c.room)}</li>`).join('')}</ul><form method="post">${hidden}<input type="hidden" name="action" value="class-config"><div class="fields"><label>반<select name="classId">${options(classes)}</select></label><label>담당 강사<select name="teacher">${options(teachers)}</select></label><label>교실<input name="room" maxlength="60" required value="1강의실"></label><label>시작<input name="start" type="time" required></label><label>종료<input name="end" type="time" required></label><label>학원 동시 수용 인원<input name="capacity" type="number" min="1" max="1000" value="${config.capacity}" required></label><label>학원 수업 종료 한도<input name="closeTime" type="time" value="${h(config.closeTime)}" required></label></div><fieldset><legend>정규 수업 요일</legend><div class="actions">${[...'일월화수목금토'].map((d, i) => `<label class="check-label"><input type="checkbox" name="days" value="${i}">${d}</label>`).join('')}</div></fieldset><button>시간표 저장</button></form></details>` : ''}
    ${staff(ctx) ? `<details class="panel"><summary>휴강·결석 등록</summary><form method="post">${hidden}<input type="hidden" name="action" value="create"><div class="fields"><label>반<select name="classId" required>${options(classes.filter((c) => academy.classes.some((x) => x.classId === c.id)))}</select></label><label>대상<select name="scope"><option value="class">반 전체 휴강</option><option value="student">학생 결석</option></select></label><label>결석 학생<select name="studentId"><option value="">반 휴강은 선택하지 않음</option>${options(students)}</select></label><label>휴강·결석일<input type="date" name="date" required></label><label>보강일 (미정이면 비움)<input type="date" name="makeupDate"></label><label>보강 시작<input type="time" name="makeupStart"></label><label>교실<select name="room">${config.rooms.map((r) => `<option>${h(r)}</option>`).join('')}</select></label></div><label>사유<input name="reason" maxlength="500"></label>${ctx.actor.role === 'admin' ? '<label class="check-label"><input type="checkbox" name="confirm" value="yes">일정 확정</label>' : ''}<button>일정 저장</button></form></details>` : ''}
    ${sessions}<div class="module-grid">${
      state.events
        .filter((e) => visible(ctx, e))
        .map(eventCard)
        .join('') || '<p class="empty">등록된 일정이 없습니다.</p>'
    }</div>
    ${configuredStudents.length ? `<details class="panel"><summary>보강 가능 시간 등록</summary><form method="post">${hidden}<input type="hidden" name="action" value="availability"><label>학생<select name="studentId">${options(configuredStudents)}</select></label><fieldset><legend>가능 요일</legend><div class="actions">${[...'일월화수목금토'].map((d, i) => `<label class="check-label"><input type="checkbox" name="days" value="${i}">${d}</label>`).join('')}</div></fieldset><div class="fields"><label>시작<input name="start" type="time"></label><label>종료<input name="end" type="time"></label></div><p class="muted">저장하면 기존 가능 시간을 선택한 요일·시간으로 바꿉니다.</p><div class="actions"><button>가능 시간 저장</button><button class="secondary" name="clearAvailability" value="yes">가능 시간 초기화</button></div></form><ul>${configuredStudents.map((s) => `<li>${h(s.name)} · ${h(formatWindows(state.availability?.[s.id] ?? [])) || '미등록'}</li>`).join('')}</ul></details>` : ''}
    ${
      staff(ctx)
        ? `<details class="panel"><summary>안내문 발송 대기</summary><p class="muted">안내문은 저장되어 있으며 외부 메시지는 발송하지 않습니다.</p>${state.outbox
            .filter((n) => {
              const e = state.events.find((e) => e.eventId === n.eventId);
              return e && visible(ctx, e);
            })
            .map(
              (n) =>
                `<article class="message"><strong>${h(n.kind)}</strong><p class="preserve">${h(n.text)}</p></article>`,
            )
            .join('')}</details>`
        : ''
    }`;
}
export const teamScheduleModule: OperationModule = {
  path: '/makeup',
  label: '휴·보강 일정',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup: setupTeamSchedule,
  render,
  submit,
};

export function calendarSessions(ctx: PageContext, from: string, to: string) {
  const record = stored(ctx.db, ctx.actor.academyId);
  const state = JSON.parse(record.state) as ScheduleState;
  const academy = academyConfig(
    ctx.db,
    ctx.actor.academyId,
    JSON.parse(record.config),
  );
  const sessions = new Map<
    string,
    { date: string; label: string; kind: string }
  >();
  const allowed = new Set(
    accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
  );
  for (const s of accessibleStudents(ctx.db, ctx.actor)) {
    const member = academy.students.find((x) => x.studentId === s.id);
    if (!member) continue;
    const safe = {
      ...academy,
      students: academy.students.map((x) =>
        x.studentId === s.id
          ? {
              ...x,
              classIds: x.classIds.filter(
                (id) =>
                  allowed.has(id) &&
                  academy.classes.some((c) => c.classId === id),
              ),
            }
          : x,
      ),
    };
    for (const x of studentSchedule(safe, state, s.id, from, to)) {
      if (!allowed.has(x.classId)) continue;
      const label =
        x.start +
        ' ' +
        x.className +
        ' ' +
        { regular: '수업', canceled: '휴강', absent: '결석', makeup: '보강' }[
          x.kind
        ];
      sessions.set(
        JSON.stringify([x.date, x.start, x.classId, x.eventId, x.kind]),
        { date: x.date, label, kind: x.kind },
      );
    }
  }
  return [...sessions.values()];
}
