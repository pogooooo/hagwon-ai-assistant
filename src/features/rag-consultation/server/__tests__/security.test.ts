/**
 * 권한·격리·인젝션·로그 개인정보 테스트(E13, E26, E31, E33 관련).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryRagLogger } from '../adapters/memory/index.ts';
import { parseInstant } from '../text/time.ts';
import { runQuery, scopeFor, sharedEnv } from './helpers.ts';

const env = await sharedEnv();
const asOf = '2026-11-01T18:00:00+09:00';
const now = parseInstant(asOf);

describe('검색 전 권한 필터', () => {
  test('A학원 사용자는 B학원 청크를 검색 후보로도 받지 않는다', async () => {
    const results = await env.store.searchApprovedChunks({
      access: scopeFor(env.data, 'ADMIN_A'),
      studentIds: ['ST_A01', 'ST_A02'],
      asOf: now,
      query: 'B학원 중2심화반 수강료 450000 B01 일차방정식',
      limit: 50,
    });
    assert.ok(results.length > 0);
    assert.ok(results.every(({ chunk }) => chunk.academyId === 'AC_A'));
  });

  test('요청에 다른 학생 ID를 넣어도 허용 범위 밖이면 제외된다(심층 방어)', async () => {
    const results = await env.store.searchApprovedChunks({
      access: scopeFor(env.data, 'GUARDIAN_A02'),
      studentIds: ['ST_A01', 'ST_A02'],
      asOf: now,
      query: '일차방정식 정답 원생',
      limit: 50,
    });
    assert.ok(
      results.every(
        ({ chunk }) => chunk.studentId === null || chunk.studentId === 'ST_A02',
      ),
    );
    const facts = await env.store.queryApprovedFacts({
      access: scopeFor(env.data, 'GUARDIAN_A02'),
      studentIds: ['ST_A01'],
      factTypes: ['accuracy'],
      asOf: now,
    });
    assert.equal(facts.length, 0);
  });

  test('허용된 형제라도 이번 질문 대상이 아니면 개인 자료를 읽지 않는다', async () => {
    const result = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: 'A01의 10월 일차방정식 정답률은?',
      asOf,
    });
    assert.equal(result.answer.status, 'answered');
    const touched = [
      ...result.trace.retrievedFactIds,
      ...result.trace.retrievedChunkIds,
    ];
    assert.ok(
      touched.every((id) => !id.startsWith('F_S2') && !id.startsWith('D_S2')),
    );
  });

  test('미승인 초안은 유사도가 높아도 검색되지 않는다', async () => {
    const results = await env.store.searchApprovedChunks({
      access: scopeFor(env.data, 'ADMIN_A'),
      studentIds: [],
      asOf: now,
      query: '미승인 초안 중2심화반 수강료 10000원',
      limit: 50,
    });
    assert.ok(results.every(({ chunk }) => chunk.documentId !== 'D_DRAFT_FEE'));
  });

  test('지시문이 들어 있는 문서는 기본 검색·생성 입력에서 제외되고 검수 대상이 된다', async () => {
    const access = scopeFor(env.data, 'VISITOR_A');
    const normal = await env.store.searchApprovedChunks({
      access,
      studentIds: [],
      asOf: now,
      query: '시설 안내 시스템 지시 학생 명단',
      limit: 50,
    });
    assert.ok(normal.every(({ chunk }) => chunk.documentId !== 'D_INJECTION'));
    const withSuspicious = await env.store.searchApprovedChunks({
      access,
      studentIds: [],
      asOf: now,
      query: '시설 안내 시스템 지시 학생 명단',
      limit: 50,
      includeSuspicious: true,
    });
    assert.ok(
      withSuspicious.some(
        ({ chunk }) => chunk.documentId === 'D_INJECTION' && chunk.suspicious,
      ),
    );
  });
});

describe('거부 응답은 존재 여부를 드러내지 않는다', () => {
  test('존재하는 타 학생과 존재하지 않는 학생 코드의 응답이 같다', async () => {
    const existing = await runQuery(env, {
      userId: 'GUARDIAN_A02',
      question: 'A01의 10월 정답률 알려줘',
      asOf,
    });
    const missing = await runQuery(env, {
      userId: 'GUARDIAN_A02',
      question: 'Z99의 10월 정답률 알려줘',
      asOf,
    });
    assert.equal(existing.answer.status, 'denied');
    assert.equal(missing.answer.status, 'denied');
    assert.equal(existing.answer.answer, missing.answer.answer);
    assert.deepEqual(existing.answer.citations, []);
    assert.ok(!existing.answer.answer.includes('A01'));
  });

  test('보호자 연결이 해제되면 이전 대화의 선택 학생으로도 조회되지 않는다', async () => {
    // GUARDIAN_A02 는 A02 만 허용. 대화 상태에 남은 A01 선택은 무시하지 않고 차단한다.
    const result = await runQuery(env, {
      userId: 'GUARDIAN_A02',
      question: '지난달 정답률은?',
      asOf,
      session: { selected_student_id: 'ST_A01' },
    });
    assert.equal(result.answer.status, 'denied');
    assert.equal(result.trace.retrievedFactIds.length, 0);
  });

  test('요청 힌트(studentId)도 권한 밖이면 거부된다', async () => {
    const result = await runQuery(env, {
      userId: 'GUARDIAN_A02',
      question: '10월 정답률 알려줘',
      asOf,
      studentIdHint: 'ST_A01',
    });
    assert.equal(result.answer.status, 'denied');
  });

  test('방문자는 학생 코드 없이 성적을 물어도 학습 자료에 접근하지 못한다', async () => {
    const result = await runQuery(env, {
      userId: 'VISITOR_A',
      question: '10월 정답률 알려줘',
      asOf,
    });
    assert.equal(result.answer.status, 'denied');
    assert.equal(result.trace.retrievedFactIds.length, 0);
  });
});

describe('기본 로그에 개인정보·원문이 남지 않는다', () => {
  test('질문·답변 원문과 학생 코드, 성적 수치가 로그에 없다', async () => {
    const logger = new MemoryRagLogger();
    await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: 'A01의 10월 일차방정식 정답률은?',
      asOf,
      logger,
    });
    await runQuery(env, {
      userId: 'GUARDIAN_A02',
      question: 'A01 성적 알려줘',
      asOf,
      logger,
    });
    const serialized = JSON.stringify(logger.events);
    assert.ok(logger.events.length >= 2);
    for (const forbidden of [
      'A01의',
      '정답률은',
      '13/20',
      '65%',
      '13문항',
      'GUARDIAN_A',
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `로그에 포함되면 안 되는 값: ${forbidden}`,
      );
    }
  });
});
