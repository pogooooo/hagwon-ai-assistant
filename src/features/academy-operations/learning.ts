import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ApprovedFactInput,
  SourceDocumentInput,
} from '../rag-consultation/server/types.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import {
  analyze,
  outcomesFromWrongList,
  parseGradedResults,
  parseClassification,
  tagCatalog,
  type LearningSummary,
  type Outcome,
} from './classification.ts';
import {
  escapeHtml as h,
  field,
  one,
  OperationError,
  required,
  rows,
  transaction,
  type PageContext,
  type OperationModule,
} from './shared.ts';

interface Assignment {
  academy_id: string;
  assignment_id: string;
  class_id: string;
  title: string;
  period: string;
  revision: number;
  classification: string;
  classified_at: string;
}
interface Result {
  assignment_id: string;
  student_id: string;
  revision: number;
  classification_revision: number;
  outcomes: string;
  summary: string | null;
  state: 'draft' | 'confirmed' | 'withdrawn';
  created_at: string;
}
interface Publication {
  id: string;
  academy_id: string;
  student_id: string;
  class_id: string;
  period: string;
  revision: number;
  payload: string | null;
  created_at: string;
}
const maxJsonBytes = 2 * 1024 * 1024;
const staff = (ctx: PageContext) =>
  ['admin', 'teacher'].includes(ctx.actor.role);
const key = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

export function setupLearning(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_learning_assignments (
      academy_id TEXT NOT NULL, assignment_id TEXT NOT NULL, class_id TEXT NOT NULL REFERENCES classes(id),
      title TEXT NOT NULL, period TEXT NOT NULL, revision INTEGER NOT NULL, classification TEXT NOT NULL, classified_at TEXT NOT NULL,
      PRIMARY KEY(academy_id, assignment_id));
    CREATE TABLE IF NOT EXISTS op_learning_classification_versions (
      academy_id TEXT NOT NULL, assignment_id TEXT NOT NULL, revision INTEGER NOT NULL, classification TEXT NOT NULL,
      imported_by TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(academy_id, assignment_id, revision));
    CREATE TABLE IF NOT EXISTS op_learning_results (
      academy_id TEXT NOT NULL, assignment_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES students(id), revision INTEGER NOT NULL,
      classification_revision INTEGER NOT NULL, outcomes TEXT NOT NULL, summary TEXT, state TEXT NOT NULL CHECK(state IN ('draft','confirmed','withdrawn')),
      actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(academy_id, assignment_id, student_id, revision));
    CREATE TABLE IF NOT EXISTS op_learning_publications (
      id TEXT NOT NULL, academy_id TEXT NOT NULL, student_id TEXT NOT NULL, class_id TEXT NOT NULL, period TEXT NOT NULL,
      revision INTEGER NOT NULL, payload TEXT, created_at TEXT NOT NULL, PRIMARY KEY(id, revision));
    CREATE INDEX IF NOT EXISTS op_learning_current ON op_learning_publications(academy_id, student_id, class_id, period, revision);
  `);
}

function ownsHistoricResult(
  ctx: PageContext,
  assignmentId: string,
  studentId?: string,
) {
  if (staff(ctx)) return false;
  return accessibleStudents(ctx.db, ctx.actor).some(
    (s) =>
      (!studentId || s.id === studentId) &&
      one(
        ctx.db,
        'SELECT 1 FROM op_learning_results WHERE academy_id=? AND assignment_id=? AND student_id=? LIMIT 1',
        ctx.actor.academyId,
        assignmentId,
        s.id,
      ),
  );
}
function assignmentFor(ctx: PageContext, id: string): Assignment {
  const row = one<Assignment>(
    ctx.db,
    'SELECT * FROM op_learning_assignments WHERE academy_id = ? AND assignment_id = ?',
    ctx.actor.academyId,
    id,
  );
  if (
    !row ||
    (!accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === row.class_id) &&
      !ownsHistoricResult(ctx, id))
  )
    throw new OperationError('조회 가능한 분류 숙제가 아닙니다.', 404);
  return row;
}
function currentResult(
  db: DatabaseSync,
  academy: string,
  assignment: string,
  student: string,
) {
  return one<Result>(
    db,
    'SELECT * FROM op_learning_results WHERE academy_id = ? AND assignment_id = ? AND student_id = ? ORDER BY revision DESC LIMIT 1',
    academy,
    assignment,
    student,
  );
}
function requireStudent(ctx: PageContext, assignment: Assignment, id: string) {
  const student = accessibleStudents(ctx.db, ctx.actor).find(
    (s) => s.id === id && s.classIds.includes(assignment.class_id),
  );
  if (!student)
    throw new OperationError('이 숙제의 원생을 조회할 권한이 없습니다.', 403);
  return student;
}
function expectedRevision(form: FormData, actual: number, name = 'revision') {
  if (field(form, name, 12) !== String(actual))
    throw new OperationError(
      '자료가 변경되었습니다. 새로 열고 다시 제출해 주세요.',
      409,
    );
}

/** Rebuild one monthly publication from current, reviewed rows only. Never sum overlapping tag counts as overall counts. */
function publish(
  db: DatabaseSync,
  academy: string,
  student: string,
  classId: string,
  period: string,
  at: string,
) {
  const current = rows<
    Assignment & Result & { result_revision: number; reviewed_at: string }
  >(
    db,
    `SELECT a.*, r.student_id, r.outcomes, r.summary, r.state, r.classification_revision, r.revision AS result_revision, r.created_at AS reviewed_at FROM op_learning_assignments a
    JOIN op_learning_results r ON r.academy_id = a.academy_id AND r.assignment_id = a.assignment_id
    WHERE a.academy_id = ? AND a.class_id = ? AND a.period = ? AND r.student_id = ? AND r.state = 'confirmed' AND r.classification_revision = a.revision
      AND r.revision = (SELECT MAX(x.revision) FROM op_learning_results x WHERE x.academy_id = r.academy_id AND x.assignment_id = r.assignment_id AND x.student_id = r.student_id)
    ORDER BY a.assignment_id`,
    academy,
    classId,
    period,
    student,
  );
  const id = 'learning-' + key(academy, student, classId, period);
  const revision =
    (one<{ revision: number }>(
      db,
      'SELECT MAX(revision) AS revision FROM op_learning_publications WHERE id = ?',
      id,
    )?.revision ?? 0) + 1;
  // A draft is not a published revision. Only previously published records need a tombstone.
  if (revision === 1 && current.length === 0) return;
  const documents: SourceDocumentInput[] = [];
  const facts: ApprovedFactInput[] = [];
  if (current.length) {
    const subject =
      JSON.parse(current[0].classification).subject === 'M' ? '수학' : '영어';
    const name = one<{ name: string }>(
      db,
      'SELECT name FROM students WHERE academy_id = ? AND id = ?',
      academy,
      student,
    )!.name;
    const summaries = current.map(
      (r) => JSON.parse(r.summary!) as LearningSummary,
    );
    const groups = new Map<
      string,
      {
        name: string;
        dimension: 'overall' | 'unit' | 'question_type';
        correct: number;
        total: number;
        referenceOnly: boolean;
      }
    >();
    const add = (
      name: string,
      dimension: 'overall' | 'unit' | 'question_type',
      correct: number,
      total: number,
      referenceOnly = false,
    ) => {
      const id = JSON.stringify([dimension, name]);
      const g = groups.get(id) ?? {
        name,
        dimension,
        correct: 0,
        total: 0,
        referenceOnly,
      };
      g.correct += correct;
      g.total += total;
      groups.set(id, g);
    };
    for (const s of summaries) {
      add('전체', 'overall', s.correct, s.assessed);
      for (const a of s.areas) add(a.name, 'unit', a.correct, a.total);
      for (const t of s.tags)
        add(t.name, 'question_type', t.correct, t.total, t.referenceOnly);
    }
    const assignments = current.map((r) => ({
      assignmentId: r.assignment_id,
      title: r.title,
    }));
    const sourceId = `${id}:r${revision}:body`;
    const title = `${name} ${period} ${subject} 확정 학습 기록`;
    const itemCount = summaries.reduce((n, s) => n + s.itemCount, 0);
    const unknown = summaries.reduce((n, s) => n + s.unknown, 0);
    const unclassified = summaries.reduce((n, s) => n + s.unclassified, 0);
    const unclassifiedWrong = summaries.reduce(
      (n, s) => n + s.unclassifiedWrong,
      0,
    );
    const text = [
      `# ${title}`,
      `분석 기준 classification-v1. 기준서 1.0. 전체 ${itemCount}문항, 결과 미확인 ${unknown}문항, 분류 제외 ${unclassified}문항(오답 ${unclassifiedWrong}문항).`,
      '정답률은 분류 가능한 문항 중 결과가 확인된 문항만 분모로 사용합니다. 유형별 집계는 채택 태그만 쓰며 중복 유형을 합산해 전체 문항 수로 사용하지 않습니다. 수학 세부 유형은 참고용이며 능력 진단이 아닙니다.',
      ...[...groups.values()]
        .filter((g) => g.total > 0)
        .map(
          (g) =>
            `${g.name}${g.referenceOnly ? ' (참고용)' : ''}: ${g.total}문항 중 ${g.correct}문항 정답.`,
        ),
      ...current.map(
        (r) =>
          `근거 숙제 ${r.title} (${r.assignment_id}), 분류 버전 ${r.revision}, 결과 검수 버전 ${r.result_revision}.`,
      ),
    ].join('\n\n');
    documents.push({
      academyId: academy,
      documentId: id,
      revision,
      sourceId,
      title,
      documentType: 'student_analysis',
      text,
      visibility: 'student_private',
      studentId: student,
      classId,
      validFrom: at,
      approvedAt: at,
      sourceUpdatedAt: at,
    });
    for (const g of groups.values())
      if (g.total > 0)
        facts.push({
          factId: `${id}:r${revision}:${key(g.dimension, g.name)}`,
          sourceId,
          documentId: id,
          revision,
          academyId: academy,
          subjectType: 'student',
          subjectId: student,
          factType: 'accuracy',
          period,
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
            basis: 'classified_assessed',
          },
          evidence: `분석 기준 classification-v1. 결과 미확인 ${unknown}문항은 정답률에서 제외. 쪽수·문항별 검수 결과와 분류 버전은 학습 기록에서 확인합니다.`,
        });
  }
  db.prepare(
    'INSERT INTO op_learning_publications (id, academy_id, student_id, class_id, period, revision, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    academy,
    student,
    classId,
    period,
    revision,
    documents.length
      ? JSON.stringify({
          documents,
          facts,
          provenance: current.map((r) => ({
            assignmentId: r.assignment_id,
            classificationRevision: r.revision,
            resultRevision: r.result_revision,
            reviewedAt: r.reviewed_at,
            algorithm: 'classification-v1',
          })),
        })
      : null,
    at,
  );
}

export function learningEvidence(
  db: DatabaseSync,
  academy: string,
): { documents: SourceDocumentInput[]; facts: ApprovedFactInput[] } {
  // Joining the live roster prevents former teachers from finding reports through the old class scope.
  const publications = rows<Publication>(
    db,
    `SELECT p.* FROM op_learning_publications p JOIN students s ON s.id = p.student_id AND s.academy_id = p.academy_id
    WHERE p.academy_id = ? AND p.revision = (SELECT MAX(x.revision) FROM op_learning_publications x WHERE x.id = p.id) ORDER BY p.id`,
    academy,
  );
  const result: {
    documents: SourceDocumentInput[];
    facts: ApprovedFactInput[];
  } = { documents: [], facts: [] };
  for (const p of publications)
    if (p.payload) {
      const parsed = JSON.parse(p.payload) as typeof result;
      result.documents.push(...parsed.documents);
      result.facts.push(...parsed.facts);
    }
  return result;
}

async function submit(ctx: PageContext, form: FormData) {
  const action = required(form, 'action', '작업');
  if (action === 'import') {
    if (!staff(ctx))
      throw new OperationError('분류 등록 권한이 없습니다.', 403);
    const file = form.get('classificationFile');
    if (file instanceof File && file.size > maxJsonBytes)
      throw new OperationError('분류 파일은 2MB 이하로 올려 주세요.', 413);
    const content =
      file instanceof File && file.size
        ? await file.text()
        : required(form, 'classification', '분류 JSON', maxJsonBytes);
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new OperationError('올바른 JSON 파일을 올려 주세요.', 422);
    }
    const data = parseClassification(raw);
    const title = required(form, 'title', '숙제 제목', 120);
    const classId = required(form, 'classId', '반', 128);
    const period = required(form, 'period', '분석 월', 7);
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) ||
      Date.parse(data.classifiedAt) > Date.now() + 300000
    )
      throw new OperationError('분석 월 또는 분류 시각을 확인해 주세요.', 422);
    transaction(ctx.db, () => {
      ctx.assertCurrentAccess?.();
      const klass = accessibleClasses(ctx.db, ctx.actor).find(
        (c) => c.id === classId,
      );
      if (!klass) throw new OperationError('반 관리 권한이 없습니다.', 403);
      const math = /수학|math/i.test(klass.subject);
      const english = /영어|english/i.test(klass.subject);
      if (math && english)
        throw new OperationError(
          '혼합 과목 반은 과목별 반으로 구분한 뒤 분류를 등록해 주세요.',
          422,
        );
      if (data.subject === 'M' ? !math : !english)
        throw new OperationError(
          '반의 과목과 분류 과목이 일치하지 않습니다.',
          422,
        );
      const previous = one<Assignment>(
        ctx.db,
        'SELECT * FROM op_learning_assignments WHERE academy_id = ? AND assignment_id = ?',
        ctx.actor.academyId,
        data.assignmentId,
      );
      if (previous && previous.class_id !== classId)
        throw new OperationError(
          '같은 숙제 ID의 반을 변경할 수 없습니다.',
          409,
        );
      const normalized = JSON.stringify(data);
      if (
        previous?.classification === normalized &&
        previous.title === title &&
        previous.period === period
      )
        return;
      expectedRevision(form, previous?.revision ?? 0);
      if (
        previous &&
        Date.parse(data.classifiedAt) <= Date.parse(previous.classified_at)
      )
        throw new OperationError(
          '다시 분류한 파일은 기존 분류보다 새 시각이어야 합니다.',
          409,
        );
      if (previous && previous.period !== period)
        throw new OperationError(
          '등록된 숙제의 분석 월을 변경할 수 없습니다.',
          409,
        );
      const at = new Date().toISOString();
      const revision = (previous?.revision ?? 0) + 1;
      ctx.db
        .prepare(
          `INSERT INTO op_learning_assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(academy_id, assignment_id) DO UPDATE SET title=excluded.title, revision=excluded.revision, classification=excluded.classification, classified_at=excluded.classified_at`,
        )
        .run(
          ctx.actor.academyId,
          data.assignmentId,
          classId,
          title,
          period,
          revision,
          normalized,
          data.classifiedAt,
        );
      ctx.db
        .prepare(
          'INSERT INTO op_learning_classification_versions VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          ctx.actor.academyId,
          data.assignmentId,
          revision,
          normalized,
          ctx.actor.id,
          at,
        );
      for (const { student_id } of rows<{ student_id: string }>(
        ctx.db,
        'SELECT DISTINCT student_id FROM op_learning_results WHERE academy_id = ? AND assignment_id = ?',
        ctx.actor.academyId,
        data.assignmentId,
      ))
        publish(ctx.db, ctx.actor.academyId, student_id, classId, period, at);
    });
    return '/learning?assignment=' + encodeURIComponent(data.assignmentId);
  }
  let gradedInput: unknown;
  if (action === 'results-import') {
    if (!staff(ctx))
      throw new OperationError(
        '담당 교직원만 채점 결과를 가져올 수 있습니다.',
        403,
      );
    const file = form.get('resultsFile');
    if (file instanceof File && file.size > maxJsonBytes)
      throw new OperationError('결과 파일은 2MB 이하여야 합니다.', 422);
    const text =
      file instanceof File && file.size
        ? await file.text()
        : required(form, 'gradedResults', '채점 결과 JSON', maxJsonBytes);
    try {
      gradedInput = JSON.parse(text);
    } catch {
      throw new OperationError('채점 결과 JSON을 확인해 주세요.', 422);
    }
  }
  const id = required(form, 'assignmentId', '숙제', 128);
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const assignment = assignmentFor(ctx, id);
    const student = required(form, 'studentId', '학생', 128);
    requireStudent(ctx, assignment, student);
    const previous = currentResult(ctx.db, ctx.actor.academyId, id, student);
    expectedRevision(form, previous?.revision ?? 0);
    expectedRevision(form, assignment.revision, 'classificationRevision');
    const at = new Date().toISOString();
    const data = parseClassification(JSON.parse(assignment.classification));
    let state: Result['state'];
    let outcomes: Record<string, Outcome>;
    let summary: LearningSummary | null = null;
    if (action === 'results' || action === 'results-import') {
      if (
        !staff(ctx) &&
        (ctx.actor.role !== 'student' || ctx.actor.studentId !== student)
      )
        throw new OperationError(
          '학생 본인 또는 담당 강사가 결과를 등록할 수 있습니다.',
          403,
        );
      outcomes =
        action === 'results-import'
          ? parseGradedResults(gradedInput, data, student, assignment.revision)
          : outcomesFromWrongList(
              data,
              field(form, 'wrongItems', 80000),
              field(form, 'complete') === 'yes',
            );
      state = 'draft';
    } else if ((action === 'confirm' || action === 'withdraw') && staff(ctx)) {
      if (
        !previous ||
        previous.classification_revision !== assignment.revision ||
        (action === 'confirm' && previous.state !== 'draft') ||
        (action === 'withdraw' && previous.state !== 'confirmed')
      )
        throw new OperationError('현재 분류에 맞는 검수 대상이 없습니다.', 409);
      outcomes = JSON.parse(previous.outcomes);
      state = action === 'confirm' ? 'confirmed' : 'withdrawn';
      if (state === 'confirmed') summary = analyze(data, outcomes);
    } else throw new OperationError('분석 검수 권한이 없습니다.', 403);
    const reason = required(form, 'reason', '등록·검수 사유', 500);
    ctx.db
      .prepare(
        'INSERT INTO op_learning_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        ctx.actor.academyId,
        id,
        student,
        (previous?.revision ?? 0) + 1,
        assignment.revision,
        JSON.stringify(outcomes),
        summary ? JSON.stringify(summary) : null,
        state,
        ctx.actor.id,
        reason,
        at,
      );
    publish(
      ctx.db,
      ctx.actor.academyId,
      student,
      assignment.class_id,
      assignment.period,
      at,
    );
  });
  return (
    '/learning?assignment=' +
    encodeURIComponent(id) +
    '&student=' +
    encodeURIComponent(field(form, 'studentId'))
  );
}

function table(summary: LearningSummary) {
  const percent = (correct: number, total: number) =>
    total ? ((100 * correct) / total).toFixed(1) + '%' : '집계 없음';
  const metric = (label: string, correct: number, total: number) =>
    `<article class="metric-card"><small>${h(label)}</small><strong>${percent(correct, total)}</strong><p>${total}문항 중 ${correct}문항 정답</p><progress value="${correct}" max="${total || 1}"></progress></article>`;
  return `<div class="learning-metrics">${metric('분류 가능한 확인 결과', summary.correct, summary.assessed)}${summary.areas.map((a) => metric(a.name, a.correct, a.total)).join('')}</div>
    <p class="muted">등록 ${summary.itemCount}문항 · 결과 미확인 ${summary.unknown}문항 · 분류 제외 ${summary.unclassified}문항(오답 ${summary.unclassifiedWrong}문항)</p>
    <div class="table-wrap"><table><caption>채택 태그별 결과</caption><thead><tr><th>유형</th><th>영역</th><th>정답 / 확인 문항</th><th>정답률</th></tr></thead><tbody>${summary.tags.map((t) => `<tr><td>${h(t.name)}${t.referenceOnly ? ' <span class="pill">참고용</span>' : ''}</td><td>${h(t.area)}</td><td>${t.correct} / ${t.total}</td><td>${percent(t.correct, t.total)}</td></tr>`).join('')}</tbody></table></div>`;
}

function render(ctx: PageContext) {
  const publicationId = ctx.url.searchParams.get('publication');
  if (publicationId) {
    const publication = one<Publication>(
      ctx.db,
      'SELECT * FROM op_learning_publications WHERE academy_id = ? AND id = ? ORDER BY revision DESC LIMIT 1',
      ctx.actor.academyId,
      publicationId,
    );
    if (
      !publication?.payload ||
      !accessibleStudents(ctx.db, ctx.actor).some(
        (s) =>
          s.id === publication.student_id &&
          (!staff(ctx) || s.classIds.includes(publication.class_id)),
      )
    )
      throw new OperationError('조회 가능한 학습 근거가 아닙니다.', 404);
    const payload = JSON.parse(publication.payload) as {
      documents: SourceDocumentInput[];
      facts: ApprovedFactInput[];
    };
    const assignments = [
      ...new Map(
        payload.facts
          .flatMap((f) => f.assignments ?? [])
          .map((a) => [a.assignmentId, a]),
      ).values(),
    ];
    return (
      '<section class="panel source-record"><h1>상담에 사용된 확정 학습 기록</h1><p class="preserve">' +
      h(payload.documents[0].text) +
      '</p><p>분석 버전 ' +
      publication.revision +
      '</p><ul>' +
      assignments
        .map(
          (a) =>
            '<li><a href="/learning?assignment=' +
            encodeURIComponent(a.assignmentId) +
            '&amp;student=' +
            encodeURIComponent(publication.student_id) +
            '">' +
            h(a.title) +
            ' · 문항별 근거 확인</a></li>',
        )
        .join('') +
      '</ul><a href="/consultation">상담으로 돌아가기</a></section>'
    );
  }

  const classes = accessibleClasses(ctx.db, ctx.actor);
  const assignments = rows<Assignment>(
    ctx.db,
    'SELECT * FROM op_learning_assignments WHERE academy_id = ? ORDER BY period DESC, assignment_id',
    ctx.actor.academyId,
  ).filter(
    (a) =>
      classes.some((c) => c.id === a.class_id) ||
      ownsHistoricResult(ctx, a.assignment_id),
  );
  const id = ctx.url.searchParams.get('assignment');
  const assignment = id ? assignmentFor(ctx, id) : undefined;
  const students = accessibleStudents(ctx.db, ctx.actor).filter(
    (s) =>
      !assignment ||
      s.classIds.includes(assignment.class_id) ||
      ownsHistoricResult(ctx, assignment.assignment_id, s.id),
  );
  const selected =
    ctx.url.searchParams.get('student') ??
    (students.length === 1 ? students[0].id : '');
  if (
    selected &&
    assignment &&
    !ownsHistoricResult(ctx, assignment.assignment_id, selected)
  )
    requireStudent(ctx, assignment, selected);
  const result =
    assignment && selected
      ? currentResult(
          ctx.db,
          ctx.actor.academyId,
          assignment.assignment_id,
          selected,
        )
      : undefined;
  const data = assignment
    ? parseClassification(JSON.parse(assignment.classification))
    : undefined;
  const usable = result?.classification_revision === assignment?.revision;
  const outcomes: Record<string, Outcome> =
    usable && result ? JSON.parse(result.outcomes) : {};
  const hidden = assignment
    ? `<input type="hidden" name="assignmentId" value="${h(assignment.assignment_id)}"><input type="hidden" name="studentId" value="${h(selected)}"><input type="hidden" name="revision" value="${result?.revision ?? 0}"><input type="hidden" name="classificationRevision" value="${assignment.revision}">`
    : '';
  return `<div class="page-heading"><h1>학습 기록</h1></div>
    ${staff(ctx) ? `<details class="panel" ${assignments.length ? '' : 'open'}><summary>팀 분류 JSON 등록${assignment ? ' · 선택 숙제 갱신' : ''}</summary><form method="post" enctype="multipart/form-data"><input type="hidden" name="action" value="import"><input type="hidden" name="revision" value="${assignment?.revision ?? 0}"><div class="fields"><label>반<select name="classId" required>${classes.map((c) => `<option value="${h(c.id)}"${assignment?.class_id === c.id ? ' selected' : ''}>${h(c.name)}</option>`).join('')}</select></label><label>숙제 제목<input name="title" required maxlength="120" value="${h(assignment?.title)}"></label><label>분석 월<input type="month" name="period" required value="${h(assignment?.period)}"></label></div><label>분류 파일<input type="file" name="classificationFile" accept=".json,application/json"></label><label>또는 JSON 붙여넣기<textarea name="classification" rows="4" maxlength="2097152"></textarea></label><p class="muted">같은 숙제는 파일 전체를 교체합니다. 재분류 후에는 학생 결과를 다시 검수해야 상담에 반영됩니다.</p><button>분류 등록</button></form></details>` : ''}
    <div class="split learning-layout"><section class="panel"><h2>숙제 목록</h2><ul class="item-list">${assignments.map((a) => `<li><a href="/learning?assignment=${encodeURIComponent(a.assignment_id)}">${h(a.title)}</a><small>${h(a.period)} · 분류 v${a.revision} · ${h(a.assignment_id)}</small></li>`).join('') || '<li>등록된 분류 숙제가 없습니다.</li>'}</ul></section>
    <section class="panel">${
      assignment && data
        ? `<div class="panel-heading"><h2>${h(assignment.title)}</h2><span class="pill">분류 v${assignment.revision}</span></div><form method="get"><input type="hidden" name="assignment" value="${h(assignment.assignment_id)}"><label>대상 학생<select name="student" required><option value="">학생 선택</option>${students.map((s) => `<option value="${h(s.id)}"${selected === s.id ? ' selected' : ''}>${h(s.name)}</option>`).join('')}</select></label><button class="secondary">조회</button></form>
    ${
      selected
        ? `<p class="notice">${result ? (!usable ? '분류가 갱신되어 결과를 다시 입력·검수해야 합니다.' : { draft: '검수 대기 · 상담에 사용하지 않습니다.', confirmed: '검수 확정 · 상담에서 근거로 사용할 수 있습니다.', withdrawn: '철회됨 · 상담에서 제외됩니다.' }[result.state]) : '아직 등록된 결과가 없습니다.'}</p>
    ${usable && result?.state === 'confirmed' && result.summary ? table(JSON.parse(result.summary)) : ''}
    <details><summary>쪽수·문항별 결과와 분류 확인 (${data.items.length}문항)</summary><div class="table-wrap"><table><thead><tr><th>쪽수</th><th>번호</th><th>결과</th><th>채택 유형</th></tr></thead><tbody>${data.items
      .map(
        (i) =>
          `<tr><td>${i.page}</td><td>${h(i.displayNumber)}</td><td>${{ correct: '정답', incorrect: '오답', unknown: '미확인' }[outcomes[i.itemId] ?? 'unknown']}</td><td>${
            i.itemStatus === 'classified'
              ? i.tags
                  .filter((t) => t.status === 'adopted')
                  .map((t) =>
                    h(tagCatalog.tags.find((x) => x.tagId === t.tagId)!.name),
                  )
                  .join(', ')
              : h(
                  {
                    no_adopted: '채택 태그 없음',
                    unreadable: '읽기 불가',
                    out_of_scope: '분류 범위 밖',
                  }[i.itemStatus],
                )
          }</td></tr>`,
      )
      .join('')}</tbody></table></div></details>
    ${
      staff(ctx) ||
      (ctx.actor.role === 'student' &&
        students.some(
          (s) => s.id === selected && s.classIds.includes(assignment.class_id),
        ))
        ? `<details class="result-entry" ${result ? '' : 'open'}><summary>전달받은 결과 등록·수정</summary>${staff(ctx) ? `<form method="post" enctype="multipart/form-data">${hidden}<input type="hidden" name="action" value="results-import"><label>팀 채점 결과 JSON<input type="file" name="resultsFile" accept=".json,application/json" required></label><label>등록 사유<input name="reason" required maxlength="500" value="팀 채점 결과 수신"></label><p class="muted">채점을 수행하지 않습니다. 전달된 정오답을 저장하며 빠진 문항은 미확인으로 둡니다. 검수 후 분석에 반영됩니다.</p><button>결과 가져오기</button></form>` : ''}<form method="post">${hidden}<input type="hidden" name="action" value="results"><label>오답 쪽수 | 번호 (한 줄에 하나)<textarea name="wrongItems" rows="5" placeholder="42 | 1&#10;43 | 1">${data.items
            .filter((i) => outcomes[i.itemId] === 'incorrect')
            .map((i) => h(i.page + ' | ' + i.displayNumber))
            .join(
              '\n',
            )}</textarea></label><label class="check-label"><input type="checkbox" name="complete" value="yes">전체 문항 결과를 확인했습니다. 적지 않은 나머지 문항은 모두 정답입니다.</label><p class="muted">체크하지 않으면 적지 않은 문항은 미확인으로 남습니다.</p><label>등록·수정 사유<input name="reason" required maxlength="500"></label><button>검수 대기로 저장</button></form></details>`
        : ''
    }
    ${staff(ctx) && usable && result && ['draft', 'confirmed'].includes(result.state) ? `<form method="post">${hidden}<label>검수·철회 사유<input name="reason" required maxlength="500"></label><button name="action" value="${result.state === 'draft' ? 'confirm' : 'withdraw'}">${result.state === 'draft' ? '결과 확인 후 분석 확정' : '확정 분석 철회'}</button></form>` : ''}`
        : '<p>학생을 선택하면 문항별 결과를 확인할 수 있습니다.</p>'
    }`
        : '<p>숙제를 선택해 학습 기록을 확인해 주세요.</p>'
    }</section></div>
    <p class="learning-caution">정답률은 분류 가능한 문항 중 결과가 확인된 문항을 기준으로 계산합니다. 참고·보류 태그는 제외하며, 여러 태그에 포함된 문항을 전체 문항 수에 중복 합산하지 않습니다. 수학 세부 유형은 참고용입니다. 이 기록만으로 실력·태도·원인을 단정하지 않습니다.</p>`;
}

export const learningModule: OperationModule = {
  path: '/learning',
  label: '학습 기록',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup: setupLearning,
  render,
  submit,
};
export const learningLabels = [...new Set(tagCatalog.tags.map((t) => t.area))];
export const learningTypes = tagCatalog.tags.map((t) => t.name);
