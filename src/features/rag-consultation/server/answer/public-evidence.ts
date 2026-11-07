import { isAssistantDirective } from '../ingest/validation.ts';
import { compactText } from '../text/normalize.ts';
import { isValidAt } from '../text/time.ts';
import type { RagChunk } from '../types.ts';
import { type AnswerDraft, type EvidenceExcerpt } from './context.ts';
import { supportsExcerpt } from './verify.ts';

export function isCleanPublicEvidence(
  chunk: RagChunk,
  at: number,
  quote?: string,
): boolean {
  return (
    chunk.visibility === 'academy_public' &&
    isValidAt(chunk.validFrom, chunk.validTo, at) &&
    !chunk.suspicious &&
    !isAssistantDirective(chunk.text) &&
    !chunk.extraction?.needsReview &&
    !chunk.extraction?.uncertainTokens.some(
      (token) => quote === undefined || quote.includes(token),
    )
  );
}

export function readEvidenceRow(chunk: RagChunk) {
  const { kind, header, cells } = chunk.location;
  if (
    kind !== 'table_row' ||
    !header ||
    !cells ||
    header.length !== cells.length
  )
    return;
  const column = (pattern: RegExp) =>
    header.findIndex((name) => pattern.test(compactText(name)));
  const project = (...columns: number[]): EvidenceExcerpt | undefined => {
    if (columns.some((index) => index < 0 || !cells[index])) return;
    const tableColumns = [...new Set(columns)];
    const line = tableColumns
      .map((i) => header[i] + ': ' + cells[i])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt) ? excerpt : undefined;
  };
  return { column, project, cells };
}

export function fromPublicExcerpts(
  excerpts: EvidenceExcerpt[],
  missingFields: string[] = [],
): AnswerDraft {
  return {
    status: missingFields.length ? 'partial' : 'answered',
    reasonCode: missingFields.length ? 'PARTIAL_EVIDENCE' : undefined,
    text: [
      ...excerpts.map(({ line }) => line),
      ...(missingFields.length
        ? ['확인되지 않은 항목 ' + missingFields.join(', ')]
        : []),
    ].join('\n'),
    excerpts,
    citations: excerpts.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    usedFacts: [],
    missingFields: missingFields.length ? missingFields : undefined,
  };
}
