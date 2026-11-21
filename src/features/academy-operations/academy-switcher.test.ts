import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeIdentity } from './directory.ts';
import { createOperationsServer } from './application.ts';

test('학원 선택 · 네 역할별 전환, 세션 격리, 타 학원 검증과 권한 회수', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const password = 'synthetic-selector-test';
  initializeIdentity(db, password);
  db.exec(`INSERT INTO accounts(id,academy_id,username,name,role,password_hash)
    SELECT 'qa-parent-test',academy_id,'AXR_CHECK_GUARDIAN_20261119','체험 보호자',role,password_hash FROM accounts WHERE id='TA_GUARDIAN_E_MATH';`);
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
    if (role === 'student' || role === 'guardian') {
      const page = await (await send('/homework', cookie)).text();
      assert.match(page, /숙제 자료/);
      assert.match(page, /\/assets\/demo-homework-fractions\.pdf" download/);
      assert.doesNotMatch(page, /\/assets\/demo-homework-english\.pdf/);
    }
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
    if (role === 'student' || role === 'guardian') {
      const page = await (await send('/homework', cookie)).text();
      assert.match(page, /숙제 자료/);
      assert.match(page, /\/assets\/demo-homework-english\.pdf" download/);
      assert.doesNotMatch(page, /\/assets\/demo-homework-fractions\.pdf/);
      if (role === 'student') {
        const file = await send('/assets/demo-homework-english.pdf', cookie);
        assert.equal(file.status, 200);
        assert.equal(file.headers.get('content-type'), 'application/pdf');
        assert.equal(
          Buffer.from(await file.arrayBuffer())
            .subarray(0, 5)
            .toString(),
          '%PDF-',
        );
      }
    }
    if (role === 'student') {
      const assignments = await (await send('/homework', cookie)).text();
      assert.match(assignments, /일과와 약속 시간 복습/);
    }
    if (role === 'admin' || role === 'teacher') {
      const work = await (
        await send('/consultation?status=reply', cookie)
      ).text();
      assert.match(work, /시간을 말할 때 at과 on/);
      if (role === 'teacher') {
        const makeup = await (
          await send('/schedule?view=makeup', cookie)
        ).text();
        assert.match(makeup, /휴강 확정/);
        assert.match(makeup, /보강 투표 진행 중/);
        assert.match(makeup, /보강 투표 현황 보기/);
        assert.doesNotMatch(makeup, /보강 가능 시간 등록|안내문 발송 대기/);
      }
    }
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
      for (const question of ['수업 대상이 누구인지', '중학생도 수업하는지']) {
        const course = await send('/consultation', cookie, {
          _academyAccount: alt,
          action: 'ask',
          conversationId: randomUUID(),
          question,
        });
        assert.equal(course.status, 303);
        const reply = await (
          await send(course.headers.get('location')!, cookie)
        ).text();
        assert.match(reply, /data-answer-status="answered"/);
        assert.match(reply, /영어 회화반/);
        assert.doesNotMatch(reply, /중2 내신반/);
        assert.match(reply, /온답 어학원 정규 수업 안내/);
      }
      for (const [question, expected, source] of [
        ['그럼 수강료는요?', /210,000원/, /영어 회화반 수강료/],
        [
          '고등학생 수업 하나요?',
          /고등학생 대상 정규 수업을 운영하지 않습니다\. 담당자에게 문의해 볼까요\?/,
          /온답 어학원 정규 수업 안내/,
        ],
        [
          '영어 회화반 시간표 알려주세요.',
          /17:00~18:20/,
          /영어 회화반 정규 시간표/,
        ],
        [
          '학부모 상담 신청은 어떻게 하나요?',
          /일정·예약 메뉴/,
          /온답 어학원 방문과 상담 안내/,
        ],
        [
          '차 가져가도 돼요?',
          /방문자 주차장을 운영하지 않습니다/,
          /온답 어학원 방문과 상담 안내/,
        ],
      ] as const) {
        const answer = await send('/consultation', cookie, {
          _academyAccount: alt,
          action: 'ask',
          conversationId: randomUUID(),
          question,
        });
        assert.equal(answer.status, 303);
        const html = await (
          await send(answer.headers.get('location')!, cookie)
        ).text();
        assert.match(html, /data-answer-status="answered"/);
        assert.match(html, expected);
        assert.match(html, source);
        assert.match(html, /value="handoff">담당자 상담 요청/);
        assert.doesNotMatch(html, /180,000원|중2 내신반/);
      }
      const monthly = await (
        await send('/student-reports?id=archived-2026-09', cookie)
      ).text();
      assert.equal(
        (monthly.match(/href="\/student-reports\?id=archived-/g) ?? []).length,
        3,
      );
      assert.match(monthly, /길 묻고 설명하기/);
      assert.match(monthly, /<table>/);
      assert.match(monthly, /data:text\/markdown/);
      assert.doesNotMatch(monthly, /리포트 예시|분수의 덧셈과 뺄셈/);
      const inHomework = await (
        await send('/homework?view=reports', cookie)
      ).text();
      assert.match(inHomework, /2026년 11월 학습 리포트/);
      assert.ok(
        inHomework.includes(
          'href="/homework?view=reports&amp;id=archived-2026-09"',
        ),
      );
      const poll = await (await send('/makeup-votes', cookie)).text();
      assert.match(poll, /영어 회화반 휴강/);
      assert.match(poll, /name="rank1"/);
      assert.match(poll, /name="rank3"/);
      assert.doesNotMatch(poll, /초등 수학반 휴강/);
      const voice = await (await send('/voice', cookie)).text();
      assert.match(voice, /voice-workspace/);
      assert.match(voice, /채팅 상담 열기/);
      const documents = await (await send('/documents', cookie)).text();
      assert.doesNotMatch(documents, /<th>공개 범위<\/th>|철회 이력 포함/);
      const reportHub = await (
        await send('/student-reports?view=assignments', cookie)
      ).text();
      assert.match(reportHub, /학습 리포트/);
      assert.match(reportHub, /과제별 결과/);
      assert.doesNotMatch(
        documents,
        /<header[\s\S]*?profile-link[\s\S]*?<\/header>/,
      );

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
  const qaCookie = await login('AXR_CHECK_GUARDIAN_20261119', '/academies');
  assert.equal(
    (
      await send('/academies', qaCookie, {
        action: 'switch',
        profile: 'ONDAP_LANGUAGE_qa-parent-test',
        _academyAccount: 'qa-parent-test',
      })
    ).status,
    303,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT student_id FROM guardian_students WHERE guardian_id='ONDAP_LANGUAGE_qa-parent-test'",
      )
      .all()
      .map((r) => r.student_id),
    ['ONDAP_DEMO_QA_LEARNER'],
  );
  assert.equal(
    (await send('/student-reports?id=archived-2026-11', qaCookie)).status,
    404,
  );
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
