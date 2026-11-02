/**
 * 질의 해석 규칙 단위 테스트: 이름 지칭, 반 이름 최장 일치, 주제 충돌 정리, 날짜 표현, 절 단위 청크.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_RAG_CONFIG } from '../config.ts';
import { splitIntoBlocks } from '../ingest/chunking.ts';
import { mentionsName, parseQuery } from '../query/parse-query.ts';
import { normalizeText } from '../text/normalize.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';

const catalog: AcademyCatalog = {
  academyId: 'AC_T',
  displayName: '테스트수학학원',
  aliases: ['테스트수학'],
  classes: [
    {
      classId: 'C_H1',
      name: '고1 수학 내신반',
      aliases: ['고1 수학', '고1 내신반'],
      grade: '고1',
    },
    {
      classId: 'C_H1_SP',
      name: '12월 기말 대비 특강(고1 수학)',
      aliases: ['고1 수학 특강', '기말 특강'],
      grade: '고1',
    },
    {
      classId: 'C_M2',
      name: '중2 심화반',
      aliases: ['중2 심화'],
      grade: '중2',
    },
    {
      classId: 'C_M3W',
      name: '중3 내신·서술형반',
      aliases: ['중3 서술형반'],
      grade: '중3',
    },
  ],
  units: ['일차함수와 그래프', '도형의 닮음'],
  questionTypes: ['계산', '서술형'],
  studentDirectory: [
    { studentId: 'T_STU_001', names: ['김서준', '서준', '서준이'] },
    { studentId: 'T_STU_002', names: ['이도윤', '도윤', '도윤이'] },
  ],
};

const guardian: RagAccessScope = {
  actorId: 'G',
  academyId: 'AC_T',
  role: 'guardian',
  allowedStudentIds: ['T_STU_001'],
  allowedClassIds: [],
  studentRefs: [
    {
      studentId: 'T_STU_001',
      displayLabel: '김서준',
      aliases: ['T_STU_001', '김서준', '서준', '서준이'],
    },
  ],
  canViewPublicHistory: true,
};

const parse = (question: string) =>
  parseQuery(question, {
    access: guardian,
    catalog,
    config: DEFAULT_RAG_CONFIG,
  });
const topicIds = (question: string) =>
  parse(question)
    .topics.map((topic) => topic.id)
    .sort();

describe('이름 지칭', () => {
  test('2글자 이름은 조사·호칭과 함께여도 인식하고, 다른 단어의 일부는 제외한다', () => {
    assert.equal(
      mentionsName(normalizeText('서준이 10월 성적 알려주세요'), '서준'),
      true,
    );
    assert.equal(mentionsName(normalizeText('서준이네 숙제'), '서준'), true);
    assert.equal(
      mentionsName(normalizeText('시험 서준비 기간'), '서준'),
      false,
    );
  });
  test('허용 학생 이름은 대상으로, 명부의 다른 학생 이름은 권한 밖 지칭으로 분류', () => {
    const own = parse('서준이 10월 정답률은?');
    assert.deepEqual(own.matchedStudentIds, ['T_STU_001']);
    assert.deepEqual(own.unauthorizedStudentRefs, []);
    const other = parse('도윤이 성적도 알려주세요');
    assert.deepEqual(other.unauthorizedStudentRefs, ['name:T_STU_002']);
  });
});

describe('반 이름', () => {
  test('더 긴 표현이 가리키는 반을 우선한다(고1 수학 특강 ≠ 고1 수학 내신반)', () => {
    assert.deepEqual(parse('고1 수학 특강 수강료 얼마예요?').classIds, [
      'C_H1_SP',
    ]);
    assert.deepEqual(parse('고1 수학 수강료 얼마예요?').classIds, ['C_H1']);
  });
  test('반 이름 속 유형명(서술형)은 학습 분석 유형으로 오인하지 않는다', () => {
    const frame = parse('중3 서술형반 수강료는?');
    assert.deepEqual(frame.classIds, ['C_M3W']);
    assert.deepEqual(frame.questionTypes, []);
    assert.equal(frame.hasAnalysisTerms, false);
  });
  test('단원명 일부(일차함수)로도 단원을 찾는다', () => {
    assert.deepEqual(parse('일차함수 정답률 어땠어요?').units, [
      '일차함수와 그래프',
    ]);
  });
});

describe('주제 충돌 정리', () => {
  test('"주차 요금"의 요금은 수식어 — 수강료로 보지 않는다', () => {
    assert.deepEqual(topicIds('주차 요금은 얼마예요?'), ['parking']);
  });
  test('구체어가 둘이면 둘 다 답한다(수강료 + 교재비)', () => {
    assert.deepEqual(topicIds('중2 심화반 수강료랑 교재비 알려주세요'), [
      'fee',
      'material',
    ]);
  });
  test('보강 "일정" 질문은 휴보강, 보강 "규정" 질문은 보강 규정', () => {
    assert.deepEqual(topicIds('중2 심화반 보강 언제예요?'), [
      'schedule_change',
    ]);
    assert.deepEqual(topicIds('결석하면 보강 받을 수 있나요?'), ['makeup']);
  });
  test('다른 학원 이름은 교차 학원, 일반 명사 "영어학원"은 아님', () => {
    assert.equal(parse('새솔영어학원 수강료 알려줘').flags.crossTenant, true);
    assert.equal(
      parse('테스트수학학원 위치가 어디예요?').flags.crossTenant,
      false,
    );
    assert.equal(parse('다른 영어학원보다 비싼가요?').flags.crossTenant, false);
  });
});

describe('날짜 표현', () => {
  test('이번 주·다음 주·내일', () => {
    assert.equal(parse('이번 주 휴강 있어요?').relativeWeek, 'this_week');
    assert.equal(parse('다음 주에 보강 있나요?').relativeWeek, 'next_week');
    assert.equal(parse('내일 수업해요?').relativeDay, 1);
  });
});

describe('절 단위 청크', () => {
  test('## 제목이 위치에 남고 목록 항목은 줄이 유지된다', () => {
    const blocks = splitIntoBlocks(
      '# 운영 규정\n\n## 환불 규정\n\n학원법 시행령에 따릅니다.\n\n- 수업 시작 전: 전액 환불\n- 총 수업시간 1/3 경과 전: 2/3 환불\n\n## 출결\n\n지각 3회는 결석 1회로 봅니다.',
    );
    assert.equal(blocks[0].location.label, '환불 규정 · 문단 1');
    assert.equal(
      blocks[1].text,
      '- 수업 시작 전: 전액 환불\n- 총 수업시간 1/3 경과 전: 2/3 환불',
    );
    assert.equal(blocks[2].location.section, '출결');
  });
});
