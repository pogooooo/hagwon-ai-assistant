import {
  hasTerms,
  matchesCitation,
  scoreV2,
  type EvidenceRef,
  type FactSlot,
  type GoldV2,
  type ObservationV2,
} from './scoring-v2.ts';

export interface WitnessRef extends EvidenceRef {
  factId?: string;
  /** Terms the evaluator must find together in the selected source span. */
  witness: readonly string[];
}

export interface BoundFactSlot extends Omit<FactSlot, 'evidence'> {
  /** Reviewer-approved alternative spans, each keeping the subject and value together. */
  answerSpans: readonly string[];
  evidence: readonly (readonly WitnessRef[])[];
}

export interface GoldV3 extends Omit<GoldV2, 'slots'> {
  slots: readonly BoundFactSlot[];
}

/** V3 adds answer-span and selected-proof checks without changing the v2 criteria. */
export function scoreV3(gold: GoldV3, observation: ObservationV2) {
  const base = scoreV2(gold, observation);
  if (
    gold.slots.some(
      (slot) =>
        !slot.answerSpans?.length ||
        slot.answerSpans.some((span) => !span.trim()) ||
        slot.evidence.some((set) =>
          set.some(
            (ref) =>
              !ref.witness?.length ||
              ref.witness.some((term) => !term.trim()) ||
              (!ref.location && !ref.chunkId && !ref.factId),
          ),
        ),
    )
  )
    throw new Error(
      'V3 requires answer spans and located witnesses for every slot',
    );
  const lines = observation.answer.answer.split('\n');
  const slots = gold.slots.map((slot, index) => {
    const scored = base.slots[index];
    const answerLines = scored.claimLines.filter((line) =>
      slot.answerSpans.some((span) => hasTerms(lines[line - 1], [span])),
    );
    const witnessSets = slot.evidence.map((set) =>
      set.flatMap((ref) =>
        (observation.citationWitnesses ?? []).some(
          (proof) =>
            matchesCitation(proof, ref) &&
            (!ref.factId || proof.factId === ref.factId) &&
            (!ref.chunkId || proof.chunkId === ref.chunkId) &&
            hasTerms(proof.text, ref.witness),
        )
          ? []
          : [
              {
                sourceId: ref.sourceId,
                location: ref.location,
                chunkId: ref.chunkId,
                factId: ref.factId,
              },
            ],
      ),
    );
    const witnessed = witnessSets.some((missing) => missing.length === 0);
    return {
      ...scored,
      answerLines,
      witnessed,
      witnessSets,
      fulfilled: scored.fulfilled && answerLines.length > 0 && witnessed,
    };
  });
  const checks = {
    ...base.checks,
    boundClaims: slots.every((slot) => slot.fulfilled),
  };
  return {
    version: 'slot-v3',
    correct: Object.values(checks).every(Boolean),
    checks,
    slots,
  };
}
