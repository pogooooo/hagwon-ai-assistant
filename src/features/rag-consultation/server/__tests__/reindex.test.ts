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
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { IndexJobQueue } from '../store/index-jobs.ts';
import { parseInstant } from '../text/time.ts';
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
