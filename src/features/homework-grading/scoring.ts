import {
  assignmentSchema,
  GradingError,
  parse,
  retainedItemSchema,
  type AssignmentInput,
  type CriterionScore,
  type Item,
  type Key,
  type Reading,
  type RetainedItem,
} from './contracts.ts';
import {
  decimalString,
  matchesForm,
  multiply,
  numeric,
  points,
  rational,
  within,
} from './arithmetic.ts';

export function validateAssignment(value: unknown): AssignmentInput {
  const a = parse(assignmentSchema, value);
  if (
    new Set(a.items.map((i) => i.item_ref)).size !== a.items.length ||
    new Set(a.items.map((i) => i.item_no)).size !== a.items.length
  )
    throw new GradingError('DUPLICATE_ITEM');
  for (const item of a.items) {
    if (
      item.grading_mode === 'photo_solution' &&
      (item.key || item.aggregation_rule === 'teacher_only')
    )
      throw new GradingError('INVALID_RUBRIC');
    if (
      points(item.max_score) <= 0n ||
      new Set(item.criteria.map((c) => c.criterion_id)).size !==
        item.criteria.length
    )
      throw new GradingError('INVALID_RUBRIC');
    if (item.key?.rights_ref !== a.rights_ref && item.key !== null)
      throw new GradingError('RIGHTS_REFERENCE_MISMATCH');
    const total = item.criteria.reduce((sum, c) => {
      const max = points(c.max_score);
      if (
        max <= 0n ||
        !c.allowed_scores.some((s) => points(s) === 0n) ||
        !c.allowed_scores.some((s) => points(s) === max) ||
        c.allowed_scores.some((s) => points(s) > max) ||
        new Set(c.allowed_scores.map((s) => points(s).toString())).size !==
          c.allowed_scores.length
      )
        throw new GradingError('INVALID_RUBRIC');
      return sum + max;
    }, 0n);
    if (
      item.aggregation_rule === 'sum_criteria' &&
      total !== points(item.max_score)
    )
      throw new GradingError('INVALID_RUBRIC');
    if (
      item.key?.numeric_target !== null &&
      item.key?.numeric_target !== undefined
    )
      numeric(item.key.numeric_target);
    if (
      item.key &&
      !item.key.accepted_texts.length &&
      !item.key.accepted_choice_sets.length &&
      item.key.numeric_target === null &&
      !['text_semantic', 'structured_work', 'essay'].includes(item.answer_type)
    )
      throw new GradingError('EMPTY_KEY');
  }
  return a;
}

export function emptyResult(
  item: Item,
  reason: RetainedItem['exclusion_reason'] = 'UNREADABLE',
): RetainedItem {
  return {
    item_ref: item.item_ref,
    subject_id: item.subject_id,
    answer_type: item.answer_type,
    primary_skill_id: item.primary_skill_id,
    taxonomy_version: item.taxonomy_version,
    rubric_id: item.approval_status === 'approved' ? item.rubric_id : null,
    rubric_version:
      item.approval_status === 'approved' ? item.rubric_version : null,
    key_id: item.key?.approval_status === 'approved' ? item.key.key_id : null,
    key_version:
      item.key?.approval_status === 'approved' ? item.key.key_version : null,
    grading_rule_version: 'axr-grading-3.0',
    outcome: reason === 'TEACHER_EXCLUDED' ? 'excluded' : 'ungradable',
    score: null,
    max_score: item.max_score,
    criteria_scores: [],
    criteria_collection_state: 'disabled',
    observed_error_codes: [],
    error_annotation_state: 'disabled',
    review_status: 'confirmed',
    exclusion_reason: reason,
  };
}
export function scoreOutcome(
  score: string,
  maximum: string,
): RetainedItem['outcome'] {
  const s = points(score),
    m = points(maximum);
  if (s > m || m <= 0n) throw new GradingError('INVALID_SCORE');
  return s === m ? 'correct' : s === 0n ? 'incorrect' : 'partial';
}
function text(value: string, key: Key) {
  let s = value.normalize(key.normalization.unicode_form);
  if (key.normalization.trim_outer_space) s = s.trim();
  if (key.normalization.collapse_inner_space) s = s.replace(/\s+/g, ' ');
  return key.normalization.case_sensitive ? s : s.toLocaleLowerCase('en');
}
const units: Record<string, [string, bigint, bigint]> = {
  mm: ['length', 1n, 1000n],
  cm: ['length', 1n, 100n],
  m: ['length', 1n, 1n],
  km: ['length', 1000n, 1n],
  g: ['mass', 1n, 1000n],
  kg: ['mass', 1n, 1n],
  mL: ['volume', 1n, 1000n],
  L: ['volume', 1n, 1n],
};
/** Split only an explicitly written, supported unit. Never convert values or infer a missing unit here. */
export function normalizeNumericReading(item: Item, reading: Reading): Reading {
  if (item.answer_type !== 'numeric') return reading;
  const source = reading.answer_observed.trim();
  const unit = Object.keys(units)
    .sort((a, b) => b.length - a.length)
    .find((u) => source.endsWith(u));
  if (!unit) return reading;
  const value = source.slice(0, -unit.length).trim();
  try {
    numeric(value);
  } catch {
    return reading;
  }
  if (reading.unit_observed && reading.unit_observed !== unit)
    return {
      ...reading,
      answer_status: 'ambiguous',
      ambiguity_codes: [
        ...reading.ambiguity_codes,
        'UNIT_TRANSCRIPTION_CONFLICT',
      ],
    };
  return { ...reading, answer_observed: value, unit_observed: unit };
}
function numericMatch(reading: Reading, key: Key) {
  if (key.numeric_target === null) throw new GradingError('NO_KEY');
  let a = numeric(reading.answer_observed);
  const b = numeric(key.numeric_target);
  let unitMatch = key.accepted_units.length
    ? key.accepted_units.includes(reading.unit_observed)
    : reading.unit_observed === '';
  const fromUnit = units[reading.unit_observed],
    toUnit = units[key.accepted_units[0]];
  if (
    !key.unit_conversion_allowed &&
    fromUnit &&
    toUnit &&
    (fromUnit[0] !== toUnit[0] ||
      fromUnit[1] * toUnit[2] !== toUnit[1] * fromUnit[2])
  )
    unitMatch = false;
  if (
    key.unit_conversion_allowed &&
    key.accepted_units.length &&
    reading.unit_observed !== key.accepted_units[0]
  ) {
    const from = units[reading.unit_observed],
      to = units[key.accepted_units[0]];
    if (from && to && from[0] === to[0]) {
      a = multiply(a, rational(from[1] * to[2], from[2] * to[1]));
      unitMatch = true;
    } else unitMatch = false;
  }
  return {
    value: within(a, b, key.absolute_tolerance, key.relative_tolerance),
    format: matchesForm(reading.answer_observed, key.required_form),
    unit: unitMatch,
  };
}
function choice(value: string) {
  const symbols = '①②③④⑤⑥⑦⑧⑨';
  return value
    .normalize('NFC')
    .replace(/[①-⑨]/g, (s) => String(symbols.indexOf(s) + 1))
    .split(/[,·\s]+/)
    .filter(Boolean)
    .sort();
}
export function aggregate(item: Item, scores: CriterionScore[]): RetainedItem {
  if (
    scores.length !== item.criteria.length ||
    new Set(scores.map((s) => s.criterion_id)).size !== scores.length
  )
    throw new GradingError('INVALID_CRITERIA');
  for (const c of item.criteria) {
    const s = scores.find((v) => v.criterion_id === c.criterion_id);
    if (
      !s ||
      s.score === null ||
      points(s.max_score) !== points(c.max_score) ||
      !c.allowed_scores.some((v) => points(v) === points(s.score!))
    )
      throw new GradingError('INVALID_CRITERIA');
  }
  const sum = scores.reduce((n, s) => n + points(s.score!), 0n);
  const score = decimalString(
    item.aggregation_rule === 'all_or_zero'
      ? scores.every((s) => points(s.score!) === points(s.max_score))
        ? points(item.max_score)
        : 0n
      : sum,
  );
  return {
    ...emptyResult(item),
    score,
    outcome: scoreOutcome(score, item.max_score),
    exclusion_reason: null,
    criteria_scores: scores,
    criteria_collection_state: 'assessed',
  };
}
export function propose(item: Item, reading: Reading): RetainedItem {
  if (
    reading.item_ref !== item.item_ref ||
    reading.association_status !== 'matched'
  )
    return emptyResult(item, 'ASSOCIATION_AMBIGUOUS');
  if (
    reading.answer_status === 'unreadable' ||
    reading.answer_status === 'ambiguous' ||
    reading.ambiguity_codes.length
  )
    return emptyResult(item);
  if (!reading.regions.length)
    return emptyResult(item, 'ASSOCIATION_AMBIGUOUS');
  if (
    !item.key ||
    item.key.approval_status !== 'approved' ||
    item.approval_status !== 'approved'
  )
    return emptyResult(item, 'NO_KEY');
  if (reading.answer_status === 'blank') {
    if (reading.answer_observed.trim()) return emptyResult(item);
    return {
      ...emptyResult(item),
      outcome: 'blank',
      score: '0',
      exclusion_reason: null,
      criteria_scores: item.criteria.map((c) => ({
        criterion_id: c.criterion_id,
        score: '0',
        max_score: c.max_score,
      })),
      criteria_collection_state: 'assessed',
    };
  }
  if (!reading.answer_observed.trim()) return emptyResult(item);
  if (item.aggregation_rule === 'teacher_only')
    return emptyResult(item, 'UNSUPPORTED');
  const key = item.key;
  let correct: boolean;
  let format = true;
  let unit = true;
  try {
    if (item.answer_type.startsWith('choice')) {
      const response = choice(reading.answer_observed);
      if (
        !response.length ||
        new Set(response).size !== response.length ||
        (item.answer_type === 'choice_single' && response.length !== 1)
      )
        return emptyResult(item);
      correct = key.accepted_choice_sets.some(
        (set) => JSON.stringify([...set].sort()) === JSON.stringify(response),
      );
    } else if (
      item.answer_type === 'text_exact' ||
      item.answer_type === 'symbolic'
    ) {
      // Symbolic equivalence outside explicitly registered alternatives is not guessed.
      correct = key.accepted_texts.some(
        (expected) =>
          text(expected, key) === text(reading.answer_observed, key),
      );
      if (item.answer_type === 'symbolic' && !correct)
        return emptyResult(item, 'UNSUPPORTED');
    } else if (item.answer_type === 'numeric') {
      const match = numericMatch(reading, key);
      correct = match.value;
      format = match.format;
      unit = match.unit;
    } else return emptyResult(item, 'UNSUPPORTED');
  } catch {
    return emptyResult(item, 'UNSUPPORTED');
  }
  const hasFormat = item.criteria.some((c) => c.criterion_type === 'format');
  if (
    item.criteria.some(
      (c) =>
        !['choice', 'numeric', 'exact_text', 'symbolic', 'format'].includes(
          c.criterion_type,
        ),
    )
  )
    return emptyResult(item, 'UNSUPPORTED');
  return aggregate(
    item,
    item.criteria.map((c) => ({
      criterion_id: c.criterion_id,
      max_score: c.max_score,
      score: (
        c.criterion_type === 'format'
          ? format && unit
          : correct && (hasFormat || (format && unit))
      )
        ? c.max_score
        : '0',
    })),
  );
}
/** Check relationships after strict structural parsing; a valid DTO alone is insufficient. */
export function validateRetained(
  item: Item,
  value: unknown,
  reviewedReference?: string,
): RetainedItem {
  const result = parse(retainedItemSchema, value);
  if (
    result.item_ref !== item.item_ref ||
    result.subject_id !== item.subject_id ||
    result.answer_type !== item.answer_type ||
    points(result.max_score) !== points(item.max_score) ||
    result.primary_skill_id !== item.primary_skill_id ||
    result.taxonomy_version !== item.taxonomy_version
  )
    throw new GradingError('ITEM_REFERENCE_MISMATCH');
  if (
    result.rubric_id !==
      (item.approval_status === 'approved' ? item.rubric_id : null) ||
    result.rubric_version !==
      (item.approval_status === 'approved' ? item.rubric_version : null) ||
    result.key_id !==
      (item.key?.approval_status === 'approved' ? item.key.key_id : null) ||
    result.key_version !==
      (item.key?.approval_status === 'approved' ? item.key.key_version : null)
  )
    throw new GradingError('KEY_VERSION_MISMATCH');
  if (['ungradable', 'excluded'].includes(result.outcome)) {
    if (
      result.score !== null ||
      !result.exclusion_reason ||
      result.criteria_scores.some((c) => c.score !== null)
    )
      throw new GradingError('INVALID_SCORE');
  } else {
    if (
      !(
        item.key?.approval_status === 'approved' ||
        (item.grading_mode === 'photo_solution' && reviewedReference?.trim())
      ) ||
      item.approval_status !== 'approved'
    )
      throw new GradingError('KEY_OR_RUBRIC_PENDING');
    if (
      result.score === null ||
      result.exclusion_reason !== null ||
      (result.outcome === 'blank' && points(result.score) !== 0n) ||
      (result.outcome !== 'blank' &&
        result.outcome !== scoreOutcome(result.score, item.max_score))
    )
      throw new GradingError('INVALID_SCORE');
    if (result.criteria_scores.length) {
      const validated = aggregate(item, result.criteria_scores);
      if (points(validated.score!) !== points(result.score))
        throw new GradingError('INVALID_CRITERIA');
    }
  }
  if (
    (result.criteria_collection_state !== 'assessed' &&
      result.criteria_scores.length) ||
    (result.error_annotation_state !== 'assessed' &&
      result.observed_error_codes.length)
  )
    throw new GradingError('DETAIL_POLICY_MISMATCH');
  return result;
}
