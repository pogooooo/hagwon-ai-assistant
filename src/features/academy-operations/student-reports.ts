import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demoReports } from './demo-reports.ts';
import {
  buildLearningNarrative,
  comparedReportFingerprint,
  previousReportComparison,
  reportMatchesEvidence,
} from './report-narrative.ts';
import {
  renderReportDocument,
  reportTeacherComment,
  withTeacherComment,
} from './report-document.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import { parseClassification, tagById } from './classification.ts';
import { readWorkbookAnalysis } from './workbook-analysis.ts';
import {
  escapeHtml as h,
  field,
  required,
  rows,
  one,
  transaction,
  OperationError,
  type PageContext,
  type OperationModule,
} from './shared.ts';
import type { OperationsDatabase } from './database.ts';

const staff = (ctx: PageContext) =>
  ['admin', 'teacher'].includes(ctx.actor.role);
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface AdditionalReportEvidence {
  sources: unknown[];
  total: number;
  correct: number;
  unknown: number;
  types: { id: string; name: string; total: number; wrong: number }[];
}
const additionalEvidence = new WeakMap<
  OperationsDatabase,
  (student: string, classId: string, period: string) => AdditionalReportEvidence
>();
/** Optional adapter; the experimental grader stays out of the common main implementation. */
export function registerStudentReportEvidence(
  db: OperationsDatabase,
  read: (
    student: string,
    classId: string,
    period: string,
  ) => AdditionalReportEvidence,
) {
  additionalEvidence.set(db, read);
}
interface Report {
  id: string;
  academy_id: string;
  student_id: string;
  class_id: string;
  period: string;
  version: number;
  state: string;
  body: string;
  counsel: string;
  fingerprint: string;
  approved_by: string | null;
}
export function setupStudentReports(db: OperationsDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_student_reports(id TEXT PRIMARY KEY,academy_id TEXT NOT NULL,student_id TEXT NOT NULL,class_id TEXT NOT NULL,period TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,counsel TEXT NOT NULL,fingerprint TEXT NOT NULL,approved_by TEXT,UNIQUE(academy_id,student_id,class_id,period));
  CREATE TABLE IF NOT EXISTS op_student_attendance(academy_id TEXT NOT NULL,student_id TEXT NOT NULL,class_id TEXT NOT NULL,date TEXT NOT NULL,status TEXT NOT NULL,actor_id TEXT NOT NULL,PRIMARY KEY(academy_id,student_id,class_id,date));
  CREATE TABLE IF NOT EXISTS op_student_report_history(report_id TEXT NOT NULL,version INTEGER NOT NULL,actor_id TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(report_id,version));`);
}
function scope(ctx: PageContext, studentId: string, classId: string) {
  const student = accessibleStudents(ctx.db, ctx.actor).find(
    (s) => s.id === studentId && s.classIds.includes(classId),
  );
  if (
    !student ||
    !accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === classId)
  )
    throw new OperationError('이 학생·반 자료에 접근할 수 없습니다.', 403);
  return student;
}
/** All counters come from the latest teacher-confirmed revision, never an AI draft. */
export function studentReportEvidence(
  ctx: PageContext,
  studentId: string,
  classId: string,
  period: string,
) {
  scope(ctx, studentId, classId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw new OperationError('분석 월을 확인해 주세요.');
  const sources: unknown[] = [];
  const types = new Map<
    string,
    { name: string; wrong: number; total: number }
  >();
  let total = 0,
    correct = 0,
    unknown = 0;
  const add = (tags: { tagId: string; name: string }[], ok: boolean) => {
    for (const t of tags) {
      const v = types.get(t.tagId) ?? { name: t.name, wrong: 0, total: 0 };
      v.total++;
      if (!ok) v.wrong++;
      types.set(t.tagId, v);
    }
  };
  const confirmed = rows<{
    assignment_id: string;
    revision: number;
    classification: string;
    outcomes: string;
    created_at: string;
  }>(
    ctx.db,
    `SELECT a.assignment_id,a.revision,a.classification,r.outcomes,r.created_at FROM op_learning_assignments a JOIN op_learning_results r ON r.academy_id=a.academy_id AND r.assignment_id=a.assignment_id WHERE a.academy_id=? AND a.class_id=? AND a.period=? AND r.student_id=? AND r.state='confirmed' AND r.classification_revision=a.revision AND r.revision=(SELECT MAX(x.revision) FROM op_learning_results x WHERE x.academy_id=r.academy_id AND x.assignment_id=r.assignment_id AND x.student_id=r.student_id) ORDER BY a.assignment_id`,
    ctx.actor.academyId,
    classId,
    period,
    studentId,
  );
  for (const r of confirmed) {
    const c = parseClassification(JSON.parse(r.classification)),
      outcomes = JSON.parse(r.outcomes) as Record<string, string>;
    sources.push(r);
    for (const item of c.items) {
      const result = outcomes[item.itemId];
      if (result !== 'correct' && result !== 'incorrect') {
        unknown++;
        continue;
      }
      total++;
      if (result === 'correct') correct++;
      add(
        item.tags
          .filter((t) => t.status === 'adopted')
          .flatMap((t) => {
            const tag = tagById.get(t.tagId);
            return tag ? [{ tagId: t.tagId, name: tag.name }] : [];
          }),
        result === 'correct',
      );
    }
  }
  for (const r of readWorkbookAnalysis(
    ctx.db,
    ctx.actor.academyId,
  ).results.filter(
    (r) =>
      r.studentId === studentId &&
      r.dueDate.startsWith(period) &&
      r.classes.some((c) => c.id === classId),
  )) {
    sources.push(r);
    for (const q of r.questions) {
      total++;
      if (q.correct) correct++;
      add(
        q.tags.map((t) => ({ tagId: t.tagId, name: t.name })),
        !!q.correct,
      );
    }
  }
  const extra = additionalEvidence.get(ctx.db)?.(studentId, classId, period);
  if (extra) {
    sources.push(...extra.sources);
    total += extra.total;
    correct += extra.correct;
    unknown += extra.unknown;
    for (const t of extra.types) {
      const prior = types.get(t.id) ?? { name: t.name, total: 0, wrong: 0 };
      prior.total += t.total;
      prior.wrong += t.wrong;
      types.set(t.id, prior);
    }
  }
  const attendance = rows<{ date: string; status: string; actor_id: string }>(
    ctx.db,
    'SELECT date,status,actor_id FROM op_student_attendance WHERE academy_id=? AND student_id=? AND class_id=? AND date LIKE ? ORDER BY date',
    ctx.actor.academyId,
    studentId,
    classId,
    period + '-%',
  );
  const repeated = [...types.values()]
    .filter((t) => t.wrong >= 2)
    .sort((a, b) => b.wrong - a.wrong || a.name.localeCompare(b.name));
  const suggestions = [...types.values()]
    .filter((t) => t.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong || a.name.localeCompare(b.name))
    .slice(0, 3);
  return {
    total,
    correct,
    unknown,
    types: [...types].map(([id, type]) => ({ ...type, id })),
    repeated,
    suggestions,
    attendance,
    fingerprint: hash({ sources, attendance }),
    sourceCount: sources.length,
  };
}
function priorComparison(
  ctx: PageContext,
  student: string,
  klass: string,
  month: string,
  types: ReturnType<typeof studentReportEvidence>['types'],
) {
  return previousReportComparison(
    month,
    types,
    (period) => studentReportEvidence(ctx, student, klass, period).types,
  );
}

function matchesReport(
  ctx: PageContext,
  report: Report,
  current = studentReportEvidence(
    ctx,
    report.student_id,
    report.class_id,
    report.period,
  ),
) {
  return reportMatchesEvidence(report.fingerprint, current.fingerprint, () => {
    const previous = priorComparison(
      ctx,
      report.student_id,
      report.class_id,
      report.period,
      current.types,
    );
    return previous && hash(previous);
  });
}

function draft(
  ctx: PageContext,
  studentId: string,
  classId: string,
  period: string,
) {
  const student = scope(ctx, studentId, classId);
  const current = studentReportEvidence(ctx, studentId, classId, period);
  const comparison = priorComparison(
    ctx,
    studentId,
    classId,
    period,
    current.types,
  );
  const attendance = { present: 0, late: 0, absent: 0 };
  for (const { status } of current.attendance) {
    if (status === 'present' || status === 'late' || status === 'absent')
      attendance[status]++;
  }
  const narrative = buildLearningNarrative(
    { ...current, attendance },
    comparison,
  );
  const title = student.name + ' · ' + period + ' 월간 리포트';
  return {
    body: '# ' + title + '\n\n' + narrative.body,
    counsel: narrative.teacher.replace(
      '# 교사용 상담 자료 초안',
      '# 교사용 상담 자료 초안 · ' + title,
    ),
    fingerprint: comparison
      ? comparedReportFingerprint(current.fingerprint, hash(comparison))
      : current.fingerprint,
  };
}
function load(ctx: PageContext, id: string) {
  const r = one<Report>(
    ctx.db,
    'SELECT * FROM op_student_reports WHERE academy_id=? AND id=?',
    ctx.actor.academyId,
    id,
  );
  if (!r) throw new OperationError('리포트를 찾을 수 없습니다.', 404);
  scope(ctx, r.student_id, r.class_id);
  if (
    !staff(ctx) &&
    (ctx.actor.role !== 'guardian' ||
      r.state !== 'approved' ||
      !matchesReport(ctx, r))
  )
    throw new OperationError(
      '교사가 승인한 최신 리포트만 보호자에게 공개됩니다.',
      403,
    );
  return r;
}
function recordHistory(
  ctx: PageContext,
  report: Pick<Report, 'id' | 'version' | 'state' | 'body'>,
) {
  ctx.db
    .prepare('INSERT INTO op_student_report_history VALUES(?,?,?,?,?,?)')
    .run(
      report.id,
      report.version,
      ctx.actor.id,
      report.state,
      report.body,
      new Date().toISOString(),
    );
}
function reportEnrollment(form: FormData) {
  if (form.has('enrollment')) {
    const raw = required(form, 'enrollment', '학생과 수강 반');
    const match = /^([^:]+):([^:]+)$/u.exec(raw);
    if (match) {
      try {
        return [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
      } catch {
        // Malformed form input is handled as a selection error.
      }
    }
    throw new OperationError('학생과 수강 반을 다시 선택해 주세요.');
  }
  return [required(form, 'student', '학생'), required(form, 'class', '반')];
}

function submit(ctx: PageContext, form: FormData) {
  if (!staff(ctx))
    throw new OperationError('담당 교사만 분석·편집·승인할 수 있습니다.', 403);
  return transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const action = required(form, 'action', '작업');
    if (action === 'attendance') {
      const [student, klass] = reportEnrollment(form);
      const date = required(form, 'date', '날짜'),
        status = required(form, 'status', '출결');
      scope(ctx, student, klass);
      if (
        !z.iso.date().safeParse(date).success ||
        !['present', 'late', 'absent'].includes(status) ||
        date > new Date(Date.now() + 32400000).toISOString().slice(0, 10)
      )
        throw new OperationError('과거 또는 오늘의 실제 출결을 선택해 주세요.');
      const change = ctx.db
        .prepare(
          'INSERT INTO op_student_attendance VALUES(?,?,?,?,?,?) ON CONFLICT(academy_id,student_id,class_id,date) DO UPDATE SET status=excluded.status,actor_id=excluded.actor_id WHERE op_student_attendance.status<>excluded.status',
        )
        .run(ctx.actor.academyId, student, klass, date, status, ctx.actor.id);
      if (change.changes) {
        const revoked = one<Pick<Report, 'id' | 'version' | 'state' | 'body'>>(
          ctx.db,
          "UPDATE op_student_reports SET state='draft', approved_by=NULL, version=version+1 WHERE academy_id=? AND student_id=? AND class_id=? AND period=? AND state='approved' RETURNING id,version,state,body",
          ctx.actor.academyId,
          student,
          klass,
          date.slice(0, 7),
        );
        if (revoked) recordHistory(ctx, revoked);
      }
      return '/student-reports';
    }
    let r: Report;
    if (action === 'analyze') {
      const [student, klass] = reportEnrollment(form);
      const period = required(form, 'period', '분석 월');
      scope(ctx, student, klass);
      const old = one<Report>(
        ctx.db,
        'SELECT * FROM op_student_reports WHERE academy_id=? AND student_id=? AND class_id=? AND period=?',
        ctx.actor.academyId,
        student,
        klass,
        period,
      );
      const version = field(form, 'version');
      if (old && !version) return '/student-reports?id=' + old.id;
      if (version && (!old || version !== String(old.version)))
        throw new OperationError(
          '리포트가 변경되었습니다. 아래 최신 내용을 확인해 주세요.',
          409,
        );
      const result = draft(ctx, student, klass, period);
      r = {
        id: old?.id ?? randomUUID(),
        academy_id: ctx.actor.academyId,
        student_id: student,
        class_id: klass,
        period,
        version: (old?.version ?? 0) + 1,
        state: 'draft',
        body: old
          ? withTeacherComment(
              result.body,
              reportTeacherComment(old.body).comment,
            )
          : result.body,
        counsel: result.counsel,
        fingerprint: result.fingerprint,
        approved_by: null,
      };
      ctx.db
        .prepare(
          'INSERT INTO op_student_reports VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,body=excluded.body,counsel=excluded.counsel,fingerprint=excluded.fingerprint,approved_by=NULL',
        )
        .run(
          r.id,
          r.academy_id,
          r.student_id,
          r.class_id,
          r.period,
          r.version,
          r.state,
          r.body,
          r.counsel,
          r.fingerprint,
          null,
        );
    } else {
      r = load(ctx, required(form, 'id', '리포트'));
      if (field(form, 'version') !== String(r.version))
        throw new OperationError(
          '리포트가 변경되었습니다. 다시 확인해 주세요.',
          409,
        );
      const current = studentReportEvidence(
        ctx,
        r.student_id,
        r.class_id,
        r.period,
      );
      if (action !== 'withdraw' && !matchesReport(ctx, r, current))
        throw new OperationError(
          '채점·출결 근거가 바뀌었습니다. 다시 분석하고 검토해 주세요.',
          409,
        );
      if (action === 'save') {
        const body = required(form, 'body', '리포트', 10000);
        r.body = form.has('comment')
          ? withTeacherComment(
              reportTeacherComment(body).body,
              field(form, 'comment', 1500),
            )
          : body;
        r.counsel = required(form, 'counsel', '상담 자료', 10000);
        r.state = 'draft';
        r.approved_by = null;
      } else if (action === 'approve') {
        if (r.state !== 'draft' || field(form, 'reviewed') !== 'yes')
          throw new OperationError(
            '저장한 초안을 검토한 뒤 승인해 주세요.',
            409,
          );
        if (!current.sourceCount && !current.attendance.length)
          throw new OperationError(
            '근거 기록이 없어 공개할 수 없습니다. 기록 없음 안내는 교사에게만 표시합니다.',
            422,
          );
        r.state = 'approved';
        r.approved_by = ctx.actor.id;
      } else if (action === 'withdraw') {
        r.state = 'draft';
        r.approved_by = null;
      } else throw new OperationError('지원하지 않는 작업입니다.');
      r.version++;
      ctx.db
        .prepare(
          'UPDATE op_student_reports SET version=?,state=?,body=?,counsel=?,approved_by=? WHERE id=?',
        )
        .run(r.version, r.state, r.body, r.counsel, r.approved_by, r.id);
    }
    recordHistory(ctx, r);
    return '/student-reports?id=' + r.id;
  });
}
interface AssignmentResult {
  href: string;
  title: string;
  studentName: string;
  date: string;
}

function monthLabel(period: string) {
  return period.replace(/^(\d{4})-0?(\d{1,2})$/u, '$1년 $2월');
}

function groupedReports<T>(
  entries: T[],
  periodFor: (item: T) => string,
  render: (item: T) => string,
) {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const period = periodFor(entry);
    const group = groups.get(period) ?? [];
    group.push(entry);
    groups.set(period, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(
      ([period, group]) =>
        `<section class="report-month"><h3>${h(monthLabel(period))}</h3><ul>${group
          .map(render)
          .map((row) => '<li>' + row + '</li>')
          .join('')}</ul></section>`,
    )
    .join('');
}

export function renderStudentReports(
  ctx: PageContext,
  readAssignments: () => AssignmentResult[] = () => [],
  readPublishedLearning: () => { href: string; title: string }[] = () => [],
) {
  const family = ctx.actor.role === 'guardian';
  const embedded = ['/grading', '/homework'].includes(ctx.url.pathname);
  const assignmentView =
    family && ctx.url.searchParams.get('view') === 'assignments';
  const filterParam = ctx.url.searchParams.get('status');
  const filter =
    !family && (filterParam === 'draft' || filterParam === 'published')
      ? filterParam
      : '';
  const reportLink = (id?: string, status = filter) => {
    const query = new URLSearchParams();
    if (embedded) query.set('view', 'reports');
    if (status) query.set('status', status);
    if (id) query.set('id', id);
    return (
      (embedded ? ctx.url.pathname : '/student-reports') +
      (query.size ? '?' + query.toString() : '')
    );
  };
  const categories = embedded
    ? ''
    : `<div class="workspace-heading"><h1>학습 리포트</h1></div>
    <nav class="page-tabs view-tabs" aria-label="리포트 종류">
      <a href="/student-reports"${!assignmentView ? ' aria-current="page"' : ''}>월간 리포트</a>
      <a href="${family ? '/student-reports?view=assignments' : '/learning'}"${assignmentView ? ' aria-current="page"' : ''}>${family ? '과제별 결과' : '학습 기록'}</a>
    </nav>`;
  if (assignmentView) {
    const entries = readAssignments();
    return (
      categories +
      '<section class="panel report-assignment-index"><h2>과제별 결과</h2>' +
      (entries.length
        ? groupedReports(
            entries,
            (entry) => entry.date.slice(0, 7),
            (entry) =>
              `<a class="grade-report-row" href="${h(entry.href)}"><span><strong>${h(entry.title)}</strong><small>${h(entry.studentName)}</small></span><time datetime="${h(entry.date)}">${h(entry.date.slice(5))}</time></a>`,
          )
        : '<p class="muted">선생님이 공개한 과제별 리포트가 여기에 표시됩니다.</p>') +
      '</section>'
    );
  }

  const students = accessibleStudents(ctx.db, ctx.actor);
  const classes = new Map(
    accessibleClasses(ctx.db, ctx.actor).map((klass) => [klass.id, klass]),
  );
  const studentNames = new Map(
    students.map((student) => [student.id, student.name]),
  );
  const reportClass = (classId: string) => classes.get(classId)?.name ?? '';
  const submitted = ctx.submittedForm;
  let html =
    categories +
    (ctx.formError
      ? `<p class="panel report-alert" role="alert">${h(ctx.formError)}</p>`
      : '');
  const previous =
    family && !embedded && !ctx.url.searchParams.has('id')
      ? readPublishedLearning()
      : [];
  if (previous.length)
    html +=
      '<section class="panel report-assignment-index"><h2>공개 학습 기록</h2><nav class="report-links">' +
      previous
        .map(
          (record) =>
            '<a class="workspace-link" href="' +
            h(record.href) +
            '">' +
            h(record.title) +
            '</a>',
        )
        .join('') +
      '</nav></section>';
  if (staff(ctx)) {
    const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
    const enrollments = students.flatMap((student) =>
      student.classIds
        .filter((id) => classes.has(id))
        .map((id) => ({
          value: encodeURIComponent(student.id) + ':' + encodeURIComponent(id),
          label: student.name + ' · ' + reportClass(id),
        })),
    );
    const selected = submitted?.get('enrollment');
    const enrollSelect = `<label>학생 · 수강 반<select name="enrollment" required>${enrollments
      .map(
        (entry) =>
          `<option value="${h(entry.value)}"${entry.value === selected ? ' selected' : ''}>${h(entry.label)}</option>`,
      )
      .join('')}</select></label>`;
    const period = submitted?.get('period') ?? today.slice(0, 7);
    html += `<section class="panel report-create"><h2>월간 리포트 작성</h2>${
      enrollments.length
        ? `<form method="post" action="/student-reports" class="report-create-fields">${enrollSelect}<label>분석 월<input type="month" name="period" value="${h(period)}" required></label><button type="submit" name="action" value="analyze">월간 리포트 초안 만들기</button></form>
          <details class="report-attendance-editor"${submitted?.get('action') === 'attendance' ? ' open' : ''}><summary>출결 기록 입력</summary><form method="post" action="/student-reports" class="report-create-fields">${enrollSelect}<label>날짜<input type="date" name="date" value="${h(submitted?.get('date') ?? today)}" max="${today}" required></label><label>출결<select name="status"><option value="present">출석</option><option value="late"${submitted?.get('status') === 'late' ? ' selected' : ''}>지각</option><option value="absent"${submitted?.get('status') === 'absent' ? ' selected' : ''}>결석</option></select></label><button type="submit" name="action" value="attendance">출결 저장</button></form></details>`
        : '<p class="muted">담당 학생이 수강 반에 등록되면 리포트를 만들 수 있습니다.</p>'
    }</section>`;
  }

  const reports = rows<Report>(
    ctx.db,
    'SELECT * FROM op_student_reports WHERE academy_id=? ORDER BY period DESC,student_id',
    ctx.actor.academyId,
  ).filter((r) => {
    try {
      load(ctx, r.id);
      return true;
    } catch (error) {
      if (error instanceof OperationError && error.status === 403) return false;
      throw error;
    }
  });
  const samples = demoReports(ctx).filter(
    (sample) =>
      !reports.some(
        (r) =>
          r.period === sample.period &&
          r.student_id === sample.studentId &&
          r.class_id === sample.classId,
      ),
  );
  const entries = [
    ...reports.map((r) => {
      const changed =
        r.state === 'approved' && !family && !matchesReport(ctx, r);
      return {
        id: r.id,
        period: r.period,
        title: studentNames.get(r.student_id) ?? '',
        description: reportClass(r.class_id),
        category: r.state === 'approved' && !changed ? 'published' : 'draft',
        status: changed
          ? '갱신 필요'
          : r.state === 'approved'
            ? '공개'
            : '초안',
      };
    }),
    ...samples.map((r) => ({
      id: r.id,
      period: r.period,
      title: r.studentName,
      description: r.unit,
      category: 'published',
      status: '공개',
    })),
  ].sort((a, b) => b.period.localeCompare(a.period));
  const visible = filter
    ? entries.filter((entry) => entry.category === filter)
    : entries;
  const id =
    ctx.url.searchParams.get('id') ??
    samples[Number(ctx.url.searchParams.get('example')) - 1]?.id ??
    visible[0]?.id;
  const filters = family
    ? ''
    : '<nav class="report-filters" aria-label="리포트 공개 상태">' +
      [
        ['', '전체'],
        ['draft', '초안'],
        ['published', '공개'],
      ]
        .map(
          ([key, title]) =>
            `<a href="${h(reportLink(undefined, key))}"${filter === key ? ' aria-current="page"' : ''}>${title}</a>`,
        )
        .join('') +
      '</nav>';
  const mobilePicker =
    visible.length > 1
      ? `<form class="report-mobile-picker" method="get" action="${h(embedded ? ctx.url.pathname : '/student-reports')}">
      ${embedded ? '<input type="hidden" name="view" value="reports">' : ''}
      ${filter ? `<input type="hidden" name="status" value="${h(filter)}">` : ''}
      <label class="visually-hidden" for="mobile-report-id">열람할 월간 리포트</label>
      <select id="mobile-report-id" name="id">${visible
        .map(
          (entry) =>
            `<option value="${h(entry.id)}"${entry.id === id ? ' selected' : ''}>${h(monthLabel(entry.period) + ' · ' + entry.title + ' · ' + entry.description)}</option>`,
        )
        .join(
          '',
        )}</select><button type="submit" class="secondary">열기</button></form>`
      : '';
  const index =
    '<aside class="report-index panel"><h2>월간 리포트</h2>' +
    filters +
    mobilePicker +
    (visible.length
      ? '<nav class="report-index-list" aria-label="월간 리포트 목록">' +
        groupedReports(
          visible,
          (entry) => entry.period,
          (entry) =>
            `<a class="grade-report-row" href="${h(reportLink(entry.id))}"${id === entry.id ? ' aria-current="page"' : ''}><span><strong>${h(entry.title)}</strong><small>${h(entry.description)}</small></span>${family ? '' : `<span class="pill">${entry.status}</span>`}</a>`,
        ) +
        '</nav>'
      : '<p class="muted">이 분류에 표시할 리포트가 없습니다.</p>') +
    '</aside>';
  if (!id) return html + index;
  html +=
    '<div class="report-workspace">' + index + '<div class="report-preview">';

  const archived = samples.find((r) => r.id === id);
  if (archived)
    return (
      html +
      renderReportDocument(
        archived.title,
        archived.body,
        archived.studentName +
          ' · ' +
          archived.className +
          ' · ' +
          archived.unit,
        archived.period + '-학습-리포트',
      ) +
      '</div></div>'
    );

  const r = load(ctx, id);
  const name = studentNames.get(r.student_id) ?? '';
  html += renderReportDocument(
    monthLabel(r.period) + ' 학습 리포트',
    r.body,
    name + ' · ' + reportClass(r.class_id),
    r.period + '-학습-리포트',
  );
  if (!staff(ctx)) return html + '</div></div>';
  const e = studentReportEvidence(ctx, r.student_id, r.class_id, r.period);
  const hidden = `<input type="hidden" name="id" value="${h(r.id)}"><input type="hidden" name="version" value="${r.version}">`;
  const changed = !matchesReport(ctx, r, e);
  const publication = changed
    ? '보호자 비공개 · 근거가 변경되어 갱신이 필요합니다.'
    : r.state === 'approved'
      ? '보호자 공개 중'
      : '초안 · 보호자 비공개';
  const saved = reportTeacherComment(r.body);
  const restoring =
    submitted?.get('action') === 'save' && submitted.get('id') === r.id;
  const editable = {
    comment: restoring
      ? (submitted.get('comment') ?? saved.comment)
      : saved.comment,
    body: restoring ? (submitted.get('body') ?? saved.body) : saved.body,
    counsel: restoring ? (submitted.get('counsel') ?? r.counsel) : r.counsel,
  };
  html += `<section class="panel report-manage"><header><h2>검토와 공개</h2><p role="status">${publication}</p></header>
    <form method="post" action="${h(reportLink(r.id))}" class="report-comment-editor">${hidden}<label for="report-comment">보호자에게 남길 교사 코멘트 <span>선택</span></label>
    <p id="report-comment-help">수업에서 관찰한 변화나 다음 연습을 적어 주세요. 초안에 저장하고 리포트를 승인하면 보호자에게 표시됩니다.</p>
    <textarea id="report-comment" name="comment" rows="4" maxlength="1500" aria-describedby="report-comment-help" placeholder="예: 통분은 익숙해졌어요. 이번 주에는 분수의 뺄셈을 한 번 더 연습해 주세요.">${h(editable.comment)}</textarea>
    <details${restoring ? ' open' : ''}><summary>리포트 본문 및 교사용 상담 자료</summary><label>보호자에게 공개될 본문<textarea name="body" rows="9" maxlength="10000" required>${h(editable.body)}</textarea></label><label>교사용 상담 자료 <span>교사만 열람</span><textarea name="counsel" rows="6" maxlength="10000" required>${h(editable.counsel)}</textarea></label></details>
    <button type="submit" name="action" value="save"${changed ? ' disabled' : ''}>초안 저장</button>
    ${r.state === 'approved' && !changed ? '<small>수정해 저장하면 다시 승인할 때까지 비공개로 전환됩니다.</small>' : ''}</form>
    <div class="report-review-actions">
    ${
      !changed && r.state === 'draft'
        ? e.sourceCount || e.attendance.length
          ? `<form method="post" action="${h(reportLink(r.id))}">${hidden}<label class="report-review-check"><input type="checkbox" name="reviewed" value="yes" required>저장된 공개 내용을 확인했습니다</label><button type="submit" name="action" value="approve">보호자에게 공개</button></form>`
          : '<p class="muted">확정 학습 또는 출결 기록이 생기면 공개할 수 있습니다.</p>'
        : ''
    }
    ${r.state === 'approved' ? `<form method="post" action="${h(reportLink(r.id))}">${hidden}<button class="secondary" type="submit" name="action" value="withdraw">공개 철회</button></form>` : ''}
    <form method="post" action="${h(reportLink(r.id))}">${hidden}<input type="hidden" name="student" value="${h(r.student_id)}"><input type="hidden" name="class" value="${h(r.class_id)}"><input type="hidden" name="period" value="${h(r.period)}"><button class="secondary" type="submit" name="action" value="analyze">최신 기록으로 갱신</button><small>학습·출결 요약을 갱신합니다. 저장한 코멘트는 유지되며 다시 승인해야 공개됩니다.</small></form>
    </div></section></div></div>`;
  return html;
}
export const studentReportsModule: OperationModule = {
  path: '/student-reports',
  label: '학생 분석·리포트',
  roles: ['admin', 'teacher', 'guardian'],
  setup: setupStudentReports,
  render: renderStudentReports,
  submit,
};
