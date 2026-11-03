import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeRequests } from '../answer/composer.ts';
import { DEFAULT_RAG_CONFIG } from '../config.ts';
import { parseQuery } from '../query/parse-query.ts';
import { planQuery } from '../query/plan.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';

const access: RagAccessScope = {
  actorId: 'visitor',
  academyId: 'scope-test',
  role: 'visitor',
  allowedStudentIds: [],
  allowedClassIds: [],
  studentRefs: [],
  canViewPublicHistory: false,
};
const catalog: AcademyCatalog = {
  academyId: access.academyId,
  displayName: '공방',
  aliases: [],
  classes: [
    { classId: 'METAL', name: '금속 조형반', aliases: [] },
    { classId: 'WOOD', name: '목재 조형반', aliases: [] },
  ],
  units: [],
};

test('복합 질문에서 생략한 반은 가장 최근에 지정한 반만 이어받는다', () => {
  const question =
    '금속 조형반 교습비는요? 목재 조형반 수업 시간표는요? 교재비는요?';
  const config = DEFAULT_RAG_CONFIG;
  const frame = parseQuery(question, { access, catalog, config });
  const plan = planQuery(question, frame, access, catalog, config, true);
  assert.deepEqual(
    plan.requests.map((request) => request.frame.classIds),
    [['METAL'], ['WOOD'], ['WOOD']],
  );
});

test('일부만 답한 절은 누락 라벨이 비어 있어도 전체 완료로 바뀌지 않는다', () => {
  const response = composeRequests(
    [
      {
        status: 'partial',
        text: '확인된 시간은 15:00입니다.',
        citations: [],
        usedFacts: [],
      },
    ],
    ['수업 시간과 강의실을 알려줘?'],
  );
  assert.equal(response.status, 'partial');
  assert.deepEqual(response.missingFields, ['수업 시간과 강의실을 알려줘']);
});

test('한 문장에 독립 학원 정보 항목 세 개가 있으면 각각 계획한다', () => {
  const question = '금속 조형반 교습비랑 담당 강사 그리고 수업 시간표 알려줘';
  const config = DEFAULT_RAG_CONFIG;
  const frame = parseQuery(question, { access, catalog, config });
  const plan = planQuery(question, frame, access, catalog, config, true);
  assert.deepEqual(
    plan.requests.map(({ intentIds }) => intentIds),
    [['fee'], ['teacher'], ['schedule']],
  );
  assert.deepEqual(
    plan.requests.map(({ frame }) => frame.classIds),
    [['METAL'], ['METAL'], ['METAL']],
  );
});
