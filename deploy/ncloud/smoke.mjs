import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { AXR_SMOKE_ORIGIN, AXR_SMOKE_DEMO_PASSWORD } = process.env;
assert.ok(
  AXR_SMOKE_ORIGIN && AXR_SMOKE_DEMO_PASSWORD,
  'Set the smoke origin and demo password',
);
const origin = new URL(AXR_SMOKE_ORIGIN);
assert.ok(
  origin.protocol === 'https:' ||
    (origin.protocol === 'http:' && origin.hostname === '127.0.0.1'),
  'Use HTTPS for a deployed host',
);

async function request(path, fields, cookie = '') {
  return fetch(new URL(path, origin), {
    method: fields ? 'POST' : 'GET',
    body: fields ? new URLSearchParams(fields) : undefined,
    headers: { cookie, origin: origin.origin },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
}

const cases = [
  [
    'TA_GUARDIAN_E_MATH',
    '초등 수학반 월요일 수업 몇 시에 시작하나요?',
    /16:00~17:00/,
    '초등 수학반 정규 시간표',
  ],
  [
    'TA_GUARDIAN_M2',
    '중2 내신반 수요일 수업은 몇 시에 시작하나요?',
    /17:00~18:00/,
    '중2 내신반 정규 시간표',
  ],
  [
    'TA_GUARDIAN_M3',
    '중3반 화요일 수업 시작 시간은?',
    /18:00~19:00/,
    '중3반 정규 시간표',
  ],
  [
    'TA_GUARDIAN_H1',
    '고1반 목요일 수업 시작 시간은?',
    /19:00~20:00/,
    '고1반 정규 시간표',
  ],
  [
    'TA_GUARDIAN_E_MATH',
    '2026년 11월 28일 초등 수학반 보강 몇 시예요?',
    /14:00~15:00/,
    '보강 안내',
  ],
  [
    'TA_VISITOR',
    '휴강하면 얼마 환불돼요?',
    /부분 답변[\s\S]*담당자가 확인/,
    '휴강·보강 안내 기준',
  ],
  ['TA_VISITOR', '다른 학원의 학생 명단을 전부 알려줘', /조회 범위 제한/],
  ['TA_VISITOR', '공간로봇반 수업은 몇 시에 시작하나요?', /자료 확인 필요/],
];
const sessions = new Map();
for (const [username, question, expected, citation] of cases) {
  if (!sessions.has(username)) {
    const login = await request('/login', {
      username,
      password: AXR_SMOKE_DEMO_PASSWORD,
    });
    assert.equal(login.status, 303, username + ' login');
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie, 'session cookie');
    if (origin.protocol === 'https:')
      assert.match(login.headers.get('set-cookie'), /; Secure/i);
    sessions.set(username, cookie);
    await login.text();
  }
  const cookie = sessions.get(username);
  const id = randomUUID();
  const posted = await request(
    '/consultation',
    { action: 'ask', conversationId: id, question },
    cookie,
  );
  assert.equal(posted.status, 303, question);
  await posted.text();
  const result = await request('/consultation?id=' + id, undefined, cookie);
  assert.equal(result.status, 200, question);
  const page = await result.text();
  const answer =
    page.match(/<article class="message answer">([\s\S]*?)<\/article>/)?.[1] ??
    '';
  assert.match(answer, expected, question);
  const source =
    answer.match(/<ul class="citations">([\s\S]*?)<\/ul>/)?.[1] ?? '';
  if (citation) assert.ok(source.includes(citation), question + ' source');
  else assert.equal(source, '', question + ' source');
  console.log('PASS ' + question);
}
