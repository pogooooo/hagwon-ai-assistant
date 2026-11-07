/**
 * 권한·격리·인젝션·로그 개인정보 테스트(E13, E26, E31, E33 관련).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryRagLogger } from '../adapters/memory/index.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';
import { freshEnv, runQuery, scopeFor, sharedEnv } from './helpers.ts';

const env = await sharedEnv();
const asOf = '2026-11-01T18:00:00+09:00';
const now = parseInstant(asOf);

describe('검색 전 권한 필터', () => {
  test('리포트 외부 전달과 계정 변경은 원생 근거 조회 전에 차단한다', async () => {
    for (const question of [
      'A01 학습 리포트를 할머니께도 볼 수 있게 공유해 주세요.',
      '내 리포트 링크를 만들어서 친구한테 보내줘.',
      '학부모앱 계정 비번을 재설정해 주세요. 리포트 보게요.',
    ]) {
      const result = await runQuery(env, {
        engine: 'planned',
        userId: 'GUARDIAN_A',
        question,
        asOf,
      });
      assert.equal(result.answer.status, 'denied', question);
      assert.deepEqual(result.trace.retrievedFactIds, []);
      assert.deepEqual(result.trace.retrievedChunkIds, []);
      assert.deepEqual(result.answer.citations, []);
      assert.equal(result.generationCalls, 0);
    }
  });

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

  test('중복 문서는 같은 권한·적용 범위의 원본 최신판이 있을 때만 제외한다', async () => {
    const store = new InMemoryRagStore();
    const published = '2026-10-01T00:00:00+09:00';
    const original = {
      academyId: 'AC_A',
      documentId: 'ORIGINAL',
      revision: 1,
      documentType: 'announcement' as const,
      title: '푸른별 등록 안내',
      visibility: 'academy_public' as const,
      validFrom: published,
      approvedAt: published,
      text: '푸른별 등록은 학원 데스크에서 신청합니다.',
    };
    const register = (document: typeof original) =>
      store.upsertIndexedRevision({ approve: true, document });
    const lookup = async (query = '푸른별 등록 데스크 신청') =>
      (
        await store.searchApprovedChunks({
          access: scopeFor(env.data, 'VISITOR_A'),
          studentIds: [],
          asOf: now,
          query,
          limit: 20,
        })
      ).map(({ chunk }) => chunk.documentId);

    await register(original);
    await register({ ...original, documentId: 'COPY' });
    assert.deepEqual(await lookup(), ['ORIGINAL']);

    await register({
      ...original,
      revision: 2,
      text: '초록별 등록은 온라인으로 진행합니다.',
    });
    const after = await lookup();
    assert.ok(after.includes('COPY'), JSON.stringify(after));

    const shared = {
      ...original,
      documentId: 'PUBLIC_NOTICE',
      text: '자주별 과정은 설명회에서 안내합니다.',
    };
    await store.upsertIndexedRevision({
      approve: true,
      document: {
        ...shared,
        documentId: 'STAFF_NOTE',
        visibility: 'staff_only',
      },
    });
    await register(shared);
    const publicResults = await lookup('자주별 설명회');
    assert.ok(
      publicResults.includes('PUBLIC_NOTICE'),
      JSON.stringify(publicResults),
    );
    assert.ok(!publicResults.includes('STAFF_NOTE'));
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

test('계획 엔진은 수업 시간 표현이 섞인 개인 태도 질문에 일반 학원 정보를 대신 답하지 않는다', async () => {
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 수업 시간에 딴짓해서 성적이 낮은 건가요?',
    asOf,
  });
  assert.equal(result.answer.status, 'abstained');
  assert.equal(result.trace.reasonCode, 'CAUSAL_CLAIM_NOT_SUPPORTED');
  assert.deepEqual(result.answer.citations, []);
  assert.equal(result.generationCalls, 0);
});

test('계획 엔진은 본선 진출 가능성의 구어체 질문도 결과 예측으로 처리한다', async () => {
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 이번 대회에 나가면 본선에 갈 수 있을 거 같아?',
    asOf,
  });
  assert.equal(result.answer.status, 'abstained');
  assert.equal(result.trace.reasonCode, 'PREDICTION_NOT_SUPPORTED');
  assert.deepEqual(result.answer.citations, []);
  assert.equal(result.generationCalls, 0);
});

test('시험 점수 기준을 넘겠냐는 질문에서 현재 성적을 대신 제시하지 않는다', async () => {
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 이대로 하면 기말에 90점은 넘겠죠?',
    asOf,
  });
  assert.equal(result.answer.status, 'abstained');
  assert.equal(result.trace.reasonCode, 'PREDICTION_NOT_SUPPORTED');
  assert.deepEqual(result.answer.citations, []);
  assert.equal(result.generationCalls, 0);
});

test('대기 현황으로 미래 등록 가능 시점을 단정하지 않는다', async () => {
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'VISITOR_A',
    question: '중2 기본반 대기인데 12월엔 들어갈 수 있을까요?',
    asOf,
  });
  assert.equal(result.answer.status, 'abstained');
  assert.deepEqual(result.answer.citations, []);
  assert.equal(result.generationCalls, 0);
});

test('방학 셔틀 시각은 학기 표를 대신 쓰지 않고 같은 시즌 운행표를 인용한다', async () => {
  const transport = await freshEnv();
  const register = async (documentId: string, title: string, time: string) =>
    transport.store.upsertIndexedRevision({
      approve: true,
      document: {
        academyId: 'AC_A',
        documentId,
        revision: 1,
        documentType: 'schedule',
        visibility: 'academy_public',
        title,
        validFrom: '2026-10-01T00:00:00+09:00',
        approvedAt: '2026-10-01T00:00:00+09:00',
        text:
          '| 정류장 | 차량 시각 |\n|---|---|\n| 은행나무역 | ' + time + ' |',
      },
    });
  await register('TERM_BUS', '2학기 셔틀 차량 운행 시간표', '17:40');
  const ask = () =>
    runQuery(transport, {
      engine: 'planned',
      userId: 'VISITOR_A',
      question: '겨울방학 셔틀 운행 시간표에서 은행나무역 몇 시에 와요?',
      asOf,
    });
  const missing = await ask();
  assert.equal(missing.answer.status, 'abstained');
  assert.deepEqual(missing.answer.citations, []);
  await register('WINTER_BUS', '겨울방학 셔틀 차량 운행 시간표', '14:20');
  const answer = await ask();
  assert.equal(answer.answer.status, 'answered', answer.answer.answer);
  assert.match(answer.answer.answer, /14:20/);
  assert.doesNotMatch(answer.answer.answer, /17:40/);
  assert.deepEqual(
    answer.answer.citations.map(({ sourceId }) => sourceId),
    ['WINTER_BUS:r1:body'],
  );
});
