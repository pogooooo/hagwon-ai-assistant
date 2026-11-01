/**
 * 한국어 질의·문서 정규화와 검색용 토큰화(P0 기준선).
 * 형태소 분석기(Kiwi 등)는 P1 비교 대상이며, 여기서는 의존성 없이
 * 단어 토큰 + 한글 2-gram 으로 조사 변형("수강료는"/"수강료")을 흡수한다.
 */

const GRADE_RULES: Array<[RegExp, string]> = [
  [/(초|중|고)등학교\s*([1-6])\s*학년/g, '$1$2'],
  [/(초|중|고)학교\s*([1-6])\s*학년/g, '$1$2'],
  [/(초|중|고)등\s*([1-6])(?:\s*학년)?/g, '$1$2'],
  [/(초|중|고)\s*([1-6])\s*학년/g, '$1$2'],
];

export function normalizeText(input: string): string {
  let text = input.normalize('NFKC').toLowerCase();
  text = text.replace(/[\u200b-\u200d\ufeff]/g, '');
  for (const [pattern, replacement] of GRADE_RULES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** 공백 제거 형태(“중2 심화반” ↔ “중2심화반” 비교용). */
export function compactText(input: string): string {
  return normalizeText(input).replace(/\s+/g, '');
}

const HANGUL = /[가-힣]/;

export function tokenize(input: string): string[] {
  const words = normalizeText(input)
    .split(/[^0-9a-z가-힣]+/)
    .filter(Boolean);
  const tokens: string[] = [];
  for (const word of words) {
    tokens.push(word);
    if (HANGUL.test(word) && word.length >= 2) {
      for (let i = 0; i < word.length - 1; i += 1) {
        tokens.push(`§${word.slice(i, i + 2)}`);
      }
    }
  }
  return tokens;
}

/** 문장 단위 분리(마침표·물음표·줄바꿈 기준). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * "등록된 자료에 없습니다"처럼 '자료가 없다'는 문장은 답이 아니다.
 * ("주차장 없음"처럼 사실 자체가 부정인 문장과 구분한다.)
 */
const DATA_ABSENCE_PATTERNS = [
  /자료에\s*(는\s*)?없/,
  /규정에\s*(는\s*)?없/,
  /안내되어\s*있지\s*않/,
  /확인되지\s*않/,
  /정해지지\s*않/,
  /명시되어\s*있지\s*않/,
  /등록되어\s*있지\s*않/,
];

export function isDataAbsenceStatement(sentence: string): boolean {
  const normalized = normalizeText(sentence);
  return DATA_ABSENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function containsAny(
  haystack: string,
  needles: readonly string[],
): boolean {
  const compact = compactText(haystack);
  return needles.some((needle) => compact.includes(compactText(needle)));
}
