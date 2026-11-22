import { z } from 'zod';
import { accessibleStudents } from './directory.ts';
import {
  readWorkbookAnalysis,
  summarizeWorkbookAnalysis,
} from './workbook-analysis.ts';
import { renderWorkbookPublicationControls } from './workbook-publication.ts';
import { workbookClasses, requireStaff } from './workbook-catalog.ts';
import {
  escapeHtml as h,
  field,
  required,
  rows,
  transaction,
  OperationError,
  type PageContext,
} from './shared.ts';

export interface WorkbookRecipient {
  id: string;
  title: string;
  class_id: string;
  class_name: string;
  book_id: string;
  book: string;
  grade: string;
  semester: string;
  edition: string;
  subject: string;
  target_kind: string;
  due_date: string;
  due_time: string | null;
  student_id: string | null;
  student_name: string | null;
  submission_id: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  review_version: number | null;
}
export function workbookRecipients(ctx: PageContext, assignment?: string) {
  const { actor, db } = ctx;
  if (!['admin', 'teacher', 'student'].includes(actor.role)) return [];
  const conditions = ['a.academy_id=?'];
  const params = [actor.academyId];
  if (assignment) {
    conditions.push('a.id=?');
    params.push(assignment);
  }
  if (actor.role === 'teacher') {
    conditions.push(
      'EXISTS(SELECT 1 FROM teacher_classes tc WHERE tc.class_id=t.class_id AND tc.teacher_id=?)',
    );
    params.push(actor.id);
  }
  const member =
    'EXISTS(SELECT 1 FROM student_class_memberships m WHERE m.class_id=r.class_id AND m.student_id=r.student_id AND m.ended_at IS NULL)';
  if (actor.role === 'student') {
    conditions.push('r.student_id=?', member);
    params.push(actor.studentId ?? '');
  }
  return rows<WorkbookRecipient>(
    db,
    `SELECT a.id,a.title,a.due_date,w.due_time,w.target_kind,b.id book_id,b.name book,b.grade,b.semester,b.edition,b.subject,
    c.id class_id,c.name class_name,r.student_id,st.name student_name,s.id submission_id,s.submitted_at,s.confirmed_at,s.review_version
    FROM homework_workbooks w JOIN homework_assignments a ON a.id=w.assignment_id JOIN books b ON b.id=w.book_id
    JOIN homework_targets t ON t.assignment_id=a.id JOIN classes c ON c.id=t.class_id
    LEFT JOIN homework_recipients r ON r.assignment_id=t.assignment_id AND r.class_id=t.class_id ${actor.role === 'teacher' ? 'AND ' + member : ''}
    LEFT JOIN students st ON st.id=r.student_id
    LEFT JOIN homework_submissions s ON s.assignment_id=a.id AND s.student_id=r.student_id
    WHERE ${conditions.join(' AND ')} ORDER BY a.due_date DESC,a.title,c.name,st.name`,
    ...params,
  );
}
export function uniqueRecipients(data: WorkbookRecipient[]) {
  return [
    ...new Map(
      data.filter((r) => r.student_id).map((r) => [r.student_id, r]),
    ).values(),
  ];
}
export function groupHomework(data: WorkbookRecipient[]) {
  const groups = new Map<string, WorkbookRecipient[]>();
  for (const r of data) {
    const group = groups.get(r.id) ?? [];
    group.push(r);
    groups.set(r.id, group);
  }
  return groups;
}
export function late(r: WorkbookRecipient) {
  return (
    !!r.submitted_at &&
    Date.parse(r.submitted_at) >
      Date.parse(
        r.due_date +
          'T' +
          (r.due_time ? r.due_time + ':00' : '23:59:59.999') +
          '+09:00',
      )
  );
}
export function assignedQuestions(ctx: PageContext, id: string) {
  return rows<{
    id: string;
    page: number;
    number: string;
    tag_ids: string;
    book_question_id: string;
  }>(
    ctx.db,
    `SELECT q.id,p.page,p.number,p.tag_ids,p.book_question_id
    FROM homework_questions q JOIN homework_question_snapshots p ON p.question_id=q.id WHERE q.assignment_id=? ORDER BY q.position`,
    id,
  );
}
export function approvedReview(ctx: PageContext, form: FormData) {
  requireStaff(ctx);
  const id = required(form, 'assignmentId', '숙제', 128),
    single = field(form, 'single', 128);
  const selected = single
    ? [single]
    : [...new Set(form.getAll('selected').map(String))];
  if (!selected.length)
    throw new OperationError('확인을 마친 제출물을 선택해 주세요.');
  return transaction(ctx.db, () => {
    requireStaff(ctx);
    const roster = uniqueRecipients(workbookRecipients(ctx, id)),
      questions = assignedQuestions(ctx, id);
    for (const sub of selected) {
      const r = roster.find((r) => r.submission_id === sub);
      if (!r)
        throw new OperationError('확인할 제출물을 찾을 수 없습니다.', 404);
      if (
        String(r.review_version) !==
        required(form, 'version-' + sub, '제출물 확인 버전')
      )
        throw new OperationError(
          '다른 교사가 제출 내용을 확인했습니다. 새로고침해 주세요.',
          409,
        );
      const reason = r.confirmed_at
        ? required(form, 'reason-' + sub, '정정 사유', 500)
        : null;
      const wrong = new Set(form.getAll('wrong-' + sub).map(String));
      if ([...wrong].some((q) => !questions.some((i) => i.id === q)))
        throw new OperationError('숙제의 문항을 확인해 주세요.');
      const now = new Date().toISOString(),
        version = (r.review_version ?? 0) + 1;
      const scores = questions.map((q) => ({
        questionId: q.id,
        points: wrong.has(q.id) ? 0 : 1,
      }));
      for (const q of scores)
        ctx.db
          .prepare(
            'UPDATE homework_marks SET awarded_points=? WHERE submission_id=? AND question_id=?',
          )
          .run(q.points, sub, q.questionId);
      ctx.db
        .prepare(
          'INSERT INTO homework_grade_revisions(submission_id,version,finalized_at,reviewer_id,reason,scores) VALUES(?,?,?,?,?,?)',
        )
        .run(sub, version, now, ctx.actor.id, reason, JSON.stringify(scores));
      ctx.db
        .prepare(
          'UPDATE homework_submissions SET confirmed_at=?,review_version=? WHERE id=?',
        )
        .run(now, version, sub);
    }
    return '/homework?detail=' + id;
  });
}

export function renderCatalogList(data: WorkbookRecipient[], staff: boolean) {
  const items = [...groupHomework(data).values()]
    .map((group) => {
      const r = group[0],
        members = uniqueRecipients(group);
      const targets =
        r.target_kind === 'student'
          ? members.map((i) => i.student_name)
          : [...new Set(group.map((i) => i.class_name))];
      const state = r.submitted_at
        ? late(r)
          ? '지각 제출'
          : '제출 완료'
        : '미제출';
      return `<tr><td><a href="/homework?${staff ? 'detail' : 'assignment'}=${h(r.id)}">${h(r.title)}</a></td><td>${h(targets.join(', '))}</td><td>${h(r.due_date)} ${h(r.due_time)}</td><td>${staff ? members.filter((i) => i.submitted_at).length + '/' + members.length : state}</td><td>${staff ? members.filter((i) => i.confirmed_at).length + '/' + members.length : !r.submitted_at ? '—' : r.confirmed_at ? '선생님 확인 완료' : '선생님 확인 대기'}</td></tr>`;
    })
    .join('');
  return `<section class="panel"><h2>교재 숙제</h2>${items ? `<div class="table-wrap"><table><thead><tr><th>숙제</th><th>배정 대상</th><th>마감</th><th>제출</th><th>선생님 확인</th></tr></thead><tbody>${items}</tbody></table></div>` : '<p>배정된 교재 숙제가 없습니다.</p>'}</section>`;
}

export function renderWorkbookDetail(ctx: PageContext, id: string) {
  requireStaff(ctx);
  let data = workbookRecipients(ctx, id);
  const first = data[0];
  if (!first) throw new OperationError('숙제를 찾을 수 없습니다.', 404);
  const classes = [
    ...new Map(data.map((r) => [r.class_id, r.class_name])).entries(),
  ];
  const classId = ctx.url.searchParams.get('class');
  if (classId) data = data.filter((r) => r.class_id === classId);
  if (!data.length) throw new OperationError('반을 찾을 수 없습니다.', 404);
  const questions = assignedQuestions(ctx, id);
  const members = uniqueRecipients(data);
  const detail = members
    .map((r) => {
      const sub = r.submission_id;
      const marks = sub
        ? rows<{
            question_id: string;
            awarded_points: number;
            automatic_points: number;
          }>(
            ctx.db,
            'SELECT question_id,awarded_points,automatic_points FROM homework_marks WHERE submission_id=?',
            sub,
          )
        : [];
      const original = questions
        .filter((q) =>
          marks.some((m) => m.question_id === q.id && m.automatic_points === 0),
        )
        .map((q) => q.page + '쪽 ' + q.number + '번')
        .join(', ');
      return `<tr><td>${sub && !r.confirmed_at ? `<input type="checkbox" aria-label="${h(r.student_name)} 제출물 선택" name="selected" value="${h(sub)}">` : ''}${h(r.student_name)}</td>
    <td>${!sub ? '미제출' : late(r) ? '지각 제출' : '제출 완료'}</td><td>${sub ? h(original || '모두 맞음') : '—'}</td>
    <td>${sub ? `<details><summary>오답 확인·수정</summary>${questions.map((q) => `<label class="check-label"><input type="checkbox" name="wrong-${h(sub)}" value="${h(q.id)}"${marks.some((m) => m.question_id === q.id && !m.awarded_points) ? ' checked' : ''}>${q.page}쪽 ${h(q.number)}번</label>`).join('')}</details>` : '—'}</td>
    <td>${r.confirmed_at ? '확인 완료' : sub ? '확인 대기' : '—'}${sub ? `<input type="hidden" name="version-${h(sub)}" value="${r.review_version}">${r.confirmed_at ? `<label>정정 사유<input name="reason-${h(sub)}" maxlength="500"></label>` : ''}<button name="single" value="${h(sub)}">${r.confirmed_at ? '수정 내용 확인 완료' : '제출 내용 확인 완료'}</button>` : ''}</td></tr>`;
    })
    .join('');
  return `<section class="panel"><a href="/homework">숙제 목록</a><h1>${h(first.title)}</h1><p>${h(first.book)} · ${h(first.due_date)} ${h(first.due_time)} 마감</p>
  <p>${questions.map((q) => h(q.page + '쪽 ' + q.number + '번')).join(', ')}</p>
  <nav class="actions"><a href="/homework?detail=${h(id)}">전체</a>${classes.map(([k, v]) => `<a href="/homework?detail=${h(id)}&amp;class=${h(k)}">${h(v)}</a>`).join('')}</nav>
  <p>대상 ${members.length}명 · 제출 ${members.filter((r) => r.submitted_at).length}명 · 확인 완료 ${members.filter((r) => r.confirmed_at).length}명</p>
  <p>확인을 마친 결과는 반 브리핑과 학생별 분석에 반영됩니다.</p>
  <form method="post" action="/homework"><input type="hidden" name="action" value="approve-workbook"><input type="hidden" name="assignmentId" value="${h(id)}"><div class="table-wrap"><table><thead><tr><th>학생</th><th>제출</th><th>학생 제출 오답</th><th>교사 확인 오답</th><th>선생님 확인</th></tr></thead><tbody>${detail}</tbody></table></div>
  ${members.some((r) => r.submitted_at && !r.confirmed_at) ? '<button>선택한 제출물 확인 완료</button>' : ''}</form><a href="/briefing?workbook=${h(id)}&amp;class=${h(classId ?? classes[0][0])}">반 브리핑</a></section>`;
}

function option(id: string, name: string, value: string | null) {
  return `<option value="${h(id)}"${value === id ? ' selected' : ''}>${h(name)}</option>`;
}

export function workbookAnalytics(ctx: PageContext, individual: boolean) {
  requireStaff(ctx);
  const params = ctx.url.searchParams,
    roster = workbookRecipients(ctx);
  const classes = workbookClasses(ctx),
    students = uniqueRecipients(roster);
  const classId = params.get('class') ?? classes[0]?.id ?? '';
  const classStudents = individual
    ? []
    : accessibleStudents(ctx.db, ctx.actor).filter((s) =>
        s.classIds.includes(classId),
      );
  const student =
    params.get('student') ?? (individual ? students[0]?.student_id : '') ?? '';
  const selected = classStudents.find((s) => s.id === student);
  const book = params.get('book') ?? '',
    subject = params.get('subject') ?? '',
    assignment = params.get('workbook') ?? '';
  const from = params.get('from') ?? '',
    to = params.get('to') ?? '';
  if (
    (from && !z.iso.date().safeParse(from).success) ||
    (to && !z.iso.date().safeParse(to).success) ||
    (from && to && from > to)
  )
    throw new OperationError('기간의 시작일과 종료일을 확인해 주세요.');
  if (
    (individual &&
      student &&
      !students.some((s) => s.student_id === student)) ||
    (!individual && classId && !classes.some((c) => c.id === classId)) ||
    (!individual && student && !selected) ||
    (book && !roster.some((r) => r.book_id === book)) ||
    (assignment && !roster.some((r) => r.id === assignment)) ||
    (subject && subject !== 'M' && subject !== 'E')
  )
    throw new OperationError('조회 가능한 분석 범위를 선택해 주세요.', 404);
  const scope = roster.filter((r) =>
    individual
      ? r.student_id === student
      : r.class_id === classId && (!selected || r.student_id === selected.id),
  );
  const chosen = scope.filter(
    (r) =>
      r.confirmed_at &&
      (!assignment || r.id === assignment) &&
      (!book || r.book_id === book) &&
      (!subject || r.subject === subject) &&
      (!from || r.due_date >= from) &&
      (!to || r.due_date <= to),
  );
  const selectedIds = new Set(chosen.map((r) => r.submission_id));
  const analysis = readWorkbookAnalysis(ctx.db, ctx.actor.academyId);
  const { results, correct, total, groups, types, misses, unclassified } =
    summarizeWorkbookAnalysis(
      analysis.results.filter((r) => selectedIds.has(r.submissionId)),
    );
  const rejected = analysis.rejected.filter((id) => selectedIds.has(id)).length;
  const stats = (map: typeof types) =>
    [...map]
      .filter(([, s]) => individual || selected || s.correct < s.total)
      .sort((a, b) => b[1].total - b[1].correct - (a[1].total - a[1].correct))
      .map(
        ([, s]) =>
          `<li>${h(s.name)} · 정답 ${s.correct}/${s.total} (${((100 * s.correct) / s.total).toFixed(1)}%) · 오답 ${s.total - s.correct}건${s.referenceOnly ? ' · 참고용' : ''}</li>`,
      )
      .join('');
  const books = [
    ...new Map(
      roster.map((r) => [
        r.book_id,
        [r.book, r.grade, r.semester, r.edition].filter(Boolean).join(' · '),
      ]),
    ).entries(),
  ];
  // Keep assignment choices available when switching between classes.
  const assignments = [...groupHomework(roster).values()].map((g) => g[0]);
  return `<section class="panel${individual ? '' : ' briefing-results'}">${individual ? '<h1>학생별 분석</h1>' : ''}<form method="get"${individual ? ' class="fields"' : ' class="briefing-filters" data-briefing-filters'}>
  ${
    individual
      ? `<input type="hidden" name="view" value="analysis"><label>학생<select name="student">${students.map((r) => option(r.student_id!, r.student_name!, student)).join('')}</select></label>
  <label>과목<select name="subject">${option('', '전체', subject) + option('M', '수학', subject) + option('E', '영어', subject)}</select></label>
  <label>교재<select name="book">${option('', '전체 교재', book) + books.map(([k, v]) => option(k, v, book)).join('')}</select></label>`
      : `<label>반<select name="class">${classes.map((c) => option(c.id, c.name, classId)).join('')}</select></label>
  <label>학생<select name="student">${option('', '반 전체', student) + classStudents.map((s) => option(s.id, s.name, student)).join('')}</select></label>
  <label>숙제<select name="workbook">${option('', '기간 내 전체 숙제', assignment) + assignments.map((r) => option(r.id, r.title, assignment)).join('')}</select></label>`
  }
  <label>마감일 기준 시작<input type="date" name="from" value="${h(from)}"></label><label>종료<input type="date" name="to" value="${h(to)}"></label><button>조회</button></form>
  ${selected ? `<h2 class="briefing-student-heading">${h(selected.name)} 학습 결과</h2>` : ''}
  ${rejected ? `<p role="alert">승인 기록과 문항별 결과가 일치하지 않는 ${rejected}건은 집계에서 제외했습니다. 숙제 상세에서 확인해 주세요.</p>` : ''}
  ${
    total
      ? `<div class="${individual ? '' : 'briefing-student-card'}"><h${selected ? 3 : 2}>${selected ? '정답률' : '전체 정답률'} ${((100 * correct) / total).toFixed(1)}%</h${selected ? 3 : 2}><p>확인 완료 ${results.length}건 · 정답 ${correct}/${total}문항</p></div>
  <p class="muted">유형 미지정 ${unclassified}문항은 전체 정답률에 포함하고 유형별 집계에서만 제외합니다. 배정 당시 유형과 교사 승인 결과를 사용하며, 오답만으로 원인을 단정하지 않습니다.</p>
  <h3>${individual || selected ? '대분류별 결과' : '다시 설명할 대분류'}</h3><ul>${stats(groups) || '<li>집계할 유형이 없습니다.</li>'}</ul>
  <h3>${individual || selected ? '소분류별 결과' : '다시 설명할 소분류'}</h3><ul>${stats(types) || '<li>집계할 유형이 없습니다.</li>'}</ul>
  <h3>많이 틀린 문항</h3><ul>${
    [...misses.values()]
      .filter((m) => m.wrong)
      .sort((a, b) => b.wrong - a.wrong)
      .map((m) => `<li>${h(m.label)} · 오답 ${m.wrong}/${m.total}건</li>`)
      .join('') || '<li>오답이 없습니다.</li>'
  }</ul>`
      : '<p>이 범위에 선생님이 확인한 제출물이 없습니다.</p>'
  }</section>${individual && student ? renderWorkbookPublicationControls(ctx, student, analysis.results) : ''}`;
}
