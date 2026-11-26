/**
 * 문서 안 개인정보 가림(색인 전). 원본 파일은 자료 관리 기능이 보관하고, RAG 색인·답변에는 가린 텍스트만 쓴다.
 * - 주민등록번호, 개인 휴대전화 번호(01X), 외국인등록번호 형식은 항상 가린다.
 * - 학원 대표번호(지역번호·1588 등)와 이메일·계좌번호는 공개 안내에 필요하므로 그대로 둔다.
 */
const PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'resident_id', pattern: /(?<!\d)\d{6}\s?-\s?[1-8]\d{6}(?!\d)/g },
  {
    kind: 'mobile',
    pattern: /(?<![\d-])01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?![\d-])/g,
  },
];

export const PII_MASK = '[개인정보 가림]';

export function maskPersonalData(text: string): {
  text: string;
  masked: Record<string, number>;
} {
  const masked: Record<string, number> = {};
  let out = text;
  for (const { kind, pattern } of PATTERNS) {
    out = out.replace(pattern, () => {
      masked[kind] = (masked[kind] ?? 0) + 1;
      return PII_MASK;
    });
  }
  return { text: out, masked };
}
