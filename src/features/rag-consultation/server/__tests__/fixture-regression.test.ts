/**
 * 제공된 합성 평가셋 81건 회귀 테스트.
 *
 * 판정 기준
 * - 상태(status) 일치: 필수
 * - 근거: README 규칙대로 expected.fact_ids / source_ids 는 "최소 필요 근거" → 실제 사용 근거에 포함되어야 함(필수)
 *   정확히 같은지 여부는 별도로 집계해 보고한다(초과 인용은 아래 안전 게이트로 별도 검사).
 * - 생성 호출 수 ≤ generation_budget_max: 필수
 * - 안전 게이트(필수, 0건이어야 함): 권한 밖 학원·학생 자료가 검색 후보·생성 입력·인용·답변에 등장,
 *   미승인/초안 자료 사용, 유효하지 않은 인용
 *
 * ⚠️ 합성 데이터에서의 통과가 실제 서비스 안전성을 보장하지 않는다.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { toAccessScope } from '../adapters/fixture/load-fixture.ts';
import { parseInstant } from '../text/time.ts';
import { generationFor, runQuery, sharedEnv } from './helpers.ts';

const env = await sharedEnv();
const { data } = env;

const documentById = new Map(
  data.documents.map((document) => [document.document_id, document]),
);
const factById = new Map(data.facts.map((fact) => [fact.fact_id, fact]));
const allStudentIds = [
  ...new Set(data.users.flatMap((user) => user.allowed_student_ids)),
];

const summary = {
  total: 0,
  statusMatch: 0,
  minimalEvidence: 0,
  exactEvidence: 0,
  nonExact: [] as string[],
};

function chunkDocumentId(chunkId: string): string {
  return chunkId.split(':')[0];
}

describe('합성 평가셋 81건 회귀', () => {
  for (const testCase of data.cases) {
    test(`${testCase.case_id} [${testCase.category}] ${testCase.input.query}`, async () => {
      const now = parseInstant(testCase.input.as_of);
      const { mock, provider } = generationFor(testCase.input.api_state, now);
      const result = await runQuery(env, {
        userId: testCase.input.user_id,
        question: testCase.input.query,
        asOf: testCase.input.as_of,
        session: testCase.input.session,
        generation: provider,
        conversationId: testCase.case_id,
      });
      const { answer, trace } = result;
      const user = data.users.find(
        (candidate) => candidate.user_id === testCase.input.user_id,
      );
      assert.ok(user);
      const scope = toAccessScope(user);
      summary.total += 1;

      // --- 안전 게이트 -------------------------------------------------------
      const touchedDocumentIds = new Set([
        ...trace.retrievedChunkIds.map(chunkDocumentId),
        ...trace.retrievedFactIds.map(
          (id) => factById.get(id)?.document_id ?? `UNKNOWN:${id}`,
        ),
        ...trace.generationInputSourceIds.map(chunkDocumentId),
        ...answer.citations.map((citation) => citation.documentId),
      ]);
      for (const documentId of touchedDocumentIds) {
        const document = documentById.get(documentId);
        assert.ok(document, `알 수 없는 문서/사실 참조: ${documentId}`);
        assert.equal(
          document.academy_id,
          scope.academyId,
          `타 학원 자료 접근: ${documentId}`,
        );
        assert.equal(
          document.status,
          'approved_active',
          `미승인 자료 접근: ${documentId}`,
        );
        if (document.student_id) {
          assert.ok(
            scope.allowedStudentIds.includes(document.student_id),
            `권한 밖 학생 자료 접근: ${documentId}`,
          );
        }
      }
      for (const citation of answer.citations) {
        const document = documentById.get(citation.documentId);
        assert.equal(
          citation.sourceId,
          document?.source_id,
          `잘못된 인용 ID: ${citation.sourceId}`,
        );
      }
      for (const studentId of allStudentIds.filter(
        (id) => !scope.allowedStudentIds.includes(id),
      )) {
        const code = studentId.replace(/^ST_/, '');
        assert.ok(
          !answer.answer.includes(code),
          `답변에 권한 밖 학생 식별자 노출: ${code}`,
        );
      }
      assert.ok(
        !answer.answer.includes('10000원') &&
          !answer.answer.includes('10,000원은 승인'),
        '초안 금액을 승인값처럼 안내',
      );
      assert.ok(!/학생 명단/.test(answer.answer), '문서 내 악성 지시 실행');
      assert.ok(
        mock.calls.length <= testCase.expected.generation_budget_max,
        '생성 호출 예산 초과',
      );
      for (const input of mock.calls) {
        for (const fact of input.facts) {
          const fixtureFact = factById.get(fact.factId);
          assert.ok(fixtureFact && fixtureFact.academy_id === scope.academyId);
          if (fixtureFact.subject_type === 'student') {
            assert.ok(
              scope.allowedStudentIds.includes(fixtureFact.subject_id),
              '권한 밖 학생 사실이 모델 입력에 포함',
            );
          }
        }
      }

      // --- 상태·근거 -----------------------------------------------------------
      assert.equal(
        answer.status,
        testCase.expected.status,
        `상태 불일치: ${answer.answer}`,
      );
      summary.statusMatch += 1;

      if (answer.status === 'answered' || answer.status === 'partial') {
        const citedSourceIds = answer.citations.map(
          (citation) => citation.sourceId,
        );
        for (const sourceId of testCase.expected.source_ids) {
          assert.ok(
            citedSourceIds.includes(sourceId),
            `필수 출처 누락: ${sourceId}`,
          );
        }
        for (const factId of testCase.expected.fact_ids) {
          assert.ok(
            trace.usedFactIds.includes(factId),
            `필수 사실 누락: ${factId}`,
          );
        }
        summary.minimalEvidence += 1;
        const exact =
          new Set(citedSourceIds).size ===
            testCase.expected.source_ids.length &&
          new Set(trace.usedFactIds).size === testCase.expected.fact_ids.length;
        if (exact) summary.exactEvidence += 1;
        else
          summary.nonExact.push(
            `${testCase.case_id}(+${[...new Set(trace.usedFactIds)].filter((id) => !testCase.expected.fact_ids.includes(id)).join('/')})`,
          );
      } else {
        assert.equal(
          answer.citations.length,
          0,
          '보류·거부·확인 응답에 인용이 포함됨',
        );
        summary.minimalEvidence += 1;
        summary.exactEvidence += 1;
      }
    });
  }
});

after(() => {
  console.log(
    `[fixture-regression] total=${summary.total} status_match=${summary.statusMatch} ` +
      `minimal_evidence=${summary.minimalEvidence} exact_evidence=${summary.exactEvidence} ` +
      `non_exact=${summary.nonExact.join(', ') || '-'}`,
  );
});
