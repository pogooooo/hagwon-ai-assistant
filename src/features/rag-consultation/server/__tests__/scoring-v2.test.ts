import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RagCitation } from '../../contract.ts';
import {
  scoreV2,
  type GoldV2,
  type ObservationV2,
} from '../eval/scoring-v2.ts';

const ref = (sourceId: string, location: string, chunkId: string) => ({
  sourceId,
  location,
  chunkId,
});
const table = ref('TABLE:r1:body', '1쪽 · 표 1 · 2행', 'TABLE#2');
const policy = ref('POLICY:r2:body', '2쪽 · 문단 1', 'POLICY#1');
const replacement = ref('NOTICE:r1:body', '1쪽 · 문단 1', 'NOTICE#1');
const gold: GoldV2 = {
  status: 'answered',
  maxGenerationCalls: 0,
  slots: [
    {
      id: 'scoped-duration',
      claim: ['중2 심화반', '90분'],
      evidence: [[{ ...table, columns: ['수업 시간'] }, policy], [replacement]],
    },
  ],
};

function observation(
  text: string,
  refs: Array<{ sourceId: string; location: string; chunkId: string }>,
): ObservationV2 {
  const citations: RagCitation[] = refs.map((entry) => ({
    sourceId: entry.sourceId,
    documentId: entry.sourceId.split(':')[0],
    location: entry.location,
    title: '가상 문서',
  }));
  return {
    answer: { status: 'answered', answer: text, citations, requestId: 'test' },
    citationLocations: citations,
    retrievedSourceIds: refs.map((entry) => entry.sourceId),
    retrievedChunkIds: refs.map((entry) => entry.chunkId),
    generationCalls: 0,
    violations: [],
  };
}

test('slot-v2 distinguishes jointly required rows from a valid substitute', () => {
  const selected = {
    ...table,
    location: table.location + ' · 열 반, 수업 시간',
  };
  const partial = scoreV2(gold, observation('중2 심화반 90분', [selected]));
  assert.equal(partial.correct, false);
  assert.equal(partial.slots[0].retrieved, false);
  assert.equal(
    scoreV2(gold, observation('중2 심화반 90분', [selected, policy])).correct,
    true,
  );
  assert.equal(
    scoreV2(gold, observation('중2 심화반 90분', [replacement])).correct,
    true,
  );
});

test('a correct document or digit substring cannot hide a wrong row, column or subject', () => {
  for (const location of [
    '1쪽 · 표 1 · 12행 · 열 수업 시간',
    table.location + ' · 열 쉬는 시간',
  ]) {
    const wrong = { ...table, location };
    assert.equal(
      scoreV2(gold, observation('중2 심화반 90분', [wrong, policy])).correct,
      false,
    );
  }
  assert.equal(
    scoreV2(gold, observation('중2 심화반 190분', [replacement])).correct,
    false,
  );
  assert.equal(
    scoreV2(
      gold,
      observation('중2 심화반은 자료 없음\n중3 심화반 90분', [replacement]),
    ).correct,
    false,
  );
});

test('clarification and handoff require their distinct payloads and safety remains mandatory', () => {
  const observed = observation('', []);
  observed.answer.status = 'clarify';
  const clarify: GoldV2 = {
    status: 'clarify',
    slots: [],
    maxGenerationCalls: 0,
    clarifyOptions: ['첫째', '둘째'],
  };
  assert.equal(scoreV2(clarify, observed).correct, false);
  observed.answer.clarifyOptions = ['첫째', '둘째'];
  assert.equal(scoreV2(clarify, observed).correct, true);
  assert.equal(
    scoreV2({ ...clarify, status: 'denied' }, observed).correct,
    false,
  );
  observed.answer.status = 'handoff';
  assert.equal(
    scoreV2({ ...clarify, status: 'handoff' }, observed).correct,
    false,
  );
  observed.answer.handoff = {
    needed: true,
    reasonCode: 'INSUFFICIENT_EVIDENCE',
  };
  assert.equal(
    scoreV2({ ...clarify, status: 'handoff' }, observed).correct,
    true,
  );
  assert.equal(
    scoreV2(
      { ...clarify, status: 'handoff' },
      { ...observed, violations: ['draft'] },
    ).correct,
    false,
  );
});
