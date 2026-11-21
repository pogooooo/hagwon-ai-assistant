import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createOperationsServer } from './application.ts';

test('학원 선택 · 네 역할별 전환, 세션 격리, 타 학원 검증과 권한 회수', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const password = 'synthetic-selector-test';
  const server = createOperationsServer({
    db,
    demoPassword: password,
    showDemoAccounts: true,
    assetsRoot: null,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const origin = 'http://127.0.0.1:' + addr.port;
  const send = (url: string, cookie = '', fields?: Record<string, string>) =>
    fetch(origin + url, {
      method: fields ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { origin, cookie },
      body: fields ? new URLSearchParams(fields) : undefined,
    });
  async function login(username: string, location: string) {
    const res = await send('/login', '', { username, password });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), location);
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }
  for (const [id, role] of [
    ['TA_STUDENT_001', 'student'],
    ['TA_GUARDIAN_E_MATH', 'guardian'],
    ['TA_TEACHER', 'teacher'],
    ['TA_DIRECTOR', 'admin'],
  ]) {
    const alt = 'ONDAP_LANGUAGE_' + id;
    const cookie = await login(id, '/academies');
    const chooser = await (await send('/academies', cookie)).text();
    assert.match(chooser, /테스트 교습소/);
    assert.match(chooser, /온답 어학원/);
    assert.ok(chooser.includes('value="' + alt + '"'));
    const choose = (from: string, profile: string) =>
      send('/academies', cookie, {
        action: 'switch',
        profile,
        _academyAccount: from,
      });
    assert.equal((await choose(id, 'TA_VISITOR')).status, 403);
    assert.equal((await choose(id, alt)).status, 303);
    const home = await (await send('/', cookie)).text();
    assert.ok(
      home.includes('data-account="' + alt + '"') &&
        home.includes('data-role="' + role + '"'),
    );
    assert.match(home, /내 학원 선택 · \[가상\] 온답 어학원/);
    assert.doesNotMatch(home, /테스트 교습소/);
    assert.equal(
      (
        await send('/settings', cookie, {
          _academyAccount: id,
          character: 'water',
        })
      ).status,
      409,
    );
    assert.equal(
      (await send('/settings', cookie, { character: 'water' })).status,
      409,
    );
    if (role === 'admin') {
      const doc = await (await send('/documents', cookie)).text();
      assert.match(doc, /온답 어학원 운영시간 안내/);
      const directory = await (await send('/directory', cookie)).text();
      assert.match(directory, /영어 회화반/);
      assert.doesNotMatch(directory, /TA_E_MATH/);
    }
    if (role === 'guardian') {
      const thread = await send('/consultation', cookie, {
        _academyAccount: alt,
        action: 'ask',
        conversationId: randomUUID(),
        question: '학원 운영시간을 알려주세요',
      });
      assert.equal(thread.status, 303);
      const path = thread.headers.get('location')!;
      const answer = await (await send(path, cookie)).text();
      assert.match(answer, /오후 2시/);
      assert.equal((await choose(alt, id)).status, 303);
      assert.equal((await send(path, cookie)).status, 404);
    } else {
      assert.equal((await choose(alt, id)).status, 303);
    }
    assert.ok(
      (await (await send('/', cookie)).text()).includes(
        'data-account="' + id + '"',
      ),
    );
  }
  const user = 'TA_GUARDIAN_M2';
  const cookie = await login(user, '/'),
    separate = await login(user, '/');
  db.exec(`INSERT INTO academies VALUES ('third','제삼 학원');
    INSERT INTO accounts(id,academy_id,username,name,role,password_hash)
      SELECT 'third-staff','third','third-staff','별도 강사','teacher',password_hash FROM accounts WHERE id='TA_TEACHER';`);
  const connect = (pw: string) =>
    send('/academies', cookie, {
      _academyAccount: user,
      action: 'connect',
      username: 'third-staff',
      password: pw,
    });
  assert.equal((await connect('incorrect')).status, 401);
  assert.doesNotMatch(
    await (await send('/academies', cookie)).text(),
    /제삼 학원/,
  );
  assert.equal((await connect(password)).status, 303);
  assert.match(await (await send('/', cookie)).text(), /data-role="teacher"/);
  assert.doesNotMatch(
    await (await send('/academies', separate)).text(),
    /제삼 학원/,
  );
  assert.equal(
    (
      await send('/academies', cookie, {
        action: 'switch',
        profile: user,
        _academyAccount: 'third-staff',
      })
    ).status,
    303,
  );
  assert.equal(
    (
      await send('/academies', cookie, {
        action: 'switch',
        profile: 'third-staff',
        _academyAccount: user,
      })
    ).status,
    303,
  );
  db.exec("UPDATE accounts SET role='visitor' WHERE id='third-staff'");
  assert.equal((await send('/', cookie)).headers.get('location'), '/login');
  assert.equal((await send('/', separate)).status, 200);
  const director = await login('TA_DIRECTOR', '/academies');
  assert.equal(
    (
      await send('/academies', director, {
        action: 'switch',
        profile: 'ONDAP_LANGUAGE_TA_DIRECTOR',
        _academyAccount: 'TA_DIRECTOR',
      })
    ).status,
    303,
  );
  db.exec("DELETE FROM op_academy_memberships WHERE login_id='TA_DIRECTOR'");
  assert.equal((await send('/', director)).headers.get('location'), '/login');
});
