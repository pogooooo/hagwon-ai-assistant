import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demoReports } from './demo-reports.ts';
import { renderReportDocument } from './report-document.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import { photoReportStats } from '../homework-grading/report-adapter.ts';
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
  return reportEvidence(
    ctx.db,
    ctx.actor.academyId,
    studentId,
    classId,
    period,
  );
}
function reportEvidence(
  db: OperationsDatabase,
  academyId: string,
  studentId: string,
  classId: string,
  period: string,
) {
  const { sources, types, total, correct, unknown } = photoReportStats(
    db,
    academyId,
    studentId,
    classId,
    period,
  );
  const attendance = rows<{ date: string; status: string; actor_id: string }>(
    db,
    'SELECT date,status,actor_id FROM op_student_attendance WHERE academy_id=? AND student_id=? AND class_id=? AND date LIKE ? ORDER BY date',
    academyId,
    studentId,
    classId,
    period + '-%',
  );
  const repeated = types
    .slice()
    .filter((t) => t.wrong >= 2)
    .sort((a, b) => b.wrong - a.wrong || a.name.localeCompare(b.name));
  const suggestions = types
    .slice()
    .filter((t) => t.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong || a.name.localeCompare(b.name))
    .slice(0, 3);
  return {
    total,
    correct,
    unknown,
    repeated,
    suggestions,
    attendance,
    fingerprint: hash(
      sources.length || unknown
        ? { sources, total, correct, unknown, types, attendance }
        : { sources, attendance },
    ),
    sourceCount: sources.length,
  };
}
/** Used for guardian notifications. Recheck current enrollment, approval, and the same evidence as the report page. */
export function approvedPhotoReports(
  db: OperationsDatabase,
  academy: string,
  student: string,
  period: string,
  classId: string,
) {
  return rows<
    Pick<
      Report,
      'id' | 'version' | 'period' | 'body' | 'class_id' | 'fingerprint'
    >
  >(
    db,
    `SELECT r.id,r.version,r.period,r.body,r.class_id,r.fingerprint FROM op_student_reports r
    JOIN student_class_memberships m ON m.academy_id=r.academy_id AND m.student_id=r.student_id AND m.class_id=r.class_id AND m.ended_at IS NULL
    WHERE r.academy_id=? AND r.student_id=? AND r.period=? AND r.state='approved' AND r.approved_by IS NOT NULL
    AND (?='' OR r.class_id=?) ORDER BY r.class_id,r.id`,
    academy,
    student,
    period,
    classId,
    classId,
  ).filter((r) => {
    const current = reportEvidence(db, academy, student, r.class_id, period);
    return current.sourceCount > 0 && current.fingerprint === r.fingerprint;
  });
}
function draft(
  ctx: PageContext,
  studentId: string,
  classId: string,
  period: string,
) {
  const student = scope(ctx, studentId, classId),
    e = studentReportEvidence(ctx, studentId, classId, period);
  const score = e.total
    ? `교사 확정 ${e.total}문항 중 ${e.correct}문항 정답 (${Math.round((e.correct / e.total) * 100)}%).`
    : '이 기간에 교사가 확정한 채점 기록이 없습니다.';
  const repeat = e.repeated.length
    ? '반복 오답: ' +
      e.repeated
        .map((t) => `${t.name} ${t.wrong}/${t.total}문항 오답`)
        .join(', ')
    : '반복 오답 유형을 확인할 기록이 부족합니다.';
  const practice = e.suggestions.length
    ? '추천 연습 유형: ' +
      e.suggestions.map((t) => t.name).join(', ') +
      ' (확인된 오답을 바탕으로 한 제안).'
    : '추천 연습 유형을 정할 근거가 없습니다.';
  const attendance = e.attendance.length
    ? '출결 기록: ' +
      ['present', 'late', 'absent']
        .map(
          (v, i) =>
            ['출석', '지각', '결석'][i] +
            ' ' +
            e.attendance.filter((a) => a.status === v).length +
            '건',
        )
        .join(' · ')
    : '출석·지각 등 출결 기록이 없습니다. 출석이나 태도를 추정하지 않습니다.';
  const body = [
    '# ' + student.name + ' · ' + period + ' 월간 리포트',
    '## 성취도',
    score +
      (e.unknown
        ? ' 미확인 ' + e.unknown + '문항은 정답률에서 제외했습니다.'
        : ''),
    '## 오답 유형',
    repeat,
    '## 다음 학습',
    practice,
    '## 출결',
    attendance,
  ].join('\n\n');
  return {
    body,
    counsel: `교사용 상담 자료 초안\n${body}\n상담 확인 항목: 반복 오답을 함께 살펴보고 다음 연습 유형을 협의합니다. 기록에 없는 원인·태도·가정 상황은 단정하지 않습니다.`,
    e,
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
      r.fingerprint !==
        studentReportEvidence(ctx, r.student_id, r.class_id, r.period)
          .fingerprint)
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
function submit(ctx: PageContext, form: FormData) {
  if (!staff(ctx))
    throw new OperationError('담당 교사만 분석·편집·승인할 수 있습니다.', 403);
  return transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const action = required(form, 'action', '작업');
    if (action === 'attendance') {
      const student = required(form, 'student', '학생'),
        klass = required(form, 'class', '반'),
        date = required(form, 'date', '날짜'),
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
      const student = required(form, 'student', '학생'),
        klass = required(form, 'class', '반'),
        period = required(form, 'period', '분석 월');
      const result = draft(ctx, student, klass, period);
      const old = one<Report>(
        ctx.db,
        'SELECT * FROM op_student_reports WHERE academy_id=? AND student_id=? AND class_id=? AND period=?',
        ctx.actor.academyId,
        student,
        klass,
        period,
      );
      if (old) {
        if (field(form, 'version') !== String(old.version))
          throw new OperationError(
            '기존 리포트를 열고 현재 버전에서 다시 분석해 주세요.',
            409,
          );
      }
      r = {
        id: old?.id ?? randomUUID(),
        academy_id: ctx.actor.academyId,
        student_id: student,
        class_id: klass,
        period,
        version: (old?.version ?? 0) + 1,
        state: 'draft',
        body: result.body,
        counsel: result.counsel,
        fingerprint: result.e.fingerprint,
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
      if (action !== 'withdraw' && current.fingerprint !== r.fingerprint)
        throw new OperationError(
          '채점·출결 근거가 바뀌었습니다. 다시 분석하고 검토해 주세요.',
          409,
        );
      if (action === 'save') {
        r.body = required(form, 'body', '리포트', 10000);
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

export function renderStudentReports(
  ctx: PageContext,
  readAssignments: () => AssignmentResult[] = () => [],
) {
  const family = ctx.actor.role === 'guardian';
  const embedded = ['/grading', '/homework'].includes(ctx.url.pathname);
  const reportLink = (id: string) =>
    (embedded
      ? ctx.url.pathname + '?view=reports&id='
      : '/student-reports?id=') + encodeURIComponent(id);
  const assignments =
    family && ctx.url.searchParams.get('view') === 'assignments';
  const tabs =
    family && !embedded
      ? `<div class="workspace-heading"><h1>학습 리포트</h1></div><nav class="page-tabs view-tabs" aria-label="리포트 종류"><a href="/student-reports?view=assignments"${assignments ? ' aria-current="page"' : ''}>과제별 결과</a><a href="/student-reports"${!assignments ? ' aria-current="page"' : ''}>월간 리포트</a></nav>`
      : '';
  if (assignments) {
    const entries = readAssignments();
    return (
      tabs +
      `<section class="panel"><h2>과제별 결과</h2>${
        entries.length
          ? `<ul class="grade-queue-list">${entries.map((result) => `<li><a class="grade-queue-entry" href="${h(result.href)}"><strong>${h(result.title)}</strong><span class="grade-student">${h(result.studentName)}</span><time class="pill">${h(result.date)}</time></a></li>`).join('')}</ul>`
          : '<p class="muted">선생님이 확인한 과제 결과가 등록되면 여기에 표시됩니다.</p>'
      }</section>`
    );
  }
  const students = accessibleStudents(ctx.db, ctx.actor),
    classes = accessibleClasses(ctx.db, ctx.actor);
  let html = family
    ? tabs
    : '<div class="workspace-heading"><h1>월간 리포트</h1></div><p>확정된 학습과 출결 기록으로 학생별 리포트를 작성합니다.</p>';
  const options = (list: { id: string; name: string }[]) =>
    list
      .map((s) => `<option value="${h(s.id)}">${h(s.name)}</option>`)
      .join('');
  if (staff(ctx))
    html += `<section class="panel"><h2>학생별 분석</h2><form method="post"><label>학생<select name="student">${options(students)}</select></label><label>반<select name="class">${options(classes)}</select></label><label>분석 월<input type="month" name="period" value="${new Date(Date.now() + 32400000).toISOString().slice(0, 7)}" required></label><button name="action" value="analyze">분석 · 상담 자료 초안 만들기</button></form><details><summary>실제 출결 기록 입력</summary><form method="post"><label>학생<select name="student">${options(students)}</select></label><label>반<select name="class">${options(classes)}</select></label><label>날짜<input type="date" name="date" required></label><label>출결<select name="status"><option value="present">출석</option><option value="late">지각</option><option value="absent">결석</option></select></label><button name="action" value="attendance">출결 기록 저장</button></form></details></section>`;
  const list = rows<Report>(
    ctx.db,
    'SELECT * FROM op_student_reports WHERE academy_id=? ORDER BY period DESC,student_id',
    ctx.actor.academyId,
  ).filter((r) => {
    try {
      load(ctx, r.id);
      return true;
    } catch {
      return false;
    }
  });
  const samples = demoReports(ctx).filter(
    (sample) =>
      !list.some(
        (r) =>
          r.period === sample.period &&
          sample.studentId === r.student_id &&
          sample.classId === r.class_id,
      ),
  );
  const entries = [
    ...list.map((r) => ({
      id: r.id,
      period: r.period,
      title:
        students.find((s) => s.id === r.student_id)?.name + ' · ' + r.period,
      description: classes.find((c) => c.id === r.class_id)?.name ?? '',
      status: r.state === 'approved' ? '공개' : '초안',
    })),
    ...samples.map((r) => ({
      id: r.id,
      period: r.period,
      title: r.title,
      description: r.unit,
      status: '공개',
    })),
  ].sort((a, b) => b.period.localeCompare(a.period));
  const id =
    ctx.url.searchParams.get('id') ??
    samples[Number(ctx.url.searchParams.get('example')) - 1]?.id ??
    entries[0]?.id;
  if (!id) return html + '<p class="muted">아직 열람할 리포트가 없습니다.</p>';
  if (entries.length && (!family || entries.length > 1))
    html +=
      (family
        ? '<details class="report-periods"><summary>다른 리포트 보기</summary>'
        : '') +
      '<nav class="report-links report-library" aria-label="월간 리포트 목록">' +
      entries
        .map(
          (r) =>
            '<a class="grade-report-row" href="' +
            h(reportLink(r.id)) +
            '"' +
            (id === r.id ? ' aria-current="page"' : '') +
            '><span><strong>' +
            h(r.title) +
            '</strong><small>' +
            h(r.description) +
            '</small></span><span class="pill">' +
            h(r.status) +
            '</span></a>',
        )
        .join('') +
      '</nav>' +
      (family ? '</details>' : '');
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
      )
    );
  const r = load(ctx, id);
  const name = students.find((s) => s.id === r.student_id)?.name ?? '';
  html += renderReportDocument(
    r.period + ' 월간 학습 리포트',
    r.body,
    name + ' · ' + (classes.find((c) => c.id === r.class_id)?.name ?? ''),
    r.period + '-학습-리포트',
  );
  if (!staff(ctx)) return html;
  const e = studentReportEvidence(ctx, r.student_id, r.class_id, r.period),
    hidden = `<input type="hidden" name="id" value="${h(r.id)}"><input type="hidden" name="version" value="${r.version}">`;
  const publication =
    r.fingerprint !== e.fingerprint
      ? '보호자 비공개 · 근거가 변경되어 다시 분석해야 합니다.'
      : r.state === 'approved'
        ? '보호자 공개 중'
        : '교사 검토 초안 · 보호자 비공개';
  html += `<section class="panel"><p>${publication}</p><form method="post">${hidden}<label>월간 리포트<textarea name="body" rows="12" maxlength="10000">${h(r.body)}</textarea></label><label>교사용 상담 자료 초안<textarea name="counsel" rows="12" maxlength="10000">${h(r.counsel)}</textarea></label><button name="action" value="save">수정 저장 · 비공개 초안</button></form><form method="post">${hidden}<label><input type="checkbox" name="reviewed" value="yes" required>저장된 내용을 검토했습니다</label><button name="action" value="approve">교사 승인 · 해당 보호자에게 공개</button></form><form method="post">${hidden}<button name="action" value="withdraw">공개 철회</button></form><form method="post">${hidden}<input type="hidden" name="student" value="${h(r.student_id)}"><input type="hidden" name="class" value="${h(r.class_id)}"><input type="hidden" name="period" value="${h(r.period)}"><button name="action" value="analyze">최신 근거로 다시 분석 · 승인 해제</button></form></section>`;
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
