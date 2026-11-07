import type {
  RagAnswer,
  RagAnswerStatus,
  RagCitation,
} from '../../contract.ts';
import type { CitationWitness } from '../answer/context.ts';
import { compactText } from '../text/normalize.ts';

/** One evidence set is conjunctive. Sets within a slot are alternatives. */
export interface EvidenceRef {
  sourceId: string;
  location?: string;
  chunkId?: string;
  columns?: readonly string[];
}

export interface FactSlot {
  id: string;
  /** Terms that must be present together in a single answer line. */
  claim: readonly string[];
  evidence: readonly (readonly EvidenceRef[])[];
}

export interface GoldV2 {
  status: RagAnswerStatus;
  slots: readonly FactSlot[];
  missingFields?: readonly string[];
  clarifyOptions?: readonly string[];
  handoffReason?: NonNullable<RagAnswer['handoff']>['reasonCode'];
  forbidden?: readonly string[];
  maxGenerationCalls: number;
}

export interface ObservationV2 {
  answer: RagAnswer;
  citationLocations?: readonly RagCitation[];
  citationWitnesses?: readonly CitationWitness[];
  retrievedChunkIds: readonly string[];
  retrievedSourceIds: readonly string[];
  generationCalls: number;
  violations: readonly string[];
}

export function hasTerms(text: string, terms: readonly string[]): boolean {
  const haystack = compactText(text);
  return terms.every((term) => {
    const needle = compactText(term);
    if (!needle) return false;
    for (
      let index = haystack.indexOf(needle);
      index >= 0;
      index = haystack.indexOf(needle, index + 1)
    ) {
      const before = haystack.slice(0, index);
      const after = haystack.slice(index + needle.length);
      const joinsPrevious =
        /^\d/.test(needle) &&
        (/\d$/.test(before) ||
          (/\d,$/.test(before) && /^\d{3}(?!\d)/.test(needle)));
      const joinsNext =
        /\d$/.test(needle) && /^(?:\d|,\d{3}(?!\d))/.test(after);
      if (!joinsPrevious && !joinsNext) return true;
    }
    return false;
  });
}

export function matchesCitation(
  citation: Pick<RagCitation, 'sourceId' | 'location'>,
  ref: EvidenceRef,
): boolean {
  if (citation.sourceId !== ref.sourceId) return false;
  if (!ref.location && !ref.columns?.length) return true;
  return (citation.location ?? '').split(' / ').some((part) => {
    const [location, columns = ''] = part.split(' · 열 ');
    const labels = columns.split(',').map(compactText);
    return (
      (!ref.location || compactText(location) === compactText(ref.location)) &&
      (ref.columns ?? []).every((column) =>
        labels.includes(compactText(column)),
      )
    );
  });
}

export function scoreV2(gold: GoldV2, observation: ObservationV2) {
  const { answer } = observation;
  const givesFacts = gold.status === 'answered' || gold.status === 'partial';
  if (
    givesFacts !== gold.slots.length > 0 ||
    gold.slots.some(
      (slot) =>
        slot.claim.length === 0 ||
        slot.evidence.length === 0 ||
        slot.evidence.some((set) => set.length === 0),
    )
  ) {
    throw new Error('V2 requires explicit claim and evidence sets for answers');
  }
  const slots = gold.slots.map((slot) => {
    const claimLines = answer.answer
      .split('\n')
      .flatMap((line, index) =>
        hasTerms(line, slot.claim) ? [index + 1] : [],
      );
    const citations = observation.citationLocations ?? answer.citations;
    const evidenceSets = slot.evidence.map((set) => ({
      missingCitations: set.filter(
        (ref) => !citations.some((citation) => matchesCitation(citation, ref)),
      ),
      missingRetrieval: set.filter((ref) =>
        ref.chunkId
          ? !observation.retrievedChunkIds.includes(ref.chunkId)
          : !observation.retrievedSourceIds.includes(ref.sourceId),
      ),
    }));
    const claim = claimLines.length > 0;
    const cited = evidenceSets.some((set) => set.missingCitations.length === 0);
    const retrieved = evidenceSets.some(
      (set) => set.missingRetrieval.length === 0,
    );
    return {
      id: slot.id,
      claim,
      cited,
      retrieved,
      fulfilled: claim && cited,
      claimLines,
      evidenceSets,
    };
  });
  const missing = (gold.missingFields ?? []).every((field) =>
    (answer.missingFields ?? []).some((actual) => hasTerms(actual, [field])),
  );
  const checks = {
    status: answer.status === gold.status,
    facts: slots.every((slot) => slot.fulfilled),
    missing,
    stateDetails:
      (gold.status !== 'partial' || Boolean(answer.missingFields?.length)) &&
      (gold.status !== 'clarify' ||
        (Boolean(answer.clarifyOptions?.length) &&
          (!gold.clarifyOptions ||
            (answer.clarifyOptions?.length === gold.clarifyOptions.length &&
              gold.clarifyOptions.every((name) =>
                answer.clarifyOptions?.includes(name),
              ))))) &&
      (gold.status !== 'handoff' ||
        (answer.handoff?.needed === true &&
          (!gold.handoffReason ||
            answer.handoff.reasonCode === gold.handoffReason))),
    forbidden: (gold.forbidden ?? []).every(
      (term) => !hasTerms(answer.answer, [term]),
    ),
    nonAnswerCitations: givesFacts || answer.citations.length === 0,
    generation: observation.generationCalls <= gold.maxGenerationCalls,
    safety: observation.violations.length === 0,
  };
  return {
    version: 'slot-v2',
    correct: Object.values(checks).every(Boolean),
    checks,
    slots,
  };
}
