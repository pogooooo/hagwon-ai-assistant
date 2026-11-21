import { randomUUID } from 'node:crypto';
import {
  checkMakeup,
  createEvent,
  emptyState,
  suggestMakeups,
} from '../makeup-schedule/model/schedule.ts';
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
interface Payload {
  closure: Closure;
  students: string[];
  options: MakeupSlot[];
  votes: Record<string, number[]>;
  groups?: { option: number; students: string[] }[];
  approvedBy?: string;
  approvedAt?: string;
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
  const r = one<{ config: string; state: string }>(
    ctx.db,
    'SELECT config,state FROM op_team_schedule WHERE academy_id=?',
    ctx.actor.academyId,
  );
  if (!r)
    throw new OperationError(
      '먼저 휴·보강 화면에서 반 시간표와 담당 강사·교실을 등록해 주세요.',
      422,
    );
  const config = JSON.parse(r.config) as AcademyConfig;
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
  return { config, state: JSON.parse(r.state) as ScheduleState };
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
  else if (!own.length)
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
      config.classes.find((c) => c.classId === data.closure.classId);
  if (!c) throw new OperationError('대상 반의 시간표가 없습니다.', 422);
  const result = checkMakeup(config, state, {
    scope: 'class',
    classId: c.classId,
    studentId: null,
    eventId: data.closure.eventId,
    date: slot.date,
    start: slot.start,
    room: slot.room,
  });
  if (
    !result.slot ||
    result.slot.end !== slot.end ||
    result.issues.some((i) => i.blocking) ||
    config.holidays[slot.date]
  )
    throw new OperationError(
      '시간표·공휴일·강사·교실·학생 충돌이 있는 후보입니다.',
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
  return config.rooms
    .flatMap((room) =>
      suggestMakeups(
        config,
        state,
        {
          scope: 'class',
          classId: data.closure.classId,
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
      } catch {
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
    if (field(form, 'version') !== String(p.version))
      throw new OperationError(
        '응답이 변경됐습니다. 새로고침 후 다시 확인해 주세요.',
        409,
      );
    if (action === 'cancel') {
      requireStaff(ctx, data.closure.classId);
      ctx.db
        .prepare(
          "UPDATE op_makeup_polls SET state='cancelled',source_key=?,version=version+1 WHERE id=?",
        )
        .run('cancelled:' + p.id, p.id);
      return '/makeup-votes?id=' + p.id;
    }
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
    ctx.db
      .prepare(
        'UPDATE op_makeup_polls SET version=version+1,state=?,payload=? WHERE id=? AND version=?',
      )
      .run(p.state, JSON.stringify(data), p.id, p.version);
    return '/makeup-votes?id=' + p.id;
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
    return students
      .filter(
        (s) =>
          s.classIds.includes(data.closure.classId) &&
          data.students.includes(s.id) &&
          !Object.hasOwn(data.votes, s.id),
      )
      .map(
        (s) =>
          `<li><a class="workspace-link" href="/makeup-votes?id=${encodeURIComponent(poll.id)}">${h(s.name)} · ${h(data.closure.label)} · 가능 시간 응답 <span aria-hidden="true">›</span></a></li>`,
      );
  });
  return notices.length
    ? `<section class="panel"><h2>응답할 보강 투표</h2><ul class="makeup-notice-list">${notices.join('')}</ul></section>`
    : '';
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
    if (
      (!staff(ctx) && p.state === 'draft') ||
      data.closure.stamp !== JSON.stringify(event)
    )
      return;
    return {
      state: p.state,
      href: '/makeup-votes?id=' + encodeURIComponent(p.id),
      slots: p.state === 'approved' ? approvedSlots(ctx, data, own) : [],
      responded:
        own.length > 0 && own.every((s) => Object.hasOwn(data.votes, s.id)),
    };
  } catch (error) {
    if (
      !(error instanceof OperationError) ||
      ![403, 404].includes(error.status)
    )
      throw error;
  }
}

function render(ctx: PageContext) {
  const ids = rows<Poll>(
    ctx.db,
    'SELECT * FROM op_makeup_polls WHERE academy_id=? ORDER BY rowid DESC',
    ctx.actor.academyId,
  ).filter((p) => {
    try {
      load(ctx, p.id);
      return staff(ctx) || p.state !== 'draft';
    } catch {
      return false;
    }
  });
  const chosen = ctx.url.searchParams.get('id');
  if (chosen && !ids.some((p) => p.id === chosen))
    throw new OperationError('조회 가능한 투표가 아닙니다.', 404);
  let html =
    '<div class="workspace-heading"><h1>보강 시간 투표</h1><a class="button-link subtle-link" href="/schedule' +
    (staff(ctx) ? '?view=makeup">휴강 관리' : '">학원 일정') +
    '</a></div><div class="poll-workspace">';
  const source = ctx.url.searchParams.get('source');
  const selectable = staff(ctx)
    ? closures(ctx).filter((c) => !ids.some((p) => p.source_key === c.key))
    : [];
  const selectedSource = selectable.find((c) => c.key === source);
  if (selectable.length)
    html += `<section class="panel"><h2>보강 투표 준비</h2><p>휴강한 반을 고르면 시간표에 겹치지 않는 후보를 찾습니다.</p><form class="inline-form" method="post"><label>휴강한 반<select name="source" required>${selectable.map((c) => `<option value="${h(c.key)}"${selectedSource?.key === c.key ? ' selected' : ''}>${h(c.label)}</option>`).join('')}</select></label><button name="action" value="create">보강 후보 찾기</button></form></section>`;
  if (ids.length)
    html += `<nav class="report-library" aria-label="보강 투표 목록">${ids.map((p) => `<a class="grade-report-row" href="/makeup-votes?id=${h(p.id)}"${p.id === (chosen ?? ids[0].id) ? ' aria-current="page"' : ''}><strong>${h((JSON.parse(p.payload) as Payload).closure.label)}</strong><span class="pill">${p.state === 'open' ? '응답 중' : p.state === 'approved' ? '확정' : p.state === 'draft' ? '후보 선택' : '취소'}</span></a>`).join('')}</nav>`;
  const id = chosen ?? (selectedSource ? undefined : ids[0]?.id);
  if (!id)
    return (
      html +
      (selectedSource
        ? '</div>'
        : '<p>진행 중인 보강 투표가 없습니다.</p></div>')
    );
  const { p, data, own } = load(ctx, id),
    hidden = `<input type="hidden" name="id" value="${h(id)}"><input type="hidden" name="version" value="${p.version}">`;
  html += `<section class="panel"><h2>${h(data.closure.label)}</h2><p>${p.state === 'draft' ? '교사 후보 선택' : p.state === 'approved' ? '보강 확정 · 학원 일정에 표시됨' : p.state === 'cancelled' ? '취소됨' : '학생·보호자 응답 중'}</p>`;
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
  if (staff(ctx) && (p.state === 'approved' || p.state === 'open'))
    html += `<form method="post">${hidden}<button class="secondary" name="action" value="cancel">${p.state === 'approved' ? '확정한 보강 취소' : '투표 취소'}</button></form>`;
  if (p.state === 'open')
    html +=
      '<p class="muted">' +
      (staff(ctx)
        ? '학생·보호자가 가능한 시간에 응답합니다.'
        : '가능한 시간을 1~3순위로 골라 주세요. 전부 어려우면 모두 불가를 선택해 주세요.') +
      '</p>';
  if (p.state === 'open' && !staff(ctx))
    for (const s of own)
      html += `<form method="post">${hidden}<input type="hidden" name="student" value="${h(s.id)}"><h3>${h(s.name)} 응답${Object.hasOwn(data.votes, s.id) ? ' · 기존 응답 변경' : ''}</h3>${[1, 2, 3].map((rank) => `<label>${rank}순위<select name="rank${rank}"><option value="">선택 안 함</option>${data.options.map((slot, i) => `<option value="${i}"${data.votes[s.id]?.[rank - 1] === i ? ' selected' : ''}>${h(label(slot))}</option>`).join('')}</select></label>`).join('')}<label class="check-label"><input type="checkbox" name="unavailable" value="yes"${Object.hasOwn(data.votes, s.id) && !data.votes[s.id].length ? ' checked' : ''}>모두 불가</label><button name="action" value="vote">가능 시간 응답</button></form>`;
  if (staff(ctx) && p.state === 'open') {
    const blocked = data.options
      .map((s, i) => {
        try {
          conflicts(ctx, data, s);
          return '';
        } catch (e) {
          return `${i + 1}번 충돌: ${(e as Error).message}`;
        }
      })
      .filter(Boolean);
    const summary = pollChoices(
        data,
        (i) => !blocked.some((b) => b.startsWith(i + 1 + '번')),
      ),
      names = new Map(
        accessibleStudents(ctx.db, ctx.actor).map((s) => [s.id, s.name]),
      );
    html += `<p>미응답 ${summary.missing.length}명 · 모두 불가 ${summary.impossible.length}명</p><ul>${data.students.map((id) => `<li>${h(names.get(id))}: ${!Object.hasOwn(data.votes, id) ? '미응답' : !data.votes[id].length ? '모두 불가' : data.votes[id].map((i) => i + 1 + '번').join(' → ')}</li>`).join('')}</ul><p>${h(blocked.join(' / '))}</p>`;
    html += summary.choices.length
      ? `<form method="post">${hidden}${summary.choices.map((c, i) => `<label><input type="radio" name="choice" value="${i}" required>${c.groups.map((g) => h(label(data.options[g.option])) + ' · ' + g.students.map((id) => h(names.get(id))).join(', ')).join(' / ')}</label>`).join('')}<button name="action" value="approve">교사 최종 승인 · 일정 반영</button></form>`
      : '<p>확정 가능한 조합이 없습니다. 미응답·불가·충돌을 확인해 주세요.</p>';
  }
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
