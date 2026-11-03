/** Re-score the frozen architecture holdout with per-slot mandatory sources. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RagAnswerStatus } from '../../contract.ts';
import { loadSuite, type CaseResult } from './harness.ts';
import { scoreV2 } from './scoring-v2.ts';

const directory = process.argv[2];
if (!directory) throw new Error('Supply the holdout run-eval output directory');
const total = new Map<
  string,
  { cases: number; v1: number; v2: number; slots: number; fulfilled: number }
>();
for (const variant of ['engine', 'engine-planned']) {
  const aggregate = { cases: 0, v1: 0, v2: 0, slots: 0, fulfilled: 0 };
  for (const id of ['AC_ARCH_1', 'AC_ARCH_2', 'AC_ARCH_3']) {
    const suite = loadSuite('v2-' + id);
    const data = JSON.parse(
      readFileSync(
        join(directory, suite.name + '__' + variant + '.json'),
        'utf8',
      ),
    ) as { results: CaseResult[] };
    const cases = new Map(suite.cases.map((item) => [item.id, item]));
    for (const result of data.results) {
      const item = cases.get(result.id);
      if (!item || item.split !== 'holdout')
        throw new Error('Unknown holdout case');
      const expected = item.expected;
      const given = result.status === 'answered' || result.status === 'partial';
      const score = scoreV2(
        {
          status: expected.status as RagAnswerStatus,
          slots: expected.mustInclude.map((claim, index) => ({
            id: 'field-' + index,
            claim: [claim],
            evidence: [
              (expected.sourceIds.length > 1
                ? [expected.sourceIds[index]]
                : expected.sourceIds
              ).map((sourceId) => ({ sourceId })),
            ],
          })),
          forbidden: expected.mustNotInclude,
          maxGenerationCalls: expected.generationBudgetMax,
        },
        {
          answer: {
            status: result.status as RagAnswerStatus,
            answer: result.answer,
            citations: result.cited.map((sourceId) => ({
              sourceId,
              documentId: sourceId.split(':')[0],
              title: '',
            })),
            requestId: result.id,
            // v1 exports answer text only. This adapter can check a rendered
            // partial-answer disclosure, not the original API missingFields.
            missingFields:
              given && result.answer.includes('확인되지 않은 항목')
                ? ['표시됨']
                : undefined,
          },
          retrievedChunkIds: [],
          retrievedSourceIds: [],
          generationCalls: result.generationCalls,
          violations: result.violations,
        },
      );
      aggregate.cases += 1;
      aggregate.v1 += Number(result.correct);
      aggregate.v2 += Number(score.correct);
      aggregate.slots += score.slots.length;
      aggregate.fulfilled += score.slots.filter(
        (slot) => slot.fulfilled,
      ).length;
    }
  }
  total.set(variant, aggregate);
}
console.table(Object.fromEntries(total));
