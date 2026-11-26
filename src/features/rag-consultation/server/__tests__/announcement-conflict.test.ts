import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshEnv, runQuery } from './helpers.ts';

async function fixture() {
  const env = await freshEnv();
  const register = (
    documentId: string,
    title: string,
    text: string,
    approve = true,
  ) =>
    env.store.upsertIndexedRevision({
      approve,
      document: {
        academyId: 'AC_A',
        documentId,
        revision: 1,
        documentType: 'announcement',
        visibility: 'academy_public',
        title,
        validFrom: '2026-11-01T09:00:00+09:00',
        approvedAt: '2026-11-01T09:00:00+09:00',
        text,
      },
    });
  const ask = (question: string) =>
    runQuery(env, {
      engine: 'planned',
      userId: 'VISITOR_A',
      question,
      asOf: '2026-11-03T12:00:00+09:00',
    });
  return { register, ask };
}

test('같은 행사의 승인 시작 시각이 서로 다르면 답변을 보류한다', async () => {
  const { register, ask } = await fixture();
  const question = '11월 7일 공예발표회 몇 시에 시작해요?';
  await register(
    'ART_NOTICE',
    '월간 공지',
    '## 공예발표회\n\n11월 7일(토) 9:00부터 진행합니다.',
  );
  await register(
    'ART_QUESTION',
    '학부모 게시판',
    '## 공예발표회\n\nQ. 11월 7일(토) 13:00부터 맞나요?',
  );
  await register(
    'ART_DRAFT',
    '공예발표회 초안',
    '## 공예발표회\n\n11월 7일(토) 15:00부터 진행합니다.',
    false,
  );
  await register(
    'ART_BOARD_CONFIRM',
    '학부모 게시판',
    '## 공예발표회\n\nA. (데스크) 11월 7일(토) 09:00부터 진행합니다.',
  );
  const agreed = await ask(question);
  assert.notEqual(agreed.trace.intent, 'announcement_conflict');
  assert.doesNotMatch(agreed.answer.answer, /13:00|15:00/);
  await register(
    'ART_BOARD_CONFLICT',
    '학부모 게시판',
    '## 공예발표회\n\nA. (데스크) 11월 7일(토) 10:00부터 진행합니다.',
  );
  const conflict = await ask(question);
  assert.equal(
    conflict.trace.intent,
    'announcement_conflict',
    conflict.answer.answer,
  );
  assert.equal(conflict.answer.status, 'abstained');
  assert.deepEqual(conflict.answer.citations, []);
  assert.equal(conflict.generationCalls, 0);
});

test('같은 공식 답변 안에서 행사명과 별도 문장의 마감일을 함께 검증한다', async () => {
  const { register, ask } = await fixture();
  await register(
    'BOOK_EVENT',
    '행사 공지',
    '## 그림책 경연대회\n\n참가 신청은 11월 15일(일)까지 받습니다.',
  );
  await register(
    'BOOK_REPLY',
    '학부모 게시판',
    'Q. 참가 대상이 궁금합니다.\nA. (데스크) 그림책 경연대회는 모든 원생이 참가할 수 있습니다. 참가 신청은 11월 12일(목)까지 받습니다.',
  );
  const result = await ask('그림책 경연대회 신청은 언제까지 해요?');
  assert.equal(
    result.trace.intent,
    'announcement_conflict',
    result.answer.answer,
  );
  assert.equal(result.answer.status, 'abstained');
  assert.deepEqual(result.answer.citations, []);
});

test('같은 시작월의 주간 행사 요일이 승인 공지에서 다르면 보류한다', async () => {
  const { register, ask } = await fixture();
  await register(
    'DRILL_A',
    '월간 공지',
    '11월부터 매주 수요일 주간 발음훈련을 진행합니다.',
  );
  await register(
    'DRILL_B',
    '학부모 게시판',
    'A. (담당 강사) 11월부터 매주 금요일 주간 발음훈련을 진행합니다.',
  );
  const result = await ask('11월부터 주간 발음훈련은 무슨 요일에 해요?');
  assert.equal(
    result.trace.intent,
    'announcement_conflict',
    result.answer.answer,
  );
  assert.equal(result.answer.status, 'abstained');
});
