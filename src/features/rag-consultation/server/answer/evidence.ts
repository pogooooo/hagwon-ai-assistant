/**
 * 검색 기반 질문 해석과 근거 답변(계층적 라우팅의 2단계).
 *
 * 규칙(1단계)이 주제를 정하지 못했거나, 애매한 단서로만 정했거나, 정한 주제로 답을 만들지 못했을 때
 * 사용자 원문으로 권한 범위 안의 근거를 찾고, 찾은 근거의 "자리"로 무엇을 묻는지 판단한다.
 *  - 근거 청크가 정형 사실(수강료·시간표·휴보강 등)의 위치이면 → 그 사실 종류를 정형 조회로 답한다(값은 사실 저장소에서).
 *  - 근거가 원생 분석 리포트이면 → 학습 분석 경로
 *  - 그 밖의 운영 문서이면 → 근거 문장·표 행을 그대로 인용(표는 질문한 행·열, 반 이름이 있으면 그 반 행)
 * 답변 전 충분성 검사: 질문의 의문사가 요구하는 값(금액·날짜·시각·인원·장소·사람·비율)이 근거에 없으면 답하지 않는다.
 * 근거 신뢰도: 질문 핵심어가 근거에 있거나(어휘), 의미 유사도·재정렬 점수가 기준 이상일 때만 근거로 쓴다.
 * 유사어 사전을 늘리지 않고 문서 자체로 표현 차이를 메우는 것이 목적이다.
 */
import type { TopicDefinition } from '../config.ts';
import type { ScoredChunk } from '../ports.ts';
import { compactText, normalizeText } from '../text/normalize.ts';
import type { FactType, RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import {
  classFilter,
  contentWords,
  explicitClassIds,
  renderParagraphs,
  renderTableRows,
} from './info.ts';

/** 대상 반 이름(질문의 반, "우리 반"·자녀의 반) — 검색 바인딩·표 칸 선택용. */
export function boundClassNames(ctx: AnswerContext): string[] {
  const ids = explicitClassIds(ctx);
  return ctx.catalog.classes
    .filter((klass) => ids.includes(klass.classId))
    .flatMap((klass) => [klass.name]);
}

export type AnswerType =
  'amount' | 'date' | 'time' | 'count' | 'percent' | 'place' | 'person';

/** 의문사·질문 형식이 요구하는 답의 값 종류(국어 의문 표현 — 학원별 유사어가 아님). */
export function expectedAnswerTypes(question: string): AnswerType[] {
  const q = normalizeText(question);
  const types = new Set<AnswerType>();
  if (/얼마|금액|비용|가격|요금|이용료|몇\s*원/.test(q)) types.add('amount');
  if (/며칠|몇\s*월\s*몇\s*일|날짜|무슨\s*요일|몇\s*일(?!\s*(동안|간))/.test(q))
    types.add('date');
  if (/몇\s*시|몇\s*분(?!\s*(동안|간))|시간(?!표)|언제/.test(q))
    types.add('time');
  // "언제"는 날짜로도 답한다(“언제까지 해요?” → 12월 18일).
  if (/언제/.test(q) && !/몇\s*시/.test(q)) types.add('date');
  if (/몇\s*(명|개|석|번|회|문항|권|자리)|정원|인원/.test(q))
    types.add('count');
  if (/몇\s*점|몇\s*퍼|몇\s*%|정답률|백분율/.test(q)) types.add('percent');
  if (/어디|위치|몇\s*(호|층)|주소|장소/.test(q)) types.add('place');
  if (/누구|누가|어느\s*(선생|쌤|강사)|성함|이름이?\s*뭐/.test(q))
    types.add('person');
  return [...types];
}

const TYPE_PATTERNS: Record<AnswerType, RegExp> = {
  amount:
    /\d[\d,]*\s*(원|만\s*원)|무료|없(음|습니다)|포함|\d+\s*분의\s*\d+|\d+\/\d+|전액|반액|\d+\s*%|실비/,
  date: /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}-\d{2}-\d{2}|매월\s*\d{1,2}\s*일|[월화수목금토일]요일|[월화수목금토일](·[월화수목금토일])+/,
  time: /\d{1,2}:\d{2}|\d{1,2}\s*시(\s*\d{1,2}\s*분)?|오전|오후|저녁|\d+\s*분(?!의)|\d{1,2}\s*월\s*\d{1,2}\s*일|[월화수목금토일]요일|매주|평일|주말/,
  count: /\d+\s*(명|개|석|번|회|문항|권|자리|차시)|없(음|습니다)|마감/,
  percent: /\d+(\.\d+)?\s*%|\d+\s*점|\d+\s*문항/,
  place:
    /\d+\s*(호|층)|[가-힣]+(로|길|동|역|건물|빌딩|센터|관|실)\b|출구|도보|주차/,
  person: /[가-힣]{2,4}\s*(강사|선생님|원장|부원장|실장|쌤)|강사/,
};

export function satisfiesAnswerTypes(
  text: string,
  types: readonly AnswerType[],
): boolean {
  if (types.length === 0) return true;
  // 질문이 여러 값을 물어도(예: "언제 몇 시") 하나 이상 확인되면 충분하다고 본다(나머지는 답변 문장에 그대로 드러남).
  return types.some((type) => TYPE_PATTERNS[type].test(text));
}

/** 근거 검색: 사용자 원문으로(의미 검색·재정렬은 원문), 권한 범위 안에서. 재정렬은 순위가 애매할 때만. */
/** 규칙이 정한 주제의 근거가 있을 만한 문서 종류(문서 메타데이터 계약의 document_type). */
const TOPIC_DOCUMENT_TYPES: Record<string, string[]> = {
  fee: ['fee', 'announcement', 'policy'],
  material: ['fee', 'announcement'],
  discount: ['fee', 'policy'],
  payment: ['fee', 'policy'],
  schedule: ['schedule', 'announcement', 'academy_info'],
  classroom: ['schedule', 'facility', 'academy_info'],
  teacher: ['teacher', 'academy_info'],
  enrollment: ['announcement', 'academy_info'],
  schedule_change: ['announcement', 'schedule'],
  makeup: ['policy', 'announcement', 'schedule'],
};

export function documentTypesFor(
  topicIds: readonly string[],
): string[] | undefined {
  const types = [
    ...new Set(topicIds.flatMap((id) => TOPIC_DOCUMENT_TYPES[id] ?? [])),
  ];
  return types.length > 0 && topicIds.every((id) => TOPIC_DOCUMENT_TYPES[id])
    ? types
    : undefined;
}

/** 값이 바뀌었는지 묻는 질문이면 비슷하게 믿을 만한 근거 중 더 최근에 효력이 시작된 문서를 앞에 둔다. */
function preferRecent(
  ctx: AnswerContext,
  evidence: readonly ScoredChunk[],
): ScoredChunk[] {
  const changeCue =
    ctx.frame.futureCue ||
    /바뀌|바뀐|변경|새로|부터|인상|오른|달라/.test(ctx.frame.normalized);
  if (!changeCue) return [...evidence];
  const head = evidence
    .slice(0, 3)
    .sort((a, b) => b.chunk.validFrom - a.chunk.validFrom);
  return [...head, ...evidence.slice(3)];
}

export async function retrieveEvidence(
  ctx: AnswerContext,
  options: {
    studentIds?: readonly string[];
    limit?: number;
    documentTypes?: readonly string[];
  } = {},
): Promise<ScoredChunk[]> {
  // 질문·계정·대화로 정해진 반 이름을 키워드 질의에 더해 그 반의 행·문장이 위로 오게 한다(근거 바인딩).
  const bound = boundClassNames(ctx);
  const search = (documentTypes?: readonly string[]) =>
    ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: options.studentIds ?? ctx.access.allowedStudentIds,
      asOf: ctx.asOf,
      query: [ctx.question, ...bound].join(' '),
      question: ctx.question,
      limit: options.limit ?? 8,
      rerank: 'auto',
      ...(documentTypes ? { documentTypes } : {}),
    });
  let results = await search(options.documentTypes);
  // 주제에 맞는 문서 종류에서 믿을 만한 근거를 못 찾으면 전체에서 다시 찾는다.
  if (
    options.documentTypes &&
    !results.some((r) => evidenceConfidence(ctx.question, r).trusted)
  )
    results = await search();
  results = preferRecent(ctx, results);
  recordChunks(
    ctx.trace,
    results.map((result) => result.chunk),
  );
  return results;
}

/** 근거를 근거로 쓸 만큼 믿을 수 있는지: 어휘 핵심어 일치 또는 의미 유사도·재정렬 점수. */
const GENERIC_WORDS = new Set([
  '학원',
  '수업',
  '선생님',
  '우리',
  '저희',
  '아이',
  '학생',
  '어떻게',
  '언제',
  '얼마',
  '몇시',
  '알려',
  '궁금',
  '혹시',
  '그럼',
  '근데',
  '이번',
  '다음',
]);

export const EVIDENCE_THRESHOLDS = {
  /** e5-small 코사인 유사도(개발셋으로 정함) */
  dense: 0.84,
  /** bge-reranker 로짓(개발셋으로 정함) */
  rerank: -2.5,
};

export function keywordsOf(question: string): string[] {
  return contentWords(question).filter(
    (word) => !GENERIC_WORDS.has(word) && word.length >= 2,
  );
}

/** 단어 앞부분(2~3글자 어간)이 근거에 있으면 일치로 본다("열어요"↔"열", "돌려받"↔"돌려"). */
function stemHit(word: string, text: string): boolean {
  if (text.includes(word)) return true;
  for (const length of [3, 2]) {
    if (
      word.length > length &&
      /^[가-힣]+$/.test(word) &&
      text.includes(word.slice(0, length))
    )
      return true;
  }
  return false;
}

export function evidenceConfidence(
  question: string,
  result: ScoredChunk,
): { trusted: boolean; reason: string } {
  const text = compactText(
    `${result.chunk.title} ${result.chunk.location.section ?? ''} ${result.chunk.text}`,
  );
  const keywords = keywordsOf(question).map(compactText);
  const hits = keywords.filter((word) => stemHit(word, text));
  if (
    result.signals?.rerankScore !== undefined &&
    result.signals.rerankScore >= EVIDENCE_THRESHOLDS.rerank
  )
    return { trusted: true, reason: 'rerank' };
  if (
    result.signals?.denseScore !== undefined &&
    result.signals.denseScore >= EVIDENCE_THRESHOLDS.dense
  )
    return { trusted: true, reason: 'dense' };
  if (hits.length >= Math.min(2, keywords.length) && hits.length > 0)
    return { trusted: true, reason: 'lexical' };
  // 절 제목이 질문 핵심어 하나를 그대로 담고 있으면(“교재비 따로 내요?” → [5. 교재비]) 그 절을 근거로 본다.
  const heading = compactText(result.chunk.location.section ?? '');
  if (
    heading &&
    keywords.some(
      (word) =>
        word.length >= 3 &&
        heading.includes(word) &&
        text.split(word).length - 1 >= 2,
    )
  )
    return { trusted: true, reason: 'heading' };
  return {
    trusted: false,
    reason: `keywords ${hits.length}/${keywords.length}`,
  };
}

const FACT_TOPIC: Partial<Record<FactType, string>> = {
  monthly_fee: 'fee',
  material_fee: 'material',
  schedule: 'schedule',
  teacher: 'teacher',
  enrollment_status: 'enrollment',
  schedule_change: 'schedule_change',
  makeup_policy: 'makeup',
};
const ANALYSIS_FACTS: readonly FactType[] = [
  'accuracy',
  'weak_area',
  'learning_guidance',
];

export type EvidencePlan =
  | {
      kind: 'facts';
      topics: TopicDefinition[];
      classIds: string[];
      top: ScoredChunk;
    }
  | {
      kind: 'analysis';
      studentIds: string[];
      guidance: boolean;
      top: ScoredChunk;
    }
  | { kind: 'document'; top: ScoredChunk }
  | { kind: 'none'; reason: string };

/** 가장 믿을 만한 근거의 자리 → 답변 경로. */
export function planFromEvidence(
  ctx: AnswerContext,
  evidence: readonly ScoredChunk[],
): EvidencePlan {
  const top = evidence.find(
    (result) => evidenceConfidence(ctx.question, result).trusted,
  );
  if (!top)
    return {
      kind: 'none',
      reason: evidence.length ? 'low_confidence' : 'no_evidence',
    };
  const refs = ctx.documents.factRefsAtChunk?.(top.chunk.chunkId) ?? [];
  if (
    top.chunk.documentType === 'student_analysis' ||
    refs.some((ref) => ANALYSIS_FACTS.includes(ref.factType))
  ) {
    const studentIds = top.chunk.studentId ? [top.chunk.studentId] : [];
    const guidance = /방향|조언|지도|코멘트|의견|계획/.test(
      top.chunk.location.section ?? '',
    );
    return { kind: 'analysis', studentIds, guidance, top };
  }
  const topicOf = (list: typeof refs) => [
    ...new Set(
      list
        .map((ref) => FACT_TOPIC[ref.factType])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const topicIds = topicOf(refs);
  if (topicIds.length > 0) {
    // 다음으로 믿을 만한 근거가 다른 정형 사실 자리이면 그 주제도 함께(예: 휴강 공지 + 수능 이후 시간표)
    const second = evidence
      .filter(
        (result) =>
          result !== top && evidenceConfidence(ctx.question, result).trusted,
      )
      .slice(0, 2)
      .map(
        (result) => ctx.documents.factRefsAtChunk?.(result.chunk.chunkId) ?? [],
      )
      .find(
        (list) =>
          topicOf(list).length > 0 &&
          !list.some((ref) => ANALYSIS_FACTS.includes(ref.factType)),
      );
    // 규칙이 (일반어로라도) 주제를 잡았으면 두 번째 근거의 주제는 그 범위 안에서만 더한다.
    const ruleIds = ctx.frame.topics.map((topic) => topic.id);
    const extra = topicOf(second ?? []).filter(
      (id) => ruleIds.length === 0 || ruleIds.includes(id),
    );
    const allIds = [...new Set([...topicIds, ...extra])];
    const topics = ctx.config.topics.filter((topic) =>
      allIds.includes(topic.id),
    );
    const classIds = [
      ...new Set(
        refs
          .filter((ref) => ref.subjectType === 'class')
          .map((ref) => ref.subjectId),
      ),
    ];
    return { kind: 'facts', topics, classIds, top };
  }
  return { kind: 'document', top };
}

/** 운영 문서 근거 인용: 근거 청크가 속한 절의 관련 문장·표 행(질문한 반·열)을 그대로 보여 준다. */
export async function answerFromDocuments(
  ctx: AnswerContext,
  evidence: readonly ScoredChunk[],
): Promise<AnswerDraft> {
  ctx.trace.intent = `${ctx.trace.intent === 'unknown' ? '' : `${ctx.trace.intent}>`}evidence`;
  const types = expectedAnswerTypes(ctx.question);
  const words = contentWords(ctx.question);
  const keepText = classFilter(ctx);
  const trusted = evidence.filter(
    (result) => evidenceConfidence(ctx.question, result).trusted,
  );
  // 같은 절의 청크는 한 묶음으로 본다. 절 제목이 없는 문서(게시판 글 모음 등)는 서로 이웃한 청크끼리만 묶는다
  // (질문 글과 바로 뒤 답변 글 — 같은 문서의 무관한 글이 한 묶음으로 섞이지 않게).
  const indexOf = (chunk: RagChunk) => Number(chunk.chunkId.split('#').pop());
  const groups: Array<{ key: string; chunks: ScoredChunk[] }> = [];
  for (const result of trusted) {
    const section = result.chunk.location.section;
    const group = section
      ? groups.find((g) => g.key === `${result.chunk.sourceId}§${section}`)
      : groups.find(
          (g) =>
            g.key === `${result.chunk.sourceId}§` &&
            g.chunks.some(
              (entry) =>
                Math.abs(indexOf(entry.chunk) - indexOf(result.chunk)) <= 1,
            ),
        );
    if (group) group.chunks.push(result);
    else
      groups.push({
        key: `${result.chunk.sourceId}§${section ?? ''}`,
        chunks: [result],
      });
  }
  // 상위 근거 묶음 중 질문이 요구한 값 종류를 더 많이 갖춘 묶음, 그다음 절 제목에 질문 핵심어가 든 묶음을 먼저 본다
  // (“교재비 따로 내요?” → [5. 교재비] 절, “몇 번·몇 분?” → 횟수와 분이 모두 있는 표).
  const keywords = keywordsOf(ctx.question).map(compactText);
  const groupText = (group: (typeof groups)[number]) =>
    group.chunks.map((entry) => entry.chunk.text).join('\n');
  const coverage = (group: (typeof groups)[number]) =>
    types.filter((type) => TYPE_PATTERNS[type].test(groupText(group))).length;
  // 반 이름은 절 제목(강사 소개 등)에 흔히 들어가므로 제목 일치에서 뺀다.
  const classNames = ctx.catalog.classes.flatMap((klass) =>
    [klass.name, ...klass.aliases].map(compactText),
  );
  const isClassWord = (word: string) =>
    classNames.some(
      (name) =>
        name.includes(word) ||
        word.includes(name) ||
        (word.length >= 3 && name.includes(word.slice(0, 3))),
    );
  const headingHits = (group: (typeof groups)[number]) => {
    const heading = compactText(group.chunks[0].chunk.location.section ?? '');
    return keywords.filter(
      (word) =>
        word.length >= 2 &&
        !isClassWord(word) &&
        (heading.includes(word) ||
          (word.length > 3 && heading.includes(word.slice(0, 3)))),
    ).length;
  };
  const ordered = groups
    .slice(0, 5)
    .map((group, index) => ({
      group,
      index,
      coverage: coverage(group),
      heading: headingHits(group),
    }))
    .sort(
      (a, b) =>
        b.coverage - a.coverage || b.heading - a.heading || a.index - b.index,
    )
    .map((entry) => entry.group);
  for (const group of ordered.slice(0, 3)) {
    const chunks = group.chunks
      .map((entry) => entry.chunk)
      .sort(
        (a, b) =>
          Number(a.chunkId.split('#').pop()) -
          Number(b.chunkId.split('#').pop()),
      );
    const tables = chunks.filter(
      (chunk) => chunk.location.kind === 'table_row',
    );
    const paragraphs = chunks.filter(
      (chunk) => chunk.location.kind !== 'table_row',
    );
    const lines = [
      ...renderParagraphs(paragraphs, words, [], keepText),
      ...renderTableRows(tables, words, [], keepText, boundClassNames(ctx)),
    ]
      .map((line) => line.replace(/\*\*|__/g, ''))
      .slice(0, 8);
    if (lines.length === 0) continue;
    const text = lines.join('\n');
    if (!satisfiesAnswerTypes(text, types)) continue;
    const best = chunks[0];
    return {
      status: 'answered',
      text: `[${best.location.section ?? best.title}] ${best.title} 기준 안내입니다.\n${text}`,
      citations: chunks.map((chunk) => ({ kind: 'chunk' as const, chunk })),
      usedFacts: [],
      instants: [ctx.asOf],
    };
  }
  return abstain(
    '질문하신 내용을 등록된 승인 자료에서 확인할 수 없어 답변드리기 어렵습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
    'INSUFFICIENT_EVIDENCE',
    undefined,
    ['INSUFFICIENT_EVIDENCE'],
  );
}

/** 규칙이 정한 주제가 일반어(얼마·언제·몇시)로만 잡혔는지. */
export function hasOnlyGenericTopics(ctx: AnswerContext): boolean {
  const compact = ctx.frame.compact;
  return ctx.frame.topics.every((topic) => {
    const matched = topic.terms.filter((term) =>
      compact.includes(compactText(term)),
    );
    return (
      matched.length > 0 &&
      matched.every((term) => topic.genericTerms?.includes(term))
    );
  });
}

/** 질문에서 이름씨처럼 보이는 핵심어(동사·형용사 활용형으로 끝나는 말 제외). */
const VERB_ENDING =
  /(요|다|까|죠|나|니|래|지|서|면|고|데|게|네|냐|음|함|됨|여|어|아|야|자|쇼|임|세)$/;
const CHATTER = new Set([
  '엄마',
  '아빠',
  '부모님',
  '친구',
  '동생',
  '언니',
  '오빠',
  '누나',
  '형',
  '애들',
  '아이들',
  '선생님',
  '쌤',
  '원장님',
  '질문',
  '문의',
  '답변',
  '확인',
  '부탁',
  '정도',
  '쯤',
  '혹시',
  '진짜',
  '그냥',
  '요즘',
  '지금',
  '오늘',
  '내일',
  '이번',
  '저번',
  '다음',
  '같이',
  '따로',
  '미리',
  '먼저',
  '처음',
  '계속',
  '보통',
  '항상',
]);

/**
 * 권한 범위의 승인 자료 어디에도 나오지 않는 핵심 개념(예: "현금영수증", "할부", "합격률").
 * 반·학생·강사·단원 이름과 주제 사전의 말, 일상어는 제외한다. 문서 자체를 근거로 하는 판단이라 학원마다 따로 맞출 필요가 없다.
 */
export async function unknownConcepts(ctx: AnswerContext): Promise<string[]> {
  if (!ctx.documents.corpusContains) return [];
  const entities = [
    ...ctx.access.studentRefs.flatMap((ref) => [
      ref.displayLabel,
      ...ref.aliases,
    ]),
    ...(ctx.catalog.studentDirectory ?? []).flatMap((entry) => entry.names),
    ...ctx.catalog.classes.flatMap((klass) => [
      klass.name,
      ...klass.aliases,
      klass.subject ?? '',
    ]),
    ...ctx.catalog.units,
    ...(ctx.catalog.questionTypes ?? []),
    ctx.catalog.displayName,
    ...ctx.catalog.aliases,
  ]
    .map(compactText)
    .filter((name) => name.length >= 2);
  const topicTerms = ctx.config.topics
    .flatMap((topic) => topic.terms)
    .map(compactText);
  const candidates = keywordsOf(ctx.question)
    .map(compactText)
    .filter(
      (word) =>
        word.length >= 2 &&
        !/\d/.test(word) &&
        !VERB_ENDING.test(word) &&
        !CHATTER.has(word) &&
        !entities.some((name) => name.includes(word) || word.includes(name)) &&
        !topicTerms.some(
          (term) =>
            term.length >= 2 && (word.includes(term) || term.includes(word)),
        ),
    );
  const unknown: string[] = [];
  for (const word of candidates) {
    const found = await ctx.documents.corpusContains({
      access: ctx.access,
      studentIds: ctx.access.allowedStudentIds,
      asOf: ctx.asOf,
      term: word,
    });
    if (!found) unknown.push(word);
  }
  return unknown;
}

/** 강사를 이름으로 부른 질문인지(역할·과목·반 표현 제외) — 강사 개인 속성 질문 판별용. */
const NON_NAME_WORDS = new Set([
  '담당',
  '담임',
  '우리',
  '저희',
  '원장',
  '부원장',
  '원어민',
  '영어',
  '수학',
  '국어',
  '과학',
  '사회',
  '논술',
  '코딩',
  '학원',
  '학교',
  '과외',
  '다른',
  '어떤',
  '무슨',
  '어느',
  '새로',
  '새로운',
  '남자',
  '여자',
  '외국인',
  '실장',
  '상담',
  '조교',
  '보조',
  '전임',
  '전담',
  '그',
]);
export function namedTeacher(normalized: string): string | null {
  for (const match of normalized.matchAll(
    /(?:^|[^가-힣a-z])([가-힣]{2,4}|[a-z]{3,})\s*(?:쌤|샘|선생님|강사님|강사)/g,
  )) {
    const word = match[1];
    if (NON_NAME_WORDS.has(word) || /반$|[0-9]/.test(word)) continue;
    return word;
  }
  return null;
}
export const TEACHER_WHO =
  /누구|누가|담당|담임|이름|성함|맡|무슨\s*반|어느\s*반|어떤\s*반|바뀌|바뀐|교체|소개/;
