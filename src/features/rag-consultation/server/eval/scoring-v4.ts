import type { RagCitation } from '../../contract.ts';
import type { CitationWitness } from '../answer/context.ts';
import { normalizeText } from '../text/normalize.ts';
import { hasTerms, type ObservationV2 } from './scoring-v2.ts';
import {
  scoreV3,
  type BoundFactSlot,
  type GoldV3,
  type WitnessRef,
} from './scoring-v3.ts';

interface ReviewedWitnessRef extends WitnessRef {
  /** Accepted transcriptions of the whole selected source span. */
  exactWitness?: readonly string[];
}

interface ReviewedFactSlot extends Omit<BoundFactSlot, 'evidence'> {
  evidence: readonly (readonly ReviewedWitnessRef[])[];
}

export interface GoldV4 extends GoldV3 {
  slots: readonly ReviewedFactSlot[];
  /** Reviewer-approved complete non-claim lines, such as headings or a refusal. */
  contextLines: readonly string[];
}

type CitationLocation = Pick<RagCitation, 'sourceId' | 'location'>;

function atSameLocation(a: CitationLocation, b: CitationLocation): boolean {
  return (
    a.sourceId === b.sourceId &&
    normalizeText(a.location ?? '') === normalizeText(b.location ?? '')
  );
}

function normalizeWitness(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function provesRef(proof: CitationWitness, ref: ReviewedWitnessRef): boolean {
  const [location = '', labels] = proof.location?.split(' · 열 ') ?? [];
  if (
    proof.sourceId !== ref.sourceId ||
    (ref.location && normalizeText(location) !== normalizeText(ref.location)) ||
    (ref.factId && proof.factId !== ref.factId) ||
    (ref.chunkId && proof.chunkId !== ref.chunkId) ||
    !hasTerms(proof.text, ref.witness) ||
    (ref.exactWitness !== undefined &&
      !ref.exactWitness.some(
        (text) => normalizeWitness(text) === normalizeWitness(proof.text),
      ))
  )
    return false;
  return (
    !ref.columns?.length ||
    sameLabels(ref.columns, proof.columns ?? labels?.split(','))
  );
}

function sameLabels(
  expected: readonly string[] = [],
  actual: readonly string[] = [],
) {
  const labels = new Set(expected.map(normalizeText));
  return (
    labels.size === actual.length &&
    actual.every((label) => labels.delete(normalizeText(label)))
  );
}

/** Exact reviewed lines and the witnesses for one complete, actually cited alternative. */
export function scoreV4(
  gold: GoldV4,
  observation: ObservationV2,
  version: 'slot-v4' | 'slot-v4.1' = 'slot-v4',
) {
  if (
    !Array.isArray(gold.contextLines) ||
    gold.contextLines.some(
      (line) => typeof line !== 'string' || !line.trim(),
    ) ||
    new Set(gold.slots.map(({ id }) => id)).size !== gold.slots.length ||
    (gold.status === 'partial' && !gold.missingFields?.length)
  ) {
    throw new Error(
      'V4 requires reviewed context lines, unique slots and explicit missing fields for partial answers',
    );
  }
  for (const slot of gold.slots) {
    for (const alternative of slot.evidence) {
      for (const { exactWitness } of alternative) {
        if (
          exactWitness !== undefined &&
          (!Array.isArray(exactWitness) ||
            !exactWitness.length ||
            exactWitness.some(
              (text) => typeof text !== 'string' || !text.trim(),
            ))
        )
          throw new Error(
            'V4 exact witnesses require non-empty source text alternatives',
          );
      }
    }
  }
  const base = scoreV3(gold, observation);
  const { answer } = observation;
  const publicSources = new Set(
    answer.citations.map(({ sourceId }) => sourceId),
  );
  const citations = observation.citationLocations ?? answer.citations;
  const witnesses = (observation.citationWitnesses ?? []).filter(
    (proof) =>
      publicSources.has(proof.sourceId) &&
      citations.some((citation) => atSameLocation(citation, proof)),
  );
  const lines = answer.answer.split('\n').map(normalizeText);
  const coveredLines = new Set<number>();
  const supportedWitnesses = new Set<CitationWitness>();
  const context = new Set(gold.contextLines.map(normalizeText));

  const slots = gold.slots.map((slot, index) => {
    const allowed = new Set(slot.answerSpans.map(normalizeText));
    const exactAnswerLines = base.slots[index].claimLines.filter((line) =>
      allowed.has(lines[line - 1]),
    );
    const witnessSets = slot.evidence
      .map((alternative) =>
        alternative.map((ref) =>
          witnesses.filter((proof) => provesRef(proof, ref)),
        ),
      )
      .filter((alternative) => alternative.every((matches) => matches.length));
    const fulfilled = Boolean(exactAnswerLines.length && witnessSets.length);
    if (fulfilled) {
      for (const line of exactAnswerLines) coveredLines.add(line);
      for (const proof of witnessSets.flat(2)) supportedWitnesses.add(proof);
    }
    return {
      id: slot.id,
      exactAnswerLines,
      provenAlternatives: witnessSets.length,
      fulfilled,
    };
  });

  const unreviewedLines = lines.flatMap((line, index) =>
    !line || context.has(line) || coveredLines.has(index + 1)
      ? []
      : [index + 1],
  );
  const supported = [...supportedWitnesses];
  const unsupportedCitations = citations
    .filter(
      (citation) => !supported.some((proof) => atSameLocation(citation, proof)),
    )
    .map(({ sourceId, location }) => ({ sourceId, location }));
  const expectsHandoff =
    gold.status === 'handoff' ||
    (version === 'slot-v4.1' && gold.status === 'abstained');
  const checks = {
    ...base.checks,
    facts: slots.every(({ fulfilled }) => fulfilled),
    boundClaims: slots.every(({ fulfilled }) => fulfilled),
    missing: sameLabels(gold.missingFields, answer.missingFields),
    stateDetails:
      sameLabels(gold.clarifyOptions, answer.clarifyOptions) &&
      (expectsHandoff
        ? answer.handoff?.needed === true &&
          (!gold.handoffReason ||
            answer.handoff.reasonCode === gold.handoffReason)
        : answer.handoff === undefined),
    reviewedLines: unreviewedLines.length === 0,
    citedClaims:
      unsupportedCitations.length === 0 &&
      [...publicSources].every((id) =>
        supported.some((proof) => proof.sourceId === id),
      ),
  };
  return {
    version,
    correct: Object.values(checks).every(Boolean),
    checks,
    slots,
    unreviewedLines,
    unsupportedCitations,
  };
}
