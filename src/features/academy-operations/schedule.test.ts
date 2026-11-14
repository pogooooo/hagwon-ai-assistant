import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createRagConsultationService,
  DisabledGenerationProvider,
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
} from '../rag-consultation/server/index.ts';
import {
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
} from '../rag-consultation/server/adapters/fixture/load-academies.ts';
import { getActor, initializeIdentity } from './directory.ts';
import { buildDocumentsIndex, documentsModule } from './documents.ts';
import {
  scheduleDocuments,
  scheduleFacts,
  scheduleModule,
} from './schedule.ts';
import { OperationError } from './shared.ts';

const fixture = readAcademiesDataset(
  fileURLToPath(new URL('../makeup-schedule/academies/', import.meta.url)),
);
const academyId = fixture.academies[0].academy_id;

function setup(t: { after: (callback: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  initializeIdentity(db, 'schedule-fixture');
  documentsModule.setup(db);
  scheduleModule.setup(db);
  return db;
}

async function query(
  db: DatabaseSync,
  userId: string,
  question: string,
  asOf: string,
) {
  const user = fixture.users.find(({ user_id }) => user_id === userId);
  assert.ok(user);
  const store = await buildDocumentsIndex(
    db,
    academyId,
    scheduleDocuments(db, academyId),
    scheduleFacts(db, academyId),
  );
  return createRagConsultationService({
    facts: store,
    documents: store,
    catalog: createAcademyCatalogPort(fixture),
    generation: new DisabledGenerationProvider(),
    handoff: new InMemoryHandoffStore(),
    conversations: new InMemoryConversationStore(),
    clock: new FixedClock(Date.parse(asOf)),
    engine: 'planned',
  }).query({
    question,
    conversationId: 'makeup-regression',
    access: toAcademyAccessScope(user, fixture.students),
  });
}

test('팀의 휴·보강 6개 사례를 운영 색인에서 검증한다', async (t) => {
  const db = setup(t);
  assert.equal(fixture.cases.length, 6);
  for (const { case_id, input, expected } of fixture.cases) {
    await t.test(case_id, async () => {
      const { answer, trace } = await query(
        db,
        input.user_id,
        input.query,
        input.as_of,
      );
      assert.equal(answer.status, expected.status, answer.answer);
      assert.deepEqual(
        [...new Set(answer.citations.map(({ sourceId }) => sourceId))].sort(),
        [...expected.source_ids].sort(),
      );
      assert.deepEqual(
        [...new Set(trace.usedFactIds)].sort(),
        [...(expected.fact_ids ?? [])].sort(),
      );
      for (const text of expected.must_include ?? [])
        assert.ok(answer.answer.includes(text), answer.answer);
      for (const text of expected.must_not_include ?? [])
        assert.ok(!answer.answer.includes(text), answer.answer);
      assert.ok(trace.generationCalls <= expected.generation_budget_max);
    });
  }
});

function submitNotice(db: DatabaseSync, values: Record<string, string>) {
  const actor = getActor(db, 'TA_DIRECTOR');
  assert.ok(actor);
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return scheduleModule.submit(
    { db, actor, url: new URL('http://127.0.0.1/schedule') },
    form,
  );
}

test('다일 휴강은 KST 종료일을 제외하고 연결된 승인 보강만 인용한다', async (t) => {
  const db = setup(t);
  const year = new Date().getUTCFullYear() + 1;
  const common = {
    action: 'save_notice',
    class_id: 'TA_E_MATH',
    title: '다일 휴강 공지',
    closure_start: `${year}-12-01T00:00`,
    closure_end: `${year}-12-04T00:00`,
    makeup_kind: 'scheduled',
    makeup_start: `${year}-12-05T13:00`,
    makeup_end: `${year}-12-05T14:00`,
  };
  await submitNotice(db, common);
  const [first] = scheduleDocuments(db, academyId);
  assert.ok(first);
  const { documentId } = first;
  const noticeId = documentId.replace(/^ops-schedule-/, '');
  assert.throws(
    () =>
      submitNotice(db, {
        ...common,
        closure_start: `${year}-12-02T12:00`,
        makeup_start: `${year}-12-05T16:00`,
        makeup_end: `${year}-12-05T17:00`,
      }),
    (error) => error instanceof OperationError && error.status === 409,
  );
  assert.throws(
    () =>
      submitNotice(db, {
        ...common,
        closure_start: `${year}-12-05T13:30`,
        closure_end: `${year}-12-05T14:30`,
        makeup_kind: 'pending',
      }),
    (error) => error instanceof OperationError && error.status === 409,
  );
  await submitNotice(db, {
    ...common,
    title: '별도 휴강 공지',
    closure_start: `${year}-12-06T00:00`,
    closure_end: `${year}-12-07T00:00`,
    makeup_start: `${year}-12-08T13:00`,
    makeup_end: `${year}-12-08T14:00`,
  });
  const ask = (day: number, userId = 'TA_GUARDIAN_E_MATH') =>
    query(
      db,
      userId,
      `${year}년 12월 ${day}일 초등 수학반 휴강하고 보강은 언제예요?`,
      new Date(Date.now() + 1000).toISOString(),
    );
  const initial = (await ask(2)).answer;
  assert.equal(initial.status, 'answered', initial.answer);
  assert.match(initial.answer, /12월 5일 13:00/);
  assert.doesNotMatch(initial.answer, /12월 8일/);
  assert.deepEqual(
    initial.citations.map(({ sourceId }) => sourceId),
    [documentId + ':r1:body'],
  );

  const boundary = (await ask(4)).answer;
  assert.equal(boundary.status, 'abstained', boundary.answer);
  assert.deepEqual(boundary.citations, []);

  const outOfScope = (await ask(2, 'TA_GUARDIAN_M2')).answer;
  assert.ok(outOfScope.citations.every((c) => c.documentId !== documentId));
  assert.doesNotMatch(outOfScope.answer, /12월 5일 13:00/);

  await submitNotice(db, {
    ...common,
    notice_id: noticeId,
    revision: '1',
    makeup_start: `${year}-12-05T15:00`,
    makeup_end: `${year}-12-05T16:00`,
  });
  const edited = (await ask(2)).answer;
  assert.equal(edited.status, 'answered', edited.answer);
  assert.match(edited.answer, /12월 5일 15:00/);
  assert.doesNotMatch(edited.answer, /13:00/);
  assert.deepEqual(
    edited.citations.map(({ sourceId }) => sourceId),
    [documentId + ':r2:body'],
  );

  await submitNotice(db, {
    action: 'revoke_notice',
    notice_id: noticeId,
    revision: '2',
  });
  const withdrawn = (await ask(2)).answer;
  assert.equal(withdrawn.status, 'abstained', withdrawn.answer);
  assert.deepEqual(withdrawn.citations, []);

  await submitNotice(db, { ...common, makeup_kind: 'pending' });
  const pending = (await ask(2)).answer;
  assert.equal(pending.status, 'partial', pending.answer);
  assert.match(pending.answer, /확정되지 않았습니다/);
  assert.doesNotMatch(pending.answer, /12월 8일|15:00/);
});

test('주간 조회는 이전 주에 시작해 조회 주간까지 이어지는 휴강을 포함한다', async (t) => {
  const db = setup(t);
  const year = new Date().getUTCFullYear() + 1;
  await submitNotice(db, {
    action: 'save_notice',
    class_id: 'TA_E_MATH',
    title: '여러 주에 걸친 휴강',
    closure_start: `${year}-12-01T00:00`,
    closure_end: `${year}-12-12T00:00`,
    makeup_kind: 'pending',
  });
  const [notice] = scheduleDocuments(db, academyId);
  assert.ok(notice);
  const { answer } = await query(
    db,
    'TA_GUARDIAN_E_MATH',
    '이번 주 초등 수학반 휴강 있나요?',
    `${year}-12-10T10:00:00+09:00`,
  );
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /12월 1일.*12월 12일/);
  assert.deepEqual(
    answer.citations.map(({ documentId }) => documentId),
    [notice.documentId],
  );
});
