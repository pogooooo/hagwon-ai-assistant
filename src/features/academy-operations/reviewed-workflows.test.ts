import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createOperationsServer } from './application.ts';
import { test, type TestContext } from 'node:test';
import { initializeIdentity, getActor } from './directory.ts';
import { calendarModule, visibleCalendarEntries } from './calendar.ts';
import { learningModule } from './learning.ts';
import { homeworkModule } from './homework.ts';
import { documentsModule } from './documents.ts';
import { consultationModule } from './consultation.ts';
import { scheduleModule } from './schedule.ts';
import type { RagAnswer } from '../rag-consultation/contract.ts';
import {
  makeupPollsModule,
  pollChoices,
  pendingMakeupNotices,
  assertPollSessionFree,
  pollScheduleEvidence,
} from './makeup-polls.ts';
import {
  studentReportsModule,
  studentReportEvidence,
} from './student-reports.ts';
import { emptyState, createEvent } from '../makeup-schedule/model/schedule.ts';
import type {
  AcademyConfig,
  ScheduleState,
} from '../makeup-schedule/model/types.ts';
import {
  assertTeacherFree,
  assertUnifiedSchedule,
} from './schedule-conflicts.ts';
import type { PageContext } from './shared.ts';

function form(data: Record<string, string | string[]>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(data))
    for (const s of Array.isArray(v) ? v : [v]) f.append(k, s);
  return f;
}
function setup(
  t: TestContext,
  date = '2026-11-23',
  availability?: ScheduleState['availability'],
) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  initializeIdentity(db, 'workflow-tests');
  calendarModule.setup(db);
  learningModule.setup(db);
  homeworkModule.setup(db);
  makeupPollsModule.setup(db);
  studentReportsModule.setup(db);
  db.prepare(
    "INSERT OR IGNORE INTO student_class_memberships(academy_id,student_id,class_id,enrolled_at) VALUES('AC_TEST_A','TA_STU_002','TA_E_MATH','2026-11-01')",
  ).run();
  const ctx = (id = 'TA_DIRECTOR', path = '/makeup-votes'): PageContext => ({
    db,
    actor: getActor(db, id)!,
    url: new URL('http://localhost' + path),
  });
  const config: AcademyConfig = {
    academyId: 'AC_TEST_A',
    name: '가상',
    capacity: 50,
    closeTime: '22:00',
    rooms: ['1강의실'],
    holidays: {},
    classes: [
      {
        classId: 'TA_E_MATH',
        name: '초등 수학반',
        days: [1, 3],
        start: '16:00',
        end: '17:00',
        teacher: 'TA_TEACHER',
        room: '1강의실',
      },
    ],
    students: [
      { studentId: 'TA_STU_001', name: '가상A', classIds: ['TA_E_MATH'] },
      { studentId: 'TA_STU_002', name: '가상B', classIds: ['TA_E_MATH'] },
    ],
  };
  const event = createEvent(
    config,
    { ...emptyState(), availability },
    { scope: 'class', classId: 'TA_E_MATH', date, confirm: true },
    '2026-11-19T00:00:00Z',
  );
  assert.ok(event.ok);
  db.prepare('INSERT INTO op_team_schedule VALUES(?,?,?,?)').run(
    'AC_TEST_A',
    1,
    JSON.stringify(config),
    JSON.stringify(event.state),
  );
  const row = () =>
    db.prepare('SELECT * FROM op_makeup_polls').get() as {
      id: string;
      version: number;
      state: string;
      payload: string;
    };
  const submit = (
    action: string,
    values: Record<string, string | string[]> = {},
    actor = 'TA_DIRECTOR',
  ) =>
    makeupPollsModule.submit(
      ctx(actor),
      form({
        action,
        ...(row() ? { id: row().id, version: String(row().version) } : {}),
        ...values,
      }),
    );
  const start = () => {
    submit('create', { source: 'team:EV-001' });
    submit('publish', { options: ['0', '1', '2', '3', '4'] });
  };
  return { db, ctx, config, row, submit, start };
}
test('missing and all-unavailable never produce an approval; complete ranks prefer one slot', () => {
  const data = {
    closure: {
      key: 'x',
      stamp: '',
      classId: 'c',
      date: '2026-11-23',
      label: '휴강',
    },
    students: ['a', 'b'],
    options: [
      { date: '2026-11-24', start: '16:00', end: '17:00', room: 'r' },
      { date: '2026-11-25', start: '16:00', end: '17:00', room: 'r' },
    ],
    votes: { a: [0, 1] } as Record<string, number[]>,
  };
  assert.deepEqual(pollChoices(data).missing, ['b']);
  assert.equal(pollChoices(data).choices.length, 0);
  data.votes.b = [];
  assert.deepEqual(pollChoices(data).impossible, ['b']);
  data.votes.b = [1, 0];
  assert.equal(pollChoices(data).choices[0].groups.length, 1);
  data.votes.a = [0];
  data.votes.b = [1];
  assert.equal(pollChoices(data).choices[0].groups.length, 2);
  data.options[1] = { ...data.options[0] };
  assert.equal(pollChoices(data).choices.length, 0);
});
test('recommend → teacher selects → own-student votes → teacher approval → calendar; replay rejected', async (t) => {
  const s = setup(t);
  s.start();
  assert.equal(s.row().state, 'open');
  assert.match(
    pendingMakeupNotices(s.ctx('TA_GUARDIAN_E_MATH')),
    /응답할 보강 투표/,
  );
  assert.match(pendingMakeupNotices(s.ctx('TA_STUDENT_001')), /가능 시간 응답/);
  assert.doesNotMatch(
    pendingMakeupNotices(s.ctx('TA_STUDENT_001')),
    /가상학생B/,
  );
  assert.throws(() => s.submit('approve', { choice: '0' }), /미응답|불가|충돌/);
  s.submit('vote', { student: 'TA_STU_001', rank1: '0' }, 'TA_STUDENT_001');
  assert.equal(pendingMakeupNotices(s.ctx('TA_GUARDIAN_E_MATH')), '');
  assert.match(
    pendingMakeupNotices(s.ctx('TA_GUARDIAN_M2')),
    /응답할 보강 투표/,
  );
  assert.throws(
    () =>
      s.submit('vote', { student: 'TA_STU_002', rank1: '0' }, 'TA_STUDENT_001'),
    /본인/,
  );
  assert.throws(
    () => s.submit('approve', { choice: '0' }, 'TA_GUARDIAN_E_MATH'),
    /교사/,
  );
  s.submit('vote', { student: 'TA_STU_002', rank1: '0' }, 'TA_GUARDIAN_M2');
  s.submit('approve', { choice: '0' }, 'TA_TEACHER');
  assert.equal(s.row().state, 'approved');
  assert.equal(
    s.db.prepare('SELECT COUNT(*) n FROM op_makeup_sessions').get()?.n,
    1,
  );
  assert.ok(
    visibleCalendarEntries(
      s.ctx('TA_STUDENT_001'),
      '2026-11-01',
      '2026-12-31',
    ).some((e) => e.title.includes('투표 확정 보강')),
  );
  assert.throws(() => s.submit('approve', { choice: '0' }), /이미 승인/);
  const session = s.db.prepare('SELECT * FROM op_makeup_sessions').get()!;
  assert.throws(
    () =>
      assertTeacherFree(
        s.db,
        'AC_TEST_A',
        'TA_TEACHER',
        Number(session.starts_at),
        Number(session.ends_at),
      ),
    /투표/,
  );
  assert.throws(
    () =>
      assertPollSessionFree(
        s.db,
        'AC_TEST_A',
        Number(session.starts_at),
        Number(session.ends_at),
        'other',
        '1강의실',
        [],
      ),
    /투표/,
  );
  s.submit('cancel');
  assert.equal(
    visibleCalendarEntries(
      s.ctx('TA_STUDENT_001'),
      '2026-11-01',
      '2026-12-31',
    ).filter((e) => e.title.includes('투표 확정 보강')).length,
    0,
  );
  assert.doesNotThrow(() =>
    assertTeacherFree(
      s.db,
      'AC_TEST_A',
      'TA_TEACHER',
      Number(session.starts_at),
      Number(session.ends_at),
    ),
  );
  assert.doesNotThrow(() => s.submit('create', { source: 'team:EV-001' }));
});
test('two nonoverlapping groups cover every student exactly once, with subgroup calendar visibility', (t) => {
  const s = setup(t);
  s.start();
  s.submit('vote', { student: 'TA_STU_001', rank1: '0' }, 'TA_STUDENT_001');
  s.submit('vote', { student: 'TA_STU_002', rank1: '1' }, 'TA_GUARDIAN_M2');
  s.submit('approve', { choice: '0' });
  assert.equal(
    s.db.prepare('SELECT COUNT(*) n FROM op_makeup_sessions').get()?.n,
    2,
  );
  const own = visibleCalendarEntries(
    s.ctx('TA_STUDENT_001'),
    '2026-11-01',
    '2026-12-31',
  ).filter((e) => e.title.includes('투표 확정 보강'));
  assert.equal(own.length, 1);
  const evidence = pollScheduleEvidence(s.db, 'AC_TEST_A');
  assert.equal(evidence.documents.length, 2);
  assert.ok(
    evidence.documents.every(
      (d) => d.visibility === 'student_private' && d.studentId,
    ),
  );
  assert.equal(evidence.facts.length, 2);
  const session = s.db
    .prepare('SELECT * FROM op_makeup_sessions ORDER BY starts_at')
    .get()!;
  const changed = structuredClone(s.config);
  changed.classes[0].days = [
    new Date(Number(session.starts_at) + 32400000).getUTCDay(),
  ];
  changed.classes[0].start = new Date(Number(session.starts_at) + 32400000)
    .toISOString()
    .slice(11, 16);
  assert.throws(
    () => assertUnifiedSchedule(s.db, 'AC_TEST_A', emptyState(), changed),
    /투표/,
  );
});
for (const origin of ['team', 'notice']) {
  test(`consultation cites the original ${origin} cancellation and only the selected student's approved makeup`, async (t) => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2026-11-19T12:00:00+09:00'),
    });
    const s = setup(t, origin === 'team' ? '2026-11-30' : '2026-11-23', {
      TA_STU_001: [{ day: 6, start: '13:00', end: '14:00' }],
      TA_STU_002: [{ day: 0, start: '10:00', end: '11:00' }],
    });
    documentsModule.setup(s.db);
    scheduleModule.setup(s.db);
    consultationModule.setup(s.db);
    const notice = (date: string, makeup: boolean) =>
      scheduleModule.submit(
        s.ctx(),
        form({
          action: 'save_notice',
          class_id: 'TA_E_MATH',
          title: date + ' 휴강',
          closure_start: date + 'T16:00',
          closure_end: date + 'T17:00',
          makeup_kind: makeup ? 'scheduled' : 'pending',
          ...(makeup
            ? {
                makeup_start: '2026-12-05T14:00',
                makeup_end: '2026-12-05T15:00',
              }
            : {}),
        }),
      );
    let key = 'team:EV-001';
    if (origin === 'notice') {
      await notice('2026-11-30', false);
      key =
        'notice:' +
        s.db
          .prepare('SELECT id FROM ops_schedule_notices WHERE title=?')
          .get('2026-11-30 휴강')!.id;
    }
    await notice('2026-11-25', true);
    const ask = async (
      actor: string,
      studentId = '',
      question = '초등 수학반 11월 30일 휴강에 대해 투표로 확정한 보강은 언제인가요?',
    ) => {
      const conversationId = randomUUID();
      await consultationModule.submit(
        s.ctx(actor),
        form({ action: 'ask', conversationId, studentId, question }),
      );
      return JSON.parse(
        String(
          s.db
            .prepare(
              "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
            )
            .get(conversationId)!.response,
        ),
      ) as RagAnswer;
    };
    s.submit('create', { source: key });
    const slots = JSON.parse(s.row().payload).options as {
      date: string;
      start: string;
    }[];
    const options = [
      ['2026-12-05', '13:00'],
      ['2026-12-06', '10:00'],
    ].map(([date, start]) => {
      const index = slots.findIndex(
        (slot) => slot.date === date && slot.start === start,
      );
      assert.ok(index >= 0);
      return String(index);
    });
    s.submit('publish', { options });
    s.submit('vote', { student: 'TA_STU_001', rank1: '0' }, 'TA_STUDENT_001');
    s.submit('vote', { student: 'TA_STU_002', rank1: '1' }, 'TA_GUARDIAN_M2');
    const pending = await ask('TA_GUARDIAN_E_MATH');
    assert.equal(pending.status, 'partial', pending.answer);
    assert.equal(pending.citations.length, 1);
    const original = pending.citations[0].documentId;
    s.submit('approve', { choice: '0' }, 'TA_TEACHER');
    const own = await ask('TA_GUARDIAN_E_MATH');
    const other = await ask('TA_GUARDIAN_M2', 'TA_STU_002');
    const ownStudent = await ask('TA_STUDENT_001', 'TA_STU_001');
    assert.equal(ownStudent.status, 'answered', ownStudent.answer);
    assert.match(ownStudent.answer, /12월 5일/);
    await assert.rejects(
      ask('TA_GUARDIAN_E_MATH', 'TA_STU_002'),
      /조회 가능한 학생/,
    );
    for (const [answer, studentId, slot, excluded] of [
      [
        own,
        'TA_STU_001',
        /12월 5일 13:00~14:00 .*1강의실/,
        /12월 6일|학생\s*B/,
      ],
      [
        other,
        'TA_STU_002',
        /12월 6일 10:00~11:00 .*1강의실/,
        /12월 5일|학생\s*A/,
      ],
    ] as const) {
      assert.equal(answer.status, 'answered', answer.answer);
      assert.match(answer.answer, /11월 30일 16:00~17:00 휴강/);
      assert.match(answer.answer, slot);
      assert.doesNotMatch(answer.answer, excluded);
      assert.doesNotMatch(answer.answer, /14:00~15:00|미정|확정되지/);
      assert.equal(answer.citations.length, 2);
      assert.equal(answer.citations[0].documentId, original);
      assert.ok(
        answer.citations[1].documentId.startsWith('poll-makeup-') &&
          answer.citations[1].documentId.endsWith(studentId),
      );
    }
    const separate = await ask(
      'TA_GUARDIAN_E_MATH',
      '',
      '초등 수학반 11월 25일 휴강의 보강은 언제인가요?',
    );
    assert.equal(separate.status, 'answered', separate.answer);
    assert.match(separate.answer, /12월 5일 14:00~15:00/);
    assert.ok(
      separate.citations.every(
        (c) =>
          c.documentId !== original && !c.documentId.startsWith('poll-makeup-'),
      ),
    );
    const absence = await ask(
      'TA_GUARDIAN_E_MATH',
      '',
      '우리 아이 12월 5일 결석 보강은 언제인가요?',
    );
    assert.equal(absence.status, 'abstained', absence.answer);
    assert.deepEqual(absence.citations, []);
    s.db
      .prepare('INSERT INTO guardian_students VALUES(?,?)')
      .run('TA_GUARDIAN_E_MATH', 'TA_STU_002');
    assert.equal((await ask('TA_GUARDIAN_E_MATH')).status, 'clarify');
    assert.deepEqual(
      (await ask('TA_GUARDIAN_E_MATH', 'TA_STU_002')).citations,
      other.citations,
    );
    s.submit('cancel');
    const cancelled = await ask('TA_GUARDIAN_E_MATH', 'TA_STU_001');
    assert.equal(cancelled.status, 'partial', cancelled.answer);
    assert.deepEqual(cancelled.citations, pending.citations);
    assert.doesNotMatch(cancelled.answer, /12월|13:00/);
  });
}
test('HTTP routes require login and reject student report access and guardian approval', async (t) => {
  const db = new DatabaseSync(':memory:');
  const server = createOperationsServer({
    db,
    demoPassword: 'workflow-http',
    assetsRoot: null,
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    db.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const send = (path: string, cookie = '', values?: Record<string, string>) =>
    fetch(origin + path, {
      method: values ? 'POST' : 'GET',
      headers: { origin, cookie },
      body: values ? new URLSearchParams(values) : undefined,
      redirect: 'manual',
    });
  assert.equal((await send('/makeup-votes')).status, 303);
  const login = async (username: string) => {
    const res = await send('/login', '', {
      username,
      password: 'workflow-http',
    });
    assert.equal(res.status, 303);
    return res.headers.get('set-cookie')!.split(';')[0];
  };
  const guardian = await login('TA_GUARDIAN_E_MATH');
  assert.equal((await send('/makeup-votes', guardian)).status, 200);
  assert.equal(
    (
      await send('/student-reports', guardian, {
        action: 'approve',
        id: 'fake',
        version: '1',
        reviewed: 'yes',
      })
    ).status,
    403,
  );
  const student = await login('TA_STUDENT_001');
  assert.equal((await send('/student-reports', student)).status, 403);
});
test('stale versions, duplicate ranks and changed closure are rejected', (t) => {
  const s = setup(t);
  s.start();
  assert.throws(
    () =>
      s.submit(
        'vote',
        { student: 'TA_STU_001', rank1: '0', rank2: '0' },
        'TA_STUDENT_001',
      ),
    /중복/,
  );
  assert.throws(
    () =>
      s.submit(
        'vote',
        { student: 'TA_STU_001', rank1: '0', version: '1' },
        'TA_STUDENT_001',
      ),
    /변경/,
  );
  s.submit('vote', { student: 'TA_STU_001', rank1: '0' }, 'TA_STUDENT_001');
  s.submit('vote', { student: 'TA_STU_002', rank1: '0' }, 'TA_GUARDIAN_M2');
  s.db
    .prepare("UPDATE op_team_schedule SET state=? WHERE academy_id='AC_TEST_A'")
    .run(JSON.stringify(emptyState()));
  assert.throws(() => s.submit('approve', { choice: '0' }), /휴강/);
  assert.equal(
    s.db.prepare('SELECT COUNT(*) n FROM op_makeup_sessions').get()?.n,
    0,
  );
});
test('report drafts stay private, absence of evidence explicit; approval/edit/revocation and source changes enforced', async (t) => {
  const s = setup(t),
    base = { student: 'TA_STU_001', class: 'TA_E_MATH', period: '2026-11' };
  await studentReportsModule.submit(
    s.ctx(),
    form({ action: 'analyze', ...base }),
  );
  const report = () =>
    s.db.prepare('SELECT * FROM op_student_reports').get() as {
      id: string;
      version: number;
    };
  const write = (action: string, extra: Record<string, string> = {}) =>
    studentReportsModule.submit(
      s.ctx('TA_TEACHER'),
      form({
        action,
        id: report().id,
        version: String(report().version),
        ...extra,
      }),
    );
  const url = () => '/student-reports?id=' + report().id;
  assert.match(
    await studentReportsModule.render(s.ctx('TA_TEACHER', url())),
    /채점 기록이 없습니다/,
  );
  assert.throws(
    () => studentReportsModule.render(s.ctx('TA_GUARDIAN_E_MATH', url())),
    /승인/,
  );
  assert.throws(() => write('approve', { reviewed: 'yes' }), /근거 기록/);
  await studentReportsModule.submit(
    s.ctx('TA_TEACHER'),
    form({
      action: 'attendance',
      student: base.student,
      class: base.class,
      date: '2026-11-18',
      status: 'late',
    }),
  );
  assert.throws(() => write('approve', { reviewed: 'yes' }), /근거가 바뀌/);
  await studentReportsModule.submit(
    s.ctx('TA_TEACHER'),
    form({ action: 'analyze', ...base, version: String(report().version) }),
  );
  await write('save', {
    body: '가상학생 A · 확인된 지각 기록 1건',
    counsel: '교사 전용 상담 초안',
  });
  await write('approve', { reviewed: 'yes' });
  const guardian = await studentReportsModule.render(
    s.ctx('TA_GUARDIAN_E_MATH', url()),
  );
  assert.match(guardian, /확인된 지각/);
  assert.doesNotMatch(guardian, /교사 전용 상담 초안/);
  assert.throws(
    () => studentReportsModule.render(s.ctx('TA_GUARDIAN_M2', url())),
    /접근/,
  );
  const recordAttendance = (status: string) =>
    studentReportsModule.submit(
      s.ctx('TA_TEACHER'),
      form({
        action: 'attendance',
        student: base.student,
        class: base.class,
        date: '2026-11-18',
        status,
      }),
    );
  const approvedVersion = report().version;
  await recordAttendance('late');
  assert.equal(report().version, approvedVersion);
  await recordAttendance('present');
  assert.equal(report().version, approvedVersion + 1);
  const changed = await studentReportsModule.render(s.ctx('TA_TEACHER', url()));
  assert.match(changed, /보호자 비공개 · 근거가 변경/);
  assert.doesNotMatch(changed, /보호자 공개 중/);
  await recordAttendance('late');
  assert.throws(
    () => studentReportsModule.render(s.ctx('TA_GUARDIAN_E_MATH', url())),
    /승인/,
  );
  await write('approve', { reviewed: 'yes' });
  await write('save', { body: '수정됨', counsel: '교사 전용' });
  assert.throws(
    () => studentReportsModule.render(s.ctx('TA_GUARDIAN_E_MATH', url())),
    /승인/,
  );
});
test('only latest confirmed classification is used; repeated errors use observed type counts', (t) => {
  const s = setup(t);
  const c = {
    formatVersion: '1.0',
    assignmentId: 'virtual',
    subject: 'M',
    rubricVersion: '1.0',
    classifiedAt: '2026-11-18T00:00:00Z',
    items: [1, 2].map((n) => ({
      itemId: String(n),
      page: 1,
      displayNumber: String(n),
      itemStatus: 'classified',
      tags: [
        {
          tagId: 'math-01',
          status: 'adopted',
          evidenceKind: 'text',
          agreement: { same: 3, runs: 3 },
        },
      ],
    })),
  };
  s.db
    .prepare('INSERT INTO op_learning_assignments VALUES(?,?,?,?,?,?,?,?)')
    .run(
      'AC_TEST_A',
      'virtual',
      'TA_E_MATH',
      '가상 숙제',
      '2026-11',
      1,
      JSON.stringify(c),
      '2026-11-18T00:00:00Z',
    );
  const insert = (revision: number, state: string) =>
    s.db
      .prepare('INSERT INTO op_learning_results VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'AC_TEST_A',
        'virtual',
        'TA_STU_001',
        revision,
        1,
        JSON.stringify({ '1': 'incorrect', '2': 'incorrect' }),
        null,
        state,
        'TA_TEACHER',
        '가상 확인',
        '2026-11-18T00:00:00Z',
      );
  insert(1, 'confirmed');
  const e = studentReportEvidence(
    s.ctx(),
    'TA_STU_001',
    'TA_E_MATH',
    '2026-11',
  );
  assert.equal(e.total, 2);
  assert.equal(e.repeated[0].wrong, 2);
  insert(2, 'draft');
  assert.equal(
    studentReportEvidence(s.ctx(), 'TA_STU_001', 'TA_E_MATH', '2026-11').total,
    0,
  );
});
