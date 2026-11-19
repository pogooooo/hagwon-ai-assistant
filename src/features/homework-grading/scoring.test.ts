import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decimalString, numeric, points, rate } from './arithmetic.ts';
import {
  aggregate,
  propose,
  validateAssignment,
  validateRetained,
} from './scoring.ts';
import { item, reading } from './test-fixtures.ts';

test('exact arithmetic preserves four decimal score places and aggregate range', () => {
  assert.equal(decimalString(points('0.1') + points('0.2')), '0.3');
  assert.equal(decimalString(points('600000') + points('600000')), '1200000');
  assert.equal(rate(1n, 3n), '0.333333');
  assert.equal(rate(2n, 3n), '0.666667');
  assert.equal(rate(0n, 0n), null);
});
test('bounded numeric grammar handles fractions and rejects code, division by zero and huge exponents', () => {
  assert.deepEqual(numeric('0.5'), numeric('1 / 2'));
  assert.deepEqual(numeric('(1+2)/6'), numeric('1/2'));
  assert.deepEqual(numeric('\\frac{1}{2}'), numeric('1/2'));
  assert.deepEqual(numeric('\\frac{1}{\\frac{2}{3}}'), numeric('3/2'));
  for (const s of [
    'globalThis.process.exit()',
    '1/0',
    '10^100000',
    'sqrt(2)',
    'NaN',
    '1e9999',
    '('.repeat(40) + '1' + ')'.repeat(40),
  ])
    assert.throws(() => numeric(s));
});
test('Korean exact answers preserve negation and internal spacing by default', () => {
  const def = item('KOR');
  assert.equal(propose(def, reading(def, '한다')).outcome, 'incorrect');
  assert.equal(propose(def, reading(def, '안한다')).outcome, 'incorrect');
  assert.equal(propose(def, reading(def, ' 안 한다 ')).outcome, 'correct');
});
test('English answers are not silently spell-corrected, lowercased or stripped of apostrophes', () => {
  const def = item('ENG');
  for (const answer of ['want', 'Went', 'WENT'])
    assert.equal(propose(def, reading(def, answer)).outcome, 'incorrect');
  const possessive = { ...def, key: { ...def.key!, accepted_texts: ["it's"] } };
  assert.equal(
    propose(possessive, reading(possessive, 'its')).outcome,
    'incorrect',
  );
  assert.equal(
    propose(
      {
        ...def,
        key: {
          ...def.key!,
          normalization: { ...def.key!.normalization, case_sensitive: false },
        },
      },
      reading(def, 'WENT'),
    ).outcome,
    'correct',
  );
});
test('numeric value and required reduced-fraction form receive independent rubric scores', () => {
  const def = item();
  def.key!.required_form = 'reduced_fraction';
  def.criteria = [
    {
      ...def.criteria[0],
      criterion_id: 'criterion_value',
      max_score: '1',
      allowed_scores: ['0', '1'],
    },
    {
      ...def.criteria[0],
      criterion_id: 'criterion_form',
      criterion_type: 'format',
      max_score: '1',
      allowed_scores: ['0', '1'],
    },
  ];
  assert.equal(propose(def, reading(def, '1/2')).score, '2');
  assert.equal(propose(def, reading(def, '2/4')).score, '1');
  assert.equal(propose(def, reading(def, '2/4')).outcome, 'partial');
  assert.equal(propose(def, reading(def, '\\frac{2}{4}')).outcome, 'partial');
  assert.equal(propose(def, reading(def, '\\frac{1}{2}')).outcome, 'correct');
});
test('numeric tolerance, units and allowed conversion are controlled by the registered key', () => {
  const def = item();
  def.key!.numeric_target = '100';
  def.key!.accepted_units = ['cm'];
  assert.equal(propose(def, reading(def, '100')).outcome, 'incorrect');
  assert.equal(
    propose(def, reading(def, '100', { unit_observed: 'cm' })).outcome,
    'correct',
  );
  assert.equal(
    propose(def, reading(def, '1', { unit_observed: 'm' })).outcome,
    'incorrect',
  );
  def.key!.unit_conversion_allowed = true;
  assert.equal(
    propose(def, reading(def, '1', { unit_observed: 'm' })).outcome,
    'correct',
  );
  assert.equal(
    propose(def, reading(def, '100', { unit_observed: 'kg' })).outcome,
    'incorrect',
  );
});
test('unreadable, ambiguous, missing region and empty transcription never become wrong or blank', () => {
  const def = item();
  for (const extra of [
    { answer_status: 'unreadable' as const },
    { answer_status: 'ambiguous' as const },
    { association_status: 'missing' as const },
    { regions: [] },
    { ambiguity_codes: ['ERASURE'] },
  ])
    assert.equal(propose(def, reading(def, '1/2', extra)).score, null);
  assert.equal(propose(def, reading(def, '')).outcome, 'ungradable');
  assert.equal(
    propose(def, reading(def, '', { answer_status: 'blank' })).outcome,
    'blank',
  );
});
test('unapproved AI answer candidates have no scoring authority', () => {
  const def = item();
  def.key!.source = 'ai_candidate';
  def.key!.approval_status = 'pending';
  assert.equal(propose(def, reading(def)).exclusion_reason, 'NO_KEY');
  assert.equal(propose(def, reading(def)).score, null);
});
test('multiple choice compares complete sets and defers duplicate or ambiguous marks', () => {
  const def = item('KOR', { answer_type: 'choice_multiple' });
  def.key!.accepted_choice_sets = [['1', '3']];
  assert.equal(propose(def, reading(def, '③,①')).outcome, 'correct');
  assert.equal(propose(def, reading(def, '1')).outcome, 'incorrect');
  assert.equal(propose(def, reading(def, '1,1,3')).outcome, 'ungradable');
});
test('strict retained result rejects answer text, fake key version, fake totals and forged outcome', () => {
  const def = item(),
    result = propose(def, reading(def));
  assert.throws(() =>
    validateRetained(def, { ...result, answer_observed: 'private-answer' }),
  );
  assert.throws(() =>
    validateRetained(def, { ...result, key_version: 'fake' }),
  );
  assert.throws(() => validateRetained(def, { ...result, score: '1' }));
  assert.throws(() =>
    validateRetained(def, { ...result, outcome: 'incorrect' }),
  );
  assert.throws(() =>
    aggregate(def, [
      {
        criterion_id: def.criteria[0].criterion_id,
        score: '0.7',
        max_score: '2',
      },
    ]),
  );
});
test('assignment validates every expected item, criteria, rights reference and maximum', () => {
  const def = item(),
    assignment = {
      title: 'synthetic',
      class_id: 'class_001',
      rights_ref: 'rights_synthetic',
      items: [def],
    };
  validateAssignment(assignment);
  assert.throws(() => validateAssignment({ ...assignment, items: [def, def] }));
  assert.throws(() =>
    validateAssignment({ ...assignment, rights_ref: 'rights_other' }),
  );
  assert.throws(() =>
    validateAssignment({ ...assignment, items: [{ ...def, max_score: '0' }] }),
  );
});
