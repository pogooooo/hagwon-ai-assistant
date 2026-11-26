import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CitationWitness } from '../answer/context.ts';
import { scoreV2, type ObservationV2 } from '../eval/scoring-v2.ts';
import { scoreV3, type GoldV3 } from '../eval/scoring-v3.ts';
import { scoreV4, type GoldV4 } from '../eval/scoring-v4.ts';

const reference = {
  sourceId: 'FEE:r1:body',
  location: '표 1 · 2행',
  columns: ['반', '월 수강료'],
  chunkId: 'FEE:r1:body#2',
  witness: ['중2 실험반', '130,000원'],
};
const gold: GoldV3 = {
  status: 'answered',
  slots: [
    {
      id: 'fee',
      claim: ['중2 실험반', '130,000원'],
      answerSpans: ['중2 실험반 월 수강료 130,000원'],
      evidence: [[reference]],
    },
  ],
  maxGenerationCalls: 0,
};
const proof = {
  sourceId: reference.sourceId,
  chunkId: reference.chunkId,
  location: reference.location + ' · 열 반, 월 수강료',
  text: '반: 중2 실험반 / 월 수강료: 130,000원',
};

function observed(
  text: string,
  citationWitnesses: CitationWitness[] = [proof],
): ObservationV2 {
  const citation = {
    sourceId: proof.sourceId,
    documentId: 'FEE',
    title: '월 수강료',
    location: proof.location,
  };
  return {
    answer: {
      requestId: 'test',
      status: 'answered',
      answer: text,
      citations: [citation],
    },
    citationLocations: [citation],
    citationWitnesses,
    retrievedChunkIds: [reference.chunkId],
    retrievedSourceIds: [reference.sourceId],
    generationCalls: 0,
    violations: [],
  };
}

test('slot-v4.1 checks the public abstention handoff and preserves the v4 score', () => {
  const message = '승인된 자료가 없어 안내할 수 없습니다.';
  const gold: GoldV4 = {
    status: 'abstained',
    slots: [],
    contextLines: [message],
    missingFields: ['수업 시간표'],
    handoffReason: 'INSUFFICIENT_EVIDENCE',
    maxGenerationCalls: 0,
  };
  const observation = observed(message, []);
  const answer: ObservationV2['answer'] = {
    ...observation.answer,
    status: 'abstained',
    citations: [],
    missingFields: ['수업 시간표'],
    handoff: { needed: true, reasonCode: 'INSUFFICIENT_EVIDENCE' },
  };
  const output = { ...observation, answer, citationLocations: [] };
  assert.equal(scoreV4(gold, output).correct, false);
  assert.equal(scoreV4(gold, output, 'slot-v4.1').correct, true);
  answer.handoff = undefined;
  assert.equal(scoreV4(gold, output, 'slot-v4.1').correct, false);
  answer.handoff = { needed: true, reasonCode: 'CONFLICTING_EVIDENCE' };
  assert.equal(scoreV4(gold, output, 'slot-v4.1').correct, false);
});

test('slot-v3 rejects a number attached to the wrong class on the same line', () => {
  const wrong = observed(
    '중2 실험반 월 수강료 140,000원 / 중3 실험반 월 수강료 130,000원',
  );
  assert.equal(scoreV2(gold, wrong).correct, true);
  assert.equal(scoreV3(gold, wrong).correct, false);
  const right = observed('중2 실험반 월 수강료 130,000원');
  assert.equal(scoreV3(gold, right).correct, true);
});

test('slot-v3 distinguishes selected proof from a retrieved row or another column', () => {
  const answer = '중2 실험반 월 수강료 130,000원';
  const differentChunk = observed(answer, [
    { ...proof, chunkId: 'FEE:r1:body#1' },
  ]);
  const differentColumn = observed(answer, [
    {
      ...proof,
      location: reference.location + ' · 열 반, 교재비',
      text: '반: 중2 실험반 / 교재비: 130,000원',
    },
  ]);
  const differentAmount = observed(answer, [
    {
      ...proof,
      text: '반: 중2 실험반 / 월 수강료: 140,000원',
    },
  ]);
  for (const observation of [
    differentChunk,
    differentColumn,
    differentAmount,
    observed(answer, []),
  ]) {
    assert.equal(scoreV2(gold, observation).correct, true);
    assert.equal(scoreV3(gold, observation).correct, false);
  }
});

test('slot-v3 does not combine the identity and value from separate selected witnesses', () => {
  const result = scoreV3(
    gold,
    observed('중2 실험반 월 수강료 130,000원', [
      { ...proof, text: '중2 실험반 월 수강료 미정' },
      { ...proof, text: '중3 실험반 월 수강료 130,000원' },
    ]),
  );
  assert.equal(result.slots[0].witnessed, false);
  assert.equal(result.correct, false);
});

const reviewed = {
  ...gold,
  contextLines: ['승인 수강료 안내'],
} satisfies GoldV4;
const reviewedLine = '중2 실험반 월 수강료 130,000원';

test('slot-v4 rejects unreviewed claims and changed meaning on a matched line', () => {
  const good = observed('승인 수강료 안내\n' + reviewedLine);
  assert.equal(scoreV4(reviewed, good).correct, true);

  for (const response of [
    reviewedLine + '\n중3 실험반 월 수강료 160,000원',
    reviewedLine + '이 아닙니다.',
  ]) {
    const wrong = observed(response);
    assert.equal(scoreV3(gold, wrong).correct, true);
    const strict = scoreV4(reviewed, wrong);
    assert.equal(strict.correct, false);
    assert.ok(strict.unreviewedLines.length);
  }
});

test('slot-v4 requires a complete evidence alternative from the same public citations', () => {
  const alternative = {
    ...reference,
    sourceId: 'NOTICE:r1:body',
    chunkId: 'NOTICE:r1:body#3',
  };
  const annotation = {
    ...reviewed,
    slots: [
      {
        ...reviewed.slots[0],
        evidence: [[{ ...reference, witness: ['140,000원'] }], [alternative]],
      },
    ],
  } satisfies GoldV4;
  const orphaned = { ...proof, ...alternative, location: proof.location };
  const wrong = observed(reviewedLine, [proof, orphaned]);
  assert.equal(scoreV3(annotation, wrong).correct, true);
  assert.equal(scoreV4(annotation, wrong).correct, false);

  const right = observed(reviewedLine, [orphaned]);
  const noticeCitation = {
    ...right.answer.citations[0],
    sourceId: alternative.sourceId,
    documentId: 'NOTICE',
  };
  right.answer.citations = [noticeCitation];
  right.citationLocations = [noticeCitation];
  assert.equal(scoreV4(annotation, right).correct, true);

  right.citationLocations = [
    noticeCitation,
    { ...noticeCitation, location: '표 1 · 9행' },
  ];
  assert.deepEqual(scoreV4(annotation, right).unsupportedCitations, [
    { sourceId: alternative.sourceId, location: '표 1 · 9행' },
  ]);
});

test('slot-v4 can require a complete reviewed citation witness even when the answer is correct', () => {
  const annotation = {
    ...reviewed,
    slots: [
      {
        ...reviewed.slots[0],
        evidence: [
          [
            {
              ...reference,
              exactWitness: [
                proof.text,
                '반: 중2 실험반 / 월 수강료: 130,000원 (제1실험실)',
              ],
            },
          ],
        ],
      },
    ],
  } satisfies GoldV4;
  const wrong = observed(reviewedLine, [
    { ...proof, text: '반: 중2 실험반 / 월 수강료: 130,000원 (제1실함실)' },
  ]);
  assert.equal(scoreV4(reviewed, wrong).correct, true);
  assert.equal(scoreV4(annotation, wrong).correct, false);
  assert.equal(scoreV4(annotation, wrong).slots[0].provenAlternatives, 0);
  for (const text of [
    proof.text,
    '반:  중2 실험반 / 월 수강료: 130,000원 (제1실험실)',
  ]) {
    assert.equal(
      scoreV4(annotation, observed(reviewedLine, [{ ...proof, text }])).correct,
      true,
    );
  }
});

test('slot-v4 rejects an empty exact witness annotation', () => {
  const annotation = {
    ...reviewed,
    slots: [
      {
        ...reviewed.slots[0],
        evidence: [[{ ...reference, exactWitness: [] }]],
      },
    ],
  } satisfies GoldV4;
  assert.throws(
    () => scoreV4(annotation, observed(reviewedLine)),
    /exact witnesses/,
  );
});

test('slot-v4 rejects extra cited columns and extra missing fields', () => {
  const wideProof = {
    ...proof,
    location: proof.location + ', 교재비',
    columns: [...reference.columns, '교재비'],
  };
  const wide = observed(reviewedLine, [wideProof]);
  wide.answer.citations = [
    { ...wide.answer.citations[0], location: wideProof.location },
  ];
  wide.citationLocations = wide.answer.citations;
  assert.equal(scoreV3(gold, wide).correct, true);
  assert.equal(scoreV4(reviewed, wide).correct, false);

  const partial = observed(reviewedLine);
  partial.answer.status = 'partial';
  partial.answer.missingFields = ['교실 번호', '강사 이름'];
  const expected = {
    ...reviewed,
    status: 'partial',
    missingFields: ['교실 번호'],
  } as const;
  assert.equal(scoreV3(expected, partial).correct, true);
  assert.equal(scoreV4(expected, partial).correct, false);
  partial.answer.missingFields = ['교실 번호'];
  assert.equal(scoreV4(expected, partial).correct, true);
});
