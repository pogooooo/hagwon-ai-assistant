import { z } from 'zod';

export const subjects = ['KOR', 'ENG', 'MATH'] as const;
export const subjectNames = { KOR: '국어', ENG: '영어', MATH: '수학' };
export const outcomes = [
  'correct',
  'incorrect',
  'partial',
  'blank',
  'ungradable',
  'excluded',
] as const;
export const outcomeNames = {
  correct: '정답',
  incorrect: '오답',
  partial: '부분 정답',
  blank: '미응답',
  ungradable: '판독·채점 불가',
  excluded: '평가 제외',
};
export const answerTypes = [
  'choice_single',
  'choice_multiple',
  'text_exact',
  'numeric',
  'symbolic',
  'text_semantic',
  'structured_work',
  'essay',
] as const;
export const observationCodes = [
  'SPELLING_NOT_MET',
  'INFLECTION_NOT_MET',
  'REQUIRED_FORM_NOT_MET',
  'UNIT_NOT_MET',
  'NEGATION_REVERSED',
  'CAUSAL_DIRECTION_REVERSED',
  'EVIDENCE_NOT_MET',
  'CORE_CONCEPT_NOT_MET',
  'MISSING_FINAL_ANSWER',
  'OTHER_TEACHER_CONFIRMED',
] as const;
export const reasons = [
  'NO_KEY',
  'UNREADABLE',
  'ASSOCIATION_AMBIGUOUS',
  'UNSUPPORTED',
  'PROVIDER_UNAVAILABLE',
  'PROBLEM_UNRESOLVED',
  'TEACHER_EXCLUDED',
] as const;
export const decimal = z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,4})?$/);
export const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,95}$/);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v + 'T00:00:00Z')) &&
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
  );
export const normalizationSchema = z
  .object({
    unicode_form: z.enum(['NFC', 'NFKC']).default('NFC'),
    trim_outer_space: z.boolean().default(true),
    collapse_inner_space: z.boolean().default(false),
    case_sensitive: z.boolean().default(true),
  })
  .strict();
export const criterionSchema = z
  .object({
    criterion_id: id,
    label: z.string().min(1).max(200),
    max_score: decimal,
    allowed_scores: z.array(decimal).min(1).max(100),
    criterion_type: z.enum([
      'choice',
      'exact_text',
      'numeric',
      'symbolic',
      'concept',
      'evidence',
      'reasoning',
      'language',
      'format',
    ]),
    teacher_instruction: z.string().min(1).max(3000),
  })
  .strict();
export const keySchema = z
  .object({
    key_id: id,
    key_version: z.string().min(1).max(80),
    source: z.enum(['teacher_registered', 'licensed_bank', 'ai_candidate']),
    approval_status: z.enum(['pending', 'approved']),
    rights_ref: id,
    accepted_choice_sets: z
      .array(z.array(z.string().min(1).max(30)).min(1).max(50))
      .max(50)
      .default([]),
    accepted_texts: z.array(z.string().min(1).max(12000)).max(200).default([]),
    numeric_target: z.string().min(1).max(500).nullable().default(null),
    absolute_tolerance: decimal.default('0'),
    relative_tolerance: decimal.default('0'),
    accepted_units: z.array(z.string().min(1).max(50)).max(30).default([]),
    unit_conversion_allowed: z.boolean().default(false),
    required_form: z
      .enum(['integer', 'decimal', 'fraction', 'reduced_fraction'])
      .nullable()
      .default(null),
    normalization: normalizationSchema.default({
      unicode_form: 'NFC',
      trim_outer_space: true,
      collapse_inner_space: false,
      case_sensitive: true,
    }),
  })
  .strict();
export const itemSchema = z
  .object({
    grading_mode: z.literal('photo_solution').optional(),
    item_ref: id,
    item_no: z.string().min(1).max(40),
    subject_id: z.enum(subjects),
    answer_type: z.enum(answerTypes),
    primary_skill_id: id,
    skill_label: z.string().min(1).max(120),
    taxonomy_version: z.string().min(1).max(80),
    max_score: decimal,
    expected_page_no: z.number().int().min(1).max(20),
    key: keySchema.nullable(),
    rubric_id: id,
    rubric_version: z.string().min(1).max(80),
    criteria: z.array(criterionSchema).min(1).max(24),
    approval_status: z.enum(['pending', 'approved']),
    aggregation_rule: z.enum(['sum_criteria', 'all_or_zero', 'teacher_only']),
  })
  .strict();
export const assignmentSchema = z
  .object({
    title: z.string().min(1).max(200),
    class_id: z.string().min(1).max(100),
    rights_ref: id,
    scope: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('workbook'),
            subject: z.enum(subjects),
            skill: z.string().min(1).max(120),
            from: z.number().int().min(1).max(9999),
            to: z.number().int().min(1).max(9999),
          })
          .strict(),
        z
          .object({
            kind: z.literal('worksheet'),
            subject: z.enum(subjects),
            skill: z.string().min(1).max(120),
          })
          .strict(),
      ])
      .optional(),
    items: z.array(itemSchema).max(500),
  })
  .strict();
export const regionSchema = z
  .object({
    page_no: z.number().int().min(1).max(20),
    // Coordinates are normalized to [0,1], relative to the submitted page.
    bbox: z.tuple([
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
    ]),
  })
  .strict()
  .refine((v) => v.bbox[2] > v.bbox[0] && v.bbox[3] > v.bbox[1]);
export const readingSchema = z
  .object({
    item_ref: id,
    answer_observed: z.string().max(12000),
    unit_observed: z.string().max(50).default(''),
    answer_status: z.enum(['readable', 'blank', 'unreadable', 'ambiguous']),
    association_status: z.enum(['matched', 'ambiguous', 'missing']),
    regions: z.array(regionSchema).max(20),
    ambiguity_codes: z.array(z.string().max(60)).max(15).default([]),
    printed_calculation: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const extractionSchema = z
  .object({ items: z.array(readingSchema).max(500) })
  .strict();
export const scoreSchema = z
  .object({ criterion_id: id, score: decimal.nullable(), max_score: decimal })
  .strict();
export const retainedItemSchema = z
  .object({
    item_ref: id,
    subject_id: z.enum(subjects),
    answer_type: z.enum(answerTypes),
    primary_skill_id: id,
    taxonomy_version: z.string().min(1).max(80),
    rubric_id: id.nullable(),
    rubric_version: z.string().min(1).max(80).nullable(),
    key_id: id.nullable(),
    key_version: z.string().min(1).max(80).nullable(),
    grading_rule_version: z.literal('axr-grading-3.0'),
    outcome: z.enum(outcomes),
    score: decimal.nullable(),
    max_score: decimal,
    criteria_scores: z.array(scoreSchema).max(24),
    criteria_collection_state: z.enum(['disabled', 'not_assessed', 'assessed']),
    observed_error_codes: z.array(z.enum(observationCodes)).max(12),
    error_annotation_state: z.enum(['disabled', 'not_assessed', 'assessed']),
    review_status: z.literal('confirmed'),
    exclusion_reason: z.enum(reasons).nullable(),
  })
  .strict();
export type Subject = (typeof subjects)[number];
export type Outcome = (typeof outcomes)[number];
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Key = z.infer<typeof keySchema>;
export type Reading = z.infer<typeof readingSchema>;
export type RetainedItem = z.infer<typeof retainedItemSchema>;
export type CriterionScore = z.infer<typeof scoreSchema>;
export interface DraftItem {
  extraction: Reading;
  proposed: RetainedItem;
  reviewed: boolean;
  // Temporary teacher-only evidence; the result serializer keeps only proposed.
  solution?: PhotoSolution;
  review_reference?: string;
  initial_proposal?: Pick<RetainedItem, 'outcome' | 'score'>;
}
export const photoSolutionSchema = z
  .object({
    problem: z.string().trim().min(1).max(8000),
    answer: z.string().trim().min(1).max(1200),
    explanation: z.string().trim().min(1).max(1600),
    comparison: z.enum(['number', 'choice', 'rubric']),
  })
  .strict();
export type PhotoSolution = z.infer<typeof photoSolutionSchema>;
export interface Draft {
  submission_id: string;
  draft_revision: number;
  items: DraftItem[];
}
export interface Assignment extends AssignmentInput {
  assignment_id: string;
  assignment_version: number;
  tenant_id: string;
  approved_by: string;
  approved_at: string;
}
export interface Result {
  schema_version: '3.0';
  tenant_id: string;
  student_ref: string;
  assignment_id: string;
  assignment_version: number;
  submission_id: string;
  attempt_no: number;
  result_set_id: string;
  revision: number;
  previous_revision: number | null;
  submitted_at: string;
  confirmed_at: string;
  confirmed_by: string;
  assessment_date: string;
  assessment_date_source: 'teacher_reported' | 'submitted_date';
  raw_scope_id: string;
  raw_generation: number;
  retention_policy_version: string;
  analysis_detail_policy: 'none' | 'criteria' | 'criteria_and_codes';
  items: RetainedItem[];
}
export class GradingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 422) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GradingError('VALIDATION_FAILED');
  return result.data;
}
export function kstDate(at: number) {
  return new Date(at + 9 * 3600000).toISOString().slice(0, 10);
}
