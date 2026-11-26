/**
 * 문서·채점 변경 반영 테스트(E12, E29 CounterMem식, E34).
 * 같은 질문·같은 권한으로 다시 물었을 때 최종 답변이 바뀌는지까지 확인한다.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FixedClock } from '../adapters/memory/index.ts';
import {
  analysisReportToIndexInput,
  onAnalysisReportPublished,
  onDocumentChanged,
  type AnalysisReportPublished,
} from '../events.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { Bm25Ranker } from '../retrieval/rankers.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { IndexJobQueue } from '../store/index-jobs.ts';
import { parseInstant } from '../text/time.ts';
import type {
  ApprovedFactInput,
  RagAccessScope,
  SourceDocumentInput,
} from '../types.ts';
import { freshEnv, runQuery } from './helpers.ts';

const asOf = '2026-11-25T10:00:00+09:00';
const question = 'A01의 12월 일차방정식 정답률은?';

function report(
  revision: number,
  correct: number,
  publishedAt = '2026-11-24T09:00:00+09:00',
): AnalysisReportPublished {
  return {
    academyId: 'AC_A',
    studentId: 'ST_A01',
    classId: 'CL_ADV',
    reportId: 'RPT_A01_2026_12',
    revision,
    period: '2026-12',
    title: '가상 원생 A01 12월 단원 분석',
    publishedAt,
    units: [
      {
        unitName: '일차방정식',
        correctCount: correct,
        questionCount: 20,
        assignmentIds: ['HW_1'],
      },
    ],
  };
}

describe('CounterMem식 변경 반응', () => {
  test('채점 수정(13/20 → 15/20) 후 같은 질문의 답과 인용 revision 이 바뀐다', async () => {
    const env = await freshEnv();
    const queue = new IndexJobQueue({
      documents: env.store,
      clock: new FixedClock(parseInstant(asOf)),
    });

    await onAnalysisReportPublished(queue, report(1, 13));
    const before = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question,
      asOf,
    });
    assert.equal(before.answer.status, 'answered');
    assert.match(before.answer.answer, /20문항 중 13문항 정답\(정답률 65%\)/);
    assert.deepEqual(
      before.answer.citations.map((c) => [c.sourceId, c.revision]),
      [['RPT_A01_2026_12:r1:body', 1]],
    );

    const job = await onAnalysisReportPublished(queue, report(2, 15));
    assert.equal(job.status, 'activated');
    const after = await runQuery(env, { userId: 'GUARDIAN_A', question, asOf });
    assert.equal(after.answer.status, 'answered');
    assert.match(after.answer.answer, /20문항 중 15문항 정답\(정답률 75%\)/);
    assert.ok(!after.answer.answer.includes('13문항'));
    assert.deepEqual(
      after.answer.citations.map((c) => [c.sourceId, c.revision]),
      [['RPT_A01_2026_12:r2:body', 2]],
    );
    assert.ok(after.trace.retrievedFactIds.every((id) => !id.includes(':r1:')));
  });

  test('근거를 삭제하면 기억한 값으로 답하지 않고 보류한다', async () => {
    const env = await freshEnv();
    const queue = new IndexJobQueue({
      documents: env.store,
      clock: new FixedClock(parseInstant(asOf)),
    });
    await onAnalysisReportPublished(queue, report(1, 13));
    assert.equal(
      (await runQuery(env, { userId: 'GUARDIAN_A', question, asOf })).answer
        .status,
      'answered',
    );

    const job = await onDocumentChanged(queue, {
      type: 'deleted',
      academyId: 'AC_A',
      documentId: 'RPT_A01_2026_12',
    });
    assert.equal(job.status, 'revoked');
    const after = await runQuery(env, { userId: 'GUARDIAN_A', question, asOf });
    assert.equal(after.answer.status, 'abstained');
    assert.deepEqual(after.answer.citations, []);
  });

  test('수강료 문서 삭제·권한 철회는 즉시 검색·인용에서 빠진다', async () => {
    const env = await freshEnv();
    const fee = '중2 기본반 11월 1일 수강료?';
    const at = '2026-11-01T18:00:00+09:00';
    assert.equal(
      (await runQuery(env, { userId: 'VISITOR_A', question: fee, asOf: at }))
        .answer.status,
      'answered',
    );
    await env.store.revokeRevision({
      documentId: 'D_FEE_REG',
      reason: 'revoked',
    });
    const after = await runQuery(env, {
      userId: 'VISITOR_A',
      question: fee,
      asOf: at,
    });
    assert.equal(after.answer.status, 'abstained');
    assert.ok(after.trace.retrievedFactIds.every((id) => id !== 'F_FEE_REG'));
  });
});

describe('revision 전환 규칙', () => {
  const reportDoc = (revision: number, correct: number) =>
    analysisReportToIndexInput(report(revision, correct));

  test('승인 전(staged) revision 은 노출되지 않고, 승인 활성화 후에만 보인다', async () => {
    const env = await freshEnv();
    const r1 = reportDoc(1, 13);
    const staged = await env.store.upsertIndexedRevision({
      ...r1,
      approve: false,
    });
    assert.equal(staged.status, 'staged');
    assert.equal(
      (await runQuery(env, { userId: 'GUARDIAN_A', question, asOf })).answer
        .status,
      'abstained',
    );
    assert.equal(
      env.store.activateRevision('RPT_A01_2026_12', 1).status,
      'activated',
    );
    assert.equal(
      (await runQuery(env, { userId: 'GUARDIAN_A', question, asOf })).answer
        .status,
      'answered',
    );
  });

  test('같은 revision 재전송은 멱등, 내용이 다르면 거부', async () => {
    const store = new InMemoryRagStore();
    const r1 = reportDoc(1, 13);
    assert.equal(
      (await store.upsertIndexedRevision({ ...r1, approve: true })).status,
      'activated',
    );
    assert.equal(
      (await store.upsertIndexedRevision({ ...r1, approve: true })).status,
      'unchanged',
    );
    const tampered = reportDoc(1, 19);
    const result = await store.upsertIndexedRevision({
      ...tampered,
      approve: true,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.errorCode, 'REVISION_CONFLICT');
  });

  test('늦게 도착한 낮은 revision 은 활성화되지 않는다(순서 역전 방지)', async () => {
    const env = await freshEnv();
    await env.store.upsertIndexedRevision({
      ...reportDoc(3, 17),
      approve: true,
    });
    const late = await env.store.upsertIndexedRevision({
      ...reportDoc(2, 15),
      approve: true,
    });
    assert.equal(late.status, 'rejected');
    assert.equal(late.errorCode, 'STALE_REVISION');
    const answer = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question,
      asOf,
    });
    assert.match(answer.answer.answer, /17문항 정답/);
  });

  test('큐에 역순으로 들어온 이벤트도 revision 순서로 처리하고 중복 이벤트는 합친다', async () => {
    const env = await freshEnv();
    const queue = new IndexJobQueue({
      documents: env.store,
      clock: new FixedClock(parseInstant(asOf)),
    });
    const r3 = reportDoc(3, 17);
    const r2 = reportDoc(2, 15);
    const first = queue.enqueue({ jobType: 'upsert', ...r3, approve: true });
    const duplicate = queue.enqueue({
      jobType: 'upsert',
      ...r3,
      approve: true,
    });
    assert.equal(first.jobId, duplicate.jobId);
    const second = queue.enqueue({ jobType: 'upsert', ...r2, approve: true });
    await queue.runPending();
    assert.equal(queue.getJob(second.jobId)?.status, 'activated');
    assert.equal(queue.getJob(first.jobId)?.status, 'activated');
    assert.equal(
      env.store.getRevisionStatus('RPT_A01_2026_12', 2),
      'superseded',
    );
    assert.equal(
      env.store.getRevisionStatus('RPT_A01_2026_12', 3),
      'approved_active',
    );
  });

  test('승인된 새 revision 색인이 실패하면 구버전을 현재 값으로 답하지 않고, 재시도 후 dead 처리', async () => {
    let failing = true;
    const store = new InMemoryRagStore({
      failIndexing: (doc) =>
        failing && doc.documentId === 'RPT_A01_2026_12' && doc.revision === 2,
    });
    const env = { ...(await freshEnv()), store };
    const { buildFixtureStore } =
      await import('../adapters/fixture/load-fixture.ts');
    await buildFixtureStore(env.data, store);
    const clock = new FixedClock(parseInstant(asOf));
    const queue = new IndexJobQueue({
      documents: store,
      clock,
      maxAttempts: 3,
      baseBackoffMs: 1000,
    });

    await onAnalysisReportPublished(queue, report(1, 13));
    assert.equal(
      (await runQuery(env, { userId: 'GUARDIAN_A', question, asOf })).answer
        .status,
      'answered',
    );

    const job = await onAnalysisReportPublished(queue, report(2, 15));
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
    assert.ok(store.hasPendingApprovedRevision('RPT_A01_2026_12'));
    const stale = await runQuery(env, { userId: 'GUARDIAN_A', question, asOf });
    assert.equal(
      stale.answer.status,
      'abstained',
      '검증되지 않은 상태에서 이전 13/20 을 현재 값으로 답하면 안 됨',
    );

    // 백오프 시간이 지나기 전에는 재시도하지 않는다.
    await queue.runPending();
    assert.equal(queue.getJob(job.jobId)?.attempts, 1);
    clock.set(clock.now() + 1000);
    await queue.runPending();
    clock.set(clock.now() + 2000);
    await queue.runPending();
    assert.equal(queue.getJob(job.jobId)?.status, 'dead');

    // 원인 해결 후 같은 revision 을 다시 보내면 처리된다.
    failing = false;
    const retried = await onAnalysisReportPublished(queue, report(2, 15));
    assert.equal(retried.status, 'activated');
    assert.notEqual(retried.jobId, job.jobId);
    assert.ok(!store.hasPendingApprovedRevision('RPT_A01_2026_12'));
    const fresh = await runQuery(env, { userId: 'GUARDIAN_A', question, asOf });
    assert.match(fresh.answer.answer, /15문항 정답/);
  });
});

function testAccess(academyId: string, studentId?: string): RagAccessScope {
  return {
    academyId,
    actorId: 'TEST_ACTOR',
    role: studentId ? 'guardian' : 'visitor',
    allowedStudentIds: studentId ? [studentId] : [],
    allowedClassIds: [],
    studentRefs: [],
    canViewPublicHistory: false,
  };
}

test('학생 ID가 직원 전용 자료의 권한을 대신할 수 없다', async () => {
  const store = new InMemoryRagStore();
  const data = analysisReportToIndexInput(report(1, 13));
  const document = {
    ...data.document,
    documentType: 'guidance' as const,
    visibility: 'staff_only' as const,
  };
  assert.equal(
    (await store.upsertIndexedRevision({ document, approve: true })).errorCode,
    'INVALID_DOCUMENT',
  );
  assert.equal(
    canReadRecord(
      testAccess('AC_A', 'ST_A01'),
      { ...document, studentId: 'ST_A01', classId: null },
      ['ST_A01'],
    ),
    false,
  );
});

test('동일 ID의 두 학원은 승인 작업, 청크, 사실, 인용, 철회가 독립적이다', async () => {
  const store = new InMemoryRagStore({
    ranker: new Bm25Ranker({
      id: 'test-tokenizer',
      tokenize: (text) => text.match(/[0-9]+|[가-힣]+/g) ?? [],
    }),
  });
  const at = parseInstant(asOf);
  const queue = new IndexJobQueue({
    documents: store,
    clock: new FixedClock(at),
  });
  const alpha = analysisReportToIndexInput(report(1, 13));
  const beta = analysisReportToIndexInput({
    ...report(1, 17),
    academyId: 'AC_B',
    studentId: 'ST_B01',
    title: '학원 B 단원 분석',
  });
  const draftDocument = { ...alpha.document };
  delete draftDocument.approvedAt;
  const stage = {
    jobType: 'upsert' as const,
    ...alpha,
    document: draftDocument,
    approve: false,
  };
  const staged = queue.enqueue(stage);
  assert.equal(queue.enqueue(stage).jobId, staged.jobId);
  await queue.runPending();
  assert.equal(queue.getJob(staged.jobId)?.status, 'staged');

  const approvalA = queue.enqueue({
    jobType: 'upsert',
    ...alpha,
    approve: true,
  });
  const approvalB = queue.enqueue({
    jobType: 'upsert',
    ...beta,
    approve: true,
  });
  assert.notEqual(approvalA.jobId, staged.jobId);
  assert.notEqual(approvalA.jobId, approvalB.jobId);
  await queue.runPending();
  assert.equal(queue.getJob(approvalA.jobId)?.status, 'activated');
  assert.equal(queue.getJob(approvalB.jobId)?.status, 'activated');

  const query = (access: RagAccessScope) => ({
    access,
    studentIds: access.allowedStudentIds,
    asOf: at,
  });
  const queryA = query(testAccess('AC_A', 'ST_A01'));
  const queryB = query(testAccess('AC_B', 'ST_B01'));
  const search = (request: typeof queryA) =>
    store.searchApprovedChunks({
      ...request,
      query: '일차방정식',
      limit: 10,
    });
  const [a] = await search(queryA);
  const [b] = await search(queryB);
  assert.match(a.chunk.text, /정답 문항: 13\b/);
  assert.match(b.chunk.text, /정답 문항: 17\b/);
  assert.equal(a.chunk.chunkId, b.chunk.chunkId);
  assert.deepEqual(
    await store.searchApprovedChunks({
      ...queryB,
      query: '13',
      limit: 10,
    }),
    [],
  );
  assert.deepEqual(store.factRefsAtChunk(a.chunk.chunkId), []);
  assert.equal(
    store.factRefsAtChunk(a.chunk.chunkId, 'AC_A')[0]?.subjectId,
    'ST_A01',
  );
  assert.equal(
    store.factRefsAtChunk(b.chunk.chunkId, 'AC_B')[0]?.subjectId,
    'ST_B01',
  );
  const [factB] = await store.queryApprovedFacts({
    ...queryB,
    factTypes: ['accuracy'],
  });
  const sourceId = b.chunk.sourceId;
  assert.equal(
    (await store.getCitableSource({ ...queryB, sourceId }))?.title,
    '학원 B 단원 분석',
  );
  assert.equal(
    await store.getCitableSource({ ...queryA, sourceId, locate: factB }),
    null,
  );
  const duplicateSource = await store.upsertIndexedRevision({
    document: { ...alpha.document, documentId: 'UNRELATED' },
    approve: true,
  });
  assert.equal(duplicateSource.errorCode, 'REVISION_CONFLICT');

  await store.revokeRevision({
    documentId: alpha.document.documentId,
    reason: 'revoked',
  });
  assert.equal((await search(queryA)).length, 1);
  assert.equal((await search(queryB)).length, 1);
  const revoked = await onDocumentChanged(queue, {
    type: 'access_revoked',
    academyId: 'AC_A',
    documentId: alpha.document.documentId,
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal((await search(queryA)).length, 0);
  assert.equal((await search(queryB)).length, 1);
});

function feeRevision(
  revision: number,
  validFrom: string,
  approvedAt: string,
  amount: number,
): { document: SourceDocumentInput; facts: ApprovedFactInput[] } {
  const sourceId = `SAME_FEE:r${revision}:body`;
  const academyId = 'AC_A';
  const documentId = 'SAME_FEE';
  return {
    document: {
      academyId,
      documentId,
      revision,
      sourceId,
      documentType: 'fee',
      visibility: 'academy_public',
      title: '수강료 안내',
      text: `정규 수강료는 ${amount}원입니다.`,
      validFrom,
      approvedAt,
    },
    facts: [
      {
        academyId,
        documentId,
        revision,
        sourceId,
        factId: `FEE:r${revision}`,
        subjectType: 'academy',
        subjectId: academyId,
        factType: 'monthly_fee',
        value: { kind: 'money', amount, currency: 'KRW' },
        period: null,
        validFrom,
        validTo: null,
        approvalStatus: 'approved',
      },
    ],
  };
}

test('잘못된 승인 날짜는 유효한 개정이나 검색 세대를 바꾸지 않는다', async () => {
  const store = new InMemoryRagStore();
  const start = '2026-11-01T00:00:00+09:00';
  const r1 = feeRevision(1, start, start, 230000);
  await store.upsertIndexedRevision({ ...r1, approve: true });
  const generation = store.indexGeneration;
  for (const badApproval of [
    '2026-13-01T00:00:00+09:00',
    '2026-02-30T00:00:00+09:00',
  ]) {
    const malformed = feeRevision(2, start, badApproval, 250000);
    const result = await store.upsertIndexedRevision({
      ...malformed,
      approve: true,
    });
    assert.equal(result.errorCode, 'INVALID_DOCUMENT');
    assert.equal(
      store.hasPendingApprovedRevision(r1.document.documentId, 'AC_A'),
      false,
    );
    assert.equal(store.indexGeneration, generation);
  }
  const results = await store.searchApprovedChunks({
    access: testAccess('AC_A'),
    studentIds: [],
    asOf: parseInstant(asOf),
    query: '수강료',
    limit: 10,
  });
  assert.deepEqual(
    results.map(({ chunk }) => chunk.sourceId),
    [r1.document.sourceId],
  );
});

test('승인 시각과 적용 시각을 구분해 현재와 미래의 출처를 선택한다', async () => {
  const store = new InMemoryRagStore();
  const currentStart = '2026-11-01T00:00:00+09:00';
  const futureStart = '2026-12-01T00:00:00+09:00';
  const current = feeRevision(1, currentStart, currentStart, 230000);
  const future = feeRevision(
    2,
    futureStart,
    '2026-11-20T00:00:00+09:00',
    250000,
  );
  const unknown = feeRevision(
    3,
    futureStart,
    '2026-11-28T00:00:00+09:00',
    270000,
  );
  for (const revision of [current, future, unknown])
    assert.equal(
      (await store.upsertIndexedRevision({ ...revision, approve: true }))
        .status,
      'activated',
    );
  const request = {
    access: testAccess('AC_A'),
    studentIds: [],
    asOf: parseInstant(asOf),
  };
  const effectiveAt = parseInstant(futureStart);
  const factRequest = { ...request, factTypes: ['monthly_fee'] as const };
  assert.deepEqual(
    (await store.queryApprovedFacts(factRequest)).map(
      ({ revision }) => revision,
    ),
    [1],
  );
  assert.deepEqual(
    (await store.queryApprovedFacts({ ...factRequest, effectiveAt })).map(
      ({ revision }) => revision,
    ),
    [2],
  );
  const search = { ...request, query: '수강료', limit: 10 };
  assert.deepEqual(
    (await store.searchApprovedChunks(search)).map(
      ({ chunk }) => chunk.revision,
    ),
    [1],
  );
  assert.deepEqual(
    (
      await store.searchApprovedChunks({
        ...search,
        upcomingUntil: effectiveAt,
      })
    )
      .map(({ chunk }) => chunk.revision)
      .sort(),
    [1, 2],
  );
  assert.equal(
    await store.getCitableSource({
      ...request,
      sourceId: future.document.sourceId!,
    }),
    null,
  );
  assert.equal(
    (
      await store.getCitableSource({
        ...request,
        sourceId: future.document.sourceId!,
        effectiveAt,
      })
    )?.revision,
    2,
  );
  assert.equal(
    await store.getCitableSource({
      ...request,
      sourceId: current.document.sourceId!,
      effectiveAt,
    }),
    null,
  );
});

test('미래 적용 개정으로 공개 범위가 축소되면 이전 개정에도 즉시 적용한다', async () => {
  const store = new InMemoryRagStore();
  const start = '2026-11-01T00:00:00+09:00';
  const current = feeRevision(1, start, start, 230000);
  const future = feeRevision(
    2,
    '2026-12-01T00:00:00+09:00',
    '2026-11-20T00:00:00+09:00',
    250000,
  );
  future.document.visibility = 'staff_only';
  for (const revision of [current, future])
    assert.equal(
      (await store.upsertIndexedRevision({ ...revision, approve: true }))
        .status,
      'activated',
    );

  const request = {
    access: testAccess('AC_A'),
    studentIds: [],
    asOf: parseInstant(asOf),
  };
  const citation = { ...request, sourceId: current.document.sourceId! };
  const search = { ...request, query: '수강료', limit: 10 };
  const facts = { ...request, factTypes: ['monthly_fee'] as const };
  assert.equal(
    (
      await store.searchApprovedChunks({
        ...search,
        asOf: parseInstant('2026-11-19T00:00:00+09:00'),
      })
    ).length,
    1,
  );
  assert.deepEqual(await store.searchApprovedChunks(search), []);
  assert.deepEqual(await store.queryApprovedFacts(facts), []);
  assert.equal(await store.getCitableSource(citation), null);
  assert.equal(
    await store.corpusContains({ ...request, term: '230000' }),
    false,
  );

  const staff: RagAccessScope = { ...request.access, role: 'teacher' };
  assert.equal(
    (await store.getCitableSource({ ...citation, access: staff }))?.revision,
    1,
  );
});

test('비동기 검색 중 철회된 문서는 순위 응답에서 반환하지 않는다', async () => {
  const pause = Promise.withResolvers<void>();
  const store = new InMemoryRagStore({
    ranker: {
      id: 'test-delayed-ranker',
      async rank(candidates) {
        await pause.promise;
        return candidates.map((chunk) => ({ chunk, score: 1 }));
      },
    },
  });
  const start = '2026-11-01T00:00:00+09:00';
  const entry = feeRevision(1, start, start, 230000);
  await store.upsertIndexedRevision({ ...entry, approve: true });
  const pending = store.searchApprovedChunks({
    access: testAccess('AC_A'),
    studentIds: [],
    asOf: parseInstant(asOf),
    query: '수강료',
    limit: 10,
  });
  await store.revokeRevision({
    academyId: 'AC_A',
    documentId: entry.document.documentId,
    reason: 'revoked',
  });
  pause.resolve();
  assert.deepEqual(await pending, []);
});
