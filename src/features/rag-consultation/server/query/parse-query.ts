/**
 * 규칙 기반 질의 해석(생성 API 호출 없음).
 *
 * 질문에 들어 있는 학생·반·단원·유형·기간·숫자·부정/비교 연산자(Evidence Anchors)를
 * 지우거나 바꾸지 않고 구조화한다. 해석이 애매하면 더 좁은 범위나 확인 질문을 택하도록
 * 플래그만 세우고, 최종 판단은 서비스 계층이 한다.
 */
import {
  ANALYSIS_TERMS,
  CUMULATIVE_TERMS,
  GENERIC_ACADEMY_PREFIXES,
  RELATION_WORDS,
  TOPIC_SUPPRESSION,
  type RagConfig,
  type TopicDefinition,
} from '../config.ts';
import { compactText, normalizeText } from '../text/normalize.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';

export interface ExplicitDate {
  year: number;
  month: number;
  day: number;
  operator: 'at' | 'after' | 'before';
}

export interface QueryFlags {
  crossTenant: boolean;
  bulkStudent: boolean;
  shareOrPermission: boolean;
  sessionChange: boolean;
  citationForgery: boolean;
  documentIdReference: boolean;
  injectionDirective: boolean;
  misattribution: boolean;
  causal: boolean;
  attitude: boolean;
  prediction: boolean;
  compare: boolean;
  trend: boolean;
  cumulative: boolean;
  previousRevision: boolean;
  generationRequest: boolean;
  countLimit: boolean;
  unconditional: boolean;
  weakUnit: boolean;
  elliptical: boolean;
  unitDimension: boolean;
  /** "유형별"처럼 문항 유형 분석을 묻는지 */
  typeDimension: boolean;
  /** 보강 "일정"을 묻는지(보강 규정이 아니라) */
  makeupSchedule: boolean;
  /** 휴강을 묻는지 */
  cancelSchedule: boolean;
}

export interface QueryFrame {
  normalized: string;
  compact: string;
  /** 질문에 등장한 학생 코드(정규화된 대문자, 예: A01) */
  studentCodes: string[];
  /** 서버가 내려준 허용 학생 별칭(코드·이름·형제 지칭)으로 해석된 학생 ID */
  matchedStudentIds: string[];
  /**
   * 허용 범위 밖 학생 지칭(코드 또는 원생 명부의 이름).
   * 권한 밖인지 존재하지 않는지는 구분하지 않고 같은 거부 응답을 쓴다.
   */
  unauthorizedStudentRefs: string[];
  /** 서버 별칭이 없는 형제 지시어(첫째/둘째 등) */
  unresolvedRelationWords: string[];
  selfReference: boolean;
  groupReference: boolean;
  anaphora: boolean;
  classIds: string[];
  negatedClassIds: string[];
  explicitDates: ExplicitDate[];
  /** 오늘/내일/모레 → 0/1/2 */
  relativeDay: number | null;
  relativeWeek: 'last_week' | 'this_week' | 'next_week' | null;
  months: number[];
  relativePeriod: 'last_month' | 'this_month' | 'next_month' | null;
  /** 질문이 미래 시점의 값을 묻는지("1월부터"·"내년"·"다음 달부터"·"오른다던데") — 학원 정보의 적용 시점 계산용 */
  futureCue: boolean;
  units: string[];
  questionTypes: string[];
  /** 질문에 나온 과목(카탈로그 반의 과목명) */
  subjects: string[];
  topics: TopicDefinition[];
  /** 카탈로그 반과 일치하지 않는 프로그램 지칭(예: "겨울방학 특강") */
  unknownPrograms: string[];
  amountsKrw: number[];
  percents: number[];
  hasAnalysisTerms: boolean;
  flags: QueryFlags;
}

function test(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function parseDates(text: string): { dates: ExplicitDate[]; rest: string } {
  const dates: ExplicitDate[] = [];
  let rest = text;
  const patterns: Array<{
    regex: RegExp;
    map: (m: RegExpExecArray) => [number | null, number, number];
  }> = [
    {
      regex: /(\d{4})-(\d{1,2})-(\d{1,2})/g,
      map: (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
    },
    {
      regex: /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/g,
      map: (m) => [m[1] ? Number(m[1]) : null, Number(m[2]), Number(m[3])],
    },
  ];
  for (const { regex, map } of patterns) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    const replacements: Array<[number, number]> = [];
    while ((match = regex.exec(rest)) !== null) {
      const [year, month, day] = map(match);
      const after = rest.slice(match.index + match[0].length);
      const operator: ExplicitDate['operator'] = /^\s*(이후|부터)/.test(after)
        ? 'after'
        : /^\s*(이전|전까지|까지)/.test(after)
          ? 'before'
          : 'at';
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        dates.push({ year: year ?? Number.NaN, month, day, operator });
      }
      replacements.push([match.index, match.index + match[0].length]);
    }
    for (const [start, end] of replacements.reverse()) {
      rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
    }
  }
  return { dates, rest };
}

function parseAmounts(text: string): number[] {
  const amounts: number[] = [];
  let rest = text;
  rest = rest.replace(/(\d+(?:\.\d+)?)\s*만\s*원/g, (_, value: string) => {
    amounts.push(Math.round(Number(value) * 10_000));
    return ' ';
  });
  for (const match of rest.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/g)) {
    amounts.push(Number(match[1].replace(/,/g, '')));
  }
  return amounts;
}

const GRADE = /(초|중|고)[1-6]/;

/**
 * 반 이름·별칭 매칭. 같은 위치에서 더 긴 표현이 다른 반을 가리키면 짧은 쪽은 버린다
 * (예: "고1 수학 특강" 은 "고1 수학" 반이 아니라 특강).
 */
function matchClasses(compact: string, catalog: AcademyCatalog) {
  const grades = unique(
    [...compact.matchAll(/(초|중|고)[1-6]/g)].map((m) => m[0]),
  );
  interface Hit {
    classId: string;
    start: number;
    end: number;
    negated: boolean;
  }
  const hits: Hit[] = [];
  for (const klass of catalog.classes) {
    const name = compactText(klass.name);
    const grade = klass.grade
      ? compactText(klass.grade)
      : (name.match(GRADE)?.[0] ?? null);
    const core = name.replace(GRADE, '').replace(/반$/, '');
    const keywords = unique(
      [name, core, ...klass.aliases.map(compactText)]
        .map((k) => k.replace(/[^0-9a-z가-힣]/g, ''))
        .filter((k) => k.length >= 2),
    );
    for (const keyword of keywords) {
      const keywordGrade = keyword.match(GRADE)?.[0] ?? null;
      // 학년 없는 키워드는 질문에 다른 학년이 명시되면 쓰지 않는다.
      if (
        !keywordGrade &&
        grade &&
        grades.length > 0 &&
        !grades.includes(grade)
      )
        continue;
      let index = compact.indexOf(keyword);
      while (index !== -1) {
        const after = compact.slice(index + keyword.length).replace(/^반/, '');
        hits.push({
          classId: klass.classId,
          start: index,
          end: index + keyword.length,
          negated: /^(이|가|은|는)?(아닌|아니고|말고|제외|빼고)/.test(after),
        });
        index = compact.indexOf(keyword, index + keyword.length);
      }
    }
  }
  const isProgram = (classId: string) =>
    /특강|캠프|패키지|파이널/.test(
      catalog.classes.find((klass) => klass.classId === classId)?.name ?? '',
    );
  const kept = hits.filter(
    (hit) =>
      !hits.some(
        (other) =>
          other.classId !== hit.classId &&
          ((other.start <= hit.start &&
            other.end >= hit.end &&
            other.end - other.start > hit.end - hit.start) ||
            // "고1 수학 기말 특강"처럼 특강 이름 바로 앞의 반 표현은 특강을 꾸미는 말로 본다.
            (isProgram(other.classId) &&
              !isProgram(hit.classId) &&
              other.start >= hit.end &&
              other.start - hit.end <= 3)),
      ),
  );
  const negated = unique(
    kept.filter((hit) => hit.negated).map((hit) => hit.classId),
  );
  const positive = unique(
    kept
      .filter((hit) => !hit.negated && !negated.includes(hit.classId))
      .map((hit) => hit.classId),
  );
  return {
    positive,
    negated,
    spans: kept.map((hit) => [hit.start, hit.end] as const),
  };
}

const NON_CLASS_PREFIXES = new Set([
  '우리',
  '저희',
  '제',
  '내',
  '이',
  '그',
  '저',
  '같은',
  '무슨',
  '어느',
  '어떤',
  '다른',
  '몇',
  '두',
  '각',
  '모든',
  '학원',
  '수업',
  '전',
  '새',
  '윗',
  '아랫',
  '옆',
  '합',
  '분',
]);

/** 글자들이 같은 순서로 들어 있는지("과고" ⊂ "과학고대비반"). */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

export function abbreviatedClasses(
  normalized: string,
  catalog: AcademyCatalog,
): string[] {
  const grades = unique(
    [...normalized.replace(/\s+/g, '').matchAll(/(초|중|고)[1-6]/g)].map(
      (m) => m[0],
    ),
  );
  const found = new Set<string>();
  for (const match of normalized.matchAll(
    /([가-힣a-z0-9]{2,8})반(?![가-힣])/g,
  )) {
    const word = match[1].replace(/^(초|중|고)[1-6]/, '');
    if (word.length < 2 || NON_CLASS_PREFIXES.has(word)) continue;
    const candidates = catalog.classes.filter((klass) => {
      const name = compactText(klass.name).replace(/^(초|중|고)[1-6]/, '');
      const names = [
        name,
        ...klass.aliases.map((a) =>
          compactText(a).replace(/^(초|중|고)[1-6]/, ''),
        ),
      ];
      if (!names.some((n) => n.startsWith(word[0]) && isSubsequence(word, n)))
        return false;
      const grade = klass.grade
        ? compactText(klass.grade)
        : (compactText(klass.name).match(/^(초|중|고)[1-6]/)?.[0] ?? null);
      return grades.length === 0 || !grade || grades.includes(grade);
    });
    if (candidates.length > 0 && candidates.length <= 4)
      candidates.forEach((klass) => found.add(klass.classId));
  }
  return [...found];
}

function matchAcademies(normalized: string, catalog: AcademyCatalog): boolean {
  const own = new Set(
    [catalog.displayName, ...catalog.aliases].map((name) =>
      compactText(name).replace(/학원$/, ''),
    ),
  );
  // "새솔영어학원"처럼 붙여 쓴 이름은 그대로, "새솔영어 학원"처럼 띄어 쓴 경우는 앞말이 조사로 끝나지 않을 때만 학원 이름으로 본다.
  for (const match of normalized.matchAll(/([0-9a-z가-힣]+)(\s*)학원/g)) {
    const prefix = match[1];
    const spaced = match[2].length > 0;
    if (GENERIC_ACADEMY_PREFIXES.includes(prefix)) continue;
    // 띄어 쓴 경우 앞말이 "OO영어/OO수학"처럼 학원 이름 꼴일 때만 인정한다("감기 걸려서 학원 빠지면" 등 제외).
    if (
      spaced &&
      !/(영어|수학|국어|과학|입시|종합|보습|논술|코딩|미술|음악|어학|단과)$/.test(
        prefix,
      )
    )
      continue;
    if (!own.has(prefix)) return true;
  }
  return false;
}

/** 카탈로그에 없는 프로그램(특강·캠프 등)을 가리키는 말 — 승인 자료로 확인할 수 없으므로 정형 답변 대상이 아니다. */
const PROGRAM_TERMS = [
  '겨울방학특강',
  '여름방학특강',
  '방학특강',
  '특강',
  '캠프',
  '패키지',
  '파이널',
  '단기반',
  '윈터스쿨',
  '썸머스쿨',
];

const NAME_SUFFIX =
  '(이|가|는|은|의|도|랑|이랑|한테|에게|이는|이가|이의|이도|이한테|이네|네|씨|학생|군|양)?';

/** 한글 이름 지칭 여부. 2글자 이름은 앞뒤가 다른 한글 단어의 일부가 아닐 때만 인정한다. */
export function mentionsName(normalized: string, name: string): boolean {
  const target = compactText(name);
  if (!/[가-힣]/.test(target)) return false;
  if (target.length >= 3)
    return normalized.replace(/\s+/g, '').includes(target);
  return new RegExp(`(^|[^가-힣])${target}${NAME_SUFFIX}(?![가-힣])`).test(
    normalized,
  );
}

function selectTopics(compact: string, config: RagConfig): TopicDefinition[] {
  const matched = config.topics
    .map((topic) => ({
      topic,
      terms: topic.terms.filter((term) => compact.includes(compactText(term))),
    }))
    .filter((entry) => entry.terms.length > 0);
  const hasSpecific = (except: TopicDefinition) =>
    matched.some(
      (entry) =>
        entry.topic !== except &&
        entry.terms.some(
          (term) => !(entry.topic.genericTerms ?? []).includes(term),
        ),
    );
  let topics = matched
    .filter(
      (entry) =>
        !(
          entry.topic.genericTerms &&
          entry.terms.every((term) =>
            entry.topic.genericTerms?.includes(term),
          ) &&
          hasSpecific(entry.topic)
        ),
    )
    .map((entry) => entry.topic);
  for (const [dominant, suppressed] of TOPIC_SUPPRESSION) {
    if (topics.some((topic) => topic.id === dominant)) {
      topics = topics.filter((topic) => topic.id !== suppressed);
    }
  }
  return topics;
}

export function parseQuery(
  question: string,
  context: {
    access: RagAccessScope;
    catalog: AcademyCatalog;
    config: RagConfig;
  },
): QueryFrame {
  const { access, catalog, config } = context;
  const normalized = normalizeText(question);
  const compact = normalized.replace(/\s+/g, '');

  // 1) 학생 코드(합성 형식)
  const codePattern = new RegExp(config.studentCodePattern.source, 'g');
  const studentCodes = unique(
    [...normalized.matchAll(codePattern)].map((match) =>
      match[1].toUpperCase(),
    ),
  );
  const matchedStudentIds: string[] = [];
  const unauthorizedStudentRefs: string[] = [];
  for (const code of studentCodes) {
    const owner = access.studentRefs.find((ref) =>
      ref.aliases.some((alias) => {
        const a = alias.toUpperCase();
        return a === code || a === `ST_${code}`;
      }),
    );
    if (owner) matchedStudentIds.push(owner.studentId);
    else unauthorizedStudentRefs.push(code);
  }

  // 2) 이름·별칭(서버가 내려준 허용 학생 별칭 → 원생 명부 순으로 판별)
  for (const ref of access.studentRefs) {
    const names = [ref.displayLabel, ...ref.aliases].filter(
      (alias) => !RELATION_WORDS.includes(alias),
    );
    if (names.some((name) => mentionsName(normalized, name)))
      matchedStudentIds.push(ref.studentId);
  }
  for (const entry of catalog.studentDirectory ?? []) {
    if (access.allowedStudentIds.includes(entry.studentId)) continue;
    if (matchedStudentIds.includes(entry.studentId)) continue;
    if (entry.names.some((name) => mentionsName(normalized, name))) {
      unauthorizedStudentRefs.push(`name:${entry.studentId}`);
    }
  }

  // 3) 형제 지칭(첫째/둘째 …)
  const unresolvedRelationWords: string[] = [];
  for (const word of RELATION_WORDS) {
    if (!compact.includes(word)) continue;
    const owner = access.studentRefs.find((ref) => ref.aliases.includes(word));
    if (owner) matchedStudentIds.push(owner.studentId);
    else unresolvedRelationWords.push(word);
  }

  // 4) 날짜·기간
  const { dates, rest: withoutDates } = parseDates(normalized);
  const months = unique(
    [...withoutDates.matchAll(/(\d{1,2})\s*월/g)]
      .map((match) => Number(match[1]))
      .filter((month) => month >= 1 && month <= 12),
  );
  const relativePeriod = test(/다음\s*달|담달|내달|다음달/g, normalized)
    ? 'next_month'
    : test(/지난\s*달|저번\s*달|전월/g, normalized)
      ? 'last_month'
      : test(/이번\s*달|이달|금월/g, normalized)
        ? 'this_month'
        : null;
  const relativeWeek = test(/이번\s*주|금주|이번주/g, normalized)
    ? 'this_week'
    : test(/다음\s*주|차주/g, normalized)
      ? 'next_week'
      : test(/지난\s*주|저번\s*주/g, normalized)
        ? 'last_week'
        : null;
  const relativeDay = test(/(^|\s)오늘/g, normalized)
    ? 0
    : test(/(^|\s)내일/g, normalized)
      ? 1
      : test(/(^|\s)모레/g, normalized)
        ? 2
        : null;

  // 5) 반 → (반 이름을 지운 문장에서) 단원·유형 → 주제
  const stripped = compact.replace(/[^0-9a-z가-힣]/g, '');
  const matched = matchClasses(stripped, catalog);
  const { negated, spans } = matched;
  // 반 이름 줄임말("과고반"·"영재원반"·"실험반"·"내신반"): 정확히 맞는 반이 없을 때만, 학년이 맞고 글자 순서가 같은 반들
  const positive =
    matched.positive.length > 0
      ? matched.positive
      : abbreviatedClasses(normalized, catalog);
  let withoutClasses = stripped;
  for (const [start, end] of spans) {
    withoutClasses = `${withoutClasses.slice(0, start)}${' '.repeat(end - start)}${withoutClasses.slice(end)}`;
  }
  const clean = (text: string) =>
    compactText(text).replace(/[^0-9a-z가-힣]/g, '');
  const questionTypes = (catalog.questionTypes ?? []).filter((type) =>
    withoutClasses.includes(clean(type)),
  );
  const unknownPrograms = PROGRAM_TERMS.filter((term) =>
    withoutClasses.includes(term),
  ).filter(
    (term, index, list) =>
      !list.some(
        (other, j) =>
          j !== index && other.length > term.length && other.includes(term),
      ),
  );
  // 단원: 전체 이름 일치를 우선하고, 없을 때만 한 단원에만 있는 고유 토큰(3글자 이상)으로 찾는다.
  const unitTokens = (unit: string) =>
    unit
      .split(/[\s·,/()\-–—]+|와|과|및/)
      .map(clean)
      .filter((token) => token.length >= 3 && !questionTypes.includes(token));
  const fullUnitMatches = catalog.units.filter((unit) =>
    withoutClasses.includes(clean(unit)),
  );
  const tokenOwners = new Map<string, number>();
  for (const unit of catalog.units) {
    for (const token of new Set(unitTokens(unit)))
      tokenOwners.set(token, (tokenOwners.get(token) ?? 0) + 1);
  }
  const units =
    fullUnitMatches.length > 0
      ? fullUnitMatches
      : catalog.units.filter((unit) =>
          unitTokens(unit).some(
            (token) =>
              tokenOwners.get(token) === 1 && withoutClasses.includes(token),
          ),
        );
  // 과목(국어·수학·영어 등): 카탈로그 반의 과목명이 질문에 있으면 그 과목 자료로 좁힌다.
  const subjects = [
    ...new Set(
      catalog.classes
        .map((klass) => klass.subject)
        .filter((v): v is string => Boolean(v)),
    ),
  ].filter((subject) => withoutClasses.includes(clean(subject)));
  const percents = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) =>
    Number(m[1]),
  );

  let topics = selectTopics(compact, config);
  const makeupClassContext =
    test(/보충/g, normalized) &&
    (dates.length > 0 ||
      relativeDay !== null ||
      relativeWeek !== null ||
      test(
        /언제|몇\s*시|요일|수업\s*(있|없|해|하)|쉬|휴강|빠지|빠졌|못\s*(가|갔)|결석|보충\s*수업|날짜/g,
        normalized,
      ));
  if (
    makeupClassContext &&
    !topics.some(
      (topic) => topic.id === 'makeup' || topic.id === 'schedule_change',
    )
  ) {
    const makeup = config.topics.find((topic) => topic.id === 'makeup');
    if (makeup) topics = [...topics, makeup];
  }
  // "수업 있어요/해요"는 날짜·행사 단서가 있을 때만 휴강 질문으로 본다("한 번에 몇 분 수업해요?"는 수업 정보).
  const changeTopic = topics.find((topic) => topic.id === 'schedule_change');
  if (changeTopic) {
    const matchedTerms = changeTopic.terms.filter((term) =>
      compact.includes(compactText(term)),
    );
    const verbOnly = matchedTerms.every((term) => /^수업/.test(term));
    const dateAnchor =
      dates.length > 0 ||
      relativeDay !== null ||
      relativeWeek !== null ||
      months.length > 0 ||
      /수능|명절|방학|연휴|공휴일|설날|추석|크리스마스|성탄|어린이날|기념일|휴일|시험\s*기간|기말|중간고사|[월화수목금토일]요일|주말/.test(
        normalized,
      );
    if (verbOnly && !dateAnchor)
      topics = topics.filter((topic) => topic !== changeTopic);
  }
  const policyWords = test(
    /규정|기준|받을\s*수|신청|무조건|횟수|조건|어떻게|되나요|돼요|가능한가|가능해요/g,
    normalized,
  );
  const scheduleWords =
    dates.length > 0 ||
    relativeWeek !== null ||
    relativeDay !== null ||
    test(/일정|언제|날짜|몇\s*시|잡혔|예정|있어요|있나요/g, normalized);
  const makeupSchedule =
    topics.some((topic) => topic.id === 'makeup') &&
    scheduleWords &&
    !policyWords;
  if (makeupSchedule) {
    const change = config.topics.find(
      (topic) => topic.id === 'schedule_change',
    );
    topics = topics.filter(
      (topic) => topic.id !== 'makeup' && topic.id !== 'schedule',
    );
    if (change && !topics.includes(change)) topics.push(change);
  }
  if (topics.some((topic) => topic.id === 'schedule_change')) {
    topics = topics.filter(
      (topic) => topic.id !== 'schedule' || test(/시간표|요일/g, normalized),
    );
  }

  const distinctStudentRefs =
    unique(matchedStudentIds).length + unauthorizedStudentRefs.length;
  const selfReference =
    test(/(^|\s)(내|제|나의|저의)\s/g, normalized) ||
    test(/(우리|내|제)\s*(아이|애|자녀|딸|아들)/g, normalized);

  const flags: QueryFlags = {
    crossTenant: matchAcademies(normalized, catalog),
    bulkStudent:
      test(/(모든|전체|전부|모두의)\s*(학생|원생|아이|회원)/g, normalized) ||
      test(
        /(학생|원생)\s*(명단|목록|리스트|전원|연락처|전화번호)/g,
        normalized,
      ) ||
      test(/(전체|모든|전부)\s*(명단|목록|리스트)/g, normalized) ||
      test(
        /(애들|아이들|학생들|원생들|친구들)\s*(전체|명단|목록|리스트|연락처)/g,
        normalized,
      ) ||
      test(
        /다른\s*(애들|아이들|학생|원생|친구|사람)\S*\s*(점수|성적|정답률|결과|명단|연락처|리포트)/g,
        normalized,
      ) ||
      test(/순위|등수|석차|몇\s*등(?!급)/g, normalized),
    shareOrPermission:
      test(
        /(아무나|누구나|외부인?|모두가)\s*(열|볼|보|접근|다운)/g,
        normalized,
      ) ||
      test(/링크.{0,10}(공유|공개)/g, normalized) ||
      test(/공개\s*(링크|설정|로)/g, normalized) ||
      test(/권한.{0,8}(바꿔|변경|부여|올려)/g, normalized) ||
      test(/(관리자|admin)\s*(권한|로)/g, normalized),
    sessionChange: test(
      /(선택(한|된)|현재|조회)\s*(학생|아이|대상).{0,12}(바꿔|변경|전환)/g,
      normalized,
    ),
    citationForgery:
      test(/(source|document|fact|chunk)_?id\s*[=:]/g, normalized) ||
      test(/근거\s*없이/g, normalized),
    documentIdReference: test(/(?<![a-z0-9])d_[a-z0-9_]+/g, normalized),
    injectionDirective:
      test(/(명령|지시|지침)\s*(대로|을\s*따라|에\s*따라)/g, normalized) ||
      test(/무시하고|ignore\s+(all|previous)/g, normalized),
    misattribution:
      distinctStudentRefs + (selfReference ? 1 : 0) >= 2 &&
      (test(/(성적|점수|결과|정답률)\s*(으로|처럼)/g, normalized) ||
        test(/인\s*것처럼|라고\s*(답|해)/g, normalized)),
    causal: test(
      /원인|이유|때문|(^|\s)왜(\s|$)|탓|(해서|라서|어서)\s*그런\s*(건가|거|걸까)/g,
      normalized,
    ),
    attitude: test(
      /집중력|집중(을|이|도)?\s*(안|못)|태도|성실|의지|산만|게으|성격|공부\s*안\s*하|딴짓|노력(을|이)?\s*(안|부족)/g,
      normalized,
    ),
    prediction:
      test(
        /받을까|나올까|오를까|떨어질까|예상|예측|전망|붙을까|갈\s*수\s*있을까|(점수|등급|성적)[^?]{0,8}될까/g,
        normalized,
      ) && !test(/(하면|시키면|해야|봐야)\s*될까/g, normalized),
    compare: test(
      /비교(?!급)|차이|같나요|같아|같은가|다른가|다르나|보다|비싸|싼가|싸요|저렴|더\s*(높|낮|많|적)/g,
      normalized,
    ),
    trend: test(
      /좋아졌|나아졌|향상|올랐|늘었|나빠졌|떨어졌|낮아졌|높아졌|달라졌|변했|변화|추이/g,
      normalized,
    ),
    cumulative: CUMULATIVE_TERMS.some((term) => compact.includes(term)),
    previousRevision:
      test(/(개정|변경|인상|인하|바뀌기)\s*전/g, normalized) ||
      test(
        /이전\s*(가격|요금|수강료|시간표)|예전|원래|전에는|종전/g,
        normalized,
      ),
    generationRequest:
      test(
        /학습\s*방향|공부\s*방향|방향으로|방향\s*(좀|을|잡)|공부\s*방법|보완|조언|어떻게\s*(하면|공부|해야)|공부\s*(하면|시키면|해야)\s*(좋|될|할)|뭘\s*(더\s*)?(해야|공부)|서술형\s*상담|자세(한|히)|생성해|상담해/g,
        normalized,
      ) ||
      // "보충"은 날짜·요일·수업 일정 맥락이면 보충 수업(보강), 아니면 보충 학습(학습 상담)
      (test(/보충/g, normalized) && !makeupClassContext),
    countLimit: test(/\d+\s*(번|회)|횟수|몇\s*번|한도|제한/g, normalized),
    unconditional: test(
      /무조건|자동으로|자동\s*승인|항상|반드시|언제나/g,
      normalized,
    ),
    weakUnit: test(/취약|약한|약점|부족한|못하는/g, normalized),
    elliptical: test(/^(그럼|그러면|그리고|그건|그거)(\s|$)/g, normalized),
    unitDimension:
      test(/(두|여러|각|모든)\s*단원/g, normalized) || units.length >= 2,
    typeDimension: test(/유형/g, normalized) || questionTypes.length > 0,
    makeupSchedule,
    cancelSchedule: test(
      /휴강|휴원|쉬|수업\s*(하나요|있나요|있어요|해요|하는지|없)/g,
      normalized,
    ),
  };

  return {
    normalized,
    compact,
    studentCodes,
    matchedStudentIds: unique(matchedStudentIds),
    unauthorizedStudentRefs: unique(unauthorizedStudentRefs),
    unresolvedRelationWords,
    selfReference,
    groupReference: test(
      /두\s*(아이|애|명|자녀)|둘\s*다|아이들|애들|형제|남매|자매/g,
      normalized,
    ),
    anaphora: test(
      /그\s*(아이|애|학생|친구)|걔|그때\s*말한|아까\s*말한/g,
      normalized,
    ),
    classIds: positive,
    negatedClassIds: negated,
    explicitDates: dates,
    relativeDay,
    relativeWeek,
    months,
    relativePeriod,
    futureCue: test(
      /내년|다음\s*(달|학기|해)|담달|(\d{1,2})\s*월\s*부터|오른다|오르나|오른대|인상|바뀐다|바뀌나요|바뀐대|달라지/g,
      normalized,
    ),
    units,
    questionTypes,
    subjects,
    topics,
    unknownPrograms,
    amountsKrw: parseAmounts(withoutDates),
    percents,
    hasAnalysisTerms:
      ANALYSIS_TERMS.some((term) => compact.includes(term)) ||
      units.length > 0 ||
      questionTypes.length > 0,
    flags,
  };
}
