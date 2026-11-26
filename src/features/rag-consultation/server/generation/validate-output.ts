/**
 * 생성 모델 출력 사후 검증. 실패하면 재시도하지 않고 호출자가 템플릿/담당자 연결로 처리한다.
 */
import { z } from 'zod';

import {
  findForbiddenIdentifiers,
  findUnsupportedNumbers,
} from '../answer/verify.ts';

const outputSchema = z.object({
  status: z.enum(['answered', 'partial', 'unknown']),
  answer: z.string().max(1500),
  cited_source_ids: z.array(z.string().max(200)).max(20),
  missing_fields: z.array(z.string().max(100)).max(20).optional(),
});

export type GeneratedOutput = z.infer<typeof outputSchema>;

export type OutputValidation =
  | { ok: true; output: GeneratedOutput }
  | {
      ok: false;
      problem:
        | 'INVALID_JSON'
        | 'SCHEMA'
        | 'UNKNOWN'
        | 'CITATION_UNSUPPORTED'
        | 'NUMBER_UNSUPPORTED'
        | 'FORBIDDEN_IDENTIFIER'
        | 'FORBIDDEN_CLAIM';
    };

/** 관찰 자료로 검증할 수 없는 원인·태도 단정 표현 */
const FORBIDDEN_CLAIMS = /집중력|태도|성실|게으|산만|의지\s*부족|성격|때문에/;

export function validateGeneratedOutput(
  rawText: string,
  options: {
    allowedSourceIds: readonly string[];
    allowedNumbers:
      Set<number> | ((sourceIds: readonly string[]) => Set<number>);
    studentCodePattern: RegExp;
    allowedStudentCodes: readonly string[];
  },
): OutputValidation {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, problem: 'INVALID_JSON' };
  }
  const result = outputSchema.safeParse(parsed);
  if (!result.success) return { ok: false, problem: 'SCHEMA' };
  const output = result.data;
  if (output.status === 'unknown' || output.answer.trim() === '')
    return { ok: false, problem: 'UNKNOWN' };
  if (
    output.cited_source_ids.length === 0 ||
    output.cited_source_ids.some((id) => !options.allowedSourceIds.includes(id))
  ) {
    return { ok: false, problem: 'CITATION_UNSUPPORTED' };
  }
  const allowedNumbers =
    typeof options.allowedNumbers === 'function'
      ? options.allowedNumbers(output.cited_source_ids)
      : options.allowedNumbers;
  if (findUnsupportedNumbers(output.answer, allowedNumbers).length > 0) {
    return { ok: false, problem: 'NUMBER_UNSUPPORTED' };
  }
  if (
    findForbiddenIdentifiers(output.answer, {
      studentCodePattern: options.studentCodePattern,
      allowedCodes: options.allowedStudentCodes,
    }).length > 0
  ) {
    return { ok: false, problem: 'FORBIDDEN_IDENTIFIER' };
  }
  if (FORBIDDEN_CLAIMS.test(output.answer))
    return { ok: false, problem: 'FORBIDDEN_CLAIM' };
  return { ok: true, output };
}
