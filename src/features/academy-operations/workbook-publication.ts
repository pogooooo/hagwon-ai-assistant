import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InMemoryRagStore } from '../rag-consultation/server/index.ts';
import type {
  ApprovedFactInput,
  SourceDocumentInput,
} from '../rag-consultation/server/types.ts';
import { canReadRecord } from '../rag-consultation/server/retrieval/access-filter.ts';
import type { OperationsDatabase } from './database.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import { requireStaff } from './workbook-catalog.ts';
import {
  readWorkbookAnalysis,
  summarizeWorkbookAnalysis,
  workbookFingerprint,
  type WorkbookAnalysisResult,
} from './workbook-analysis.ts';
import {
  escapeHtml as h,
  required,
  rows,
  one,
  transaction,
  OperationError,
  type PageContext,
} from './shared.ts';

interface Scope {
  studentId: string;
  classId: string;
  period: string;
}
interface Publication {
  id: string;
  student_id: string;
  class_id: string;
  period: string;
  revision: number;
  payload: string | null;
  created_at: string;
}
interface Payload {
  format: 'workbook-analysis-v1';
  fingerprint: string;
  documents: SourceDocumentInput[];
  facts: ApprovedFactInput[];
  publishedBy: string;
}
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
export const isWorkbookPublication = (id: string) => id.startsWith('workbook-');
const reportId = (academy: string, s: Scope) =>
  'workbook-' + hash([academy, s.studentId, s.classId, s.period]);
const selectResults = (all: WorkbookAnalysisResult[], s: Scope) =>
  all.filter(
    (r) =>
      r.studentId === s.studentId &&
      r.classes.some((c) => c.id === s.classId) &&
      r.dueDate.slice(0, 7) === s.period,
  );

function latest(db: OperationsDatabase, academy: string, id: string) {
  return one<Publication>(
    db,
    'SELECT * FROM op_learning_publications WHERE academy_id=? AND id=? ORDER BY revision DESC LIMIT 1',
    academy,
    id,
  );
}
function completeScope(
  db: OperationsDatabase,
  academy: string,
  s: Scope,
  current: WorkbookAnalysisResult[],
) {
  const subject =
    one<{ subject: string }>(
      db,
      'SELECT subject FROM classes WHERE academy_id=? AND id=?',
      academy,
      s.classId,
    )?.subject ?? '';
  const math = /수학|math/i.test(subject),
    english = /영어|english/i.test(subject);
  if (math === english || current.some((r) => r.subject !== (math ? 'M' : 'E')))
    return false;
  const expected = rows<{ id: string }>(
    db,
    `SELECT sub.id FROM homework_submissions sub
    JOIN homework_assignments a ON a.id=sub.assignment_id
    JOIN homework_workbooks w ON w.assignment_id=a.id
    WHERE a.academy_id=? AND a.submission_mode='catalog' AND sub.student_id=?
      AND substr(a.due_date,1,7)=? AND sub.confirmed_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM homework_recipients r WHERE r.assignment_id=a.id AND r.student_id=sub.student_id AND r.class_id=?)`,
    academy,
    s.studentId,
    s.period,
    s.classId,
  );
  return (
    expected.length === current.length &&
    expected.every((s) => current.some((r) => r.submissionId === s.id))
  );
}
function payloadFor(
  db: OperationsDatabase,
  academy: string,
  p: Publication,
  all: WorkbookAnalysisResult[],
): Payload | null {
  try {
    const payload = JSON.parse(p.payload ?? 'null') as Payload | null;
    const scope = {
      studentId: p.student_id,
      classId: p.class_id,
      period: p.period,
    };
    const current = selectResults(all, scope);
    const document = payload?.documents?.[0];
    return payload?.format === 'workbook-analysis-v1' &&
      payload.documents.length === 1 &&
      document?.academyId === academy &&
      document.documentId === p.id &&
      document.revision === p.revision &&
      document.studentId === p.student_id &&
      document.classId === p.class_id &&
      current.length &&
      completeScope(db, academy, scope, current) &&
      payload.fingerprint === workbookFingerprint(current)
      ? payload
      : null;
  } catch {
    return null;
  }
}

/** Uses the existing publication table. Source homework and schema are read-only. */
export function workbookEvidence(db: OperationsDatabase, academy: string) {
  const publications = rows<Publication>(
    db,
    `SELECT p.* FROM op_learning_publications p
    WHERE p.academy_id=? AND p.id LIKE 'workbook-%' AND p.payload IS NOT NULL
    AND p.revision=(SELECT MAX(x.revision) FROM op_learning_publications x WHERE x.academy_id=p.academy_id AND x.id=p.id)
    ORDER BY p.id`,
    academy,
  );
  const documents: SourceDocumentInput[] = [],
    facts: ApprovedFactInput[] = [];
  if (!publications.length) return { documents, facts };
  const all = readWorkbookAnalysis(db, academy).results;
  for (const p of publications) {
    const value = payloadFor(db, academy, p, all);
    if (value) {
      documents.push(...value.documents);
      facts.push(...value.facts);
    }
  }
  return { documents, facts };
}

function requireScope(ctx: PageContext, s: Scope, withdraw = false) {
  requireStaff(ctx);
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.period) ||
    !z.iso.date().safeParse(s.period + '-01').success
  )
    throw new OperationError('분석 월을 확인해 주세요.');
  if (
    !accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === s.classId) ||
    !accessibleStudents(ctx.db, ctx.actor).some(
      (r) =>
        r.id === s.studentId &&
        (r.classIds.includes(s.classId) ||
          (withdraw && ctx.actor.role === 'admin')),
    )
  )
    throw new OperationError(
      '이 학생과 반의 분석을 공개할 권한이 없습니다.',
      403,
    );
}

function buildPayload(
  academy: string,
  s: Scope,
  id: string,
  revision: number,
  at: string,
  results: WorkbookAnalysisResult[],
  publishedBy: string,
): Payload {
  const summary = summarizeWorkbookAnalysis(results),
    first = results[0];
  if (!summary.total || new Set(results.map((r) => r.subject)).size !== 1)
    throw new OperationError('같은 과목의 승인 결과를 확인해 주세요.', 422);
  const subject = first.subject === 'M' ? '수학' : '영어';
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const title = `${clean(first.studentName)} ${s.period} ${subject} 교재 숙제 확정 분석`;
  const sourceId = `${id}:r${revision}:body`;
  const groups = [
    {
      name: '전체',
      dimension: 'overall' as const,
      correct: summary.correct,
      total: summary.total,
      referenceOnly: false,
    },
    ...[...summary.groups.values()].map((g) => ({
      ...g,
      dimension: 'unit' as const,
    })),
    ...[...summary.types.values()].map((g) => ({
      ...g,
      dimension: 'question_type' as const,
    })),
  ];
  const assignments = [
    ...new Map(
      results.map((r) => [
        r.assignmentId,
        { assignmentId: r.assignmentId, title: r.title },
      ]),
    ).values(),
  ];
  const document: SourceDocumentInput = {
    academyId: academy,
    documentId: id,
    revision,
    sourceId,
    title,
    documentType: 'student_analysis',
    visibility: 'student_private',
    studentId: s.studentId,
    classId: s.classId,
    validFrom: at,
    approvedAt: at,
    sourceUpdatedAt: at,
    text: [
      `# ${title}`,
      `대상 반: ${clean(first.classes.find((c) => c.id === s.classId)!.name)}. 분석 기간 ${s.period}, 숙제 마감 날짜 기준.`,
      `교사가 승인한 최종 정오답을 집계했습니다. 전체 ${summary.total}문항, 유형 미지정 ${summary.unclassified}문항. 전체 정답률에는 유형 미지정 문항도 포함하고 유형별 집계에서만 제외합니다. 같은 제출은 한 번만 셉니다.`,
      '배정 당시 문항 유형을 사용합니다. 수학 세부 유형은 참고용이며, 오답만으로 사고 과정·실수 원인·능력을 단정하지 않습니다.',
      ...groups.map(
        (g) =>
          `${g.name}${g.referenceOnly ? ' (참고용)' : ''}: ${g.total}문항 중 ${g.correct}문항 정답.`,
      ),
      ...results.flatMap((r) => [
        `근거 숙제 ${clean(r.title)} (${r.assignmentId}), 교재 ${clean(r.bookLabel)}, 마감일 ${r.dueDate}, 승인 버전 ${r.reviewVersion}.`,
        ...r.questions.map(
          (q) =>
            `${clean(r.title)} · ${q.page}쪽 ${clean(q.number)}번: ${q.correct ? '정답' : '오답'} · 유형 ${q.tags.map((t) => t.name).join(', ') || '미지정'}.`,
        ),
      ]),
    ].join('\n\n'),
  };
  const facts: ApprovedFactInput[] = groups.map((g) => ({
    factId: `${id}:r${revision}:${hash([g.dimension, g.name])}`,
    sourceId,
    documentId: id,
    revision,
    academyId: academy,
    subjectType: 'student',
    subjectId: s.studentId,
    factType: 'accuracy',
    period: s.period,
    validFrom: at,
    approvalStatus: 'approved',
    assignments,
    assignmentIds: assignments.map((a) => a.assignmentId),
    value: {
      kind: 'accuracy',
      unit: g.name,
      dimension: g.dimension,
      correct: g.correct,
      total: g.total,
      referenceOnly: g.referenceOnly,
      basis: 'approved_homework',
    },
    evidence: `교사 승인 최종 결과. 마감 월 ${s.period}. 유형 미지정 ${summary.unclassified}문항은 전체에 포함, 유형별 집계에서 제외. 근거 문항과 승인 버전은 상담 근거 원문에 기록.`,
  }));
  return {
    format: 'workbook-analysis-v1',
    publishedBy,
    fingerprint: workbookFingerprint(results),
    documents: [document],
    facts,
  };
}

export async function publishWorkbookAnalysis(
  ctx: PageContext,
  form: FormData,
  withdraw = false,
) {
  const scope: Scope = {
    studentId: required(form, 'studentId', '학생', 128),
    classId: required(form, 'classId', '반', 128),
    period: required(form, 'period', '분석 월', 7),
  };
  requireScope(ctx, scope, withdraw);
  const id = reportId(ctx.actor.academyId, scope),
    prior = latest(ctx.db, ctx.actor.academyId, id);
  const expected = required(form, 'publicationRevision', '공개 버전', 12);
  if (expected !== String(prior?.revision ?? 0))
    throw new OperationError(
      '공개 상태가 변경됐습니다. 다시 조회해 주세요.',
      409,
    );
  const current = selectResults(
    readWorkbookAnalysis(ctx.db, ctx.actor.academyId).results,
    scope,
  );
  const fingerprint = workbookFingerprint(current);
  if (
    !withdraw &&
    (required(form, 'fingerprint', '분석 버전', 64) !== fingerprint ||
      !current.length ||
      !completeScope(ctx.db, ctx.actor.academyId, scope, current))
  )
    throw new OperationError(
      '승인 결과가 변경됐습니다. 분석을 다시 조회해 주세요.',
      409,
    );
  if (withdraw && !prior?.payload)
    throw new OperationError('철회할 공개 분석이 없습니다.', 409);
  const at = new Date().toISOString(),
    revision = (prior?.revision ?? 0) + 1;
  const payload = withdraw
    ? null
    : buildPayload(
        ctx.actor.academyId,
        scope,
        id,
        revision,
        at,
        current,
        ctx.actor.id,
      );
  if (payload) {
    const result = await new InMemoryRagStore().upsertIndexedRevision({
      document: payload.documents[0],
      facts: payload.facts,
      approve: false,
    });
    if (result.status !== 'staged')
      throw new OperationError(
        '상담 근거를 검증하지 못했습니다. 분석 내용을 확인해 주세요.',
        422,
      );
  }
  transaction(ctx.db, () => {
    requireScope(ctx, scope, withdraw);
    const live = selectResults(
      readWorkbookAnalysis(ctx.db, ctx.actor.academyId).results,
      scope,
    );
    if (
      String(latest(ctx.db, ctx.actor.academyId, id)?.revision ?? 0) !==
        expected ||
      (!withdraw &&
        (workbookFingerprint(live) !== fingerprint ||
          !completeScope(ctx.db, ctx.actor.academyId, scope, live)))
    )
      throw new OperationError(
        '승인 결과 또는 공개 상태가 변경됐습니다. 다시 조회해 주세요.',
        409,
      );
    ctx.db
      .prepare(
        'INSERT INTO op_learning_publications(id,academy_id,student_id,class_id,period,revision,payload,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        ctx.actor.academyId,
        scope.studentId,
        scope.classId,
        scope.period,
        revision,
        payload ? JSON.stringify(payload) : null,
        at,
      );
  });
  return (
    '/homework?view=analysis&student=' + encodeURIComponent(scope.studentId)
  );
}

export function renderWorkbookPublicationControls(
  ctx: PageContext,
  studentId: string,
  all: WorkbookAnalysisResult[],
) {
  requireStaff(ctx);
  const student = accessibleStudents(ctx.db, ctx.actor).find(
    (s) => s.id === studentId,
  );
  const classes = accessibleClasses(ctx.db, ctx.actor).filter(
    (c) =>
      student &&
      (student.classIds.includes(c.id) || ctx.actor.role === 'admin'),
  );
  const scopes = new Map<string, Scope>();
  for (const r of all.filter((r) => r.studentId === studentId))
    for (const c of r.classes) {
      if (!classes.some((t) => t.id === c.id)) continue;
      const scope = { studentId, classId: c.id, period: r.dueDate.slice(0, 7) };
      scopes.set(reportId(ctx.actor.academyId, scope), scope);
    }
  // Keep stale/withdrawn reports manageable even when all source approvals disappear.
  for (const p of rows<Publication>(
    ctx.db,
    "SELECT * FROM op_learning_publications WHERE academy_id=? AND student_id=? AND id LIKE 'workbook-%'",
    ctx.actor.academyId,
    studentId,
  ))
    if (classes.some((c) => c.id === p.class_id))
      scopes.set(p.id, { studentId, classId: p.class_id, period: p.period });
  if (!scopes.size) return '';
  return `<section class="panel"><h2>상담 공개</h2><p>아래 반·마감 월의 승인 결과 전체를 공개합니다. 위 교재·기간 필터로 제한한 통계와 공개 범위는 다를 수 있습니다. 학생과 보호자는 공개된 분석만 상담에서 확인할 수 있습니다.</p>${[
    ...scopes,
  ]
    .sort(
      (a, b) =>
        b[1].period.localeCompare(a[1].period) ||
        a[1].classId.localeCompare(b[1].classId),
    )
    .map(([id, s]) => {
      const prior = latest(ctx.db, ctx.actor.academyId, id),
        current = selectResults(all, s),
        summary = summarizeWorkbookAnalysis(current);
      const active = prior
        ? payloadFor(ctx.db, ctx.actor.academyId, prior, all)
        : null;
      const complete = completeScope(ctx.db, ctx.actor.academyId, s, current);
      const canPublish = student?.classIds.includes(s.classId);
      return `<form method="post" action="/homework"><h3>${h(classes.find((c) => c.id === s.classId)?.name)} · ${h(s.period)}</h3><p>${summary.total ? `승인 ${current.length}건 · 정답 ${summary.correct}/${summary.total}문항` : '현재 승인 결과 없음'} · ${active ? '공개 중' : prior?.payload ? '원본 변경으로 상담 사용 중지' : prior ? '공개 철회됨' : '미공개'}</p>
    <input type="hidden" name="studentId" value="${h(studentId)}"><input type="hidden" name="classId" value="${h(s.classId)}"><input type="hidden" name="period" value="${s.period}"><input type="hidden" name="publicationRevision" value="${prior?.revision ?? 0}"><input type="hidden" name="fingerprint" value="${workbookFingerprint(current)}">
    ${!canPublish ? '<p>현재 수강 중인 반이 아니므로 기존 공개의 철회만 할 수 있습니다.</p>' : ''}${!complete ? '<p role="alert">승인 기록과 최종 결과가 일치하지 않아 공개할 수 없습니다.</p>' : ''}${summary.total && complete && canPublish && !active ? '<button name="action" value="publish-analysis">승인 분석을 상담에 공개</button>' : ''}${prior?.payload ? '<button name="action" value="withdraw-analysis" class="secondary">상담 공개 철회</button>' : ''}${active ? `<a href="/homework?view=source&amp;publication=${id}">공개 근거 확인</a>` : ''}</form>`;
    })
    .join('')}</section>`;
}

export function renderWorkbookSource(ctx: PageContext, id: string) {
  const p = latest(ctx.db, ctx.actor.academyId, id);
  const payload =
    p && isWorkbookPublication(id)
      ? payloadFor(
          ctx.db,
          ctx.actor.academyId,
          p,
          readWorkbookAnalysis(ctx.db, ctx.actor.academyId).results,
        )
      : null;
  const students = accessibleStudents(ctx.db, ctx.actor),
    document = payload?.documents[0];
  if (
    !document ||
    !canReadRecord(
      {
        actorId: ctx.actor.id,
        academyId: ctx.actor.academyId,
        role: ctx.actor.role,
        allowedStudentIds: students.map((s) => s.id),
        allowedClassIds: accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
        studentRefs: students.map((s) => ({
          studentId: s.id,
          displayLabel: s.name,
          aliases: [s.name],
          classIds: s.classIds,
        })),
        canViewPublicHistory: false,
      },
      {
        ...document,
        studentId: document.studentId ?? null,
        classId: document.classId ?? null,
      },
      students.map((s) => s.id),
    )
  )
    throw new OperationError('조회 가능한 최신 상담 근거가 아닙니다.', 404);
  return `<section class="panel source-record"><h1>${h(document.title)}</h1><p>상담 공개 버전 ${p!.revision}</p><p class="preserve">${h(document.text)}</p>${ctx.actor.role === 'student' ? '<a href="/learning">학습 기록으로</a>' : '<a href="/consultation">상담으로</a>'}</section>`;
}
