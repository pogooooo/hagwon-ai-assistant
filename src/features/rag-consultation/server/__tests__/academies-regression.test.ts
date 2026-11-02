/**
 * 가상 학원 3곳(academies-v1) 현실형 자료 회귀 테스트.
 *
 * 판정 기준(필수)
 * - 상태 일치, 필수 근거(fact_ids·source_ids) 포함, 답변 필수 문구(must_include) 포함·금지 문구(must_not_include) 없음
 * - 생성 호출 수 ≤ generation_budget_max
 * - 안전 게이트: 다른 학원·권한 밖 원생·미승인(draft) 자료가 검색 후보·모델 입력·인용·답변 어디에도 없을 것
 *
 * ⚠️ 가상 데이터에서의 통과가 실제 서비스 안전성을 보장하지 않는다.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { mentionsName } from '../query/parse-query.ts';
import { normalizeText } from '../text/normalize.ts';
import { parseInstant } from '../text/time.ts';
import { academiesEnv, generationFor, runQuery } from './helpers.ts';

const env = await academiesEnv();
const { dataset } = env;

const documentBySource = new Map(
  dataset.documents.map((document) => [
    `${document.meta.document_id}:r${document.meta.revision}:body`,
    document,
  ]),
);
const factById = new Map(dataset.facts.map((fact) => [fact.fact_id, fact]));

const summary = new Map<
  string,
  { total: number; passed: number; exact: number; failed: string[] }
>();

function sourceOfChunk(chunkId: string): string {
  return chunkId.split('#')[0];
}

describe('가상 학원 3곳 현실형 자료 회귀', () => {
  for (const testCase of dataset.cases) {
    const academyId =
      dataset.users.find((user) => user.user_id === testCase.input.user_id)
        ?.academy_id ?? '?';
    test(`${testCase.case_id} [${testCase.category}] ${testCase.input.query}`, async () => {
      const stats = summary.get(academyId) ?? {
        total: 0,
        passed: 0,
        exact: 0,
        failed: [],
      };
      summary.set(academyId, stats);
      stats.total += 1;
      try {
        const now = parseInstant(testCase.input.as_of);
        const { mock, provider } = generationFor(testCase.input.api_state, now);
        const { answer, trace } = await runQuery(env, {
          userId: testCase.input.user_id,
          question: testCase.input.query,
          asOf: testCase.input.as_of,
          session: testCase.input.session,
          generation: provider,
          conversationId: testCase.case_id,
        });
        const scope = env.resolveScope(testCase.input.user_id);

        // --- 안전 게이트 -----------------------------------------------------
        const touchedSources = new Set([
          ...trace.retrievedChunkIds.map(sourceOfChunk),
          ...trace.retrievedFactIds.map((id) => {
            const fact = factById.get(id);
            return fact
              ? `${fact.document_id}:r${fact.revision}:body`
              : `UNKNOWN:${id}`;
          }),
          ...trace.generationInputSourceIds,
          ...answer.citations.map((citation) => citation.sourceId),
        ]);
        for (const sourceId of touchedSources) {
          const document = documentBySource.get(sourceId);
          assert.ok(document, `알 수 없는 출처: ${sourceId}`);
          assert.ok(
            document.file.startsWith(`${scope.academyId}/`),
            `타 학원 자료 접근: ${sourceId}`,
          );
          assert.equal(
            document.meta.status,
            'approved_active',
            `미승인 자료 접근: ${sourceId}`,
          );
          if (document.meta.student_id) {
            assert.ok(
              scope.allowedStudentIds.includes(document.meta.student_id),
              `권한 밖 원생 자료 접근: ${sourceId}`,
            );
          }
        }
        const normalizedAnswer = normalizeText(answer.answer);
        for (const student of dataset.students) {
          if (scope.allowedStudentIds.includes(student.student_id)) continue;
          for (const name of [student.name, ...student.aliases]) {
            assert.ok(
              !mentionsName(normalizedAnswer, name),
              `답변에 권한 밖 원생 이름 노출: ${name}`,
            );
          }
        }
        assert.ok(
          mock.calls.length <= testCase.expected.generation_budget_max,
          `생성 호출 예산 초과(${mock.calls.length})`,
        );
        for (const input of mock.calls) {
          for (const fact of input.facts) {
            const source = factById.get(fact.factId);
            assert.ok(
              source && source.academy_id === scope.academyId,
              '타 학원 사실이 모델 입력에 포함',
            );
            if (source.subject_type === 'student') {
              assert.ok(
                scope.allowedStudentIds.includes(source.subject_id),
                '권한 밖 원생 사실이 모델 입력에 포함',
              );
            }
          }
          const serialized = JSON.stringify(input);
          for (const student of dataset.students) {
            assert.ok(
              !serialized.includes(student.name),
              `모델 입력에 원생 실명 포함: ${student.name}`,
            );
          }
        }

        // --- 상태·근거·문구 ---------------------------------------------------
        assert.equal(
          answer.status,
          testCase.expected.status,
          `상태 불일치(기대 ${testCase.expected.status}): ${answer.answer}`,
        );
        const cited = answer.citations.map((citation) => citation.sourceId);
        for (const sourceId of testCase.expected.source_ids) {
          assert.ok(
            cited.includes(sourceId),
            `필수 출처 누락: ${sourceId} / 실제 ${cited.join(', ')}`,
          );
        }
        for (const factId of testCase.expected.fact_ids) {
          assert.ok(
            trace.usedFactIds.includes(factId),
            `필수 사실 누락: ${factId} / 실제 ${trace.usedFactIds.join(', ')}`,
          );
        }
        for (const phrase of testCase.expected.must_include ?? []) {
          assert.ok(
            answer.answer.includes(phrase),
            `필수 문구 없음: "${phrase}" / 답변: ${answer.answer}`,
          );
        }
        for (const phrase of testCase.expected.must_not_include ?? []) {
          assert.ok(
            !answer.answer.includes(phrase),
            `금지 문구 포함: "${phrase}" / 답변: ${answer.answer}`,
          );
        }
        if (answer.status !== 'answered' && answer.status !== 'partial') {
          assert.equal(
            answer.citations.length,
            0,
            '보류·거부·확인 응답에 인용이 포함됨',
          );
        }
        stats.passed += 1;
        const exact =
          new Set(cited).size === new Set(testCase.expected.source_ids).size &&
          new Set(trace.usedFactIds).size ===
            new Set(testCase.expected.fact_ids).size;
        if (
          exact ||
          (answer.status !== 'answered' && answer.status !== 'partial')
        )
          stats.exact += 1;
      } catch (error) {
        stats.failed.push(testCase.case_id);
        throw error;
      }
    });
  }
});

after(() => {
  for (const [academyId, stats] of summary) {
    console.log(
      `[academies-regression] ${academyId} total=${stats.total} passed=${stats.passed} exact_evidence=${stats.exact}` +
        (stats.failed.length ? ` failed=${stats.failed.join(',')}` : ''),
    );
  }
});
