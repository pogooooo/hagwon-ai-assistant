import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createOperationsServer } from './application.ts';
import { prepareQADemo } from './qa-demo.ts';
import { getActor } from './directory.ts';
import { consultationModule } from './consultation.ts';
import {
  configureOperationsGeneration,
  createOperationsGeneration,
} from './runtime-generation.ts';
import { workbookEvidence } from './workbook-publication.ts';
import type { RagAnswer } from '../rag-consultation/contract.ts';

test('QA 가상 데이터: 반 4개·정원 9·예약·서로 다른 승인 분석, 재실행 중복 없음', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-11-16T10:00:00+09:00'),
  });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createOperationsServer({ db, demoPassword: 'qa-test' });
  configureOperationsGeneration(
    createOperationsGeneration({ RAG_GENERATION_PROVIDER: 'disabled' }),
  );
  const first = await prepareQADemo(db);
  assert.deepEqual(first, {
    createdHomework: 2,
    published: 2,
    addedClasses: 4,
    capacity: 9,
    slots: 2,
    archivedDuplicates: 0,
  });
  assert.deepEqual(await prepareQADemo(db), {
    createdHomework: 0,
    published: 0,
    addedClasses: 0,
    capacity: 9,
    slots: 0,
    archivedDuplicates: 0,
  });
  const sources = workbookEvidence(db, 'AC_TEST_A').documents;
  assert.equal(sources.length, 2);
  const ask = async (who: string) => {
    const id = randomUUID(),
      f = new FormData();
    for (const [k, v] of Object.entries({
      action: 'ask',
      conversationId: id,
      question: '우리 아이 요즘 뭐가 약해요?',
    }))
      f.set(k, v);
    await consultationModule.submit(
      {
        db,
        actor: getActor(db, who)!,
        url: new URL('http://localhost/consultation'),
      },
      f,
    );
    return JSON.parse(
      String(
        db
          .prepare(
            "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
          )
          .get(id)!.response,
      ),
    ) as RagAnswer;
  };
  const a = await ask('TA_GUARDIAN_E_MATH'),
    b = await ask('TA_GUARDIAN_M2');
  assert.equal(a.status, 'answered', JSON.stringify(a));
  assert.equal(b.status, 'answered', JSON.stringify(b));
  assert.match(a.answer, /계산/);
  assert.match(b.answer, /추론/);
  assert.notEqual(a.citations[0].documentId, b.citations[0].documentId);
});
