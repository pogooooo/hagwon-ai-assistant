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
   * structured: 정형 사실 조회로 답한다(수강료·시간표·모집 현황 등).
   * attribute: 시설·연락처처럼 승인 문서 문장/사실 값에 해당 속성이 실제로 있어야 답한다(문장 인용).
   * section: 환불·셔틀처럼 운영 문서의 해당 절을 찾아 인용한다(생성 0회).
   */
  kind: 'structured' | 'attribute' | 'section';
  /** 공백 제거·소문자 기준 질의 매칭어 */
  terms: readonly string[];
  /**
   * 다른 주제와 함께 나오면 수식어로 보고 이 주제를 빼는 일반어(예: "주차 요금"의 "요금").
   * 이 단어로만 매칭된 경우에 한해 적용한다.
   */
  genericTerms?: readonly string[];
  factTypes: readonly FactType[];
  /** attribute/section 주제가 근거 문장에 등장해야 하는 단어(동의어 포함) */
  evidenceTerms?: readonly string[];
}

const section = (
  id: string,
  label: string,
  terms: readonly string[],
  evidenceTerms: readonly string[],
): TopicDefinition => ({
  id,
  label,
  kind: 'section',
  terms,
  evidenceTerms,
  factTypes: [],
});

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
      '원비',
      '회비',
      '요금',
      '가격',
      '비용',
      '얼마',
    ],
    genericTerms: ['요금', '가격', '비용', '얼마'],
    factTypes: ['monthly_fee'],
  },
  {
    id: 'material',
    label: '교재·재료비',
    kind: 'structured',
    // 사실 유형 material_fee(교재·재료비)의 이름. 학원별 원문 이름(교재비/실험 재료비)은 답할 때 원문 표 머리글을 따른다.
    terms: ['교재비', '교재', '책값', '재료비'],
    factTypes: ['material_fee'],
  },
  {
    id: 'schedule',
    label: '수업 시간표',
    kind: 'structured',
    terms: ['시간표', '요일', '몇시', '수업시간', '언제'],
    genericTerms: ['몇시', '언제'],
    factTypes: ['schedule'],
  },
  {
    id: 'teacher',
    label: '담당 강사',
    kind: 'structured',
    terms: ['강사', '선생님', '선생', '교사', '쌤', '담임'],
    factTypes: ['teacher'],
  },
  {
    id: 'schedule_change',
    label: '휴강·보강 일정',
    kind: 'structured',
    terms: [
      '휴강',
      '휴원',
      '쉬는날',
      '쉬나요',
      '쉬어요',
      '수업하나요',
      '수업있나요',
      '수업있어요',
      '수업해요',
      '수업하는지',
      '수업없',
      '단축수업',
      '보강일정',
      '보강날짜',
    ],
    factTypes: ['schedule_change'],
  },
  {
    id: 'makeup',
    label: '보강 규정',
    kind: 'structured',
    terms: ['보강'],
    factTypes: ['makeup_policy'],
  },
  {
    id: 'enrollment',
    label: '모집 현황',
    kind: 'structured',
    terms: [
      '모집',
      '자리',
      '마감',
      '대기',
      '등록가능',
      '들어갈수',
      '들어갈자리',
      '빈자리',
      '여석',
      '잔여',
      '남았',
      '정원',
      '몇명',
      '인원',
      '신규등록',
      '등록할수',
      '등록되나',
      '등록돼',
      '수강가능',
      '수강할수',
      '자리있',
    ],
    // "몇 명"은 의문사(인원 일반)라 이것만으로는 모집 현황 질문으로 보지 않는다(“상 받은 학생 몇 명?”).
    genericTerms: ['몇명'],
    factTypes: ['enrollment_status'],
  },
  {
    id: 'study_room',
    label: '자습실',
    kind: 'attribute',
    terms: ['자습실', '독서실', '자습공간', '자습'],
    factTypes: ['facility'],
    evidenceTerms: ['자습실', '독서실', '자습 공간', '자습'],
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
    id: 'contact',
    label: '연락처',
    kind: 'attribute',
    terms: [
      '연락처',
      '전화번호',
      '번호알',
      '휴대폰번호',
      '핸드폰번호',
      '이메일',
      '카톡',
    ],
    factTypes: ['contact'],
    evidenceTerms: ['연락처', '전화번호', '이메일', '카톡'],
  },
  section(
    'refund',
    '환불 규정',
    ['환불', '환급', '반환', '돌려받', '돌려주', '그만두면', '그만둘'],
    ['환불', '환급', '반환'],
  ),
  section(
    'location',
    '학원 위치',
    [
      '위치',
      '주소',
      '어디에있',
      '어디예요',
      '어딨',
      '오시는길',
      '찾아가',
      '몇층',
    ],
    ['주소', '위치', '오시는 길'],
  ),
  section(
    'hours',
    '운영·상담 시간',
    [
      '운영시간',
      '몇시까지',
      '몇시부터',
      '문열',
      '상담시간',
      '상담가능',
      '영업시간',
    ],
    ['운영 시간', '운영시간', '상담 가능', '상담 시간', '상담시간'],
  ),
  section(
    'shuttle',
    '셔틀버스',
    ['셔틀', '차량운행', '학원버스', '학원차', '픽업', '등하원차'],
    ['셔틀', '통학 차량', '학원 차량', '차량 운행', '노선'],
  ),
  section('discount', '할인', ['할인', '형제'], ['할인']),
  section(
    'level_test',
    '레벨테스트·입학 상담',
    ['레벨테스트', '레테', '입학테스트', '진단평가', '입학상담', '테스트보'],
    ['레벨테스트', '레벨 테스트', '진단평가', '진단 평가', '입학 상담'],
  ),
  section(
    'attendance',
    '출결 규정',
    ['지각', '결석', '출결', '출석'],
    ['지각', '결석', '출결', '출석'],
  ),
  section(
    'phone_rule',
    '휴대폰 규정',
    ['휴대폰', '핸드폰', '스마트폰', '폰'],
    ['휴대폰', '핸드폰', '스마트폰', '폰'],
  ),
  section(
    'clinic',
    '질문 클리닉',
    ['클리닉', '질문받', '질문시간', '질문하러'],
    ['클리닉'],
  ),
  section(
    'payment',
    '납부 방법',
    ['납부', '결제', '카드결제', '계좌', '입금계좌', '계좌이체', '이체'],
    ['납부', '결제', '계좌', '카드'],
  ),
  section(
    'retest',
    '재시험 규정',
    ['재시험', '단어시험'],
    ['재시험', '단어 시험', '단어시험'],
  ),
  section('mock_exam', '모의고사', ['모의고사'], ['모의고사']),
  section('native', '원어민 수업', ['원어민'], ['원어민']),
  section(
    'intro',
    '학원 소개',
    ['어떤학원', '교육방침', '학원소개', '커리큘럼', '수업방식'],
    ['교육 방침', '교육방침', '커리큘럼', '수업 방식'],
  ),
];

/** 다른 주제와 함께 나오면 빠지는 주제(앞 주제가 있으면 뒤 주제를 제외). */
export const TOPIC_SUPPRESSION: ReadonlyArray<readonly [string, string]> = [
  ['makeup', 'attendance'],
  ['contact', 'phone_rule'],
  ['study_room', 'hours'],
  ['contact', 'teacher'],
  ['refund', 'fee'],
  ['refund', 'schedule'],
  ['level_test', 'schedule'],
  ['retest', 'schedule'],
  ['shuttle', 'schedule'],
];

/** 학습 분석 질문으로 보는 표현(단원·유형명은 카탈로그에서 추가). */
export const ANALYSIS_TERMS: readonly string[] = [
  '정답률',
  '성적',
  '점수',
  '몇문제',
  '문제수',
  '맞았',
  '맞혔',
  '맞힌',
  '맞춘',
  '틀린',
  '틀렸',
  '오답',
  '어땠',
  '단원',
  '취약',
  '약한',
  '약점',
  '리포트',
  '분석',
  '유형별',
  '월말평가',
  '평가결과',
];

/** 누적 변화(3개월 이상 추이)를 묻는 표현 */
export const CUMULATIVE_TERMS: readonly string[] = [
  '추이',
  '그동안',
  '지금까지',
  '누적',
  '쭉',
  '계속',
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

/** "X학원"에서 X가 이 단어면 특정 학원 지칭으로 보지 않는다. */
export const GENERIC_ACADEMY_PREFIXES: readonly string[] = [
  '우리',
  '저희',
  '본',
  '이',
  '그',
  '저',
  '해당',
  '제',
  '내',
  '다른',
  '어느',
  '무슨',
  '어떤',
  '동네',
  '근처',
  '영어',
  '수학',
  '국어',
  '과학',
  '사회',
  '입시',
  '보습',
  '종합',
  '단과',
  '대형',
  '소형',
];

export interface RagConfig {
  topics: readonly TopicDefinition[];
  /**
   * 학생 식별 코드 패턴(정규화된 소문자 질의 기준, 캡처 1 = 코드). 합성 데이터 형식(ST_A01, A01) 기본값.
   * 이름으로 지칭하는 경우는 카탈로그의 원생 명부(studentDirectory)와 서버 별칭으로 판별한다.
   */
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
