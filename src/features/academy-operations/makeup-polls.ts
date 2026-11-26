import { randomUUID } from 'node:crypto';
import {
  changeMakeup,
  checkMakeup,
  createEvent,
  emptyState,
  suggestMakeups,
  withdrawEvent,
} from '../makeup-schedule/model/schedule.ts';
import { classOnDate } from '../makeup-schedule/model/timetable.ts';
import { kstDateOf } from '../makeup-schedule/model/time.ts';
import { parseMakeupRequest } from './makeup-assistant-intent.ts';
import { assertUnifiedSchedule } from './schedule-conflicts.ts';
import { saveTeamSchedule } from './team-schedule-store.ts';
import type {
  AcademyConfig,
  ScheduleState,
  MakeupSlot,
  ScheduleEvent,
} from '../makeup-schedule/model/types.ts';
import {
  accessibleClasses,
  accessibleStudents,
  getActor,
} from './directory.ts';
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
import type { OperationsDatabase } from './database.ts';
import type {
  SourceDocumentInput,
  ApprovedFactInput,
} from '../rag-consultation/server/types.ts';

interface Closure {
  key: string;
  stamp: string;
  classId: string;
  date: string;
  label: string;
  eventId?: string;
}
interface Poll {
  id: string;
  academy_id: string;
  source_key: string;
  version: number;
  state: string;
  payload: string;
}
interface GuardianTarget {
  guardian: string;
  student: string;
}
interface AssistantProposal {
  question: string;
  original: MakeupSlot;
  recipients: GuardianTarget[];
  answers: Record<string, boolean>;
  sender?: string;
  teacher?: string;
  notice?: { recipients: string[]; readBy: string[] };
  eventId?: string;
  resolution?: 'declined' | 'schedule_changed';
}
interface Payload {
  closure: Closure;
  students: string[];
  options: MakeupSlot[];
  votes: Record<string, number[]>;
  groups?: { option: number; students: string[] }[];
  approvedBy?: string;
  approvedAt?: string;
  assistant?: AssistantProposal;
}
const staff = (ctx: PageContext) =>
  ['admin', 'teacher'].includes(ctx.actor.role);
const at = (s: MakeupSlot): [number, number] => [
  Date.parse(s.date + 'T' + s.start + ':00+09:00'),
  Date.parse(s.date + 'T' + s.end + ':00+09:00'),
];
const overlap = (a: number, b: number, c: number, d: number) => a < d && c < b;
const label = (s: MakeupSlot) => `${s.date} ${s.start}~${s.end} · ${s.room}`;
const exists = (db: OperationsDatabase, name: string) =>
  !!one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export function setupMakeupPolls(db: OperationsDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_makeup_polls(id TEXT PRIMARY KEY, academy_id TEXT NOT NULL, source_key TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(academy_id,source_key));
    CREATE TABLE IF NOT EXISTS op_makeup_sessions(id TEXT PRIMARY KEY,poll_id TEXT NOT NULL,academy_id TEXT NOT NULL,class_id TEXT NOT NULL,teacher_id TEXT NOT NULL,room TEXT NOT NULL,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,students TEXT NOT NULL);`);
}
export function assertPollSourceEditable(
  db: OperationsDatabase,
  academy: string,
  key: string,
) {
  if (
    exists(db, 'op_makeup_polls') &&
    one(
      db,
      "SELECT id FROM op_makeup_polls WHERE academy_id=? AND source_key=? AND state='approved'",
      academy,
      key,
    )
  )
    throw new OperationError(
      '먼저 승인된 보강 투표 일정을 취소한 뒤 원래 휴강을 변경해 주세요.',
      409,
    );
}
function team(ctx: PageContext) {
  const r = one<{ version: number; config: string; state: string }>(
    ctx.db,
    'SELECT version,config,state FROM op_team_schedule WHERE academy_id=?',
    ctx.actor.academyId,
  );
  if (!r)
    throw new OperationError(
      '먼저 휴·보강 화면에서 반 시간표와 담당 강사·교실을 등록해 주세요.',
      422,
    );
  const storedConfig = JSON.parse(r.config) as AcademyConfig;
  const names = new Map(
    rows<{ id: string; name: string }>(
      ctx.db,
      'SELECT id,name FROM classes WHERE academy_id=?',
      ctx.actor.academyId,
    ).map(({ id, name }) => [id, name]),
  );
  const config = {
    ...storedConfig,
    classes: storedConfig.classes
      .filter((c) => names.has(c.classId))
      .map((c) => ({
        ...c,
        name: names.get(c.classId)!,
      })),
  };
  config.students = rows<{ id: string; name: string }>(
    ctx.db,
    'SELECT id,name FROM students WHERE academy_id=?',
    ctx.actor.academyId,
  ).map((s) => ({
    studentId: s.id,
    name: s.name,
    classIds: rows<{ class_id: string }>(
      ctx.db,
      'SELECT class_id FROM student_class_memberships WHERE academy_id=? AND student_id=? AND ended_at IS NULL',
      ctx.actor.academyId,
      s.id,
    ).map((m) => m.class_id),
  }));
  return {
    config,
    state: JSON.parse(r.state) as ScheduleState,
    storedConfig,
    version: r.version,
  };
}
function closures(ctx: PageContext): Closure[] {
  const allowed = new Set(
    accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
  );
  const result: Closure[] = [];
  if (exists(ctx.db, 'op_team_schedule')) {
    const r = one<{ state: string }>(
      ctx.db,
      'SELECT state FROM op_team_schedule WHERE academy_id=?',
      ctx.actor.academyId,
    );
    if (r)
      for (const e of (JSON.parse(r.state) as ScheduleState).events)
        if (
          e.scope === 'class' &&
          e.status === 'confirmed' &&
          !e.makeup &&
          allowed.has(e.classId)
        )
          result.push({
            key: 'team:' + e.eventId,
            stamp: JSON.stringify(e),
            classId: e.classId,
            date: e.date,
            eventId: e.eventId,
            label: `${e.date} ${e.classSnapshot?.name ?? e.classId} 휴강`,
          });
  }
  if (exists(ctx.db, 'ops_schedule_notices'))
    for (const n of rows<{
      id: string;
      class_id: string;
      title: string;
      closure_start: number;
      revision: number;
    }>(
      ctx.db,
      "SELECT * FROM ops_schedule_notices WHERE academy_id=? AND revoked_at IS NULL AND makeup_kind='pending' AND class_id IS NOT NULL",
      ctx.actor.academyId,
    ))
      if (allowed.has(n.class_id))
        result.push({
          key: 'notice:' + n.id,
          stamp: JSON.stringify(n),
          classId: n.class_id,
          date: new Date(n.closure_start + 32400000).toISOString().slice(0, 10),
          label: n.title,
        });
  return result;
}
function roster(ctx: PageContext, classId: string) {
  return rows<{ student_id: string }>(
    ctx.db,
    'SELECT DISTINCT student_id FROM student_class_memberships WHERE academy_id=? AND class_id=? AND ended_at IS NULL ORDER BY student_id',
    ctx.actor.academyId,
    classId,
  ).map((s) => s.student_id);
}
function requireStaff(ctx: PageContext, classId: string) {
  if (
    !staff(ctx) ||
    !accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === classId)
  )
    throw new OperationError('담당 반의 교사 권한이 필요합니다.', 403);
}
function load(ctx: PageContext, id: string) {
  const p = one<Poll>(
    ctx.db,
    'SELECT * FROM op_makeup_polls WHERE academy_id=? AND id=?',
    ctx.actor.academyId,
    id,
  );
  if (!p) throw new OperationError('보강 투표를 찾을 수 없습니다.', 404);
  const data = JSON.parse(p.payload) as Payload;
  const own = accessibleStudents(ctx.db, ctx.actor).filter(
    (s) =>
      data.students.includes(s.id) && s.classIds.includes(data.closure.classId),
  );
  if (staff(ctx)) requireStaff(ctx, data.closure.classId);
  else if (
    !own.length ||
    (data.assistant &&
      (ctx.actor.role !== 'guardian' ||
        !data.assistant.recipients.some(
          ({ guardian }) => guardian === ctx.actor.id,
        )))
  )
    throw new OperationError('이 반 투표에 접근할 수 없습니다.', 403);
  return { p, data, own };
}

/** Used by every schedule writer as well as poll approval. No unknown vote is availability. */
export function assertPollSessionFree(
  db: OperationsDatabase,
  academy: string,
  start: number,
  end: number,
  teacher: string,
  room: string,
  students: string[],
  exceptPoll = '',
) {
  if (!exists(db, 'op_makeup_sessions')) return;
  for (const s of rows<{
    poll_id: string;
    teacher_id: string;
    room: string;
    students: string;
  }>(
    db,
    "SELECT s.* FROM op_makeup_sessions s JOIN op_makeup_polls p ON p.id=s.poll_id WHERE s.academy_id=? AND p.state='approved' AND starts_at<? AND ends_at>? AND poll_id<>?",
    academy,
    end,
    start,
    exceptPoll,
  ))
    if (
      (teacher && teacher === s.teacher_id) ||
      (room && room === s.room) ||
      students.some((id) => (JSON.parse(s.students) as string[]).includes(id))
    )
      throw new OperationError(
        '승인된 보강 투표 일정과 강사·교실·학생 시간이 겹칩니다.',
        409,
      );
}
function conflicts(ctx: PageContext, data: Payload, slot: MakeupSlot) {
  const { config, state } = team(ctx),
    c =
      state.events.find((e) => e.eventId === data.closure.eventId)
        ?.classSnapshot ??
      classOnDate(config, data.closure.classId, data.closure.date);
  if (!c) throw new OperationError('대상 반의 시간표가 없습니다.', 422);
  const result = checkMakeup(config, state, {
    scope: 'class',
    classId: c.classId,
    classSnapshot: c,
    studentId: null,
    eventId: data.closure.eventId,
    date: slot.date,
    start: slot.start,
    room: slot.room,
  });
  const blockedBy = new Set(
    result.issues.filter((issue) => issue.blocking).map((issue) => issue.type),
  );
  if (config.holidays[slot.date]) blockedBy.add('공휴일');
  if (!result.slot || result.slot.end !== slot.end) blockedBy.add('시간');
  if (blockedBy.size)
    throw new OperationError(
      '확정 불가 · ' +
        [...blockedBy]
          .map(
            (reason) =>
              ({
                입력: '후보 시간 정보 오류',
                시간: '운영 시간 또는 수업 길이 변경',
                정원: '동시 수강 정원 초과',
                공휴일: '공휴일',
                강사: '교사 일정 겹침',
                교실: '교실 사용 중',
                원생: '학생 일정 겹침',
                가능시간: '학생 가능 시간과 겹치지 않음',
              })[reason],
          )
          .join(' · '),
      409,
    );
  const [start, end] = at(slot);
  if (slot.date <= data.closure.date || start < Date.now())
    throw new OperationError('휴강 이후의 미래 시간을 선택해 주세요.', 422);
  for (const n of rows<{
    class_id: string | null;
    closure_start: number;
    closure_end: number;
    makeup_start: number | null;
    makeup_end: number | null;
  }>(
    ctx.db,
    'SELECT * FROM ops_schedule_notices WHERE academy_id=? AND revoked_at IS NULL',
    ctx.actor.academyId,
  )) {
    const otherTeachers = n.class_id
      ? rows<{ teacher_id: string }>(
          ctx.db,
          'SELECT teacher_id FROM teacher_classes WHERE class_id=?',
          n.class_id,
        ).map((t) => t.teacher_id)
      : [];
    const related =
      !n.class_id ||
      n.class_id === c.classId ||
      otherTeachers.includes(c.teacher);
    if (
      related &&
      (overlap(start, end, n.closure_start, n.closure_end) ||
        (n.makeup_start !== null &&
          n.makeup_end !== null &&
          overlap(start, end, n.makeup_start, n.makeup_end)))
    )
      throw new OperationError('기존 휴·보강 공지와 겹칩니다.', 409);
  }
  if (
    exists(ctx.db, 'ops_consultation_slots') &&
    one(
      ctx.db,
      'SELECT 1 FROM ops_consultation_slots WHERE academy_id=? AND staff_id=? AND revoked_at IS NULL AND starts_at<? AND ends_at>?',
      ctx.actor.academyId,
      c.teacher,
      end,
      start,
    )
  )
    throw new OperationError('담당 강사의 상담 예약 시간과 겹칩니다.', 409);
  assertPollSessionFree(
    ctx.db,
    ctx.actor.academyId,
    start,
    end,
    c.teacher,
    slot.room,
    data.students,
  );
  return c;
}
export function pollChoices(
  data: Payload,
  available = (i: number) => !!data.options[i],
) {
  const missing = data.students.filter((id) => !Object.hasOwn(data.votes, id));
  const impossible = data.students.filter(
    (id) => Object.hasOwn(data.votes, id) && !data.votes[id].length,
  );
  const rank = (id: string, i: number) => data.votes[id]?.indexOf(i) ?? -1;
  const singles = data.options
    .flatMap((_, i) =>
      available(i) &&
      !missing.length &&
      data.students.every((id) => rank(id, i) >= 0)
        ? [
            {
              groups: [{ option: i, students: [...data.students] }],
              score: data.students.reduce((n, id) => n + rank(id, i), 0),
            },
          ]
        : [],
    )
    .sort((a, b) => a.score - b.score);
  const pairs: {
    groups: { option: number; students: string[] }[];
    score: number;
  }[] = [];
  if (!singles.length && !missing.length && !impossible.length)
    for (let a = 0; a < data.options.length; a++)
      for (let b = a + 1; b < data.options.length; b++) {
        if (
          !available(a) ||
          !available(b) ||
          overlap(...at(data.options[a]), ...at(data.options[b]))
        )
          continue;
        const groups = [
          { option: a, students: [] as string[] },
          { option: b, students: [] as string[] },
        ];
        let score = 0,
          ok = true;
        for (const id of data.students) {
          const ra = rank(id, a),
            rb = rank(id, b);
          if (ra < 0 && rb < 0) {
            ok = false;
            break;
          }
          const g = ra >= 0 && (rb < 0 || ra <= rb) ? 0 : 1;
          groups[g].students.push(id);
          score += g ? rb : ra;
        }
        if (ok && groups.every((g) => g.students.length))
          pairs.push({ groups, score });
      }
  return {
    missing,
    impossible,
    choices: (singles.length
      ? singles
      : pairs.sort((a, b) => a.score - b.score)
    ).slice(0, 5),
  };
}
function suggestPollOptions(
  ctx: PageContext,
  data: Payload,
  config: AcademyConfig,
  state: ScheduleState,
  after: string,
) {
  const snapshot =
    state.events.find((e) => e.eventId === data.closure.eventId)
      ?.classSnapshot ??
    classOnDate(config, data.closure.classId, data.closure.date);
  return config.rooms
    .flatMap((room) =>
      suggestMakeups(
        config,
        state,
        {
          scope: 'class',
          classId: data.closure.classId,
          classSnapshot: snapshot,
          studentId: null,
          eventId: data.closure.eventId,
          room,
          after,
        },
        12,
      ).map((s) => s.slot),
    )
    .filter((s) => {
      try {
        conflicts(ctx, data, s);
        return true;
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return false;
      }
    })
    .slice(0, 12);
}

/** Provision an open, in-app poll only in the two hosted synthetic academies. */
export function seedDemoMakeupPolls(db: OperationsDatabase) {
  const scenarios = [
    [
      'AC_TEST_A',
      '[가상] 테스트 교습소',
      'TA_DIRECTOR',
      'TA_TEACHER',
      'TA_E_MATH',
      'TA_STU_001',
      '초등 수학반',
      [1, 3],
      '16:00',
      '17:00',
    ],
    [
      'AC_ONDAP_LANGUAGE_DEMO',
      '[가상] 온답 어학원',
      'ONDAP_LANGUAGE_TA_DIRECTOR',
      'ONDAP_LANGUAGE_TA_TEACHER',
      'ONDAP_DEMO_ENGLISH',
      'ONDAP_DEMO_LEARNER',
      '영어 회화반',
      [2, 4],
      '17:00',
      '18:20',
    ],
  ] as const;
  for (const [
    academy,
    name,
    admin,
    teacher,
    classId,
    learner,
    className,
    days,
    start,
    end,
  ] of scenarios) {
    const id = 'trial-makeup-' + academy;
    const actor = getActor(db, admin);
    if (
      !actor ||
      actor.academyId !== academy ||
      actor.role !== 'admin' ||
      !one(
        db,
        'SELECT 1 FROM academies WHERE id=? AND name=?',
        academy,
        name,
      ) ||
      !one(
        db,
        'SELECT 1 FROM classes WHERE id=? AND academy_id=?',
        classId,
        academy,
      ) ||
      !one(
        db,
        'SELECT 1 FROM teacher_classes WHERE teacher_id=? AND class_id=?',
        teacher,
        classId,
      ) ||
      one(db, 'SELECT 1 FROM op_makeup_polls WHERE id=?', id)
    )
      continue;
    const ctx = { db, actor, url: new URL('http://localhost/makeup-votes') };
    const students = roster(ctx, classId);
    if (!students.includes(learner)) continue;
    const stored = one<{ version: number; config: string; state: string }>(
      db,
      'SELECT version,config,state FROM op_team_schedule WHERE academy_id=?',
      academy,
    );
    const config: AcademyConfig = stored
      ? team(ctx).config
      : {
          academyId: academy,
          name,
          capacity: 12,
          closeTime: '22:00',
          rooms: ['1강의실'],
          holidays: {},
          students: [],
          classes: [
            {
              classId,
              name: className,
              days: [...days],
              start,
              end,
              teacher,
              room: '1강의실',
            },
          ],
        };
    const fallback = config.classes.find((c) => c.classId === classId);
    if (!fallback) continue;
    const state: ScheduleState = stored
      ? (JSON.parse(stored.state) as ScheduleState)
      : emptyState();
    if (!stored)
      config.students = students.map((studentId) => ({
        studentId,
        name: '',
        classIds: [classId],
      }));
    const now = new Date();
    const dates = Array.from(
      { length: 14 },
      (_, i) => new Date(now.getTime() + (i + 2) * 86400000 + 32400000),
    );
    const events = dates.map((day) =>
      createEvent(
        config,
        state,
        {
          scope: 'class',
          classId,
          date: day.toISOString().slice(0, 10),
          reason: '원내 연수',
          confirm: true,
        },
        now.toISOString(),
      ),
    );
    const created = events.find((result) => result.ok);
    if (!created?.ok) continue;
    const { event } = created;
    const closure: Closure = {
      key: 'team:' + event.eventId,
      stamp: JSON.stringify(event),
      date: event.date,
      classId,
      eventId: event.eventId,
      label: event.date + ' ' + className + ' 휴강',
    };
    try {
      transaction(db, () => {
        const next = { ...created.state, outbox: state.outbox };
        const schedule = JSON.stringify(next);
        if (stored)
          db.prepare(
            'UPDATE op_team_schedule SET version=version+1,state=? WHERE academy_id=?',
          ).run(schedule, academy);
        else
          db.prepare('INSERT INTO op_team_schedule VALUES(?,1,?,?)').run(
            academy,
            JSON.stringify(config),
            schedule,
          );
        db.prepare(
          'INSERT INTO op_team_schedule_history VALUES(?,?,?,?,?)',
        ).run(
          academy,
          (stored?.version ?? 0) + 1,
          actor.id,
          JSON.stringify({
            config: stored ? JSON.parse(stored.config) : config,
            state: next,
          }),
          now.toISOString(),
        );
        const data: Payload = { closure, students, options: [], votes: {} };
        data.options = suggestPollOptions(
          ctx,
          data,
          config,
          next,
          closure.date,
        ).slice(0, 5);
        if (!data.options.length)
          throw new OperationError('체험 학급에 보강 후보가 없습니다.', 422);
        if (students.includes('ONDAP_DEMO_QA_LEARNER'))
          data.votes.ONDAP_DEMO_QA_LEARNER =
            data.options.length > 1 ? [0, 1] : [0];
        db.prepare('INSERT INTO op_makeup_polls VALUES(?,?,?,1,?,?)').run(
          id,
          academy,
          closure.key,
          'open',
          JSON.stringify(data),
        );
      });
    } catch (error) {
      if (!(error instanceof OperationError) || error.status !== 422)
        throw error;
    }
  }
}

const assistantPath = '/schedule?view=makeup';
const votePath = (id: string) => '/makeup-votes?id=' + encodeURIComponent(id);
const voteReceiptPath = (id: string) =>
  '/makeup-votes?submitted=' + encodeURIComponent(id) + '#vote-receipt';
const assistantPollPath = (id: string) =>
  assistantPath + '&poll=' + encodeURIComponent(id);

function guardianTargets(ctx: PageContext, classId: string) {
  return rows<GuardianTarget>(
    ctx.db,
    `SELECT DISTINCT a.id AS guardian, m.student_id AS student
     FROM student_class_memberships m
     JOIN guardian_students g ON g.student_id=m.student_id
     JOIN accounts a ON a.id=g.guardian_id AND a.academy_id=m.academy_id AND a.role='guardian'
     WHERE m.academy_id=? AND m.class_id=? AND m.ended_at IS NULL
     ORDER BY student, guardian`,
    ctx.actor.academyId,
    classId,
  );
}

function guardians(proposal: AssistantProposal) {
  return [...new Set(proposal.recipients.map(({ guardian }) => guardian))];
}

function responseExpired(proposal: AssistantProposal) {
  return at(proposal.original)[0] <= Date.now();
}

function assistantSource(
  schedule: ReturnType<typeof team>,
  classId: string,
  date: string,
) {
  const { config, state } = schedule;
  const existing = state.events.find(
    (event) =>
      event.classId === classId &&
      event.date === date &&
      event.scope === 'class' &&
      event.status !== 'withdrawn',
  );
  if (existing && (existing.status !== 'confirmed' || existing.makeup))
    throw new OperationError(
      '이미 등록된 휴강 또는 보강이 있습니다. 휴·보강 일정에서 확인해 주세요.',
      409,
    );
  const lesson = existing?.classSnapshot ?? classOnDate(config, classId, date);
  if (!lesson)
    throw new OperationError(
      '해당 반의 날짜별 시간표를 먼저 등록해 주세요.',
      422,
    );
  const original = {
    date,
    start: lesson.start,
    end: lesson.end,
    room: lesson.room,
  };
  if (at(original)[0] <= Date.now())
    throw new OperationError(
      '이미 시작한 수업입니다. 앞으로 변경할 수업을 선택해 주세요.',
      422,
    );
  if (!existing) {
    if (config.holidays[date])
      throw new OperationError(
        '공휴일에 등록된 수업인지 휴·보강 일정에서 확인해 주세요.',
        422,
      );
    const checked = createEvent(
      config,
      state,
      { classId, date, scope: 'class', confirm: false },
      new Date().toISOString(),
    );
    if (!checked.ok) throw new OperationError(checked.error, 422);
  }
  return {
    original,
    closure: {
      key: existing
        ? 'team:' + existing.eventId
        : 'assistant:' + classId + ':' + date,
      stamp: JSON.stringify([lesson, existing]),
      classId,
      date,
      label: date + ' ' + lesson.name + ' 보강 투표',
      ...(existing ? { eventId: existing.eventId } : {}),
    },
  };
}

function verifyAssistantSource(ctx: PageContext, data: Payload) {
  const schedule = team(ctx);
  const live = assistantSource(
    schedule,
    data.closure.classId,
    data.closure.date,
  );
  if (
    live.closure.key !== data.closure.key ||
    live.closure.stamp !== data.closure.stamp ||
    JSON.stringify(roster(ctx, data.closure.classId)) !==
      JSON.stringify(data.students)
  )
    throw new OperationError(
      '원래 수업이나 대상 학생이 변경됐습니다. 새 투표를 준비해 주세요.',
      409,
    );
  return schedule;
}

function prepareAssistantPoll(ctx: PageContext, question: string) {
  const { classId, date } = parseMakeupRequest(
    question,
    accessibleClasses(ctx.db, ctx.actor),
    kstDateOf(Date.now()),
  );
  requireStaff(ctx, classId);
  const schedule = team(ctx);
  const { original, closure } = assistantSource(schedule, classId, date);
  const previous = one<Poll>(
    ctx.db,
    `SELECT * FROM op_makeup_polls WHERE academy_id=? AND source_key IN (?,?)
     ORDER BY CASE WHEN state='draft' THEN 1 ELSE 0 END, CASE WHEN source_key=? THEN 0 ELSE 1 END LIMIT 1`,
    ctx.actor.academyId,
    closure.key,
    'assistant:' + classId + ':' + date,
    closure.key,
  );
  if (previous) {
    const existing = JSON.parse(previous.payload) as Payload;
    if (!existing.assistant) return votePath(previous.id);
    if (previous.state !== 'draft') return assistantPollPath(previous.id);
  }
  const students = roster(ctx, classId);
  if (!students.length)
    throw new OperationError('등록된 수강생이 없습니다.', 422);
  const assistant: AssistantProposal = {
    question,
    original,
    recipients: guardianTargets(ctx, classId),
    answers: {},
  };
  const data: Payload = {
    closure,
    students,
    options: [],
    votes: {},
    assistant,
  };
  const [slot] = suggestPollOptions(
    ctx,
    data,
    schedule.config,
    schedule.state,
    date,
  );
  if (!slot)
    throw new OperationError(
      '시간표와 예약이 겹치지 않는 보강 후보를 찾지 못했습니다.',
      422,
    );
  data.options = [slot];
  const id = previous?.id ?? randomUUID();
  if (previous)
    ctx.db
      .prepare(
        'UPDATE op_makeup_polls SET version=version+1,source_key=?,payload=? WHERE id=?',
      )
      .run(closure.key, JSON.stringify(data), id);
  else
    ctx.db
      .prepare('INSERT INTO op_makeup_polls VALUES(?,?,?,?,?,?)')
      .run(
        id,
        ctx.actor.academyId,
        closure.key,
        1,
        'draft',
        JSON.stringify(data),
      );
  return assistantPollPath(id);
}

function persistPoll(ctx: PageContext, p: Poll, data: Payload) {
  ctx.db
    .prepare(
      'UPDATE op_makeup_polls SET version=version+1,state=?,source_key=?,payload=? WHERE id=? AND version=?',
    )
    .run(p.state, p.source_key, JSON.stringify(data), p.id, p.version);
}

export function submitMakeupAssistant(ctx: PageContext, form: FormData) {
  if (!staff(ctx))
    throw new OperationError(
      'AI 비서는 교사와 원장이 사용할 수 있습니다.',
      403,
    );
  return transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const action = field(form, 'action');
    if (action === 'makeup_request')
      return prepareAssistantPoll(
        ctx,
        required(form, 'question', '휴강 요청', 500),
      );
    if (action !== 'assistant_publish' && action !== 'assistant_read')
      throw new OperationError('지원하지 않는 AI 비서 요청입니다.', 400);
    const { p, data } = load(ctx, required(form, 'id', '투표'));
    const proposal = data.assistant;
    if (!proposal)
      throw new OperationError('AI 비서에서 준비한 투표를 선택해 주세요.', 422);
    if (action === 'assistant_read') {
      const { notice } = proposal;
      if (!notice?.recipients.includes(ctx.actor.id))
        throw new OperationError('확인할 수 없는 보강 결과입니다.', 404);
      if (!notice.readBy.includes(ctx.actor.id)) {
        notice.readBy.push(ctx.actor.id);
        persistPoll(ctx, p, data);
      }
      return assistantPollPath(p.id);
    }
    if (p.state === 'open' || p.state === 'approved')
      return assistantPollPath(p.id);
    if (p.state !== 'draft' || field(form, 'version') !== String(p.version))
      throw new OperationError(
        '후보가 변경됐습니다. 현재 후보를 다시 확인해 주세요.',
        409,
      );
    const slot = data.options[0];
    if (!slot)
      throw new OperationError(
        '추천할 보강 시간이 없습니다. 새 요청을 입력해 주세요.',
        422,
      );
    const schedule = verifyAssistantSource(ctx, data);
    planAssistantChange(ctx, schedule, data, slot, new Date().toISOString());
    const targets = guardianTargets(ctx, data.closure.classId);
    if (JSON.stringify(targets) !== JSON.stringify(proposal.recipients))
      throw new OperationError(
        '연결된 보호자 목록이 바뀌었습니다. AI 비서에서 후보를 다시 찾아 주세요.',
        409,
      );
    if (
      new Set(targets.map(({ student }) => student)).size !==
      data.students.length
    )
      throw new OperationError(
        '연결된 보호자가 없는 학생이 있습니다. 원생·반·계정에서 확인해 주세요.',
        422,
      );
    data.options = [slot];
    proposal.sender = ctx.actor.id;
    proposal.teacher = classOnDate(
      schedule.config,
      data.closure.classId,
      data.closure.date,
    )?.teacher;
    p.state = 'open';
    persistPoll(ctx, p, data);
    return assistantPollPath(p.id);
  });
}

function planAssistantChange(
  ctx: PageContext,
  schedule: ReturnType<typeof team>,
  data: Payload,
  slot: MakeupSlot,
  now: string,
) {
  const { classId, date, eventId } = data.closure;
  conflicts(ctx, data, slot);
  const result = eventId
    ? changeMakeup(schedule.config, schedule.state, eventId, slot, now)
    : createEvent(
        schedule.config,
        schedule.state,
        {
          scope: 'class',
          classId,
          date,
          makeup: slot,
          confirm: true,
          reason: '대상 보호자 전원 동의로 수업 시간 변경',
        },
        now,
      );
  if (!result.ok) throw new OperationError(result.error, 409);
  assertUnifiedSchedule(
    ctx.db,
    ctx.actor.academyId,
    result.state,
    schedule.config,
  );
  return result;
}

function confirmAssistantChange(
  ctx: PageContext,
  data: Payload,
  proposal: AssistantProposal,
) {
  const sender = proposal.sender && getActor(ctx.db, proposal.sender);
  if (!sender || sender.academyId !== ctx.actor.academyId)
    throw new OperationError(
      '투표를 보낸 교사의 일정 변경 권한을 확인해 주세요.',
      409,
    );
  const { classId } = data.closure;
  requireStaff({ ...ctx, actor: sender }, classId);
  if (
    JSON.stringify(guardianTargets(ctx, classId)) !==
    JSON.stringify(proposal.recipients)
  )
    throw new OperationError('투표 대상 보호자가 변경됐습니다.', 409);
  const schedule = verifyAssistantSource(ctx, data);
  const now = new Date().toISOString();
  const result = planAssistantChange(ctx, schedule, data, data.options[0], now);
  return { schedule, result, sender, now };
}

function assistantVote(
  ctx: PageContext,
  p: Poll,
  data: Payload,
  form: FormData,
) {
  const proposal = data.assistant;
  if (
    !proposal ||
    ctx.actor.role !== 'guardian' ||
    !proposal.recipients.some(({ guardian }) => guardian === ctx.actor.id)
  )
    throw new OperationError('초대받은 보호자만 응답할 수 있습니다.', 403);
  const answer = field(form, 'answer');
  if (answer !== 'yes' && answer !== 'no')
    throw new OperationError('가능 또는 불가를 선택해 주세요.', 422);
  const address = voteReceiptPath(p.id);
  // An invited account has one immutable response to this exact proposal.
  if (Object.hasOwn(proposal.answers, ctx.actor.id)) return address;
  if (p.state !== 'open')
    throw new OperationError('현재 응답할 수 있는 투표가 아닙니다.', 409);
  if (responseExpired(proposal))
    throw new OperationError('원래 수업 시간이 지나 응답을 마감했습니다.', 409);
  proposal.answers = { ...proposal.answers, [ctx.actor.id]: answer === 'yes' };
  const targets = guardians(proposal);
  if (targets.every((id) => Object.hasOwn(proposal.answers, id))) {
    if (targets.some((id) => !proposal.answers[id]))
      proposal.resolution = 'declined';
    else {
      let confirmed: ReturnType<typeof confirmAssistantChange> | undefined;
      try {
        confirmed = confirmAssistantChange(ctx, data, proposal);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        proposal.resolution = 'schedule_changed';
      }
      if (confirmed) {
        const { schedule, result, sender, now } = confirmed;
        saveTeamSchedule(
          ctx.db,
          ctx.actor.academyId,
          schedule.version + 1,
          sender.id,
          schedule.storedConfig,
          result.state,
          now,
        );
        proposal.eventId = result.event.eventId;
        p.source_key = 'team:' + result.event.eventId;
        p.state = 'approved';
      }
    }
    const recipients = [
      ...new Set(
        [proposal.sender, proposal.teacher].filter((id): id is string => !!id),
      ),
    ];
    if (recipients.length) proposal.notice = { recipients, readBy: [] };
  }
  persistPoll(ctx, p, data);
  return address;
}

function cancelAssistantSchedule(
  ctx: PageContext,
  data: Payload,
  eventId: string,
) {
  const schedule = team(ctx);
  const current = schedule.state.events.find(
    (event) => event.eventId === eventId,
  );
  if (!current || current.status !== 'confirmed' || !current.makeup)
    throw new OperationError(
      '보강 일정이 변경됐습니다. 현재 학원 일정에서 확인해 주세요.',
      409,
    );
  const now = new Date().toISOString();
  const keepClosure =
    !!data.closure.eventId || at(data.assistant!.original)[0] <= Date.now();
  const result = keepClosure
    ? changeMakeup(schedule.config, schedule.state, eventId, null, now)
    : withdrawEvent(schedule.config, schedule.state, eventId, now);
  if (!result.ok) throw new OperationError(result.error, 409);
  assertUnifiedSchedule(
    ctx.db,
    ctx.actor.academyId,
    result.state,
    schedule.config,
  );
  saveTeamSchedule(
    ctx.db,
    ctx.actor.academyId,
    schedule.version + 1,
    ctx.actor.id,
    schedule.storedConfig,
    result.state,
    now,
  );
}

function submit(ctx: PageContext, form: FormData) {
  return transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const action = required(form, 'action', '작업');
    if (action === 'create') {
      const closure = closures(ctx).find(
        (c) => c.key === required(form, 'source', '휴강'),
      );
      if (!closure)
        throw new OperationError('보강 미정인 확정 휴강을 선택해 주세요.', 422);
      requireStaff(ctx, closure.classId);
      const { config, state } = team(ctx);
      const students = roster(ctx, closure.classId);
      if (!students.length) throw new OperationError('대상 학생이 없습니다.');
      const after = [
        closure.date,
        new Date(Date.now() + 32400000).toISOString().slice(0, 10),
      ]
        .sort()
        .at(-1)!;
      const data: Payload = { closure, students, options: [], votes: {} };
      data.options = suggestPollOptions(ctx, data, config, state, after);
      if (!data.options.length)
        throw new OperationError(
          '충돌 없는 보강 후보가 없습니다. 시간표와 예약을 확인해 주세요.',
          422,
        );
      if (
        one(
          ctx.db,
          'SELECT id FROM op_makeup_polls WHERE academy_id=? AND source_key=?',
          ctx.actor.academyId,
          closure.key,
        )
      )
        throw new OperationError('이미 투표가 있습니다.', 409);
      const id = randomUUID();
      ctx.db
        .prepare('INSERT INTO op_makeup_polls VALUES(?,?,?,?,?,?)')
        .run(
          id,
          ctx.actor.academyId,
          closure.key,
          1,
          'draft',
          JSON.stringify(data),
        );
      return '/makeup-votes?id=' + id;
    }
    const { p, data, own } = load(ctx, required(form, 'id', '투표'));
    if (action === 'assistant_vote') return assistantVote(ctx, p, data, form);
    if (field(form, 'version') !== String(p.version))
      throw new OperationError(
        '응답이 변경됐습니다. 새로고침 후 다시 확인해 주세요.',
        409,
      );
    if (action === 'cancel') {
      requireStaff(ctx, data.closure.classId);
      if (p.state === 'approved' && data.assistant?.eventId)
        cancelAssistantSchedule(ctx, data, data.assistant.eventId);
      ctx.db
        .prepare(
          "UPDATE op_makeup_polls SET state='cancelled',source_key=?,version=version+1 WHERE id=?",
        )
        .run('cancelled:' + p.id, p.id);
      return data.assistant ? assistantPollPath(p.id) : votePath(p.id);
    }
    if (data.assistant)
      throw new OperationError(
        'AI 비서 투표는 보호자의 가능·불가 응답으로 진행합니다.',
        422,
      );
    if (p.state === 'cancelled')
      throw new OperationError('취소된 투표입니다.', 409);
    if (p.state === 'approved')
      throw new OperationError('이미 승인된 투표입니다.', 409);
    if (action === 'publish') {
      requireStaff(ctx, data.closure.classId);
      if (p.state !== 'draft')
        throw new OperationError('후보 선택은 초안에서만 가능합니다.', 409);
      const selected = form.getAll('options').map(Number);
      if (
        selected.length < 1 ||
        selected.length > 5 ||
        new Set(selected).size !== selected.length ||
        selected.some((i) => !Number.isInteger(i) || !data.options[i])
      )
        throw new OperationError('후보를 1~5개 선택해 주세요.');
      data.options = selected.map((i) => data.options[i]);
      data.options.forEach((s) => conflicts(ctx, data, s));
      p.state = 'open';
    } else if (action === 'vote') {
      if (
        p.state !== 'open' ||
        !['student', 'guardian'].includes(ctx.actor.role)
      )
        throw new OperationError(
          '학생·보호자만 열린 투표에 응답할 수 있습니다.',
          403,
        );
      const id = required(form, 'student', '학생');
      if (!own.some((s) => s.id === id))
        throw new OperationError(
          '본인 또는 연결 학생만 응답할 수 있습니다.',
          403,
        );
      const ranks = [1, 2, 3]
        .map((i) => field(form, 'rank' + i))
        .filter(Boolean)
        .map(Number);
      const none = field(form, 'unavailable') === 'yes';
      if (
        (none && ranks.length) ||
        (!none && !ranks.length) ||
        ranks.length > 3 ||
        new Set(ranks).size !== ranks.length ||
        ranks.some((i) => !Number.isInteger(i) || !data.options[i])
      )
        throw new OperationError(
          '가능한 시간을 중복 없이 1~3순위로 선택하거나 모두 불가를 선택해 주세요.',
        );
      data.votes[id] = ranks;
    } else if (action === 'approve') {
      requireStaff(ctx, data.closure.classId);
      if (p.state !== 'open')
        throw new OperationError('열린 투표만 승인할 수 있습니다.');
      const current = closures(ctx).find((c) => c.key === data.closure.key);
      if (
        !current ||
        current.stamp !== data.closure.stamp ||
        JSON.stringify(roster(ctx, data.closure.classId)) !==
          JSON.stringify(data.students)
      )
        throw new OperationError(
          '휴강 또는 대상 명단이 바뀌었습니다. 기존 투표를 다시 검토해 주세요.',
          409,
        );
      const choices = pollChoices(data, (i) => {
        try {
          conflicts(ctx, data, data.options[i]);
          return true;
        } catch {
          return false;
        }
      }).choices;
      const choice = choices[Number(required(form, 'choice', '확정안'))];
      if (!choice)
        throw new OperationError(
          '미응답·불가·충돌을 해결한 후 제안된 확정안을 선택해 주세요.',
          409,
        );
      for (const [index, g] of choice.groups.entries()) {
        const slot = data.options[g.option],
          c = conflicts(ctx, data, slot),
          [start, end] = at(slot);
        ctx.db
          .prepare('INSERT INTO op_makeup_sessions VALUES(?,?,?,?,?,?,?,?,?)')
          .run(
            p.id + ':' + index,
            p.id,
            ctx.actor.academyId,
            data.closure.classId,
            c.teacher,
            slot.room,
            start,
            end,
            JSON.stringify(g.students),
          );
      }
      data.groups = choice.groups;
      data.approvedBy = ctx.actor.id;
      data.approvedAt = new Date().toISOString();
      p.state = 'approved';
    } else throw new OperationError('지원하지 않는 작업입니다.');
    persistPoll(ctx, p, data);
    return action === 'vote' ? voteReceiptPath(p.id) : votePath(p.id);
  });
}
export function pendingMakeupNotices(ctx: PageContext): string {
  if (
    !['student', 'guardian'].includes(ctx.actor.role) ||
    !exists(ctx.db, 'op_makeup_polls')
  )
    return '';
  const students = accessibleStudents(ctx.db, ctx.actor);
  const notices = rows<Pick<Poll, 'id' | 'payload'>>(
    ctx.db,
    "SELECT id,payload FROM op_makeup_polls WHERE academy_id=? AND state='open' ORDER BY rowid DESC",
    ctx.actor.academyId,
  ).flatMap((poll) => {
    const data = JSON.parse(poll.payload) as Payload;
    if (data.assistant) {
      if (
        ctx.actor.role !== 'guardian' ||
        Object.hasOwn(data.assistant.answers, ctx.actor.id) ||
        responseExpired(data.assistant) ||
        !data.assistant.recipients.some(
          ({ guardian, student }) =>
            guardian === ctx.actor.id &&
            students.some(
              (own) =>
                own.id === student &&
                own.classIds.includes(data.closure.classId),
            ),
        )
      )
        return [];
      return [
        `<li><a class="workspace-link" href="${h(votePath(poll.id))}">${h(data.closure.label)} · 가능 여부 응답 <span aria-hidden="true">›</span></a></li>`,
      ];
    }
    return students
      .filter(
        (s) =>
          s.classIds.includes(data.closure.classId) &&
          data.students.includes(s.id) &&
          !Object.hasOwn(data.votes, s.id),
      )
      .map(
        (s) =>
          `<li><a class="workspace-link" href="/makeup-votes?id=${encodeURIComponent(poll.id)}"><span><strong>${h(data.closure.label)}</strong><small>${h(s.name)}</small></span><span>가능 시간 응답 <span aria-hidden="true">›</span></span></a></li>`,
      );
  });
  return notices.length
    ? `<section class="panel home-makeup"><h2>응답할 보강 투표</h2><ul class="makeup-notice-list">${notices.join('')}</ul></section>`
    : '';
}

function staffAssistantPolls(ctx: PageContext) {
  if (!staff(ctx) || !exists(ctx.db, 'op_makeup_polls')) return [];
  const allowed = new Set(
    accessibleClasses(ctx.db, ctx.actor).map(({ id }) => id),
  );
  return rows<Poll>(
    ctx.db,
    "SELECT * FROM op_makeup_polls WHERE academy_id=? AND json_type(payload,'$.assistant')='object' ORDER BY rowid DESC",
    ctx.actor.academyId,
  ).flatMap((p) => {
    const data = JSON.parse(p.payload) as Payload;
    return allowed.has(data.closure.classId) ? [{ p, data }] : [];
  });
}

function unreadMakeupResult(ctx: PageContext, data: Payload) {
  const notice = data.assistant?.notice;
  return (
    notice?.recipients.includes(ctx.actor.id) &&
    !notice.readBy.includes(ctx.actor.id)
  );
}

export function makeupResultNotices(ctx: PageContext) {
  const notices = staffAssistantPolls(ctx).filter(({ data }) =>
    unreadMakeupResult(ctx, data),
  );
  return notices.length
    ? `<section class="panel makeup-result-notices"><h2>보강 응답 완료 <span class="pill">${notices.length}건</span></h2><ul class="record-card-list">${notices.map(({ p, data }) => `<li><a class="record-card-link" href="${h(assistantPollPath(p.id))}"><span><strong>${h(data.closure.label)}</strong><small>${h(assistantStatus(p, data.assistant!))}</small></span><span aria-hidden="true">›</span></a></li>`).join('')}</ul></section>`
    : '';
}

export function renderMakeupAssistant(ctx: PageContext) {
  if (!staff(ctx))
    throw new OperationError(
      'AI 비서는 교사와 원장이 사용할 수 있습니다.',
      403,
    );
  const id = ctx.url.searchParams.get('poll');
  const current = id ? load(ctx, id) : undefined;
  const proposal = current?.data.assistant;
  const error =
    ctx.formError &&
    ['makeup_request', 'assistant_publish', 'assistant_read'].includes(
      String(ctx.submittedForm?.get('action')),
    )
      ? `<p class="poll-conflict" role="alert">${h(ctx.formError)}</p>`
      : '';
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const otherRequests = staffAssistantPolls(ctx)
    .filter(({ p }) => p.id !== id)
    .slice(0, 8);
  return `<section class="panel makeup-assistant" id="makeup-assistant"><div class="panel-heading"><h2>휴·보강 비서</h2>${current ? `<a class="workspace-link" href="${assistantPath}#makeup-assistant">새 요청</a>` : ''}</div>
    ${error}
    ${
      proposal && current
        ? `<div class="conversation-messages"><article class="message question" aria-label="휴강 요청"><div class="message-content"><div class="message-bubble"><p>${h(proposal.question)}</p></div></div></article>
      <article class="message answer"><img class="message-avatar" src="/assets/app-192.png" alt="" width="36" height="36"><div class="message-content"><strong class="message-sender">휴·보강 비서</strong><div class="message-bubble">
      ${
        current.p.state === 'draft'
          ? `<dl class="makeup-proposal"><div><dt>원래 수업</dt><dd>${h(label(proposal.original))}</dd></div><div><dt>추천 보강</dt><dd>${h(label(current.data.options[0]))}</dd></div></dl><p>이 시간으로 보호자에게 투표를 보낼까요?</p>
      <form class="makeup-assistant-action" method="post" action="${h(assistantPollPath(current.p.id))}">
        <input type="hidden" name="id" value="${h(current.p.id)}"><input type="hidden" name="version" value="${current.p.version}">
        <button type="submit" name="action" value="assistant_publish">보호자 ${guardians(proposal).length}명에게 투표 보내기</button>
      </form>`
          : renderAssistantBallot(
              ctx,
              current.p,
              current.data,
              `<input type="hidden" name="id" value="${h(current.p.id)}"><input type="hidden" name="version" value="${current.p.version}">`,
            )
      }
      </div></div></article></div>
      ${unreadMakeupResult(ctx, current.data) ? `<form class="actions" method="post" action="${h(assistantPollPath(current.p.id))}"><input type="hidden" name="id" value="${h(current.p.id)}"><button class="secondary" name="action" value="assistant_read">결과 확인했어요</button></form>` : ''}`
        : '<p class="muted">반 이름과 휴강일을 알려주세요. 시간표와 예약을 확인해 가능한 보강 시간을 찾아드립니다.</p>'
    }
    <form class="chat-composer" data-makeup-composer method="post" action="${h(assistantPath)}">
      <label class="compose-question"><span>휴강 요청</span><textarea name="question" rows="2" maxlength="500" required placeholder="다음 주 수요일 ${h(classes[0]?.name ?? 'A반')} 휴강할게요.">${ctx.submittedForm?.get('action') === 'makeup_request' ? h(ctx.submittedForm.get('question')) : h((ctx.url.searchParams.get('q') ?? '').slice(0, 500))}</textarea></label>
      <div class="compose-actions"><button type="submit" name="action" value="makeup_request">보내기 <span aria-hidden="true">↑</span></button></div>
      <p class="chat-progress" role="status" aria-live="polite"></p>
    </form>
    ${otherRequests.length ? `<details class="makeup-assistant-history"><summary>이전 휴·보강 요청</summary><ul class="record-card-list">${otherRequests.map(({ p, data }) => `<li><a class="record-card-link" href="${h(assistantPollPath(p.id))}"><span><strong>${h(data.closure.label)}</strong><small>${h(pollListStatus(p, data))}</small></span><span aria-hidden="true">›</span></a></li>`).join('')}</ul></details>` : ''}
    </section>`;
}

function assistantStatus(p: Poll, proposal: AssistantProposal) {
  if (p.state === 'approved') return '보강 확정 · 학원 일정에 반영됐습니다.';
  if (p.state === 'cancelled') return '투표가 취소됐습니다.';
  if (proposal.resolution === 'declined')
    return '전원 응답 완료 · 불가 응답이 있어 새 시간을 정해야 합니다.';
  if (proposal.resolution === 'schedule_changed')
    return '전원 응답 완료 · 일정 또는 대상 정보가 바뀌어 보강을 확정하지 못했습니다.';
  if (responseExpired(proposal))
    return '응답 마감 · 원래 수업 시작 전까지 동의가 모이지 않았습니다.';
  return '보호자 응답 중 · 전원이 가능으로 응답하면 보강이 확정됩니다.';
}

function renderAssistantBallot(
  ctx: PageContext,
  p: Poll,
  data: Payload,
  hidden: string,
) {
  const proposal = data.assistant!;
  const targets = guardians(proposal);
  const responses = targets.filter((id) => Object.hasOwn(proposal.answers, id));
  const yes = responses.filter((id) => proposal.answers[id]).length;
  const voted = Object.hasOwn(proposal.answers, ctx.actor.id);
  const expired = responseExpired(proposal);
  return `<dl class="assistant-vote-times"><div><dt>원래 수업</dt><dd>${h(label(proposal.original))}</dd></div><div><dt>보강 시간</dt><dd>${h(label(data.options[0]))}</dd></div></dl>
    ${voted ? `<div id="vote-receipt" class="vote-receipt" role="status" tabindex="-1"><strong>응답 저장 완료</strong><span>내 응답은 ${proposal.answers[ctx.actor.id] ? '가능' : '불가'}입니다.</span></div>` : ''}
    <p class="poll-waiting">${h(assistantStatus(p, proposal))}</p>
    <div class="poll-response-summary"><strong>${responses.length}/${targets.length}명 응답</strong><span>가능 ${yes}명 · 불가 ${responses.length - yes}명 · 대기 ${targets.length - responses.length}명</span></div>
    ${p.state === 'open' && !expired && !staff(ctx) && !voted ? `<p class="muted">원래 수업이 시작하기 전까지 응답해 주세요.</p><form class="actions" method="post">${hidden}<input type="hidden" name="action" value="assistant_vote"><button type="submit" name="answer" value="yes">가능해요</button><button class="secondary" type="submit" name="answer" value="no">어려워요</button></form>` : ''}
    ${p.state === 'approved' ? `<a class="button-link subtle-link" href="/schedule?month=${h(data.options[0].date.slice(0, 7))}">학원 일정에서 보기</a>` : ''}
    ${staff(ctx) && p.state !== 'cancelled' ? `<details class="poll-cancel"><summary>취소 옵션</summary><form method="post" action="${h(votePath(p.id))}">${hidden}<button class="secondary" name="action" value="cancel">${p.state === 'approved' ? '확정한 보강 취소' : '투표 취소'}</button></form></details>` : ''}`;
}

function approvedSlots(ctx: PageContext, data: Payload, own: { id: string }[]) {
  return (data.groups ?? [])
    .filter(
      (group) =>
        staff(ctx) ||
        group.students.some((id) => own.some((student) => student.id === id)),
    )
    .map((group) => data.options[group.option])
    .filter(Boolean);
}

export function teamMakeupPoll(ctx: PageContext, event: ScheduleEvent) {
  if (
    event.scope !== 'class' ||
    event.status !== 'confirmed' ||
    event.makeup ||
    !exists(ctx.db, 'op_makeup_polls')
  )
    return;
  const row = one<{ id: string }>(
    ctx.db,
    "SELECT id FROM op_makeup_polls WHERE academy_id=? AND source_key=? AND state IN ('draft','open','approved')",
    ctx.actor.academyId,
    'team:' + event.eventId,
  );
  if (!row) return;
  try {
    const { p, data, own } = load(ctx, row.id);
    const stamp = data.assistant
      ? JSON.stringify([
          event.classSnapshot ??
            classOnDate(team(ctx).config, event.classId, event.date),
          event,
        ])
      : JSON.stringify(event);
    if ((!staff(ctx) && p.state === 'draft') || data.closure.stamp !== stamp)
      return;
    return {
      state: p.state,
      href:
        staff(ctx) && data.assistant ? assistantPollPath(p.id) : votePath(p.id),
      slots: p.state === 'approved' ? approvedSlots(ctx, data, own) : [],
      responded: data.assistant
        ? Object.hasOwn(data.assistant.answers, ctx.actor.id) ||
          responseExpired(data.assistant)
        : own.length > 0 && own.every((s) => Object.hasOwn(data.votes, s.id)),
    };
  } catch (error) {
    if (
      !(error instanceof OperationError) ||
      ![403, 404].includes(error.status)
    )
      throw error;
  }
}

function pollListStatus(poll: Poll, data: Payload) {
  if (poll.state === 'approved') return '확정';
  if (poll.state === 'cancelled') return '취소';
  if (poll.state === 'draft') return '후보 선택';
  if (data.assistant) {
    if (data.assistant.resolution) return '전원 응답';
    if (responseExpired(data.assistant)) return '응답 마감';
  } else if (data.students.every((id) => Object.hasOwn(data.votes, id)))
    return '전원 응답';
  return '응답 중';
}

function render(ctx: PageContext) {
  const isStaff = staff(ctx);
  const records = rows<Pick<Poll, 'id'>>(
    ctx.db,
    'SELECT id FROM op_makeup_polls WHERE academy_id=? ORDER BY rowid DESC',
    ctx.actor.academyId,
  ).flatMap(({ id }) => {
    try {
      const record = load(ctx, id);
      return isStaff || record.p.state !== 'draft' ? [record] : [];
    } catch (error) {
      if (error instanceof OperationError && [403, 404].includes(error.status))
        return [];
      throw error;
    }
  });
  const listing = isStaff
    ? records
    : records.filter(
        ({ p, data, own }) =>
          p.state === 'open' &&
          (data.assistant
            ? !responseExpired(data.assistant) &&
              !Object.hasOwn(data.assistant.answers, ctx.actor.id)
            : own.some(({ id }) => !Object.hasOwn(data.votes, id))),
      );
  const chosen = ctx.url.searchParams.get('id');
  const chosenRecord = chosen && records.find(({ p }) => p.id === chosen);
  if (chosen && !chosenRecord)
    throw new OperationError('조회 가능한 투표가 아닙니다.', 404);
  let html =
    '<div class="workspace-heading"><h1>보강 시간 투표</h1><a class="button-link subtle-link" href="/schedule' +
    (isStaff ? '?view=makeup">휴강 관리' : '">학원 일정') +
    '</a></div><div class="poll-workspace">';
  if (ctx.formError)
    html += `<p class="panel poll-conflict" role="alert">${h(ctx.formError)}</p>`;
  const submitted = ctx.url.searchParams.get('submitted');
  if (!isStaff && !chosen && submitted) {
    const receipt = records.find(({ p }) => p.id === submitted);
    if (receipt) {
      const { p, data, own } = receipt;
      const proposal = data.assistant;
      const saved = proposal
        ? Object.hasOwn(proposal.answers, ctx.actor.id)
        : own.some(({ id }) => Object.hasOwn(data.votes, id));
      if (saved) {
        const details = proposal
          ? proposal.answers[ctx.actor.id]
            ? '가능으로 응답했습니다.'
            : '불가로 응답했습니다.'
          : '응답이 저장됐습니다.';
        const schedule =
          proposal && p.state === 'approved'
            ? `<a class="workspace-link" href="/schedule?month=${h(data.options[0].date.slice(0, 7))}">보강 확정 · 학원 일정 보기</a>`
            : '';
        html += `<div id="vote-receipt" class="vote-receipt" role="status" tabindex="-1"><strong>응답 저장 완료</strong><span>${details}</span>${schedule}</div>`;
      }
    }
  }
  const selected = chosenRecord || listing[0];
  if (listing.length > 1 || (listing.length && selected !== listing[0]))
    html += `<details class="poll-index"><summary>다른 보강 투표 보기</summary><nav class="report-library" aria-label="보강 투표 목록">${listing
      .map(
        ({ p, data }) =>
          `<a class="grade-report-row" href="${h(votePath(p.id))}"${p.id === selected?.p.id ? ' aria-current="page"' : ''}><strong>${h(data.closure.label)}</strong><span class="pill">${pollListStatus(p, data)}</span></a>`,
      )
      .join('')}</nav></details>`;
  if (!selected)
    return (
      html +
      (isStaff
        ? '<p>진행 중인 보강 투표가 없습니다.</p></div>'
        : '<p>응답할 보강 투표가 없습니다.</p></div>')
    );
  const { p, data, own } = selected;
  const id = p.id;
  const hidden = `<input type="hidden" name="id" value="${h(id)}"><input type="hidden" name="version" value="${p.version}">`;
  if (data.assistant)
    return (
      html +
      `<section class="panel"><h2>${h(data.closure.label)}</h2>${
        p.state === 'draft'
          ? `<a class="button-link subtle-link" href="${h(assistantPollPath(id))}">AI 비서에서 추천 시간 확인</a>`
          : renderAssistantBallot(ctx, p, data, hidden)
      }</section></div>`
    );
  html += `<section class="panel"><h2>${h(data.closure.label)}</h2><p>${p.state === 'draft' ? '교사 후보 선택' : p.state === 'approved' ? '보강 확정 · 학원 일정에 표시됨' : p.state === 'cancelled' ? '취소됨' : pollListStatus(p, data) === '전원 응답' ? '전원 응답 완료 · 교사 확인 대기' : '학생·보호자 응답 중'}</p>`;
  if (p.state === 'draft')
    return (
      html +
      `<form method="post">${hidden}${data.options.map((s, i) => `<label class="check-label"><input type="checkbox" name="options" value="${i}"${i < 5 ? ' checked' : ''}>${h(label(s))}</label>`).join('')}<button name="action" value="publish">선택한 시간으로 투표 열기</button></form></section></div>`
    );
  if (p.state === 'approved') {
    const slots = approvedSlots(ctx, data, own);
    html +=
      '<ul class="item-list">' +
      slots.map((slot) => '<li>' + h(label(slot)) + '</li>').join('') +
      '</ul><p><a class="workspace-link" href="/schedule?month=' +
      h(slots[0]?.date.slice(0, 7) ?? '') +
      '">학원 일정에서 보기</a></p>';
  }
  const saved =
    !isStaff && chosen
      ? own.filter((student) => Object.hasOwn(data.votes, student.id))
      : [];
  if (saved.length)
    html += `<div id="vote-receipt" class="vote-receipt" role="status" tabindex="-1"><strong>응답 저장 완료</strong><span>${saved.map(({ name }) => h(name)).join(', ')}${p.state === 'open' ? ' · 보강은 교사가 일정을 확정하면 표시됩니다.' : ''}</span></div>`;
  if (p.state === 'open' && !isStaff)
    html +=
      '<p class="muted">가능한 시간을 1~3순위로 골라 주세요. 전부 어려우면 모두 불가를 선택해 주세요.</p>';
  if (p.state === 'open' && !isStaff)
    for (const s of chosen
      ? own
      : own.filter(({ id }) => !Object.hasOwn(data.votes, id)))
      html += `<form method="post">${hidden}<input type="hidden" name="student" value="${h(s.id)}"><h3>${h(s.name)} 응답${Object.hasOwn(data.votes, s.id) ? ' · 기존 응답 변경' : ''}</h3>${[1, 2, 3].map((rank) => `<label>${rank}순위<select name="rank${rank}"><option value="">선택 안 함</option>${data.options.map((slot, i) => `<option value="${i}"${data.votes[s.id]?.[rank - 1] === i ? ' selected' : ''}>${h(label(slot))}</option>`).join('')}</select></label>`).join('')}<label class="check-label"><input type="checkbox" name="unavailable" value="yes"${Object.hasOwn(data.votes, s.id) && !data.votes[s.id].length ? ' checked' : ''}>모두 불가</label><button name="action" value="vote">가능 시간 응답</button></form>`;
  if (staff(ctx) && p.state === 'open') {
    const candidates = data.options.map((slot, index) => {
      let reason = '';
      try {
        conflicts(ctx, data, slot);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        reason = error.message;
      }
      return {
        slot,
        reason,
        votes: data.students.filter((id) => data.votes[id]?.includes(index))
          .length,
      };
    });
    const summary = pollChoices(data, (i) => !candidates[i].reason);
    const names = new Map(own.map((student) => [student.id, student.name]));
    const responded = data.students.length - summary.missing.length;
    html += `<div class="poll-response-summary"><strong>응답 ${responded}/${data.students.length}명</strong><span>미응답 ${summary.missing.length}명 · 모두 불가 ${summary.impossible.length}명</span></div>
      <h3>후보 시간</h3><ul class="poll-candidate-list">${candidates.map(({ slot, votes, reason }) => `<li><div><strong>${h(label(slot))}</strong>${reason ? `<p class="poll-conflict">${h(reason)}</p>` : ''}</div><span>가능 ${votes}명</span></li>`).join('')}</ul>`;
    html += summary.choices.length
      ? `<form method="post" class="poll-approve">${hidden}<h3>확정 가능한 조합</h3>${summary.choices.map((c, i) => `<label class="check-label"><input type="radio" name="choice" value="${i}" required><span>${c.groups.map((g) => h(label(data.options[g.option])) + ' · ' + g.students.map((id) => h(names.get(id) ?? '이름 확인 불가')).join(', ')).join(' / ')}</span></label>`).join('')}<button name="action" value="approve">교사 최종 승인 · 일정 반영</button></form>`
      : `<p class="poll-waiting">${summary.missing.length ? '아직 응답하지 않은 학생이 있습니다. 응답이 모이면 확정 가능한 시간을 확인할 수 있습니다.' : summary.impossible.length ? '모두 불가로 응답한 학생이 있어 보강을 확정할 수 없습니다.' : '모두 참석할 수 있는 시간이나 두 그룹의 조합이 없습니다. 후보 시간과 충돌 사유를 확인해 주세요.'}</p>`;
    html += `<details class="poll-people"><summary>학생별 응답 보기</summary><ul>${data.students.map((id) => `<li>${h(names.get(id) ?? '이름 확인 불가')}: ${!Object.hasOwn(data.votes, id) ? '미응답' : !data.votes[id].length ? '모두 불가' : data.votes[id].map((i) => h(label(data.options[i]))).join(' → ')}</li>`).join('')}</ul></details>`;
  }
  if (staff(ctx) && (p.state === 'approved' || p.state === 'open'))
    html += `<details class="poll-cancel"><summary>취소 옵션</summary><form method="post">${hidden}<button class="secondary" name="action" value="cancel">${p.state === 'approved' ? '확정한 보강 취소' : '투표 취소'}</button></form></details>`;
  return html + '</section></div>';
}
export function pollCalendarEntries(
  ctx: PageContext,
  from: string,
  to: string,
) {
  if (!exists(ctx.db, 'op_makeup_sessions')) return [];
  const students = new Set(
      accessibleStudents(ctx.db, ctx.actor).map((s) => s.id),
    ),
    classes = new Set(accessibleClasses(ctx.db, ctx.actor).map((c) => c.id));
  return rows<{
    starts_at: number;
    ends_at: number;
    class_id: string;
    room: string;
    students: string;
  }>(
    ctx.db,
    "SELECT s.* FROM op_makeup_sessions s JOIN op_makeup_polls p ON p.id=s.poll_id WHERE s.academy_id=? AND p.state='approved' ORDER BY starts_at",
    ctx.actor.academyId,
  )
    .filter(
      (s) =>
        classes.has(s.class_id) &&
        (staff(ctx) ||
          (JSON.parse(s.students) as string[]).some((id) => students.has(id))),
    )
    .map((s) => ({
      date: new Date(s.starts_at + 32400000).toISOString().slice(0, 10),
      title: `${new Date(s.starts_at + 32400000).toISOString().slice(11, 16)}~${new Date(s.ends_at + 32400000).toISOString().slice(11, 16)} ${accessibleClasses(ctx.db, ctx.actor).find((c) => c.id === s.class_id)?.name} 투표 확정 보강 · ${s.room}`,
      kind: 'makeup',
    }))
    .filter((s) => s.date >= from && s.date <= to);
}
export const makeupPollsModule: OperationModule = {
  path: '/makeup-votes',
  label: '보강 시간 투표',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup: setupMakeupPolls,
  render,
  submit,
};
/** Student-scoped group schedules enter the same live index as the calendar. */
export function pollScheduleEvidence(
  db: OperationsDatabase,
  academyId: string,
) {
  const documents: SourceDocumentInput[] = [],
    facts: ApprovedFactInput[] = [];
  if (!exists(db, 'op_makeup_sessions')) return { documents, facts };
  for (const s of rows<{
    id: string;
    class_id: string;
    starts_at: number;
    ends_at: number;
    room: string;
    students: string;
    version: number;
    payload: string;
  }>(
    db,
    "SELECT s.*,p.version,p.payload FROM op_makeup_sessions s JOIN op_makeup_polls p ON p.id=s.poll_id WHERE s.academy_id=? AND p.state='approved' ORDER BY s.id",
    academyId,
  )) {
    const data = JSON.parse(s.payload) as Payload,
      approvedAt = data.approvedAt!;
    // Both persisted source key formats predate private consultation evidence.
    const key = data.closure.key;
    const classClosureId = key.startsWith('team:')
      ? academyId + ':' + key.slice('team:'.length)
      : key.startsWith('notice:')
        ? 'ops-schedule-' + key.slice('notice:'.length)
        : undefined;
    const name = one<{ name: string }>(
      db,
      'SELECT name FROM classes WHERE academy_id=? AND id=?',
      academyId,
      s.class_id,
    )?.name;
    if (!name || !approvedAt || !classClosureId) continue;
    const date = new Date(s.starts_at + 32400000).toISOString().slice(0, 10),
      time =
        new Date(s.starts_at + 32400000).toISOString().slice(11, 16) +
        '~' +
        new Date(s.ends_at + 32400000).toISOString().slice(11, 16);
    for (const studentId of JSON.parse(s.students) as string[]) {
      if (
        !one(
          db,
          'SELECT 1 FROM student_class_memberships WHERE academy_id=? AND student_id=? AND class_id=? AND ended_at IS NULL',
          academyId,
          studentId,
          s.class_id,
        )
      )
        continue;
      const documentId = 'poll-makeup-' + s.id + '-' + studentId,
        sourceId = documentId + ':r' + s.version + ':body';
      documents.push({
        academyId,
        documentId,
        revision: s.version,
        documentType: 'schedule',
        title: name + ' 투표 확정 보강',
        text: `${name} ${date} ${time} 보강 · ${s.room}. 원래 휴강일 ${data.closure.date}. 교사 최종 승인.`,
        visibility: 'student_private',
        studentId,
        classId: s.class_id,
        approvedAt,
        validFrom: approvedAt,
      });
      facts.push({
        academyId,
        documentId,
        sourceId,
        factId: sourceId + ':makeup',
        revision: s.version,
        subjectType: 'student',
        subjectId: studentId,
        factType: 'schedule_change',
        value: {
          kind: 'schedule_change',
          changeType: 'makeup',
          date,
          time,
          text: name + ' 보강 · ' + s.room,
          event: {
            id: documentId,
            classClosureId,
            startsAt: s.starts_at,
            endsAt: s.ends_at,
          },
        },
        period: null,
        validFrom: approvedAt,
        approvalStatus: 'approved',
      });
    }
  }
  return { documents, facts };
}
