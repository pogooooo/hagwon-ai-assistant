import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENGLISH_STARTER_EXAMPLES,
  STARTER_EXAMPLES,
  buildAreaPrompt,
  chooseExamples,
  areaText,
  parseArea,
  suggestArea,
} from './area-suggest.mjs';

test('수학은 지어낸 예시를 모두 쓰고, 지시문 표기(문제해결)로 답을 보여 준다', () => {
  const chosen = chooseExamples('등차수열 {a_n}에서 a_3=7일 때 a_9의 값은?');
  assert.equal(chosen.length, STARTER_EXAMPLES.length);
  assert.deepEqual(
    chosen.map((e: { text: string }) => e.text),
    STARTER_EXAMPLES.map((e: { text: string }) => e.text),
  );
  assert.ok(chosen.some((e: { area: string }) => e.area === '문제해결'));
});

test('지시문에 정의와 예시가 들어가고 응답에서 대분류 이름만 받는다', () => {
  const prompt = buildAreaPrompt('등차수열 {a_n}에서 a_3=7');
  assert.match(prompt, /계산: 주어진 식에/);
  assert.match(prompt, /답: \{"area":"이해"\}/);
  assert.equal(parseArea('{"area":"문제해결"}'), '문제 해결');
  assert.equal(parseArea('설명 {"area":"추론","x":"\\neq"}'), '추론');
  assert.equal(parseArea('{"area":"문제 해결"}'), '문제 해결');
  assert.equal(parseArea('{"area":"기타"}'), null);
  assert.equal(parseArea('답 없음'), null);
  assert.equal(parseArea('답: 추론'), '추론');
  assert.equal(parseArea('문제 해결 문항입니다.'), '문제 해결');
});

test('대분류 추천은 HCX-007에 한 번 묻고, 요청 한도(429)면 한 번만 다시 묻는다', async (t) => {
  const saved = process.env.CLOVA_STUDIO_API_KEY;
  process.env.CLOVA_STUDIO_API_KEY = 'test';
  t.after(() => {
    if (saved === undefined) delete process.env.CLOVA_STUDIO_API_KEY;
    else process.env.CLOVA_STUDIO_API_KEY = saved;
  });
  t.mock.method(globalThis, 'setTimeout', (fn: () => void) => {
    fn();
    return 0;
  });
  const statuses = [429, 200];
  const sent: { system: string; user: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.match(String(url), /chat-completions\/HCX-007$/);
    const body = JSON.parse(String(init.body));
    sent.push({
      system: body.messages[0].content,
      user: body.messages[1].content,
    });
    const status = statuses.shift()!;
    if (status !== 200) return new Response('', { status });
    return Response.json({
      result: { message: { content: '{"area":"이해"}' } },
    });
  });
  assert.equal(await suggestArea('M', '등차수열 {a_n}에서 a_3=7'), '이해');
  assert.equal(sent.length, 2);
  assert.match(sent[0].user, /^문항: 등차수열/);
  // 예시는 지어낸 문항이다.
  assert.match(sent[0].system, /\$a_\{2\}=5\$, \$a_\{5\}=14\$/);
});

test('대분류를 물을 때는 배점과 선택지를 지운다', () => {
  assert.equal(
    areaText('$f(2)$의 값은? [$3$점]\n① $26$\n② $28$\n⑤ $34$'),
    '$f(2)$의 값은?',
  );
  assert.equal(areaText('넓이를 구하시오. [4점]'), '넓이를 구하시오.');
  assert.doesNotMatch(buildAreaPrompt('값은? [3점]\n① 1'), /①|3점/);
});

test('영어는 한글 발문이 비슷한 지어낸 예시 6개를 고르고, 영어 대분류 이름으로 답을 받는다', () => {
  // 영어 지문이 달라도 발문이 같으면 가장 비슷하다.
  const chosen = chooseExamples(
    '다음 글의 제목으로 가장 적절한 것은? Ocean plastic is growing.',
    'E',
  );
  assert.equal(chosen.length, 6);
  assert.match(chosen[0].text, /^다음 글의 제목으로/);
  assert.equal(chosen[0].area, '중심 내용 파악');
  assert.ok(
    chosen.every((e: { text: string }) =>
      ENGLISH_STARTER_EXAMPLES.some((s: { text: string }) => s.text === e.text),
    ),
  );
  const prompt = buildAreaPrompt(
    '다음 글의 목적으로 가장 적절한 것은? Dear all,',
    'E',
  );
  assert.match(prompt, /- 맥락 파악: 글의 목적/);
  assert.match(prompt, /답: \{"area":"맥락 파악"\}/);
  assert.equal(parseArea('{"area":"언어형식·어휘"}', 'E'), '언어형식·어휘');
  assert.equal(parseArea('{"area":"맥락파악"}', 'E'), '맥락 파악');
  assert.equal(parseArea('답: 간접 쓰기', 'E'), '간접 쓰기');
  assert.equal(parseArea('{"area":"이해"}', 'E'), null);
});
