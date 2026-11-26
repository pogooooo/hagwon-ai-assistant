import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createOperationsServer } from './application.ts';
import { createExternalServices } from './external-services.ts';
import { onboardingPath } from './academy-onboarding.ts';

test('academy onboarding finds, reviews and creates isolated spaces for first and existing owners', async (t) => {
  const db = new DatabaseSync(':memory:');
  const demoPassword = 'onboarding-local-fixture';
  let hits = 0;
  const services = createExternalServices(
    { AXR_NEIS_API_KEY: 'test-neis-only' },
    async (target, init) => {
      hits++;
      const url = new URL(String(target));
      assert.equal(url.host, 'open.neis.go.kr');
      assert.equal(url.pathname, '/hub/acaInsTiInfo');
      assert.equal(url.searchParams.get('ATPT_OFCDC_SC_CODE'), 'B10');
      assert.equal(url.searchParams.get('pSize'), '24');
      assert.equal(init?.redirect, 'manual');
      if (url.searchParams.get('ACA_NM') === '응답없음')
        return Response.redirect('https://example.invalid');
      if (url.searchParams.get('ACA_NM') === '없는학원')
        return Response.json({ RESULT: { CODE: 'INFO-200' } });
      assert.equal(url.searchParams.get('ACA_NM'), '합성회화학원');
      assert.equal(url.searchParams.get('ADMST_ZONE_NM'), '가상구');
      const first = {
        ATPT_OFCDC_SC_CODE: 'B10',
        ACA_ASNUM: 'R001',
        ACA_NM: '합성회화학원',
        FA_RDNMA: '서울 가상구 배움로 12',
        FA_RDNDA: '2층',
        FA_TELNO: '02-000-0000',
        ADMST_ZONE_NM: '가상구',
        REG_STTUS_NM: '개원',
        ACA_INSTI_SC_NM: '학원',
        LE_CRSE_NM: '외국어',
        THCC_OTHBC_YN: 'N',
        PSNBY_THCC_CNTNT: '미공개 금액',
      };
      return Response.json({
        acaInsTiInfo: [
          {
            head: [{ list_total_count: 38 }, { RESULT: { CODE: 'INFO-000' } }],
          },
          {
            row: [
              first,
              { ...first, LE_CRSE_NM: '회화' },
              { ...first, ACA_ASNUM: 'R002', FA_RDNMA: '서울 가상구 솔길 31' },
            ],
          },
        ],
      });
    },
    db,
  );
  const server = createOperationsServer({ db, demoPassword, services });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  async function request(
    path: string,
    cookie = '',
    fields?: Record<string, string>,
    origin = base,
  ) {
    const res = await fetch(base + path, {
      method: fields ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { cookie, origin },
      body: fields ? new URLSearchParams(fields) : undefined,
    });
    return {
      status: res.status,
      location: res.headers.get('location') ?? '',
      cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
      body: await res.text(),
    };
  }
  function hidden(body: string, name: string) {
    const match = body.match(new RegExp('name="' + name + '" value="([^"]+)"'));
    assert.ok(match, name + ' hidden');
    return match[1];
  }
  const login = await request('/login');
  assert.match(login.body, /새 학원 등록/);
  const anon = (await request(onboardingPath)).cookie;
  assert.match(anon, /^axr_academy_registration=/);
  const unauthorized = (
    await request('/login', '', {
      username: 'TA_STUDENT_001',
      password: demoPassword,
    })
  ).cookie;
  assert.equal((await request(onboardingPath, unauthorized)).status, 403);
  const query = {
    action: 'search',
    name: '합성회화학원',
    office: 'B10',
    district: '가상구',
  };
  assert.equal(
    (await request(onboardingPath, anon, query, 'https://external.invalid'))
      .status,
    403,
  );
  assert.equal(
    (await request(onboardingPath, anon, { ...query, office: 'Z00' })).status,
    400,
  );
  const search = await request(onboardingPath, anon, query);
  assert.equal(search.status, 303);
  const list = await request(search.location, anon);
  assert.match(list.body, /2개 학원 표시/);
  assert.match(list.body, /일부 결과입니다/);
  assert.match(list.body, /배움로 12 2층/);
  assert.match(list.body, /솔길 31/);
  assert.doesNotMatch(list.body, /test-neis-only|미공개 금액/);

  const reviewPath = search.location + '&candidate=1';
  const review = await request(reviewPath, anon);
  assert.match(review.body, /value="서울 가상구 솔길 31 2층"/);
  assert.match(review.body, /value="02-000-0000"/);
  assert.match(review.body, /원장 계정 만들기/);
  const foreign = (await request(onboardingPath)).cookie;
  const wrongScope = await request(reviewPath, foreign);
  assert.match(wrongScope.body, /검색 결과가 만료되었습니다/);
  assert.doesNotMatch(wrongScope.body, /솔길 31/);

  const credentials = {
    username: 'fixture-owner',
    password: 'long-fixture-password',
    passwordConfirm: 'long-fixture-password',
  };
  const fields = {
    action: 'register',
    entry: 'first',
    requestId: hidden(review.body, 'requestId'),
    search: hidden(review.body, 'search'),
    candidate: '1',
    name: '수정한 합성회화학원',
    address: '서울 가상구 솔길 31 3층',
    district: '가상구',
    course: '중등 회화',
    category: '학원',
    phone: '02-000-1000',
    ownerName: '가상 원장',
    ...credentials,
  };
  assert.equal((await request(onboardingPath, foreign, fields)).status, 409);
  assert.equal(
    (await request(onboardingPath, anon, { ...fields, candidate: '99' }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(onboardingPath, anon, {
        ...fields,
        passwordConfirm: 'mismatch',
      })
    ).status,
    400,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM academies WHERE id LIKE 'academy-%'")
      .get()?.n,
    0,
  );
  const done = await request(onboardingPath, anon, fields);
  assert.equal(done.status, 303);
  assert.equal(done.location, '/academies');
  assert.match(done.cookie, /^axr_operations=/);
  const selected = await request('/academies', done.cookie);
  assert.match(selected.body, /수정한 합성회화학원/);
  assert.match(selected.body, /솔길 31 3층/);
  assert.match(selected.body, /중등 회화/);
  assert.doesNotMatch(selected.body, /테스트 교습소|영어 회화반/);
  assert.equal((await request('/', done.cookie)).status, 200);
  assert.equal((await request('/directory', done.cookie)).status, 200);
  const row = db.prepare('SELECT * FROM op_academy_profiles').get()!;
  assert.equal(row.official_key, 'B10:R002');
  assert.equal(row.address, fields.address);
  assert.equal(
    JSON.parse(String(row.source)).address,
    '서울 가상구 솔길 31 2층',
  );
  assert.equal((await request(onboardingPath, anon, fields)).status, 409);
  const connected = await request('/academies', unauthorized, {
    action: 'connect',
    username: credentials.username,
    password: credentials.password,
  });
  assert.equal(connected.status, 303);
  assert.doesNotMatch(
    (await request('/academies', unauthorized)).body,
    /새 학원 등록/,
  );
  assert.equal((await request(onboardingPath, unauthorized)).status, 403);

  await request('/logout', done.cookie, {});
  const relogin = await request('/login', '', {
    username: credentials.username,
    password: credentials.password,
  });
  assert.equal(relogin.status, 303);

  const unavailable = await request(onboardingPath, foreign, {
    ...query,
    name: '응답없음',
  });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body, /직접 입력/);
  const empty = await request(onboardingPath, foreign, {
    ...query,
    name: '없는학원',
  });
  assert.match(
    (await request(empty.location, foreign)).body,
    /일치하는 학원이 없습니다/,
  );
  const direct = await request(onboardingPath + '?manual=1', relogin.cookie);
  const current = hidden(direct.body, '_academyAccount');
  const manual = {
    action: 'register',
    entry: 'existing',
    requestId: hidden(direct.body, 'requestId'),
    name: '새 분원',
    address: '가상시 배움로 4',
    _academyAccount: current,
  };
  assert.doesNotMatch(direct.body, /원장 계정 만들기/);
  assert.equal(
    (
      await request(onboardingPath, relogin.cookie, {
        ...manual,
        _academyAccount: 'wrong',
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(onboardingPath, relogin.cookie, manual)).status,
    303,
  );
  const multiple = await request('/academies', relogin.cookie);
  assert.match(multiple.body, /수정한 합성회화학원/);
  assert.match(multiple.body, /새 분원/);
  assert.match(multiple.body, /가상시 배움로 4/);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM academies WHERE id LIKE 'academy-%'")
      .get()?.n,
    2,
  );
  assert.ok(hits >= 3);
});
