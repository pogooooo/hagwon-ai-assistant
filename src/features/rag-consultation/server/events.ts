/**
 * 다른 기능에서 호출하는 내부 연동 이벤트(신뢰된 서버 코드에서만 호출).
 * - 7번 자료 관리: 문서 생성·수정·승인·삭제·권한 철회 → onDocumentChanged
 * - 3번 학습 분석: 강사 검수 후 확정/수정된 분석 결과 → onAnalysisReportPublished
 */
import type { IndexJob, IndexJobQueue } from './store/index-jobs.ts';
import type { ApprovedFactInput, SourceDocumentInput } from './types.ts';

export type DocumentChangedEvent =
  | {
      type: 'upserted';
      document: SourceDocumentInput;
      facts?: ApprovedFactInput[];
      /** 자료 관리에서 승인 완료된 revision 인지(승인 전에는 색인만 하고 노출하지 않음) */
      approved: boolean;
    }
  | {
      type: 'deleted' | 'access_revoked';
      academyId: string;
      documentId: string;
      revision?: number;
    };

export async function onDocumentChanged(
  queue: IndexJobQueue,
  event: DocumentChangedEvent,
): Promise<IndexJob> {
  const job =
    event.type === 'upserted'
      ? queue.enqueue({
          jobType: 'upsert',
          document: event.document,
          facts: event.facts ?? [],
          approve: event.approved,
        })
      : queue.enqueue({
          jobType: 'revoke',
          academyId: event.academyId,
          documentId: event.documentId,
          revision: event.revision,
          reason: event.type === 'deleted' ? 'deleted' : 'revoked',
        });
  await queue.runPending();
  return queue.getJob(job.jobId) ?? job;
}

/** 3번 기능이 확정한 단원별 결과. RAG 는 채점·통계를 다시 계산하지 않는다. */
export interface AnalysisReportPublished {
  academyId: string;
  studentId: string;
  classId?: string | null;
  /** 리포트(문서) ID. 채점 수정 시 같은 ID 로 revision 을 올린다. */
  reportId: string;
  revision: number;
  /** YYYY-MM */
  period: string;
  title: string;
  /** 확정·공개 시각(ISO-8601) */
  publishedAt: string;
  units: Array<{
    unitName: string;
    correctCount: number;
    questionCount: number;
    assignmentIds?: string[];
  }>;
}

export function analysisReportToIndexInput(report: AnalysisReportPublished): {
  document: SourceDocumentInput;
  facts: ApprovedFactInput[];
} {
  const sourceId = `${report.reportId}:r${report.revision}:body`;
  const header = '|단원|정답 문항|전체 문항|';
  const rows = report.units.map(
    (unit) => `|${unit.unitName}|${unit.correctCount}|${unit.questionCount}|`,
  );
  return {
    document: {
      academyId: report.academyId,
      documentId: report.reportId,
      revision: report.revision,
      documentType: 'student_analysis',
      title: report.title,
      text: [
        `분석 기간: ${report.period}`,
        '',
        header,
        '|---|---|---|',
        ...rows,
      ].join('\n'),
      visibility: 'student_private',
      studentId: report.studentId,
      classId: report.classId ?? null,
      validFrom: report.publishedAt,
      validTo: null,
      approvedAt: report.publishedAt,
      sourceId,
    },
    facts: report.units.map((unit, index) => ({
      factId: `${report.reportId}:r${report.revision}:u${index + 1}`,
      sourceId,
      documentId: report.reportId,
      revision: report.revision,
      academyId: report.academyId,
      subjectType: 'student',
      subjectId: report.studentId,
      factType: 'accuracy',
      value: {
        kind: 'accuracy',
        correct: unit.correctCount,
        total: unit.questionCount,
        unit: unit.unitName,
      },
      period: report.period,
      validFrom: report.publishedAt,
      validTo: null,
      approvalStatus: 'approved',
      assignmentIds: unit.assignmentIds,
    })),
  };
}

export async function onAnalysisReportPublished(
  queue: IndexJobQueue,
  report: AnalysisReportPublished,
): Promise<IndexJob> {
  const { document, facts } = analysisReportToIndexInput(report);
  return onDocumentChanged(queue, {
    type: 'upserted',
    document,
    facts,
    approved: true,
  });
}
