/**
 * 색인 전 문서/사실 검증.
 * - 필수 메타데이터·유효 기간·대상 학생 결합 검사
 * - 사실이 같은 문서·revision·학원·학생에 묶였는지 검사(귀속 오류 방지)
 * - 문서 안의 지시문(프롬프트 인젝션) 의심 표시 → 관리자 검수 대상, 생성 입력에서 제외
 */
import { createHash } from 'node:crypto';

import { normalizeText } from '../text/normalize.ts';
import { parseInstant, parseOptionalInstant } from '../text/time.ts';
import type { ApprovedFactInput, SourceDocumentInput } from '../types.ts';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

const INJECTION_PATTERNS = [
  /(시스템|system)\s*(지시|프롬프트|prompt|instruction)/i,
  /(이전|위의?|모든)\s*(지시|명령|규칙).{0,10}(무시|따르지)/,
  /무시하고/,
  /ignore\s+(all|any|previous|the\s+above)/i,
  /(출력|공개|노출)\s*(하라|해라|할\s*것)/,
  /(학생|원생)\s*(명단|목록).{0,10}(출력|공개|답변)/,
];

export function isSuspiciousInstruction(text: string): boolean {
  const normalized = normalizeText(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function contentHash(
  document: SourceDocumentInput,
  facts: ApprovedFactInput[],
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      document: { ...document, sourceId: document.sourceId ?? null },
      facts: [...facts].sort((a, b) => a.factId.localeCompare(b.factId)),
    }),
  );
  return hash.digest('hex');
}

export type ValidationResult = { ok: true } | { ok: false; problems: string[] };

export function validateDocument(
  document: SourceDocumentInput,
  facts: ApprovedFactInput[],
  options: { maxDocumentChars: number },
): ValidationResult {
  const problems: string[] = [];
  const check = (condition: boolean, problem: string) => {
    if (!condition) problems.push(problem);
  };

  check(ID_PATTERN.test(document.academyId), 'academyId');
  check(ID_PATTERN.test(document.documentId), 'documentId');
  check(
    Number.isInteger(document.revision) && document.revision > 0,
    'revision',
  );
  check(
    document.title.trim().length > 0 && document.title.length <= 300,
    'title',
  );
  check(document.text.length <= options.maxDocumentChars, 'text_too_long');
  check(document.text.trim().length > 0, 'text_empty');
  if (document.sourceId !== undefined)
    check(ID_PATTERN.test(document.sourceId), 'sourceId');

  let validFrom: number | null = null;
  let validTo: number | null = null;
  try {
    validFrom = parseInstant(document.validFrom);
    validTo = parseOptionalInstant(document.validTo);
  } catch {
    problems.push('valid_interval_format');
  }
  if (validFrom !== null && validTo !== null)
    check(validTo > validFrom, 'valid_interval_order');

  const isStudentDocument =
    document.documentType === 'student_analysis' ||
    document.visibility === 'student_private';
  if (isStudentDocument) {
    check(Boolean(document.studentId), 'student_document_requires_studentId');
    check(
      document.visibility === 'student_private',
      'student_document_must_be_private',
    );
  }
  if (document.visibility === 'class_members')
    check(Boolean(document.classId), 'class_document_requires_classId');

  const sourceId =
    document.sourceId ?? `${document.documentId}:r${document.revision}:body`;
  const seen = new Set<string>();
  for (const fact of facts) {
    const label = `fact:${fact.factId}`;
    check(ID_PATTERN.test(fact.factId), `${label}:factId`);
    check(!seen.has(fact.factId), `${label}:duplicate`);
    seen.add(fact.factId);
    check(fact.documentId === document.documentId, `${label}:documentId`);
    check(fact.revision === document.revision, `${label}:revision`);
    check(fact.academyId === document.academyId, `${label}:academyId`);
    check(fact.sourceId === sourceId, `${label}:sourceId`);
    if (fact.subjectType === 'student') {
      check(fact.subjectId === document.studentId, `${label}:student_binding`);
    }
    if (fact.subjectType === 'academy') {
      check(fact.subjectId === document.academyId, `${label}:academy_binding`);
    }
    if (fact.value.kind === 'accuracy') {
      const { correct, total } = fact.value;
      check(
        Number.isInteger(correct) &&
          Number.isInteger(total) &&
          total > 0 &&
          correct >= 0 &&
          correct <= total,
        `${label}:accuracy_range`,
      );
      check(
        fact.period !== null && /^\d{4}-\d{2}$/.test(fact.period ?? ''),
        `${label}:period`,
      );
    }
    if (fact.value.kind === 'money') {
      check(
        Number.isFinite(fact.value.amount) && fact.value.amount >= 0,
        `${label}:amount`,
      );
    }
    try {
      const from = parseInstant(fact.validFrom);
      const to = parseOptionalInstant(fact.validTo);
      if (to !== null) check(to > from, `${label}:valid_interval_order`);
    } catch {
      problems.push(`${label}:valid_interval_format`);
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
