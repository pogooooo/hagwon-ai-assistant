import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  RAG_ANSWER_STATUSES,
  RAG_PUBLIC_REASON_CODES,
} from '../../contract.ts';
import {
  sourceIdOf,
  toAcademyAccessScope,
  toAcademyDocumentInput,
} from '../adapters/fixture/load-academies.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import type { Suite } from './harness.ts';

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

function treeFiles(root: string, include: (name: string) => boolean) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).flatMap(
    (entry) => {
      if (entry.isDirectory()) return [];
      const file = join(entry.parentPath, entry.name);
      const name = relative(root, file).replaceAll(sep, '/');
      if (!include(name)) return [];
      if (!entry.isFile())
        throw new Error('Holdout inputs must be regular files');
      return [{ file, name }];
    },
  );
}

function hashFiles(files: { file: string; name: string }[]) {
  const digest = createHash('sha256');
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { file, name } of files)
    digest.update(JSON.stringify([name, sha256(readFileSync(file))]) + '\n');
  return digest.digest('hex');
}

export const datasetDigest = (root: string) =>
  hashFiles(treeFiles(root, () => true));

/** Includes the evaluator and the feature's server and contract code. */
export function evaluationCodeDigest(featureRoot: string, lockFile: string) {
  const files = treeFiles(
    featureRoot,
    (name) =>
      /\.[cm]?tsx?$/.test(name) &&
      !name
        .split('/')
        .some((part) => part === '__fixtures__' || part === '__tests__') &&
      !name.endsWith('.test.ts'),
  );
  return hashFiles([...files, { file: lockFile, name: 'package-lock.json' }]);
}

export function holdoutCoverage(suite: Suite) {
  const users = new Map(
    suite.dataset.users.map(({ user_id, academy_id }) => [user_id, academy_id]),
  );
  const counts = new Map<string, number>();
  for (const { userId } of suite.cases) {
    const academy = users.get(userId);
    if (!academy) continue;
    counts.set(academy, (counts.get(academy) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

const label = z
  .string()
  .refine((text) => text.trim().length > 0, 'Expected nonempty text');
const terms = z.array(label).min(1);
const witness = z
  .object({
    sourceId: label,
    location: label.optional(),
    chunkId: label.optional(),
    factId: label.optional(),
    columns: z.array(label).optional(),
    witness: terms,
    exactWitness: terms.optional(),
  })
  .refine(
    (ref) => Boolean(ref.location || ref.chunkId || ref.factId),
    'Witness must have a location, chunk ID or fact ID',
  );

const goldV4 = z.object({
  status: z.enum(RAG_ANSWER_STATUSES),
  maxGenerationCalls: z.number().int().nonnegative(),
  contextLines: z.array(label),
  missingFields: z.array(label).optional(),
  clarifyOptions: z.array(label).optional(),
  handoffReason: z.enum(RAG_PUBLIC_REASON_CODES).optional(),
  forbidden: z.array(label).optional(),
  slots: z.array(
    z.object({
      id: label,
      claim: terms,
      answerSpans: terms,
      evidence: z.array(z.array(witness).min(1)).min(1),
    }),
  ),
});

export function validateHoldoutGoldV4(
  suite: Suite,
  annotations: ReadonlyMap<string, unknown>,
) {
  const documents = new Map(
    suite.dataset.documents.map((document) => [
      sourceIdOf(document.meta),
      document,
    ]),
  );
  const users = new Map(
    suite.dataset.users.map((user) => [user.user_id, user]),
  );
  for (const { id, userId } of suite.cases) {
    const prefix = 'Invalid slot-v4 annotation for ' + id + ': ';
    const parsed = goldV4.safeParse(annotations.get(id));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(prefix + issue.path.join('.') + ' ' + issue.message);
    }
    const gold = parsed.data;
    const factual = gold.status === 'answered' || gold.status === 'partial';
    const hasSlots = gold.slots.length > 0;
    if (
      factual !== hasSlots ||
      (!factual && !gold.contextLines.length) ||
      (gold.status === 'partial' && !gold.missingFields?.length) ||
      (gold.status === 'clarify' && !gold.clarifyOptions?.length) ||
      new Set(gold.slots.map((slot) => slot.id)).size !== gold.slots.length
    )
      throw new Error(
        prefix + 'answer status, required slots and state details disagree',
      );
    const user = users.get(userId);
    if (!user) throw new Error('Unknown holdout user for ' + id);
    const access = toAcademyAccessScope(user, suite.dataset.students);
    for (const { evidence } of gold.slots) {
      for (const { sourceId } of evidence.flat()) {
        const document = documents.get(sourceId);
        const source = document && toAcademyDocumentInput(document);
        if (
          !document ||
          !source ||
          document.meta.status !== 'approved_active' ||
          !canReadRecord(
            access,
            {
              academyId: source.academyId,
              classId: source.classId ?? null,
              studentId: source.studentId ?? null,
              visibility: source.visibility,
            },
            access.allowedStudentIds,
          )
        )
          throw new Error(
            prefix +
              'witness source is not approved and accessible: ' +
              sourceId,
          );
      }
    }
  }
}

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const reviewManifest = z.strictObject({
  version: z.literal(1),
  datasetSha256: hex,
  goldSha256: hex,
  engineSha256: hex,
  reviewedBy: label,
  reviewedAt: z.iso.datetime({ offset: true }),
  reviewedCaseIds: terms,
  reviewedRepeatedCaseIds: z.array(label),
  independentInputs: z.literal(true),
});

function sameIds(recorded: readonly string[], expected: readonly string[]) {
  const ids = new Set(recorded);
  return (
    recorded.length === expected.length &&
    ids.size === recorded.length &&
    expected.every((id) => ids.has(id))
  );
}

export function validateHoldoutReview(
  content: Uint8Array,
  frozen: { datasetSha256: string; goldSha256: string; engineSha256: string },
  caseIds: readonly string[],
  repeatedCaseIds: readonly string[],
) {
  const review = reviewManifest.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)),
  );
  if (
    review.datasetSha256 !== frozen.datasetSha256 ||
    review.goldSha256 !== frozen.goldSha256
  )
    throw new Error(
      'Review manifest does not match the frozen holdout and gold hashes',
    );
  if (review.engineSha256 !== frozen.engineSha256)
    throw new Error(
      'Review manifest does not match the frozen evaluation code hash',
    );
  if (!sameIds(review.reviewedCaseIds, caseIds))
    throw new Error(
      'Review manifest must cover every holdout case exactly once',
    );
  if (!sameIds(review.reviewedRepeatedCaseIds, repeatedCaseIds))
    throw new Error(
      'Review manifest must cover every repeated conversation case',
    );
  return {
    manifestSha256: sha256(content),
    reviewedBy: review.reviewedBy,
    reviewedAt: review.reviewedAt,
  };
}

export const HOLDOUT_MIN_CASES = 300;
export const HOLDOUT_MIN_ACADEMIES = 3;

interface HoldoutGateInput {
  slotV4: boolean;
  caseCount: number;
  academyCount: number;
  knownOverlap: boolean;
  reviewed: boolean;
  mockGeneration: boolean;
  violations: number;
  correct: number;
  minimumCorrect: number;
}

function holdoutGate(input: HoldoutGateInput, requiresReview: boolean) {
  const blockers: string[] = [];
  if (!input.slotV4) blockers.push('requires_slot_v4');
  if (input.knownOverlap) blockers.push('known_overlap');
  if (input.caseCount < HOLDOUT_MIN_CASES) blockers.push('insufficient_cases');
  if (input.academyCount < HOLDOUT_MIN_ACADEMIES)
    blockers.push('insufficient_academies');
  if (requiresReview && !input.reviewed) blockers.push('missing_review');
  if (input.mockGeneration) blockers.push('mock_generation_used');
  if (input.violations) blockers.push('safety_violation');
  if (input.correct < input.minimumCorrect) blockers.push('below_target');
  return { passed: blockers.length === 0, blockers };
}

export function independentGate(input: HoldoutGateInput) {
  return holdoutGate(input, true);
}

export function automatedHoldoutGate(
  input: Omit<HoldoutGateInput, 'reviewed'>,
) {
  return holdoutGate({ ...input, reviewed: false }, false);
}
