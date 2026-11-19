import type { QueryFrame } from '../rag-consultation/server/query/parse-query.ts';
import { consultationBookingTimeRequest } from '../rag-consultation/server/answer/consultation-booking.ts';
import { InMemoryRagStore } from '../rag-consultation/server/index.ts';
import type {
  SourceDocumentInput,
  ApprovedFactInput,
} from '../rag-consultation/server/types.ts';

/** Schedule dates/times come from operations data; general makeup policy remains searchable. */
export function requestsOperationalSchedule(frame: Readonly<QueryFrame>) {
  if (consultationBookingTimeRequest(frame)) return false;
  const q = frame.normalized;
  const dated =
    frame.explicitDates.length > 0 ||
    frame.relativeDay !== null ||
    !!frame.relativeWeek ||
    frame.months.length > 0;
  // A temporal word is an attribute, not the subject. “언제/토요일”
  // also occurs in public opening hours, collection and application policies.
  // Only restrict the document port when the question actually targets lessons.
  const lessonTarget =
    frame.classIds.length > 0 ||
    frame.matchedStudentIds.length > 0 ||
    frame.subjects.length > 0 ||
    frame.selfReference ||
    /시간표|휴강|보강|휴원|개강|종강|수업|강의|등원/.test(q);
  const schedule =
    lessonTarget &&
    frame.topics.some(
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
