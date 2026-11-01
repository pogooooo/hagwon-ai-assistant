/**
 * 규칙 기반 질의 해석(생성 API 호출 없음).
 *
 * 질문에 들어 있는 학생·반·단원·기간·숫자·부정/비교 연산자(Evidence Anchors)를
 * 지우거나 바꾸지 않고 구조화한다. 해석이 애매하면 더 좁은 범위나 확인 질문을 택하도록
 * 플래그만 세우고, 최종 판단은 서비스 계층이 한다.
 */
import {
  ANALYSIS_TERMS,
  RELATION_WORDS,
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
  previousRevision: boolean;
  generationRequest: boolean;
  countLimit: boolean;
  unconditional: boolean;
  weakUnit: boolean;
  elliptical: boolean;
  unitDimension: boolean;
}

export interface QueryFrame {
  normalized: string;
  compact: string;
  /** 질문에 등장한 학생 코드(정규화된 대문자, 예: A01) */
  studentCodes: string[];
  /** 서버가 내려준 허용 학생 별칭으로 해석된 학생 ID */
  matchedStudentIds: string[];
  /** 허용 별칭으로 해석되지 않은 학생 코드(권한 밖이거나 존재하지 않음 — 구분하지 않는다) */
  unauthorizedStudentCodes: string[];
  /** 서버 별칭이 없는 형제 지시어(첫째/둘째 등) */
  unresolvedRelationWords: string[];
  selfReference: boolean;
  groupReference: boolean;
  anaphora: boolean;
  classIds: string[];
  negatedClassIds: string[];
  explicitDates: ExplicitDate[];
  months: number[];
  relativePeriod: 'last_month' | 'this_month' | null;
  units: string[];
  topics: TopicDefinition[];
  amountsKrw: number[];
  percents: number[];
  hasAnalysisTerms: boolean;
  flags: QueryFlags;
}

const SELF_WORDS = new Set(['우리', '저희', '본', '이', '해당', '제', '내']);

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

function matchClasses(compact: string, catalog: AcademyCatalog) {
  const grades = unique(
    [...compact.matchAll(/(초|중|고)[1-6]/g)].map((m) => m[0]),
  );
  const positive: string[] = [];
  const negated: string[] = [];
  for (const klass of catalog.classes) {
    const name = compactText(klass.name);
    const grade = name.match(/^(초|중|고)[1-6]/)?.[0] ?? null;
    const core = name.replace(/^(초|중|고)[1-6]/, '').replace(/반$/, '');
    if (grade && grades.length > 0 && !grades.includes(grade)) continue;
    const keywords = unique(
      [core, ...klass.aliases.map(compactText)].filter((k) => k.length >= 2),
    );
    let isPositive = false;
    let isNegated = false;
    for (const keyword of keywords) {
      let index = compact.indexOf(keyword);
      while (index !== -1) {
        const after = compact.slice(index + keyword.length).replace(/^반/, '');
        if (/^(이|가|은|는)?(아닌|아니고|말고|제외|빼고)/.test(after)) {
          isNegated = true;
        } else {
          isPositive = true;
        }
        index = compact.indexOf(keyword, index + keyword.length);
      }
    }
    if (isNegated) negated.push(klass.classId);
    else if (isPositive) positive.push(klass.classId);
  }
  return { positive, negated };
}

function matchAcademies(normalized: string, catalog: AcademyCatalog): boolean {
  const own = new Set(
    [catalog.displayName, ...catalog.aliases].map((name) =>
      compactText(name).replace(/학원$/, ''),
    ),
  );
  for (const match of normalized.matchAll(/([0-9a-z가-힣]+)\s*학원/g)) {
    const prefix = match[1];
    if (SELF_WORDS.has(prefix)) continue;
    if (!own.has(prefix)) return true;
  }
  return false;
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

  // 학생 코드와 서버 별칭
  const codePattern = new RegExp(config.studentCodePattern.source, 'g');
  const studentCodes = unique(
    [...normalized.matchAll(codePattern)].map((match) =>
      match[1].toUpperCase(),
    ),
  );
  const matchedStudentIds: string[] = [];
  const unauthorizedStudentCodes: string[] = [];
  for (const code of studentCodes) {
    const owner = access.studentRefs.find((ref) =>
      ref.aliases.some((alias) => {
        const a = alias.toUpperCase();
        return a === code || a === `ST_${code}`;
      }),
    );
    if (owner) matchedStudentIds.push(owner.studentId);
    else unauthorizedStudentCodes.push(code);
  }
  const unresolvedRelationWords: string[] = [];
  for (const word of RELATION_WORDS) {
    if (!compact.includes(word)) continue;
    const owner = access.studentRefs.find((ref) => ref.aliases.includes(word));
    if (owner) matchedStudentIds.push(owner.studentId);
    else unresolvedRelationWords.push(word);
  }

  const { dates, rest: withoutDates } = parseDates(normalized);
  const months = unique(
    [...withoutDates.matchAll(/(\d{1,2})\s*월/g)]
      .map((match) => Number(match[1]))
      .filter((month) => month >= 1 && month <= 12),
  );
  const relativePeriod = test(/지난\s*달|저번\s*달|전월/g, normalized)
    ? 'last_month'
    : test(/이번\s*달|이달|금월/g, normalized)
      ? 'this_month'
      : null;

  const units = catalog.units.filter((unit) =>
    compact.includes(compactText(unit)),
  );
  const topics = config.topics.filter((topic) =>
    topic.terms.some((term) => compact.includes(compactText(term))),
  );
  const { positive, negated } = matchClasses(compact, catalog);
  const percents = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) =>
    Number(m[1]),
  );

  const distinctStudentRefs =
    unique(matchedStudentIds).length + unauthorizedStudentCodes.length;
  const selfReference =
    test(/(^|\s)(내|제|나의|저의)\s/g, normalized) ||
    test(/(우리|내|제)\s*(아이|애|자녀|딸|아들)/g, normalized);

  const flags: QueryFlags = {
    crossTenant: matchAcademies(normalized, catalog),
    bulkStudent:
      test(/(모든|전체|전부|모두의)\s*(학생|원생|아이|회원)/g, normalized) ||
      test(/(학생|원생)\s*(명단|목록|리스트|전원)/g, normalized),
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
    causal: test(/원인|이유|때문|(^|\s)왜(\s|$)/g, normalized),
    attitude: test(/집중력|태도|성실|의지|산만|게으|성격/g, normalized),
    prediction: test(
      /받을까|될까|나올까|오를까|떨어질까|예상|예측|전망/g,
      normalized,
    ),
    compare: test(
      /비교|차이|같나요|같아|같은가|다른가|다르나|보다|비싸|싼가|싸요|저렴|더\s*(높|낮|많|적)/g,
      normalized,
    ),
    trend: test(
      /좋아졌|나아졌|향상|올랐|늘었|나빠졌|떨어졌|낮아졌|높아졌|달라졌|변했|변화/g,
      normalized,
    ),
    previousRevision:
      test(/(개정|변경|인상|인하|바뀌기)\s*전/g, normalized) ||
      test(
        /이전\s*(가격|요금|수강료|시간표)|예전|원래|전에는|종전/g,
        normalized,
      ),
    generationRequest: test(
      /학습\s*방향|공부\s*방법|보완|보충|조언|어떻게\s*(하면|공부|해야)|서술형|자세(한|히)|생성해|상담해/g,
      normalized,
    ),
    countLimit: test(/\d+\s*(번|회)|횟수|몇\s*번|한도|제한/g, normalized),
    unconditional: test(
      /무조건|자동으로|자동\s*승인|항상|반드시|언제나/g,
      normalized,
    ),
    weakUnit: test(/취약|약한|부족한|못하는/g, normalized),
    elliptical: test(/^(그럼|그러면|그리고|그건|그거)(\s|$)/g, normalized),
    unitDimension:
      test(/(두|여러|각|모든)\s*단원/g, normalized) || units.length >= 2,
  };

  return {
    normalized,
    compact,
    studentCodes,
    matchedStudentIds: unique(matchedStudentIds),
    unauthorizedStudentCodes,
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
    classIds: positive.filter((id) => !negated.includes(id)),
    negatedClassIds: negated,
    explicitDates: dates,
    months,
    relativePeriod,
    units,
    topics,
    amountsKrw: parseAmounts(withoutDates),
    percents,
    hasAnalysisTerms:
      ANALYSIS_TERMS.some((term) => compact.includes(term)) || units.length > 0,
    flags,
  };
}
