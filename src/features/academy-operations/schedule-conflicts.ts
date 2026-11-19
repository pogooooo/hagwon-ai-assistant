import { classesOnDate } from '../makeup-schedule/model/timetable.ts';
import { assertPollSessionFree } from './makeup-polls.ts';
import type { OperationsDatabase } from './database.ts';
import type {
  AcademyConfig,
  ScheduleState,
} from '../makeup-schedule/model/types.ts';
import { one, rows, OperationError } from './shared.ts';

interface NoticeRange {
  id: string;
  class_id: string | null;
  closure_start: number;
  closure_end: number;
  makeup_start: number | null;
  makeup_end: number | null;
}
const overlap = (a: number, b: number, c: number, d: number) => a < d && c < b;
const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+09:00`);
const hasTable = (db: OperationsDatabase, name: string) =>
  !!one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
export function assertUnifiedSchedule(
  db: OperationsDatabase,
  academy: string,
  state: ScheduleState,
  config: Pick<AcademyConfig, 'classes'>,
  replacement?: NoticeRange,
) {
  if (hasTable(db, 'op_makeup_sessions')) {
    const sessions = rows<{ starts_at: number; ends_at: number }>(
      db,
      'SELECT starts_at,ends_at FROM op_makeup_sessions WHERE academy_id=?',
      academy,
    );
    for (const s of sessions) {
      const day = new Date(s.starts_at + 32400000).toISOString().slice(0, 10);
      const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
      for (const c of classesOnDate(config, day)) {
        if (
          !c.days.includes(weekday) ||
          state.events.some(
            (e) =>
              e.scope === 'class' &&
              e.status === 'confirmed' &&
              e.classId === c.classId &&
              e.date === day,
          )
        )
          continue;
        const students =
          'students' in config
            ? (config as AcademyConfig).students
                .filter((s) => s.classIds.includes(c.classId))
                .map((s) => s.studentId)
            : [];
        assertPollSessionFree(
          db,
          academy,
          at(day, c.start),
          at(day, c.end),
          c.teacher,
          c.room,
          students,
        );
      }
    }
    for (const e of state.events)
      if (e.status === 'confirmed' && e.makeup) {
        const c =
          e.classSnapshot ??
          config.classes.find((c) => c.classId === e.classId);
        if (c)
          assertPollSessionFree(
            db,
            academy,
            at(e.makeup.date, e.makeup.start),
            at(e.makeup.date, e.makeup.end),
            c.teacher,
            e.makeup.room,
            e.studentId ? [e.studentId] : [],
          );
      }
    if (replacement) {
      const teacherIds = replacement.class_id
        ? rows<{ teacher_id: string }>(
            db,
            'SELECT teacher_id FROM teacher_classes WHERE class_id=?',
            replacement.class_id,
          ).map((t) => t.teacher_id)
        : [];
      for (const s of sessions)
        if (
          overlap(
            replacement.closure_start,
            replacement.closure_end,
            s.starts_at,
            s.ends_at,
          )
        )
          throw new OperationError(
            '휴강 공지가 승인된 보강 투표 일정과 겹칩니다.',
            409,
          );
      if (replacement.makeup_start !== null && replacement.makeup_end !== null)
        for (const teacher of teacherIds)
          assertPollSessionFree(
            db,
            academy,
            replacement.makeup_start,
            replacement.makeup_end,
            teacher,
            '',
            [],
          );
    }
  }
  if (!hasTable(db, 'ops_schedule_notices')) return;
  const notices = rows<NoticeRange>(
    db,
    'SELECT * FROM ops_schedule_notices WHERE academy_id=? AND revoked_at IS NULL',
    academy,
  ).filter((n) => n.id !== replacement?.id);
  if (replacement) notices.push(replacement);
  for (const event of state.events.filter((e) => e.status === 'confirmed')) {
    const klass =
      event.classSnapshot ??
      config.classes.find((c) => c.classId === event.classId);
    if (!klass) continue;
    const intervals = [
      [at(event.date, klass.start), at(event.date, klass.end)],
    ];
    if (event.makeup)
      intervals.push([
        at(event.makeup.date, event.makeup.start),
        at(event.makeup.date, event.makeup.end),
      ]);
    for (const notice of notices) {
      if (notice.class_id && notice.class_id !== event.classId) continue;
      const other = [[notice.closure_start, notice.closure_end]];
      if (notice.makeup_start !== null && notice.makeup_end !== null)
        other.push([notice.makeup_start, notice.makeup_end]);
      if (
        intervals.some(([a, b]) => other.some(([c, d]) => overlap(a, b, c, d)))
      )
        throw new OperationError(
          '학원 공지와 휴·보강 일정이 겹칩니다. 기존 일정을 변경하거나 철회한 뒤 등록해 주세요.',
          409,
        );
    }
    if (
      event.makeup &&
      hasTable(db, 'ops_consultation_slots') &&
      one(
        db,
        'SELECT 1 FROM ops_consultation_slots WHERE academy_id=? AND staff_id=? AND revoked_at IS NULL AND starts_at < ? AND ends_at > ?',
        academy,
        klass.teacher,
        at(event.makeup.date, event.makeup.end),
        at(event.makeup.date, event.makeup.start),
      )
    )
      throw new OperationError(
        '담당 강사의 상담 예약 시간과 보강이 겹칩니다.',
        409,
      );
  }
}
export function checkNoticeAgainstTeam(
  db: OperationsDatabase,
  academy: string,
  notice: NoticeRange,
) {
  if (!hasTable(db, 'op_team_schedule')) return;
  const record = one<{ state: string; config: string }>(
    db,
    'SELECT state,config FROM op_team_schedule WHERE academy_id=?',
    academy,
  );
  if (record)
    assertUnifiedSchedule(
      db,
      academy,
      JSON.parse(record.state),
      JSON.parse(record.config),
      notice,
    );
}
export function assertTeacherFree(
  db: OperationsDatabase,
  academy: string,
  teacher: string,
  start: number,
  end: number,
) {
  assertPollSessionFree(db, academy, start, end, teacher, '', []);
  if (!hasTable(db, 'op_team_schedule')) return;
  const record = one<{ state: string; config: string }>(
    db,
    'SELECT state,config FROM op_team_schedule WHERE academy_id=?',
    academy,
  );
  if (!record) return;
  const state = JSON.parse(record.state) as ScheduleState;
  const config = JSON.parse(record.config) as Pick<AcademyConfig, 'classes'>;
  if (end - start > 31 * 86400000)
    throw new OperationError('상담 기간은 31일 이내로 선택해 주세요.', 422);
  const first = new Date(start + 32400000).toISOString().slice(0, 10);
  for (
    let stamp = Date.parse(first + 'T00:00:00+09:00');
    stamp < end;
    stamp += 86400000
  ) {
    const day = new Date(stamp + 32400000).toISOString().slice(0, 10);
    const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
    for (const klass of classesOnDate(config, day))
      if (
        klass.teacher === teacher &&
        klass.days.includes(weekday) &&
        !state.events.some(
          (e) =>
            e.status === 'confirmed' &&
            e.scope === 'class' &&
            e.classId === klass.classId &&
            e.date === day,
        ) &&
        overlap(start, end, at(day, klass.start), at(day, klass.end))
      )
        throw new OperationError('담당 강사의 정규 수업 시간과 겹칩니다.', 409);
  }
  for (const e of state.events) {
    const klass =
      e.classSnapshot ?? config.classes.find((c) => c.classId === e.classId);
    if (
      e.status === 'confirmed' &&
      e.makeup &&
      klass?.teacher === teacher &&
      overlap(
        start,
        end,
        at(e.makeup.date, e.makeup.start),
        at(e.makeup.date, e.makeup.end),
      )
    )
      throw new OperationError('담당 강사의 보강 시간과 겹칩니다.', 409);
  }
}
