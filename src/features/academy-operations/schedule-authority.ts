import type { QueryFrame } from '../rag-consultation/server/query/parse-query.ts';
import { InMemoryRagStore } from '../rag-consultation/server/index.ts';
import type {
  SourceDocumentInput,
  ApprovedFactInput,
} from '../rag-consultation/server/types.ts';

/** Schedule dates/times come from operations data; general makeup policy remains searchable. */
export function requestsOperationalSchedule(frame: Readonly<QueryFrame>) {
  const q = frame.normalized;
  const dated =
    frame.explicitDates.length > 0 ||
    frame.relativeDay !== null ||
    !!frame.relativeWeek ||
    frame.months.length > 0;
  const schedule = frame.topics.some(
    ({ id }) => id === 'schedule' || id === 'schedule_change',
  );
  const makeup =
    frame.topics.some(({ id }) => id === 'makeup') &&
    (dated || /언제|몇\s*시|시간표|일정|요일/.test(q));
  return (
    (schedule || makeup) && !/환불|수강료|비용|규정|정책|신청\s*방법/.test(q)
  );
}

export async function scheduleAuthority(
  documents: SourceDocumentInput[],
  facts: ApprovedFactInput[],
) {
  const store = new InMemoryRagStore();
  for (const document of documents) {
    await store.upsertIndexedRevision({
      document,
      approve: true,
      facts: facts.filter(
        (f) =>
          f.documentId === document.documentId &&
          f.revision === document.revision,
      ),
    });
  }
  return (frame: Readonly<QueryFrame>) =>
    requestsOperationalSchedule(frame)
      ? { facts: store, documents: store }
      : undefined;
}
