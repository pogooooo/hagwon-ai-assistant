import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createOperationsServer } from './application.ts';
import { createExternalServices } from './external-services.ts';

async function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const server = createOperationsServer({
    db,
    demoPassword: 'http-new-features',
    services: createExternalServices({}, async () =>
      Response.json({
        schoolInfo: [
          { head: [{ list_total_count: 1 }, { RESULT: { CODE: 'INFO-000' } }] },
          {
            row: [
              {
                SCHUL_NM: '<script>alert(1)</script>학교',
                SD_SCHUL_CODE: 's1',
                ATPT_OFCDC_SC_CODE: 'N10',
              },
            ],
          },
        ],
      }),
    ),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  async function send(
    path: string,
    cookie = '',
    fields?: Record<string, string>,
    source = origin,
  ) {
    return fetch(origin + path, {
      method: fields ? 'POST' : 'GET',
      body: fields ? new URLSearchParams(fields) : undefined,
      headers: { cookie, origin: source },
      redirect: 'manual',
    });
  }
  async function login(username: string) {
    const response = await send('/login', '', {
      username,
      password: 'http-new-features',
    });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  return { db, send, login, origin };
}
test('새 화면 실제 HTTP: 관리자·보호자 메뉴와 기존 인증·CSRF 경계', async (t) => {
  const s = await setup(t),
    admin = await s.login('TA_DIRECTOR'),
    guardian = await s.login('TA_GUARDIAN_E_MATH');
  for (const route of ['/public-data', '/knowledge', '/schools']) {
    assert.equal((await s.send(route, admin)).status, 200);
    assert.equal((await s.send(route, guardian)).status, 403);
    assert.equal((await s.send(route)).status, 303);
  }
  assert.equal((await s.send('/voice', guardian)).status, 200);
  assert.equal((await s.send('/voice', admin)).status, 403);
  assert.equal(
    (
      await s.send(
        '/voice',
        guardian,
        { action: 'input', text: '질문' },
        'https://attacker.example',
      )
    ).status,
    403,
  );
  const html = await (await s.send('/voice', guardian)).text();
  assert.match(html, /data-voice-form/);
  assert.doesNotMatch(html, /fixture-secret|Bearer |RAG_CLOVA_API_KEY/);
  for (const route of ['/voice-ui.js', '/voice-worklet.js'])
    assert.equal((await s.send(route)).status, 200);
});
test('학교 외부 데이터는 HTML로 실행되지 않고 선택은 서버 검색 결과만 사용한다', async (t) => {
  const s = await setup(t),
    admin = await s.login('TA_DIRECTOR');
  const search = await s.send('/schools', admin, {
    action: 'search',
    office: 'N10',
    name: '학교',
  });
  assert.equal(search.status, 303);
  const html = await (
    await s.send(search.headers.get('location')!, admin)
  ).text();
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  const forged = await s.send('/schools', admin, {
    action: 'select',
    search: 'unknown',
    index: '0',
    schoolId: 'forged',
    name: '임의학교',
  });
  assert.equal(forged.status, 409);
  assert.equal(
    s.db.prepare('SELECT count(*) AS n FROM op_schools').get()!.n,
    0,
  );
});
test('음성 HTTP에서는 인식 원문만 저장하고 확인 요청 전 엔진을 호출하지 않는다', async (t) => {
  const s = await setup(t),
    guardian = await s.login('TA_GUARDIAN_E_MATH');
  const input = await s.send('/voice', guardian, {
    action: 'input',
    text: '목요일 수업은 몇 시인가요?',
  });
  assert.equal(input.status, 303);
  const page = await s.send(input.headers.get('location')!, guardian);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /인식한 질문이 맞나요/);
  const record = s.db.prepare('SELECT * FROM op_voice_turns').get()!;
  assert.equal(record.original, '목요일 수업은 몇 시인가요?');
  assert.equal(record.state, 'pending');
  assert.equal(
    s.db.prepare('SELECT count(*) AS n FROM op_consultation_messages').get()!.n,
    0,
  );
  assert.ok(!Object.keys(record).some((key) => /audio|bytes|blob/i.test(key)));
});
