/**
 * 휴·보강 확정 → RAG 상담 반영 통합 테스트(가상 데이터).
 * 관리 화면과 같은 규칙(model/schedule.ts)으로 일정을 만들고, 실제 상담 엔진에 같은 질문을 던져
 * 확정·변경·취소가 다음 답변에 바로 반영되는지, 미확정·권한 밖 일정이 새지 않는지 확인한다.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
  type AcademiesDataset,
} from '../../rag-consultation/server/adapters/fixture/load-academies.ts';
import { FixedClock } from '../../rag-consultation/server/adapters/memory/index.ts';
import {
  runQuery,
  type QueryEnv,
} from '../../rag-consultation/server/__tests__/helpers.ts';
import { IndexJobQueue } from '../../rag-consultation/server/store/index-jobs.ts';
import { parseInstant } from '../../rag-consultation/server/text/time.ts';
import { DEMO_ACADEMY } from '../model/demo-academy.ts';
import {
  changeMakeup,
  createEvent,
  emptyState,
  withdrawEvent,
} from '../model/schedule.ts';
import type { ScheduleResult, ScheduleState } from '../model/types.ts';
import { syncScheduleEvent } from '../server/rag-sync.ts';

const T0 = '2026-11-09T10:00:00+09:00';
const T1 = '2026-11-09T15:00:00+09:00';

/** 손으로 쓴 휴보강 문서(TA_CANCEL_*, TA_MAKEUP_*)는 빼고 시간표·운영 정책만 둔다. */
function baseDataset(): AcademiesDataset {
  const dataset = readAcademiesDataset(
    join(import.meta.dirname, '..', 'academies'),
  );
  const generated = (id: string) => /^TA_(CANCEL|MAKEUP)_/.test(id);
  return {
    ...dataset,
    documents: dataset.documents.filter((d) => !generated(d.meta.document_id)),
    facts: dataset.facts.filter((f) => !generated(f.document_id)),
  };
}

interface Harness {
  env: QueryEnv;
  queue: IndexJobQueue;
  dataset: AcademiesDataset;
  state: ScheduleState;
}

async function harness(): Promise<Harness> {
  const dataset = baseDataset();
  const store = await buildAcademiesStore(dataset, undefined, {
    ocr: null,
    cache: false,
  });
  return {
    dataset,
    queue: new IndexJobQueue({
      documents: store,
      clock: new FixedClock(parseInstant(T1)),
    }),
    state: emptyState(),
    env: {
      store,
      catalog: createAcademyCatalogPort(dataset),
      resolveScope: (userId) => {
        const user = dataset.users.find((u) => u.user_id === userId);
        if (!user) throw new Error(userId);
        return toAcademyAccessScope(user, dataset.students);
      },
    },
  };
}

async function apply(h: Harness, result: ScheduleResult) {
  if (!result.ok)
    assert.fail(`${result.error} ${JSON.stringify(result.issues)}`);
  h.state = result.state;
  const jobs = await syncScheduleEvent(h.queue, DEMO_ACADEMY, result.event);
  for (const job of jobs)
    assert.ok(['activated', 'revoked'].includes(job.status), job.status);
  return result.event;
}

const ask = (h: Harness, userId: string, question: string, asOf: string) =>
  runQuery(h.env, { userId, question, asOf, engine: 'planned' });

/** 프로토타입·AC_TEST_A 와 같은 시나리오(휴강+보강, 보강 변경, 보강 미정, 임시 저장) */
async function seeded(): Promise<Harness> {
  const h = await harness();
  await apply(
    h,
    createEvent(
      DEMO_ACADEMY,
      h.state,
      {
        scope: 'class',
        classId: 'TA_M2_EXAM',
        date: '2026-11-11',
        makeup: { date: '2026-11-14', start: '14:00', room: '교실1' },
        confirm: true,
      },
      T0,
    ),
  );
  const em = await apply(
    h,
    createEvent(
      DEMO_ACADEMY,
      h.state,
      {
        scope: 'class',
        classId: 'TA_E_MATH',
        date: '2026-11-16',
        makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
        confirm: true,
      },
      T0,
    ),
  );
  await apply(
    h,
    changeMakeup(
      DEMO_ACADEMY,
      h.state,
      em.eventId,
      { date: '2026-11-21', start: '13:00', room: '교실1' },
      T1,
    ),
  );
  await apply(
    h,
    createEvent(
      DEMO_ACADEMY,
      h.state,
      {
        scope: 'class',
        classId: 'TA_M3',
        date: '2026-11-19',
        confirm: true,
      },
      T0,
    ),
  );
  await apply(
    h,
    createEvent(
      DEMO_ACADEMY,
      h.state,
      {
        scope: 'class',
        classId: 'TA_H1',
        date: '2026-11-26',
        makeup: { date: '2026-11-28', start: '14:00', room: '교실1' },
        confirm: false,
      },
      T0,
    ),
  );
  return h;
}

/**
 * 상담 엔진 쪽 미해결(손으로 쓴 원래 문서로도 같은 결과, 2026-11-12 확인).
 * - TA-001: 휴강은 답하지만 연결된 11/14 보강을 함께 말하지 않는다.
 * - TA-003, TA-005: 답변 내용은 맞지만(미확정·담당자 안내) 상태가 partial 이 아니라 answered 다.
 */
// The operational planned engine must now satisfy all six fixed cases.

async function evaluateCases() {
  const h = await seeded();
  const results = [];
  for (const c of h.dataset.cases) {
    const out = await ask(h, c.input.user_id, c.input.query, c.input.as_of);
    const text = out.answer.answer;
    results.push({
      id: c.case_id,
      text,
      leaks: (c.expected.must_not_include ?? []).filter((s) =>
        text.includes(s),
      ),
      generation: out.generationCalls,
      problems: [
        out.answer.status !== c.expected.status &&
          `상태 ${out.answer.status}≠${c.expected.status}`,
        ...(c.expected.must_include ?? [])
          .filter((s) => !text.includes(s))
          .map((s) => `없음:${s}`),
      ].filter(Boolean),
    });
  }
  return results;
}

describe('휴보강 확정 → 상담 답변 (AC_TEST_A 질문)', () => {
  test('안전 조건: 6문항 모두 미확정·이전·권한 밖 일정 노출 0, 생성 0회', async () => {
    const results = await evaluateCases();
    assert.equal(results.length, 6);
    assert.deepEqual(
      results.filter((r) => r.leaks.length || r.generation).map((r) => r.id),
      [],
    );
  });

  test('기대 상태·문구: 운영 엔진의 모든 문항에서 상세 실패를 검사', async () => {
    const results = await evaluateCases();
    const failed = results.filter((r) => r.problems.length);
    assert.deepEqual(
      failed.map((r) => `${r.id} ${r.problems.join(', ')} | ${r.text}`),
      [],
    );
  });

  test('기대 상태·문구: 6문항 전부', async () => {
    const results = await evaluateCases();
    assert.deepEqual(
      results.filter((r) => r.problems.length).map((r) => r.id),
      [],
    );
  });
});

describe('변경 반영 시점', () => {
  const Q = '보강 몇 시예요?';
  const ASOF = '2026-11-10T10:00:00+09:00';

  test('보강을 바꾸면 다음 질문부터 새 시간으로 답하고 이전 시간은 나오지 않는다', async () => {
    const h = await harness();
    const ev = await apply(
      h,
      createEvent(
        DEMO_ACADEMY,
        h.state,
        {
          scope: 'class',
          classId: 'TA_E_MATH',
          date: '2026-11-16',
          makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
          confirm: true,
        },
        T0,
      ),
    );
    const before = await ask(h, 'TA_GUARDIAN_E_MATH', Q, ASOF);
    assert.match(before.answer.answer, /10:00/);

    await apply(
      h,
      changeMakeup(
        DEMO_ACADEMY,
        h.state,
        ev.eventId,
        { date: '2026-11-21', start: '13:00', room: '교실1' },
        T1,
      ),
    );
    const after = await ask(h, 'TA_GUARDIAN_E_MATH', Q, ASOF);
    assert.equal(after.answer.status, 'answered');
    assert.match(after.answer.answer, /13:00/);
    assert.doesNotMatch(after.answer.answer, /10:00/);
    assert.ok(after.answer.citations.every((c) => c.revision === 2));
  });

  test('보강을 취소하면 취소된 시간을 답하지 않는다', async () => {
    const h = await harness();
    const ev = await apply(
      h,
      createEvent(
        DEMO_ACADEMY,
        h.state,
        {
          scope: 'class',
          classId: 'TA_E_MATH',
          date: '2026-11-16',
          makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
          confirm: true,
        },
        T0,
      ),
    );
    await apply(h, changeMakeup(DEMO_ACADEMY, h.state, ev.eventId, null, T1));
    const out = await ask(h, 'TA_GUARDIAN_E_MATH', Q, ASOF);
    assert.doesNotMatch(out.answer.answer, /10:00/);
    assert.notEqual(out.answer.status, 'answered');
  });

  test('휴강을 취소하면 그 휴강을 더 이상 안내하지 않는다', async () => {
    const h = await harness();
    const ev = await apply(
      h,
      createEvent(
        DEMO_ACADEMY,
        h.state,
        {
          scope: 'class',
          classId: 'TA_M2_EXAM',
          date: '2026-11-11',
          confirm: true,
        },
        T0,
      ),
    );
    const q = '11일 수업 휴강인가요?';
    const asOf = '2026-11-10T19:00:00+09:00';
    assert.match(
      (await ask(h, 'TA_GUARDIAN_M2', q, asOf)).answer.answer,
      /휴강/,
    );
    await apply(h, withdrawEvent(DEMO_ACADEMY, h.state, ev.eventId, T1));
    const after = await ask(h, 'TA_GUARDIAN_M2', q, asOf);
    assert.ok(
      after.answer.citations.every((c) => !c.documentId.includes('EV001')),
    );
  });

  test('다른 반 보호자에게는 반 휴강이 보이지 않는다', async () => {
    const h = await seeded();
    const out = await ask(
      h,
      'TA_GUARDIAN_H1',
      '19일 휴강이에요?',
      '2026-11-17T18:00:00+09:00',
    );
    assert.doesNotMatch(out.answer.answer, /중3/);
    assert.ok(
      out.answer.citations.every((c) => !c.documentId.includes('EV004')),
    );
  });
});

describe('학생 결석 보강', () => {
  const Q = '결석한 거 보강 언제예요?';
  const ASOF = '2026-11-18T19:00:00+09:00';

  async function withAbsence() {
    const h = await harness();
    await apply(
      h,
      createEvent(
        DEMO_ACADEMY,
        h.state,
        {
          scope: 'student',
          classId: 'TA_M3',
          studentId: 'TA_STU_003',
          date: '2026-11-17',
          makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
          confirm: true,
        },
        T0,
      ),
    );
    return h;
  }

  test('다른 학생 보호자에게는 결석 보강이 보이지 않는다', async () => {
    const h = await withAbsence();
    const other = await ask(h, 'TA_GUARDIAN_H1', Q, ASOF);
    assert.doesNotMatch(other.answer.answer, /11월 21일|가상학생C/);
    assert.ok(
      other.answer.citations.every((c) => !c.documentId.includes('EV001')),
    );
  });

  test('그 학생 보호자는 결석 보강 일정을 답으로 받는다', async () => {
    const h = await withAbsence();
    const mine = await ask(h, 'TA_GUARDIAN_M3', Q, ASOF);
    assert.equal(mine.answer.status, 'answered', mine.answer.answer);
    assert.match(mine.answer.answer, /11월 21일/);
    assert.match(mine.answer.answer, /10:00/);
  });

  test('엔진 수정 전에도 지어내지 않고 보류한다', async () => {
    const h = await withAbsence();
    const mine = await ask(h, 'TA_GUARDIAN_M3', Q, ASOF);
    assert.ok(
      ['answered', 'abstained', 'partial', 'handoff'].includes(
        mine.answer.status,
      ),
    );
    if (mine.answer.status !== 'answered')
      assert.doesNotMatch(mine.answer.answer, /\d{1,2}:\d{2}/);
  });
});
