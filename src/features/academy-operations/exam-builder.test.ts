import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildExam, examBuilderModule as module } from './exam-builder.ts';
import {
  editableQuestions,
  parseQuestions,
  selectQuestions,
  wantsVariants,
  looksLikeExamRequest,
} from './exam-questions.ts';
import { examVariantGenerator } from './exam-variants.ts';
import type { PageContext, Role } from './shared.ts';
const sample = readFileSync(
  new URL('./assets/ondap-exam-example.txt', import.meta.url),
  'utf8',
);
function form(fields: Record<string, string | File | string[]>) {
  const f = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const text of value) f.append(key, text);
    else f.set(key, value);
  }
  return f;
}
test('teacher imports, reviews, assembles, privately edits and prints a paper from the sample', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  module.setup(db);
  const ctx = (
    url = '/exam-builder',
    id = 'owner',
    academyId = 'academy',
    role: Role = 'teacher',
  ): PageContext => ({
    db,
    url: new URL(url, 'https://example.test'),
    actor: { id, academyId, role, username: id, name: id, studentId: null },
  });
  const uploaded = String(
    await module.submit(
      ctx(),
      form({
        action: 'upload',
        file: new File([sample], 'practice.txt'),
        subject: '수학',
        grade: '중2',
        topic: '일차함수',
        level: '기본',
      }),
    ),
  );
  const source = ctx(uploaded).url.searchParams.get('source')!;
  const request = '중학교 2학년 수학 일차함수 객관식 5문항 시험지 만들어줘';
  const ask = (c: PageContext, key = 'exam-request-001') =>
    buildExam(c, request, key, false);
  await assert.rejects(ask(ctx()), /0개/);
  assert.match(await module.render(ctx(uploaded)), /문항과 정답 검토/);
  await assert.rejects(
    async () =>
      module.submit(ctx(), form({ action: 'approve', source, text: sample })),
    /확인/,
  );
  await module.submit(
    ctx(),
    form({ action: 'approve', source, text: sample, checked: 'yes' }),
  );
  const location = await ask(ctx());
  assert.equal(await ask(ctx()), location);
  const studentCopy = await module.render(ctx(location));
  assert.match(studentCopy, /학습 시험지/);
  assert.doesNotMatch(studentCopy, /x의 계수는 3이다|출처 ·/);
  const keyCopy = await module.render(ctx(location + '&sheet=key'));
  assert.match(keyCopy, /x의 계수는 3이다/);
  assert.match(keyCopy, /practice\.txt/);
  for (const other of [
    ctx(location, 'other'),
    ctx(location, 'owner', 'different'),
    ctx(location, 'owner', 'academy', 'guardian'),
    ctx(location, 'owner', 'academy', 'student'),
  ]) {
    await assert.rejects(
      async () => module.render(other),
      /찾을 수 없|교사 계정/,
    );
    await assert.rejects(ask(other), /0개|교사 계정/);
  }
  const paper = ctx(location).url.searchParams.get('paper')!;
  const modify = form({
    action: 'edit',
    paper,
    revision: '1',
    prompt: ['가', '나', '다', '라', '마'],
    answer: ['비공개 풀이', '', '', '', ''],
  });
  await module.submit(ctx(), modify);
  assert.match(
    await module.render(ctx(location + '&sheet=key')),
    /비공개 풀이/,
  );
  assert.doesNotMatch(await module.render(ctx(location)), /비공개 풀이/);
  await assert.rejects(async () => module.submit(ctx(), modify), /다른 창/);
  await assert.rejects(
    buildExam(ctx(), '고2 수학 1문항', 'exam-request-002', false),
    /0개/,
  );
  assert.match(
    await buildExam(
      ctx(),
      '일차함수 변형 시험지 1문항',
      'exam-request-003',
      false,
    ),
    /\?request=/,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM op_exam_papers').get()?.n,
    1,
  );
});
test('numbered prompts keep choices and answer keys private; unsupported conditions fail explicitly', () => {
  const result = parseQuestions(
    '1. 첫 문제? 정답: 비공개1\n2. 둘째 문제?\n① 가 ② 나\n정답표\n2. 비공개2',
  );
  assert.deepEqual(result, [
    { prompt: '첫 문제?', answer: '비공개1' },
    { prompt: '둘째 문제?\n① 가 ② 나', answer: '비공개2' },
  ]);
  assert.deepEqual(parseQuestions(editableQuestions(result)), result);
  assert.throws(
    () => parseQuestions('지문: 공통 본문\n1. 해당 문장은?'),
    /공통 지문/,
  );
  assert.throws(
    () => parseQuestions('1. 첫 문제\n추가 정답: 비공개'),
    /정답 줄/,
  );
  assert.throws(() => parseQuestions('1. 첫 문제\n1. 둘째 문제'), /중복/);
  const source = {
    id: 'my',
    title: '파일',
    subject: '수학',
    grade: '중2',
    topic: '일차함수',
    level: '기본',
    questions: result,
  };
  assert.equal(
    selectQuestions('중2 객관식 일차함수 1문항', [source])[0].number,
    2,
  );
  assert.throws(
    () => selectQuestions('중2 객관식 2문항', [source, source]),
    /1개/,
  );
  assert.throws(
    () => selectQuestions('수학 제외 1문항', [source]),
    /제외 조건/,
  );
  assert.equal(selectQuestions('중2 5문항', [source], true).length, 5);
  assert.equal(wantsVariants('일차함수 유사 문제 2문항'), true);
  assert.equal(looksLikeExamRequest('중2 시험지를 만들어줘'), true);
  assert.equal(looksLikeExamRequest('시험지 신청은 어디서 하나요?'), false);
});
test('CLOVA variants send only selected references, reject repeated or answer-leaking prompts', async () => {
  const item = {
    source: 'private database id',
    sourceTitle: 'private filename',
    number: 1,
    prompt: '4 + 7은?',
    answer: '11',
  };
  let text = '6 + 7은?';
  const generate = examVariantGenerator(
    { CLOVA_STUDIO_API_KEY: 'fake' },
    async (_url, init) => {
      const body = String(init?.body);
      assert.doesNotMatch(body, /private database id|private filename/);
      assert.match(body, /4 \+ 7은/);
      return Response.json({
        result: {
          message: {
            content: JSON.stringify({
              items: [{ ref: 1, prompt: text, answer: '13' }],
            }),
          },
        },
      });
    },
  )!;
  assert.equal(
    (await generate('덧셈 변형 1문항', [item]))[0].source,
    item.source,
  );
  for (const bad of [item.prompt, '6 + 7은? 정답: 13']) {
    text = bad;
    await assert.rejects(generate('덧셈 변형 1문항', [item]), /저장하지 않았/);
  }
});

test('a Worker-compatible request never follows provider redirects', async () => {
  let calls = 0;
  const generate = examVariantGenerator(
    { CLOVA_STUDIO_API_KEY: 'fake' },
    async (_, init) => {
      assert.equal(init?.redirect, 'manual');
      calls++;
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://example.test/other' },
      });
    },
  )!;
  await assert.rejects(
    generate('변형', [
      {
        source: 'test',
        sourceTitle: '시험',
        number: 1,
        prompt: '2+4?',
        answer: '6',
      },
    ]),
    /네이버 출제 요청/,
  );
  assert.equal(calls, 1);
});
