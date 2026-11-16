/**
 * 휴·보강 확정 일정 → RAG 상담 자료 반영(서버 전용).
 *
 * - 확정된 일정만 문서·사실로 넣는다. 임시 저장은 넣지 않는다.
 * - 확정 내용이 바뀌면 같은 document_id 의 revision 을 올린다. 저장소는 가장 높은 revision 만 쓰므로
 *   다음 질문부터 새 일정으로 답하고 이전 일정은 검색·인용에서 빠진다.
 * - 보강을 취소하면 보강 문서를, 휴강·결석을 취소하면 두 문서를 모두 철회한다.
 * - 반 휴강은 그 반 원생(class_members)에게만, 결석 보강은 그 학생(student_private)에게만 보인다.
 */
import {
  onDocumentChanged,
  type DocumentChangedEvent,
} from '../../rag-consultation/server/events.ts';
import type {
  IndexJob,
  IndexJobQueue,
} from '../../rag-consultation/server/store/index-jobs.ts';
import type {
  ApprovedFactInput,
  SourceDocumentInput,
} from '../../rag-consultation/server/types.ts';
import {
  documentIdOf,
  ragDocumentsOf,
  type RagScheduleDocument,
} from '../model/notice.ts';
import { eventClass } from '../model/timetable.ts';
import type { AcademyConfig, ScheduleEvent } from '../model/types.ts';

export interface ScheduleIndexInput {
  document: SourceDocumentInput;
  facts: ApprovedFactInput[];
}

function toIndexInput(
  academy: AcademyConfig,
  event: ScheduleEvent,
  doc: RagScheduleDocument,
): ScheduleIndexInput {
  const approvedAt = event.confirmedAt ?? event.updatedAt;
  const sourceId = `${doc.documentId}:r${event.revision}:body`;
  return {
    document: {
      academyId: academy.academyId,
      documentId: doc.documentId,
      revision: event.revision,
      documentType: 'announcement',
      title: doc.title,
      text: `# ${doc.title}\n\n${doc.text}`,
      visibility: doc.studentId ? 'student_private' : 'class_members',
      studentId: doc.studentId,
      classId: doc.classId,
      validFrom: approvedAt,
      validTo: null,
      approvedAt,
      sourceUpdatedAt: event.updatedAt,
      sourceId,
    },
    facts: [
      {
        factId: `${doc.documentId}:r${event.revision}:${doc.role}`,
        sourceId,
        documentId: doc.documentId,
        revision: event.revision,
        academyId: academy.academyId,
        subjectType: doc.studentId ? 'student' : 'class',
        subjectId: doc.studentId ?? doc.classId,
        factType: 'schedule_change',
        value: {
          kind: 'schedule_change',
          changeType: doc.fact.changeType,
          date: doc.fact.date,
          time: doc.fact.time,
          text: doc.fact.text,
          event: {
            id: academy.academyId + ':' + event.eventId,
            startsAt: Date.parse(
              doc.fact.date +
                'T' +
                (doc.role === 'makeup'
                  ? event.makeup!.start
                  : eventClass(academy, event).start) +
                ':00+09:00',
            ),
            endsAt: Date.parse(
              doc.fact.date +
                'T' +
                (doc.role === 'makeup'
                  ? event.makeup!.end
                  : eventClass(academy, event).end) +
                ':00+09:00',
            ),
            makeupStatus: event.makeup ? 'scheduled' : 'pending',
          },
        },
        period: null,
        validFrom: approvedAt,
        validTo: null,
        approvalStatus: 'approved',
      },
    ],
  };
}

/** 확정 일정 1건 → 색인 입력(문서 + 사실). 미확정·취소면 빈 배열. */
export function scheduleEventToIndexInputs(
  academy: AcademyConfig,
  event: ScheduleEvent,
): ScheduleIndexInput[] {
  return ragDocumentsOf(academy, event).map((doc) =>
    toIndexInput(academy, event, doc),
  );
}

/** 일정 1건의 현재 상태를 RAG 에 반영할 연동 이벤트 목록 */
export function scheduleEventChanges(
  academy: AcademyConfig,
  event: ScheduleEvent,
): DocumentChangedEvent[] {
  if (event.status === 'draft') return [];
  const revoke = (role: 'cancel' | 'makeup'): DocumentChangedEvent => ({
    type: 'deleted',
    academyId: academy.academyId,
    documentId: documentIdOf(academy, event, role),
  });
  if (event.status === 'withdrawn') return [revoke('cancel'), revoke('makeup')];
  const upserts: DocumentChangedEvent[] = scheduleEventToIndexInputs(
    academy,
    event,
  ).map(({ document, facts }) => ({
    type: 'upserted',
    document,
    facts,
    approved: true,
  }));
  return event.makeup ? upserts : [...upserts, revoke('makeup')];
}

/**
 * 일정 1건을 RAG 색인 작업 큐에 반영한다. 원장이 확정·변경·취소할 때마다 호출한다.
 * 한 번도 색인되지 않은 문서의 철회는 상담 결과에 영향이 없다.
 */
export async function syncScheduleEvent(
  queue: IndexJobQueue,
  academy: AcademyConfig,
  event: ScheduleEvent,
): Promise<IndexJob[]> {
  const jobs: IndexJob[] = [];
  for (const change of scheduleEventChanges(academy, event)) {
    jobs.push(await onDocumentChanged(queue, change));
  }
  return jobs;
}
