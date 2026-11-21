import { ask } from '../consultation.ts';
import { learningEvidence } from '../learning.ts';
import { workbookEvidence } from '../workbook-publication.ts';
import type { PageContext } from '../shared.ts';

/** Reconstruct pre-v3 answers for historical citation, revision and access tests. */
export function askArchived(ctx: PageContext, form: FormData) {
  return ask(ctx, form, undefined, (db, academy) => {
    const learning = learningEvidence(db, academy),
      workbook = workbookEvidence(db, academy);
    return {
      documents: [...learning.documents, ...workbook.documents],
      facts: [...learning.facts, ...workbook.facts],
    };
  });
}
