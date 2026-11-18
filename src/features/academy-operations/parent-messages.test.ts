import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createOperationsServer } from './application.ts';
import { getActor } from './directory.ts';
import { learningModule } from './learning.ts';
import { homeworkModule } from './homework.ts';
import {
  readWorkbookAnalysis,
  workbookFingerprint,
} from './workbook-analysis.ts';
import { publishWorkbookAnalysis } from './workbook-publication.ts';
import { parentMessagesModule } from './parent-messages.ts';
import {
  parentPolicy,
  saveParentPolicy,
  prepareMonthlyMessages,
  monthlyReport,
  runParentMessageJobs,
  queueParentBatch,
  deliverParentMessages,
  visibleParentMessages,
  messageCurrent,
  previousReportMonth,
  createParentNotice,
} from './parent-messages-model.ts';
import {
  createParentTemplate,
  fillParentTemplate,
  validateParentTemplate,
} from './parent-message-template.ts';
import {
  configureOperationsGeneration,
  createOperationsGeneration,
} from './runtime-generation.ts';
const form = (data: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(data)) f.set(k, v);
  return f;
};
function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  createOperationsServer({ db, demoPassword: 'synthetic-password' });
  t.after(() => db.close());
  const ctx = (user = 'TA_DIRECTOR', path = '/messages') => ({
    db,
    actor: getActor(db, user)!,
    url: new URL('http://localhost' + path),
  });
  const submit = async (data: Record<string, string>, user = 'TA_DIRECTOR') =>
    parentMessagesModule.submit(ctx(user), form(data));
  const result = (action: string, revision: string) =>
    learningModule.submit(
      ctx(),
      form({
        action,
        assignmentId: 'monthly-fixture',
        studentId: 'TA_STU_001',
        classificationRevision: '1',
        revision,
        wrongItems: '1 | 2',
        complete: 'yes',
        reason: '검증용 승인',
      }),
    );
  const publish = async () => {
    await learningModule.submit(
      ctx(),
      form({
        action: 'import',
        classification: JSON.stringify({
          formatVersion: '1.0',
          assignmentId: 'monthly-fixture',
          subject: 'M',
          rubricVersion: '1.0',
          classifiedAt: '2026-11-10T18:30:00+09:00',
          items: [1, 2].map((n) => ({
            itemId: 'q' + n,
            page: 1,
            displayNumber: String(n),
            itemStatus: 'classified',
            tags: [
              {
                tagId: 'math-01',
                status: 'adopted',
                evidenceKind: 'text',
                agreement: { same: 2, runs: 3 },
              },
            ],
          })),
        }),
        classId: 'TA_E_MATH',
        title: '검증용 월간 숙제',
        period: '2026-11',
        revision: '0',
      }),
    );
    await result('results', '0');
    await result('confirm', '1');
  };
  return { db, ctx, submit, publish, result };
}
test('approved learning → monthly preview → delivery → own guardian inbox and read receipt', async (t) => {
  const s = setup(t);
  await s.publish();
  const r = prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    parentPolicy(s.db, 'AC_TEST_A'),
  );
  assert.ok(r.created > 0);
  const preview = visibleParentMessages(s.ctx());
  assert.match(preview[0].body, /2문항 중 1문항 정답 \(50%\)/);
  assert.equal(visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH')).length, 0);
  queueParentBatch(s.ctx(), r.batch);
  const inbox = visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH'));
  assert.equal(inbox.length, 1);
  assert.equal(visibleParentMessages(s.ctx('TA_GUARDIAN_M2')).length, 0);
  const html = await parentMessagesModule.render(
    s.ctx('TA_GUARDIAN_E_MATH', '/messages?id=' + inbox[0].id),
  );
  assert.match(html, /학습 근거/);
  assert.match(html, /50%/);
  await s.submit({ action: 'read', id: inbox[0].id }, 'TA_GUARDIAN_E_MATH');
  assert.ok(visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH'))[0].read_at);
  await assert.rejects(
    s.submit({ action: 'read', id: inbox[0].id }, 'TA_GUARDIAN_M2'),
    /찾을 수/,
  );
});
test('monthly scheduler uses KST and previous month; repeated ticks and restarts never duplicate delivery', async (t) => {
  const s = setup(t);
  await s.publish();
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    day: 5,
    hour: 10,
    class_id: 'TA_E_MATH',
  });
  runParentMessageJobs(s.db, Date.parse('2026-12-05T09:59:00+09:00'));
  assert.equal(visibleParentMessages(s.ctx()).length, 0);
  runParentMessageJobs(s.db, Date.parse('2026-12-05T10:00:00+09:00'));
  const count = visibleParentMessages(s.ctx()).length;
  assert.ok(count > 0);
  assert.ok(
    visibleParentMessages(s.ctx()).every(
      (m) => m.period === '2026-11' && m.state === 'delivered',
    ),
  );
  runParentMessageJobs(s.db, Date.parse('2026-12-06T11:00:00+09:00'));
  assert.equal(visibleParentMessages(s.ctx()).length, count);
  prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    parentPolicy(s.db, 'AC_TEST_A'),
    Date.now(),
    true,
  );
  assert.equal(visibleParentMessages(s.ctx()).length, count);
});

test('a monthly preview prepared before the due time is delivered automatically exactly once', async (t) => {
  const s = setup(t);
  await s.publish();
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    day: 5,
    hour: 10,
    class_id: 'TA_E_MATH',
  });
  const policy = parentPolicy(s.db, 'AC_TEST_A');
  const preview = prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    policy,
    Date.parse('2026-12-04T10:00:00+09:00'),
    true,
  );
  assert.ok(preview.created > 0);
  assert.ok(visibleParentMessages(s.ctx()).every((m) => m.state === 'draft'));
  const due = Date.parse('2026-12-05T10:00:00+09:00');
  runParentMessageJobs(s.db, due);
  const messages = visibleParentMessages(s.ctx());
  assert.ok(messages.length > 0);
  assert.ok(messages.every((m) => m.state === 'delivered'));
  assert.ok(messages.every((m) => messageCurrent(s.db, m)));
  runParentMessageJobs(s.db, due + 60000);
  assert.equal(visibleParentMessages(s.ctx()).length, messages.length);
});

test('a broken academy policy cannot prevent other academies or queued notices from delivering', async (t) => {
  const s = setup(t);
  await s.publish();
  const due = Date.parse('2026-12-05T10:00:00+09:00');
  const notice = createParentNotice(s.ctx(), {
    requestId: randomUUID(),
    title: '예약 안내',
    template: '확인된 학원 안내입니다.',
    classId: 'TA_E_MATH',
    scheduledAt: new Date(due).toISOString(),
  });
  s.db
    .prepare("UPDATE op_parent_messages SET state='queued' WHERE batch_id=?")
    .run(notice);
  s.db
    .prepare('INSERT INTO op_parent_policies VALUES(?,?,?,?,?,?,?,?)')
    .run(
      'AC_TEST_B',
      1,
      1,
      1,
      5,
      10,
      'deleted-class',
      parentPolicy(s.db, 'AC_TEST_A').template,
    );
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    day: 5,
    hour: 10,
    class_id: 'TA_E_MATH',
  });
  assert.doesNotThrow(() =>
    runParentMessageJobs(s.db, Date.parse('2026-12-05T10:00:00+09:00')),
  );
  assert.ok(
    visibleParentMessages(s.ctx()).some((m) => m.state === 'delivered'),
  );
  assert.ok(
    visibleParentMessages(s.ctx())
      .filter((m) => m.batch_id === notice)
      .every((m) => m.state === 'delivered'),
  );
  assert.equal(
    s.db
      .prepare('SELECT * FROM op_parent_runs WHERE academy_id=?')
      .get('AC_TEST_B'),
    undefined,
  );
});

test('enabling automatic delivery after a scheduled draft run sends the existing preview, not another report', async (t) => {
  const s = setup(t);
  await s.publish();
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 0,
    class_id: 'TA_E_MATH',
  });
  const due = Date.parse('2026-12-05T10:00:00+09:00');
  runParentMessageJobs(s.db, due);
  const ids = visibleParentMessages(s.ctx()).map((m) => m.id);
  assert.ok(ids.length > 0);
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    automatic: 1,
  });
  runParentMessageJobs(s.db, due + 60000);
  assert.deepEqual(
    visibleParentMessages(s.ctx()).map((m) => m.id),
    ids,
  );
  assert.ok(
    visibleParentMessages(s.ctx()).every((m) => m.state === 'delivered'),
  );
});

test('an explicitly cancelled preview never becomes an automatic resend', async (t) => {
  const s = setup(t);
  await s.publish();
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    class_id: 'TA_E_MATH',
  });
  const r = prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    parentPolicy(s.db, 'AC_TEST_A'),
    Date.now(),
    true,
  );
  await s.submit({ action: 'cancel', batch: r.batch });
  runParentMessageJobs(s.db, Date.parse('2026-12-05T10:00:00+09:00'));
  assert.ok(
    visibleParentMessages(s.ctx()).every((m) => m.state === 'cancelled'),
  );
  assert.equal(visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH')).length, 0);
});

test('withdrawn evidence in an old preview is not queued at the monthly due time', async (t) => {
  const s = setup(t);
  await s.publish();
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    class_id: 'TA_E_MATH',
  });
  prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    parentPolicy(s.db, 'AC_TEST_A'),
    Date.now(),
    true,
  );
  await s.result('withdraw', '2');
  runParentMessageJobs(s.db, Date.parse('2026-12-05T10:00:00+09:00'));
  assert.equal(visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH')).length, 0);
  assert.ok(visibleParentMessages(s.ctx()).every((m) => m.state === 'draft'));
});

test('a failure between draft creation and run recording rolls back and a later tick delivers once', async (t) => {
  const s = setup(t);
  await s.publish();
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    class_id: 'TA_E_MATH',
  });
  let fail = true;
  const errors: string[] = [];
  const flaky = {
    exec: (sql: string) => {
      s.db.exec(sql);
    },
    prepare: (sql: string) => {
      const st = s.db.prepare(sql);
      return {
        all: (...args: SQLInputValue[]) => st.all(...args),
        get: (...args: SQLInputValue[]) => st.get(...args),
        run: (...args: SQLInputValue[]) => {
          if (fail && sql.includes('INSERT OR IGNORE INTO op_parent_runs')) {
            fail = false;
            throw new Error('synthetic storage interruption');
          }
          return st.run(...args);
        },
      };
    },
  };
  const due = Date.parse('2026-12-05T10:00:00+09:00');
  runParentMessageJobs(flaky, due, (id) => errors.push(id));
  assert.deepEqual(errors, ['AC_TEST_A']);
  assert.equal(visibleParentMessages(s.ctx()).length, 0);
  runParentMessageJobs(flaky, due + 60000, (id) => errors.push(id));
  const delivered = visibleParentMessages(s.ctx()).length;
  assert.ok(delivered > 0);
  assert.ok(
    visibleParentMessages(s.ctx()).every((m) => m.state === 'delivered'),
  );
  runParentMessageJobs(flaky, due + 120000);
  assert.equal(visibleParentMessages(s.ctx()).length, delivered);
});

test('monthly report period follows KST across the year boundary', () => {
  assert.equal(
    previousReportMonth(Date.parse('2026-12-31T23:59:59+09:00')),
    '2026-11',
  );
  assert.equal(
    previousReportMonth(Date.parse('2027-01-01T00:00:00+09:00')),
    '2026-12',
  );
});
test('approved workbook results join the monthly report only after explicit analysis publication', async (t) => {
  const s = setup(t),
    id = randomUUID();
  await homeworkModule.submit(
    s.ctx(),
    form({
      action: 'assign-workbook',
      assignmentId: id,
      subject: 'M',
      book: '공통 수학',
      grade: '중1',
      edition: '2026판',
      title: '월간 교재 숙제',
      date: '2026-11-15',
      targetKind: 'class',
      classId: 'TA_E_MATH',
      items: JSON.stringify([
        { page: 11, number: '1', tagIds: ['math-01'] },
        { page: 12, number: '1', tagIds: ['math-02'] },
      ]),
    }),
  );
  await homeworkModule.submit(
    s.ctx('TA_STUDENT_001'),
    form({ action: 'report', assignmentId: id, allCorrect: 'yes' }),
  );
  const sub = String(
    s.db
      .prepare(
        'SELECT id FROM homework_submissions WHERE assignment_id=? AND student_id=?',
      )
      .get(id, 'TA_STU_001')!.id,
  );
  await homeworkModule.submit(
    s.ctx(),
    form({
      action: 'approve-workbook',
      assignmentId: id,
      single: sub,
      ['version-' + sub]: '0',
    }),
  );
  assert.equal(monthlyReport(s.db, 'AC_TEST_A', 'TA_STU_001', '2026-11'), null);
  await publishWorkbookAnalysis(
    s.ctx(),
    form({
      action: 'publish-analysis',
      studentId: 'TA_STU_001',
      classId: 'TA_E_MATH',
      period: '2026-11',
      publicationRevision: '0',
      fingerprint: workbookFingerprint(
        readWorkbookAnalysis(s.db, 'AC_TEST_A').results.filter(
          (r) =>
            r.studentId === 'TA_STU_001' &&
            r.classes.some((c) => c.id === 'TA_E_MATH') &&
            r.dueDate.slice(0, 7) === '2026-11',
        ),
      ),
    }),
  );
  const monthly = prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    parentPolicy(s.db, 'AC_TEST_A'),
  );
  queueParentBatch(s.ctx(), monthly.batch);
  const received = visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH'))[0];
  assert.match(received.body, /교재 숙제/);
  assert.match(received.body, /2문항 중 2문항/);
  assert.equal(messageCurrent(s.db, received), true);
});
test('missing and unapproved results are not fabricated; late approval is picked up', async (t) => {
  const s = setup(t);
  saveParentPolicy(s.ctx(), {
    ...parentPolicy(s.db, 'AC_TEST_A'),
    enabled: 1,
    automatic: 1,
    class_id: 'TA_E_MATH',
  });
  const at = Date.parse('2026-12-05T10:00:00+09:00');
  runParentMessageJobs(s.db, at);
  assert.equal(visibleParentMessages(s.ctx()).length, 0);
  await s.publish();
  runParentMessageJobs(s.db, at + 60000);
  assert.ok(visibleParentMessages(s.ctx('TA_GUARDIAN_E_MATH')).length);
});
test('withdrawn evidence blocks queued reports and hides previously delivered content', async (t) => {
  const s = setup(t);
  await s.publish();
  const r = prepareMonthlyMessages(
    s.db,
    'AC_TEST_A',
    '2026-11',
    parentPolicy(s.db, 'AC_TEST_A'),
  );
  queueParentBatch(s.ctx(), r.batch);
  const m = visibleParentMessages(s.ctx())[0];
  assert.ok(messageCurrent(s.db, m));
  await s.result('withdraw', '2');
  assert.equal(monthlyReport(s.db, 'AC_TEST_A', 'TA_STU_001', '2026-11'), null);
  assert.equal(messageCurrent(s.db, m), false);
  const html = await parentMessagesModule.render(
    s.ctx('TA_GUARDIAN_E_MATH', '/messages?id=' + m.id),
  );
  assert.doesNotMatch(html, /50%/);
  assert.match(html, /변경되어/);
});
test('custom notice preview, scheduled delivery, POST replay and cancellation', async (t) => {
  const s = setup(t),
    requestId = randomUUID();
  const data = {
    action: 'notice',
    requestId,
    title: '휴원 안내',
    template:
      '{{학생명}} 학부모님, {{학원명}} 안내입니다. <script>bad()</script>',
    classId: 'TA_E_MATH',
    scheduledAt: '2027-01-02T10:00',
  };
  await s.submit(data);
  await s.submit(data);
  const all = visibleParentMessages(s.ctx());
  assert.ok(all.length);
  const n = all.length;
  assert.equal(
    new Set(all.map((m) => m.guardian_id + ':' + m.student_id)).size,
    n,
  );
  queueParentBatch(s.ctx(), all[0].batch_id);
  assert.equal(
    deliverParentMessages(s.db, Date.parse('2027-01-02T09:59:00+09:00')),
    0,
  );
  assert.equal(
    deliverParentMessages(s.db, Date.parse('2027-01-02T10:00:00+09:00')),
    n,
  );
  const html = await parentMessagesModule.render(
    s.ctx(
      'TA_GUARDIAN_E_MATH',
      '/messages?id=' +
        all.find((m) => m.guardian_id === 'TA_GUARDIAN_E_MATH')!.id,
    ),
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  await s.submit({ ...data, requestId: randomUUID() });
  const draft = visibleParentMessages(s.ctx()).find(
    (m) => m.state === 'draft',
  )!;
  await s.submit({ action: 'cancel', batch: draft.batch_id });
  assert.equal(
    deliverParentMessages(s.db, Date.parse('2027-01-03T10:00:00+09:00')),
    0,
  );
});
test('removed guardian relationships and other tenants cannot receive or inspect messages', async (t) => {
  const s = setup(t);
  await s.submit({
    action: 'notice',
    requestId: randomUUID(),
    title: '안내',
    template: '학원 안내입니다.',
    classId: 'TA_E_MATH',
  });
  const all = visibleParentMessages(s.ctx());
  s.db
    .prepare('DELETE FROM guardian_students WHERE guardian_id=?')
    .run('TA_GUARDIAN_E_MATH');
  assert.throws(() => queueParentBatch(s.ctx(), all[0].batch_id), /변경/);
  assert.equal(
    visibleParentMessages({
      ...s.ctx(),
      actor: { ...s.ctx().actor, academyId: 'other' },
    }).length,
    0,
  );
  await assert.rejects(
    s.submit({ action: 'send', batch: all[0].batch_id }, 'TA_TEACHER'),
    /권한/,
  );
});
test('settings conflict, invalid scopes and unsafe placeholders fail without overwriting policy', async (t) => {
  const s = setup(t),
    p = parentPolicy(s.db, 'AC_TEST_A');
  saveParentPolicy(s.ctx(), { ...p, enabled: 1 });
  assert.throws(() => saveParentPolicy(s.ctx(), p), /변경/);
  assert.equal(parentPolicy(s.db, 'AC_TEST_A').enabled, 1);
  assert.throws(
    () =>
      saveParentPolicy(s.ctx(), {
        ...parentPolicy(s.db, 'AC_TEST_A'),
        class_id: 'other',
      }),
    /반/,
  );
  assert.throws(() => validateParentTemplate('{{학부모전화번호}}'), /문구/);
  assert.equal(
    fillParentTemplate('{{학생명}}', { 학생명: '{{학원명}}', 학원명: '주입' }),
    '{{학원명}}',
  );
});
test('a queued class notice is cancelled when the learner leaves that target class', async (t) => {
  const s = setup(t);
  await s.submit({
    action: 'notice',
    requestId: randomUUID(),
    title: '반 안내',
    template: '반 안내입니다.',
    classId: 'TA_E_MATH',
    scheduledAt: '2027-02-01T10:00',
  });
  const message = visibleParentMessages(s.ctx()).find(
    (m) => m.student_id === 'TA_STU_001',
  )!;
  queueParentBatch(s.ctx(), message.batch_id);
  s.db
    .prepare(
      'UPDATE student_class_memberships SET ended_at=? WHERE student_id=? AND class_id=?',
    )
    .run('2027-01-01', 'TA_STU_001', 'TA_E_MATH');
  deliverParentMessages(s.db, Date.parse('2027-02-01T10:01:00+09:00'));
  assert.equal(
    s.db
      .prepare('SELECT state FROM op_parent_messages WHERE id=?')
      .get(message.id)!.state,
    'cancelled',
  );
});
test('NAVER template request contains only tone and variables, not student identity or results', async (t) => {
  const bodies: string[] = [];
  configureOperationsGeneration(
    createOperationsGeneration(
      { RAG_CLOVA_API_KEY: 'synthetic-test-key' },
      async (_url, init) => {
        bodies.push(String(init?.body));
        return Response.json({
          status: { code: '20000' },
          result: {
            finishReason: 'stop',
            message: {
              content: JSON.stringify({
                intro: '확인된 학습 기록을 안내해 드립니다.',
                closing: '궁금한 사항은 학원으로 문의해 주세요.',
              }),
            },
          },
        });
      },
    ),
  );
  t.after(() =>
    configureOperationsGeneration(
      createOperationsGeneration({ RAG_GENERATION_PROVIDER: 'disabled' }),
    ),
  );
  const value = await createParentTemplate('정중하게');
  assert.ok(validateParentTemplate(value));
  assert.equal(bodies.length, 1);
  assert.doesNotMatch(bodies[0], /TA_STU|가상학생|50%/);
  assert.deepEqual(JSON.parse(JSON.parse(bodies[0]).messages[1].content), {
    tone: '정중하게',
  });
  configureOperationsGeneration(
    createOperationsGeneration(
      { RAG_CLOVA_API_KEY: 'synthetic-test-key' },
      async () =>
        Response.json({
          status: { code: '20000' },
          result: {
            finishReason: 'stop',
            message: {
              content: JSON.stringify({
                intro:
                  '이번 달 학습 기록에 따르면, 학생 여러분의 꾸준한 노력이 돋보였습니다.',
                closing: '궁금한 사항은 학원으로 문의해 주세요.',
              }),
            },
          },
        }),
    ),
  );
  const neutral = await createParentTemplate('따뜻하게');
  assert.doesNotMatch(neutral, /노력|돋보/);
  assert.match(neutral, /확인된 학습 기록/);
  configureOperationsGeneration(
    createOperationsGeneration(
      { RAG_CLOVA_API_KEY: 'synthetic-test-key' },
      async () =>
        Response.json({
          status: { code: '20000' },
          result: {
            finishReason: 'stop',
            message: { content: '{"template":"95점으로 향상됐습니다"}' },
          },
        }),
    ),
  );
  await assert.rejects(createParentTemplate('정중하게'), /문구/);
});
