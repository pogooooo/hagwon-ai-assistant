/**
 * 규칙 기반 라우팅에 쓰는 운영 사전과 정책 상수.
 * 학원별로 교체할 수 있도록 서비스 생성 시 덮어쓸 수 있다.
 */
import type { FactType } from './types.ts';

export interface TopicDefinition {
  id: string;
  /** 사용자에게 "확인되지 않은 항목"으로 보여 줄 이름 */
  label: string;
  /**
   * structured: 정형 사실 조회로 답한다(수강료·시간표 등).
   * attribute: 시설·연락처처럼 승인 문서 문장/사실 값에 해당 속성이 실제로 있어야 답한다.
   */
  kind: 'structured' | 'attribute';
  /** 공백 제거·소문자 기준 질의 매칭어 */
  terms: readonly string[];
  factTypes: readonly FactType[];
  /** attribute 주제가 근거 문장·사실 값에 등장해야 하는 단어(동의어 포함) */
  evidenceTerms?: readonly string[];
}

export const DEFAULT_TOPICS: readonly TopicDefinition[] = [
  {
    id: 'fee',
    label: '수강료',
    kind: 'structured',
    terms: [
      '수강료',
      '교습비',
      '학원비',
      '납입금',
      '요금',
      '회비',
      '가격',
      '비용',
      '얼마',
    ],
    factTypes: ['monthly_fee'],
  },
  {
    id: 'schedule',
    label: '수업 시간표',
    kind: 'structured',
    terms: ['시간표', '요일', '몇시', '수업시간', '언제'],
    factTypes: ['schedule'],
  },
  {
    id: 'teacher',
    label: '담당 강사',
    kind: 'structured',
    terms: ['강사', '선생님', '선생', '교사', '쌤'],
    factTypes: ['teacher'],
  },
  {
    id: 'holiday',
    label: '휴강 일정',
    kind: 'structured',
    terms: [
      '휴강',
      '쉬는날',
      '수업하나요',
      '수업있나요',
      '수업해요',
      '수업하는지',
      '쉬나요',
    ],
    factTypes: ['holiday'],
  },
  {
    id: 'makeup',
    label: '보강 규정',
    kind: 'structured',
    terms: ['보강'],
    factTypes: ['makeup_policy'],
  },
  {
    id: 'study_room',
    label: '자습실',
    kind: 'attribute',
    terms: ['자습실', '독서실', '자습공간'],
    factTypes: ['facility'],
    evidenceTerms: ['자습실', '독서실', '자습공간'],
  },
  {
    id: 'parking',
    label: '주차',
    kind: 'attribute',
    terms: ['주차'],
    factTypes: ['facility'],
    evidenceTerms: ['주차'],
  },
  {
    id: 'wifi',
    label: '무선인터넷(와이파이)',
    kind: 'attribute',
    terms: ['와이파이', 'wifi', '무선인터넷', '인터넷'],
    factTypes: ['facility'],
    evidenceTerms: ['와이파이', 'wifi', '무선인터넷'],
  },
  {
    id: 'password',
    label: '비밀번호',
    kind: 'attribute',
    terms: ['비밀번호', '패스워드', '비번'],
    factTypes: ['facility'],
    evidenceTerms: ['비밀번호', '패스워드'],
  },
  {
    id: 'capacity',
    label: '정원',
    kind: 'attribute',
    terms: ['정원', '몇명', '인원'],
    factTypes: ['capacity'],
    evidenceTerms: ['정원', '인원'],
  },
  {
    id: 'contact',
    label: '연락처',
    kind: 'attribute',
    terms: ['연락처', '전화번호', '전화', '핸드폰', '휴대폰', '이메일', '카톡'],
    factTypes: ['contact'],
    evidenceTerms: ['연락처', '전화', '이메일', '카톡'],
  },
];

/** 학습 분석 질문으로 보는 표현(단원명은 카탈로그에서 추가). */
export const ANALYSIS_TERMS: readonly string[] = [
  '정답률',
  '성적',
  '점수',
  '몇문제',
  '문제수',
  '맞았',
  '맞힌',
  '맞춘',
  '틀린',
  '오답',
  '어땠',
  '단원',
  '취약',
  '약한',
  '숙제',
];

/** 형제 순서처럼 서버 별칭으로만 해석할 수 있는 지시어. */
export const RELATION_WORDS: readonly string[] = [
  '첫째',
  '둘째',
  '셋째',
  '큰애',
  '큰아이',
  '작은애',
  '작은아이',
  '막내',
];

export interface RagConfig {
  topics: readonly TopicDefinition[];
  /** 학생 식별 코드 패턴(정규화된 소문자 질의 기준, 캡처 1 = 코드). 합성 데이터 형식(ST_A01, A01) 기본값. */
  studentCodePattern: RegExp;
  /** 생성 호출 시간 제한 */
  generationTimeoutMs: number;
  /** 문서 하나의 최대 텍스트 길이 */
  maxDocumentChars: number;
  /** 검색 상위 후보 수 */
  searchLimit: number;
  /** 정답률 비교 시 "표본이 작다" 안내를 붙이는 문항 수 기준(제품 정책 값, 통계 상수 아님) */
  smallSampleThreshold: number;
}

export const DEFAULT_RAG_CONFIG: RagConfig = {
  topics: DEFAULT_TOPICS,
  studentCodePattern: /(?<![a-z0-9])(?:st_)?([a-z]\d{2})(?![a-z0-9])/g,
  generationTimeoutMs: 8000,
  maxDocumentChars: 200_000,
  searchLimit: 8,
  smallSampleThreshold: 10,
};
