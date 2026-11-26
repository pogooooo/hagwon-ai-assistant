import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createOperationsServer } from './application.ts';
import { seedDemoLibrary } from './demo-library.ts';
import { initializeIdentity } from './directory.ts';
import { buildDocumentsIndex } from './documents.ts';

test('demo academy documents are indexed, role scoped, cited and preserved after reseeding', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-22T14:00:00+09:00'));
  const db = new DatabaseSync(':memory:');
  const password = 'fixture-only-library';
  initializeIdentity(db, password);
  db.exec(`INSERT INTO accounts(id,academy_id,username,name,role,password_hash)
    SELECT 'demo-library-qa-parent',academy_id,'AXR_CHECK_GUARDIAN_20261119','가상 체험 보호자',role,password_hash
    FROM accounts WHERE id='TA_GUARDIAN_E_MATH'`);
  const server = createOperationsServer({
    db,
    demoPassword: password,
    showDemoAccounts: true,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  async function request(
    path: string,
    cookie = '',
    fields?: Record<string, string>,
  ) {
    return fetch(origin + path, {
      method: fields ? 'POST' : 'GET',
      headers: { origin, cookie },
      redirect: 'manual',
      body: fields ? new URLSearchParams(fields) : undefined,
    });
  }
  async function login(username: string) {
    const response = await request('/login', '', { username, password });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }
  const inventory =
    db.prepare(`SELECT document_id,state FROM op_document_versions
    WHERE academy_id=? AND document_id GLOB ? ORDER BY document_id`);
  for (const [academy, pattern, count] of [
    ['AC_TEST_A', 'TA_OPS_*', 35],
    ['AC_ONDAP_LANGUAGE_DEMO', 'ONDAP_EN_OPS_*', 29],
  ] as const) {
    const documents = inventory.all(academy, pattern) as {
      document_id: string;
      state: string;
    }[];
    assert.equal(documents.length, count);
    assert.equal(documents.filter(({ state }) => state === 'draft').length, 1);
    const index = await buildDocumentsIndex(db, academy, [], []);
    for (const { document_id, state } of documents)
      assert.equal(
        index.getRevisionStatus(document_id, 1, academy),
        state === 'published' ? 'approved_active' : null,
        document_id,
      );
  }

  const teacher = await login('TA_TEACHER');
  const owner = await login('TA_DIRECTOR');
  const parent = await login('TA_GUARDIAN_E_MATH');
  const other = await login('TA_GUARDIAN_M2');
  const mathDocs = await (await request('/documents', parent)).text();
  assert.match(mathDocs, /수강료 납부와 영수증 안내/);
  assert.match(mathDocs, /초등 수학반 12월 수업과 준비물/);
  assert.doesNotMatch(
    mathDocs,
    /중2 내신반 시험 대비 학습 계획|데스크 개원·마감|겨울방학 특별수업 기획 초안|온답센터 2층/,
  );
  const download = (id: string) =>
    '/documents/download?id=' + id + '&revision=1';
  assert.match(
    await (await request(download('TA_OPS_STU_A_NOV'), parent)).text(),
    /24문항 중 20문항/,
  );
  assert.equal(
    (await request(download('TA_OPS_STU_A_NOV'), other)).status,
    404,
  );
  assert.equal(
    (await request(download('TA_OPS_STAFF_OPEN_CLOSE'), parent)).status,
    404,
  );
  assert.match(
    await (await request(download('TA_OPS_STAFF_OPEN_CLOSE'), teacher)).text(),
    /당일 시간표/,
  );
  assert.equal(
    (await request(download('TA_OPS_WINTER_DRAFT'), parent)).status,
    404,
  );
  const ownerDraft = await request(
    '/documents?id=TA_OPS_WINTER_DRAFT&revision=1',
    owner,
  );
  assert.match(await ownerDraft.text(), /내용 검수 후 승인/);

  async function checkAnswer(
    cookie: string,
    profile: string,
    text: string,
    expected: string,
    citation: string,
  ) {
    const conversationId = randomUUID();
    assert.equal(
      (
        await request('/consultation', cookie, {
          _academyAccount: profile,
          action: 'ask',
          question: text,
          conversationId,
        })
      ).status,
      303,
    );
    const row = db
      .prepare(
        `SELECT response FROM op_consultation_messages
      WHERE thread_id=? AND kind='answer'`,
      )
      .get(conversationId);
    assert.ok(row);
    const answer = JSON.parse(String(row.response));
    assert.equal(answer.status, 'answered');
    assert.ok(answer.answer.includes(expected));
    assert.deepEqual(
      answer.citations.map((ref: { documentId: string }) => ref.documentId),
      [citation],
    );
  }
  await checkAnswer(
    parent,
    'TA_GUARDIAN_E_MATH',
    '중2 내신반 12월 등록할 수 있나요?',
    '대기 접수',
    'TA_OPS_ADMISSIONS_DEC',
  );
  await checkAnswer(
    parent,
    'TA_GUARDIAN_E_MATH',
    '처음 등록하려면 어떤 교재를 가져가요?',
    '수학 교재 한 권',
    'TA_OPS_START',
  );

  await checkAnswer(
    parent,
    'TA_GUARDIAN_E_MATH',
    '수강 확인서는 어떤 방법으로 신청하나요?',
    '온답 학원 상담에서 신청',
    'TA_OPS_REQUESTS',
  );

  const trial = await login('AXR_CHECK_GUARDIAN_20261119');
  assert.equal(
    (
      await request('/academies', trial, {
        _academyAccount: 'demo-library-qa-parent',
        action: 'switch',
        profile: 'ONDAP_LANGUAGE_demo-library-qa-parent',
      })
    ).status,
    303,
  );
  const englishDocs = await (await request('/documents', trial)).text();
  assert.match(englishDocs, /회화 수업 교재와 준비물/);
  assert.match(englishDocs, /영어 회화반 12월 주간 수업 계획/);
  assert.doesNotMatch(
    englishDocs,
    /수학 숙제 제출과 결과 확인|온답센터 응급 상황|방학 회화 집중반 운영안 초안/,
  );
  assert.match(
    await (await request(download('ONDAP_EN_OPS_STU_NOV_TRIAL'), trial)).text(),
    /8문항에서 6문항/,
  );
  assert.equal(
    (await request(download('ONDAP_EN_OPS_STU_NOV'), trial)).status,
    404,
  );
  assert.equal((await request(download('TA_OPS_START'), trial)).status, 404);
  await checkAnswer(
    trial,
    'ONDAP_LANGUAGE_demo-library-qa-parent',
    '영어 회화반의 12월 신규 등록이 가능한가요?',
    '중학생 신규 등록 상담',
    'ONDAP_EN_OPS_ADMISSIONS_DEC',
  );

  await checkAnswer(
    trial,
    'ONDAP_LANGUAGE_demo-library-qa-parent',
    '회화반 정규 납부 기간은 언제까지인가요?',
    '매월 1일부터 7일까지',
    'ONDAP_EN_OPS_BILLING',
  );

  db.prepare(
    "UPDATE op_document_versions SET state='withdrawn' WHERE document_id=?",
  ).run('TA_OPS_START');
  seedDemoLibrary(db);
  assert.equal(inventory.all('AC_TEST_A', 'TA_OPS_*').length, 35);
  assert.equal(
    db
      .prepare('SELECT state FROM op_document_versions WHERE document_id=?')
      .get('TA_OPS_START')?.state,
    'withdrawn',
  );
  assert.equal((await request(download('TA_OPS_START'), parent)).status, 404);
});
