import { randomUUID } from 'node:crypto';
import {
  assignWorkbook,
  registerBook,
  setupWorkbookCatalog,
} from './workbook-catalog.ts';
import {
  workbookRecipients,
  renderWorkbookDetail,
  renderCatalogList,
  workbookAnalytics,
  approvedReview,
  groupHomework,
  late,
} from './workbook-results.ts';
import { renderWorkbookForm, renderBookList } from './workbook-form.ts';
import { recordWorkbookReport } from './learning.ts';

interface QuestionInput {
  prompt: string;
  answer: string;
  points: number;
  type: string;
}

import {
  accessibleClasses,
  accessibleStudents,
  canReadStudent,
} from './directory.ts';
import {
  escapeHtml,
  field,
  one,
  OperationError,
  required,
  rows,
  transaction,
  type OperationModule,
  type PageContext,
  type Role,
} from './shared.ts';

interface Assignment {
  id: string;
  class_id: string;
  class_name: string;
  title: string;
  due_date: string;
  submission_mode: string;
}

interface Question {
  id: string;
  position: number;
  prompt: string;
  answer_key: string;
  points: number;
  problem_type: string;
  type_key: string;
}

interface Submission {
  id: string;
  assignment_id: string;
  student_id: string;
  student_name: string;
  class_id: string;
  assignment_title: string;
  submission_mode: string;
  confirmed_at: string | null;
  review_version: number;
  score: number;
  total: number;
}

interface MarkedAnswer extends Question {
  response: string;
  automatic_points: number;
  awarded_points: number;
}

const assignmentsSql = `
  SELECT a.id, a.class_id, c.name AS class_name, a.title, a.due_date,a.submission_mode
  FROM homework_assignments a
  JOIN classes c ON c.id = a.class_id AND c.academy_id = a.academy_id
  WHERE a.academy_id = ? AND a.submission_mode <> 'catalog'
`;

const submissionsSql = `
  SELECT s.id, s.assignment_id, s.student_id, st.name AS student_name,
    a.class_id, a.title AS assignment_title,a.submission_mode, s.confirmed_at, s.review_version,
    COALESCE(SUM(m.awarded_points), 0) AS score, COALESCE(SUM(q.points), 0) AS total
  FROM homework_submissions s
  JOIN homework_assignments a ON a.id = s.assignment_id
  JOIN students st ON st.id = s.student_id AND st.academy_id = a.academy_id
  LEFT JOIN homework_marks m ON m.submission_id = s.id
  LEFT JOIN homework_questions q ON q.id = m.question_id
  WHERE a.academy_id = ? AND a.submission_mode <> 'catalog'
`;

const submissionsOrder = 'GROUP BY s.id ORDER BY s.submitted_at DESC, s.id';

function isStaff(role: Role): boolean {
  return role === 'admin' || role === 'teacher';
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function questionsFor(ctx: PageContext, assignmentId: string): Question[] {
  return rows<Question>(
    ctx.db,
    'SELECT * FROM homework_questions WHERE assignment_id = ? ORDER BY position',
    assignmentId,
  );
}

function markedAnswers(ctx: PageContext, submissionId: string): MarkedAnswer[] {
  return rows<MarkedAnswer>(
    ctx.db,
    `SELECT q.*, m.response, m.automatic_points, m.awarded_points
     FROM homework_marks m
     JOIN homework_questions q ON q.id = m.question_id
     WHERE m.submission_id = ? ORDER BY q.position`,
    submissionId,
  );
}

function submissionFor(ctx: PageContext, id: string): Submission {
  const submission = one<Submission>(
    ctx.db,
    submissionsSql + ' AND s.id = ? GROUP BY s.id',
    ctx.actor.academyId,
    id,
  );
  if (
    !submission ||
    !canReadStudent(ctx.db, ctx.actor, submission.student_id)
  ) {
    throw new OperationError('제출 기록을 찾을 수 없습니다.', 404);
  }
  if (
    isStaff(ctx.actor.role) &&
    !accessibleClasses(ctx.db, ctx.actor).some(
      (classroom) => classroom.id === submission.class_id,
    )
  ) {
    throw new OperationError('제출 기록을 찾을 수 없습니다.', 404);
  }
  return submission;
}

function studentAssignment(ctx: PageContext, id: string): Assignment {
  if (ctx.actor.role === 'student') {
    const entry = workbookRecipients(ctx, id)[0];
    if (entry) return { ...entry, submission_mode: 'catalog' };
  }
  const student = accessibleStudents(ctx.db, ctx.actor).find(
    (entry) => entry.id === ctx.actor.studentId,
  );
  const assignment =
    ctx.actor.role === 'student' && student?.classIds.length
      ? one<Assignment>(
          ctx.db,
          assignmentsSql +
            ' AND a.id = ? AND EXISTS (SELECT 1 FROM student_class_memberships m WHERE m.class_id=a.class_id AND m.student_id=? AND m.ended_at IS NULL)',
          ctx.actor.academyId,
          id,
          student.id,
        )
      : undefined;
  if (!assignment) {
    throw new OperationError('제출할 숙제를 찾을 수 없습니다.', 404);
  }
  return assignment;
}

function isLate(dueDate: string): boolean {
  return Date.now() > Date.parse(dueDate + 'T23:59:59.999+09:00');
}

function parseQuestions(value: string): QuestionInput[] {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 50) {
    throw new OperationError('한 숙제에 문항을 최대 50개 등록할 수 있습니다.');
  }
  return lines.map((line, index) => {
    const separator = line.includes('\t') ? '\t' : '|';
    const parts = line.split(separator).map((part) => part.trim());
    const [prompt, answer, pointsText, type = ''] = parts;
    const points = Number(pointsText);
    if (
      parts.length < 3 ||
      parts.length > 4 ||
      !prompt ||
      prompt.length > 500 ||
      !answer ||
      answer.length > 200 ||
      !/^[1-9]\d{0,2}$/.test(pointsText) ||
      points > 100 ||
      type.length > 60
    ) {
      throw new OperationError(
        `${index + 1}번째 문항의 문제, 정답, 배점(1~100), 유형을 확인해 주세요.`,
      );
    }
    return { prompt, answer, points, type };
  });
}

function createAssignment(ctx: PageContext, form: FormData) {
  if (!isStaff(ctx.actor.role)) {
    throw new OperationError('숙제 등록 권한이 없습니다.', 403);
  }
  const classId = required(form, 'classId', '반', 128);
  const title = required(form, 'title', '숙제 제목', 120);
  const dueDate = required(form, 'dueDate', '제출 마감일', 10);
  const parsedDate = new Date(dueDate + 'T00:00:00.000Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== dueDate
  ) {
    throw new OperationError('제출 마감일을 확인해 주세요.');
  }
  const classroom = accessibleClasses(ctx.db, ctx.actor).find(
    (c) => c.id === classId,
  );
  if (!classroom)
    throw new OperationError('숙제를 배정할 수 있는 반을 선택해 주세요.', 403);
  const questions = parseQuestions(required(form, 'questions', '문항', 40000));
  const id = randomUUID();
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    if (
      !accessibleClasses(ctx.db, ctx.actor).some(
        (classroom) => classroom.id === classId,
      )
    ) {
      throw new OperationError(
        '숙제를 배정할 수 있는 반을 선택해 주세요.',
        403,
      );
    }
    ctx.db
      .prepare(
        `INSERT INTO homework_assignments (id, academy_id, class_id, title, due_date)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.actor.academyId, classId, title, dueDate);
    const insert = ctx.db.prepare(
      `INSERT INTO homework_questions
       (id, assignment_id, position, prompt, answer_key, points, problem_type, type_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    questions.forEach((question, index) => {
      insert.run(
        randomUUID(),
        id,
        index + 1,
        question.prompt,
        question.answer,
        question.points,
        question.type,
        normalize(question.type),
      );
    });
  });
}

function submitAnswers(ctx: PageContext, form: FormData): void {
  const assignmentId = required(form, 'assignmentId', '숙제', 128);
  const studentId = ctx.actor.studentId;
  if (!studentId) {
    throw new OperationError('학생 계정에서 제출해 주세요.', 403);
  }
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const assignment = studentAssignment(ctx, assignmentId);
    if (
      assignment.submission_mode === 'answers' &&
      isLate(assignment.due_date)
    ) {
      throw new OperationError('제출 마감일이 지났습니다.');
    }
    if (
      one(
        ctx.db,
        'SELECT id FROM homework_submissions WHERE assignment_id = ? AND student_id = ?',
        assignment.id,
        studentId,
      )
    ) {
      throw new OperationError('이미 제출한 숙제입니다.', 409);
    }
    const workbook = ['workbook', 'catalog'].includes(
      assignment.submission_mode,
    );
    const questions = questionsFor(ctx, assignment.id);
    const wrong = new Set(form.getAll('wrong'));
    if (
      workbook &&
      (field(form, 'action') !== 'report' ||
        (wrong.size === 0) !== (field(form, 'allCorrect') === 'yes') ||
        wrong.size !== form.getAll('wrong').length ||
        [...wrong].some((i) => !questions.some((q) => q.id === i)))
    )
      throw new OperationError(
        '틀린 문항을 선택하거나 모두 맞음을 체크해 주세요.',
        422,
      );
    if (!workbook && field(form, 'action') !== 'submit')
      throw new OperationError('제출 방식을 확인해 주세요.');
    const submissionId = randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO homework_submissions (id, assignment_id, student_id, submitted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(submissionId, assignment.id, studentId, new Date().toISOString());
    const insert = ctx.db.prepare(
      `INSERT INTO homework_marks
       (submission_id, question_id, response, automatic_points, awarded_points)
       VALUES (?, ?, ?, ?, ?)`,
    );
    if (workbook) {
      const outcomes: Record<string, 'correct' | 'incorrect'> = {};
      for (const q of questions) {
        const incorrect = wrong.has(q.id);
        outcomes[q.id] = incorrect ? 'incorrect' : 'correct';
        insert.run(
          submissionId,
          q.id,
          incorrect ? '오답' : '정답',
          incorrect ? 0 : 1,
          incorrect ? 0 : 1,
        );
      }
      if (assignment.submission_mode === 'catalog') return;
      recordWorkbookReport(ctx, assignment.id, studentId, outcomes);
      ctx.db
        .prepare(
          'UPDATE homework_submissions SET confirmed_at=submitted_at WHERE id=?',
        )
        .run(submissionId);
      return;
    }
    for (const question of questions) {
      const response = field(form, 'answer-' + question.id, 500);
      const score =
        normalize(response) === normalize(question.answer_key)
          ? question.points
          : 0;
      insert.run(submissionId, question.id, response, score, score);
    }
  });
}

function reviewScores(ctx: PageContext, form: FormData): void {
  if (!isStaff(ctx.actor.role)) {
    throw new OperationError('채점 검수 권한이 없습니다.', 403);
  }
  const id = required(form, 'submissionId', '제출 기록', 128);
  const decision = field(form, 'decision', 10);
  if (decision !== 'save' && decision !== 'confirm' && decision !== 'correct') {
    throw new OperationError('검수 작업을 선택해 주세요.');
  }
  const reason =
    decision === 'correct' ? required(form, 'reason', '정정 사유', 500) : null;
  const versionText = field(form, 'reviewVersion', 12);
  const version = Number(versionText || '0');
  if (versionText && !/^\d+$/.test(versionText)) {
    throw new OperationError('검수 화면을 다시 열어 주세요.');
  }
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    const submission = submissionFor(ctx, id);
    if (submission.submission_mode === 'workbook')
      throw new OperationError('학생이 제출한 오답 기록입니다.', 409);
    if (submission.review_version !== version) {
      throw new OperationError(
        '다른 검수가 저장되었습니다. 화면을 새로고침해 주세요.',
        409,
      );
    }
    if ((decision === 'correct') !== Boolean(submission.confirmed_at)) {
      throw new OperationError(
        '현재 채점 상태에서 실행할 수 없는 검수 작업입니다.',
        409,
      );
    }
    const marks = markedAnswers(ctx, id);
    const scores = marks.map((mark) => {
      const value = field(form, 'score-' + mark.id, 3);
      const score = Number(value);
      if (!/^\d+$/.test(value) || score > mark.points) {
        throw new OperationError(
          `${mark.position}번 문항의 점수를 0~${mark.points}점으로 입력해 주세요.`,
        );
      }
      return { questionId: mark.id, points: score };
    });
    if (
      decision === 'correct' &&
      scores.every(
        ({ points }, index) => points === marks[index].awarded_points,
      )
    ) {
      throw new OperationError('정정할 점수를 변경해 주세요.');
    }
    const update = ctx.db.prepare(
      `UPDATE homework_marks SET awarded_points = ?
       WHERE submission_id = ? AND question_id = ?`,
    );
    const saveRevision = ctx.db.prepare(
      `INSERT INTO homework_grade_revisions
       (submission_id, version, finalized_at, reviewer_id, reason, scores)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    if (
      submission.confirmed_at &&
      !one(
        ctx.db,
        'SELECT 1 FROM homework_grade_revisions WHERE submission_id = ? AND version = ?',
        id,
        version,
      )
    ) {
      // Capture the last published grade when an older database has no revision rows.
      saveRevision.run(
        id,
        version,
        submission.confirmed_at,
        null,
        null,
        JSON.stringify(
          marks.map((mark) => ({
            questionId: mark.id,
            points: mark.awarded_points,
          })),
        ),
      );
    }
    for (const { questionId, points } of scores) {
      update.run(points, id, questionId);
    }
    const confirmedAt = decision === 'save' ? null : new Date().toISOString();
    if (confirmedAt) {
      saveRevision.run(
        id,
        version + 1,
        confirmedAt,
        ctx.actor.id,
        reason,
        JSON.stringify(scores),
      );
    }
    ctx.db
      .prepare(
        'UPDATE homework_submissions SET confirmed_at = ?, review_version = ? WHERE id = ?',
      )
      .run(confirmedAt, version + 1, id);
  });
}

function renderAssignments(
  assignments: Assignment[],
  submissions: Submission[],
  staff: boolean,
): string {
  return `<section class="panel"><h2>배정된 숙제</h2>
    ${
      assignments.length
        ? `<div class="table-wrap"><table>
        <thead><tr><th>숙제</th><th>반</th><th>숙제 날짜 / 마감일</th><th>${staff ? '제출' : '상태'}</th></tr></thead>
        <tbody>${assignments
          .map((assignment) => {
            const submitted = submissions.filter(
              (item) => item.assignment_id === assignment.id,
            );
            const state = staff
              ? submitted.length + '건'
              : submitted.length
                ? '제출 완료'
                : assignment.submission_mode !== 'workbook' &&
                    isLate(assignment.due_date)
                  ? '마감'
                  : `<a href="/homework?assignment=${encodeURIComponent(assignment.id)}">${assignment.submission_mode === 'workbook' ? '오답 선택' : '답안 제출'}</a>`;
            return `<tr><td>${escapeHtml(assignment.title)}</td><td>${escapeHtml(assignment.class_name)}</td>
              <td>${escapeHtml(assignment.due_date)}</td><td>${state}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
        : '<p>배정된 숙제가 없습니다.</p>'
    }</section>`;
}

function renderSubmissions(submissions: Submission[], staff: boolean): string {
  return `<section class="panel"><h2>${staff ? '제출물 확인' : '제출 결과'}</h2>
    ${
      submissions.length
        ? `<div class="table-wrap"><table>
        <thead><tr><th>숙제</th><th>학생</th><th>점수</th><th>상태</th><th>보기</th></tr></thead>
        <tbody>${submissions
          .map((submission) => {
            const status =
              submission.submission_mode === 'workbook'
                ? '학생 제출'
                : submission.confirmed_at
                  ? '확정'
                  : '검수 대기';
            const action =
              staff || submission.confirmed_at
                ? `<a href="/homework?submission=${encodeURIComponent(submission.id)}">${staff && !submission.confirmed_at ? '검수' : '결과'}</a>`
                : '–';
            const score =
              staff || submission.confirmed_at
                ? `${submission.score} / ${submission.total}`
                : '–';
            return `<tr><td>${escapeHtml(submission.assignment_title)}</td>
              <td>${escapeHtml(submission.student_name)}</td><td>${score}</td><td>${status}</td><td>${action}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
        : '<p>제출 기록이 없습니다.</p>'
    }</section>`;
}

export function homeworkPhoto(ctx: PageContext) {
  const id = ctx.url.searchParams.get('assignment') ?? '';
  const assignment = one<Assignment>(
    ctx.db,
    assignmentsSql + ' AND a.id = ?',
    ctx.actor.academyId,
    id,
  );
  if (
    !assignment ||
    !['teacher', 'admin', 'student'].includes(ctx.actor.role) ||
    !accessibleClasses(ctx.db, ctx.actor).some(
      (c) => c.id === assignment.class_id,
    )
  )
    throw new OperationError('사진을 찾을 수 없습니다.', 404);
  const photo = one<{ mime: string; bytes: Uint8Array }>(
    ctx.db,
    'SELECT mime, bytes FROM homework_photos WHERE assignment_id = ?',
    id,
  );
  if (!photo) throw new OperationError('사진을 찾을 수 없습니다.', 404);
  return photo;
}

function renderPhoto(ctx: PageContext, id: string) {
  return one(
    ctx.db,
    'SELECT 1 FROM homework_photos WHERE assignment_id = ?',
    id,
  )
    ? '<img class="homework-photo" alt="숙제 문제 원본 사진" src="/homework/photo?assignment=' +
        encodeURIComponent(id) +
        '">'
    : '';
}

function renderStudentForm(ctx: PageContext, id: string): string {
  const assignment = studentAssignment(ctx, id);
  const catalog =
    assignment.submission_mode === 'catalog'
      ? workbookRecipients(ctx, id)[0]
      : undefined;
  if (catalog?.submission_id) {
    const marks = markedAnswers(ctx, catalog.submission_id);
    return `<section class="panel"><a href="/homework">숙제 목록</a><h2>${escapeHtml(assignment.title)}</h2><p>${late(catalog) ? '지각 제출' : '제출 완료'} · ${catalog.confirmed_at ? '선생님 확인 완료' : '선생님 확인 대기'}</p><ul>${marks.map((m) => `<li>${escapeHtml(m.prompt)} · ${m.awarded_points ? '정답' : '오답'}</li>`).join('')}</ul></section>`;
  }
  if (
    (assignment.submission_mode === 'answers' && isLate(assignment.due_date)) ||
    one(
      ctx.db,
      'SELECT id FROM homework_submissions WHERE assignment_id = ? AND student_id = ?',
      id,
      ctx.actor.studentId,
    )
  ) {
    throw new OperationError(
      '제출을 완료했거나 제출 마감일이 지났습니다.',
      409,
    );
  }
  if (assignment.submission_mode === 'workbook' || catalog)
    return `<section class="panel"><h2>${escapeHtml(assignment.title)}</h2><p>${escapeHtml(assignment.class_name)} · ${escapeHtml(assignment.due_date)} ${escapeHtml(catalog?.due_time)} 마감</p>
    <form method="post" action="/homework"><input type="hidden" name="action" value="report"><input type="hidden" name="assignmentId" value="${escapeHtml(id)}">
    <fieldset><legend>틀린 문항을 선택하세요</legend>${questionsFor(ctx, id)
      .map(
        (q) =>
          `<label class="check-label"><input type="checkbox" name="wrong" value="${escapeHtml(q.id)}"> ${escapeHtml(q.prompt)}</label>`,
      )
      .join('')}
    <label class="check-label"><input type="checkbox" name="allCorrect" value="yes"> 모두 맞았어요</label></fieldset><button>결과 제출</button></form></section>`;
  return `<section class="panel">
    <h2>${escapeHtml(assignment.title)}</h2>${renderPhoto(ctx, id)}
    <p>${escapeHtml(assignment.class_name)} · ${escapeHtml(assignment.due_date)}까지</p>
    <form method="post" action="/homework">
      <input type="hidden" name="action" value="submit">
      <input type="hidden" name="assignmentId" value="${escapeHtml(id)}">
      ${questionsFor(ctx, id)
        .map(
          (q) => `<label>${q.position}. ${escapeHtml(q.prompt)} (${q.points}점)
            <input name="answer-${escapeHtml(q.id)}" maxlength="500" autocomplete="off">
          </label>`,
        )
        .join('')}
      <div class="actions"><button type="submit">답안 제출</button><a href="/homework">목록</a></div>
    </form>
  </section>`;
}

function renderWrongAnswers(
  ctx: PageContext,
  submission: Submission,
  marks: MarkedAnswer[],
): string {
  const wrong = marks.filter((mark) => mark.awarded_points < mark.points);
  return `<section class="panel"><h2>오답 노트</h2>
    ${
      wrong.length
        ? wrong
            .map((mark) => {
              const practice = mark.type_key
                ? rows<{ prompt: string }>(
                    ctx.db,
                    `SELECT DISTINCT q.prompt
                   FROM homework_submissions s
                   JOIN homework_assignments a ON a.id = s.assignment_id
                   JOIN homework_questions q ON q.assignment_id = a.id
                   WHERE a.academy_id = ? AND a.submission_mode <> 'catalog' AND s.student_id = ? AND s.confirmed_at IS NOT NULL
                     AND q.type_key = ? AND q.prompt <> ?
                   ORDER BY q.prompt LIMIT 3`,
                    ctx.actor.academyId,
                    submission.student_id,
                    mark.type_key,
                    mark.prompt,
                  )
                : [];
              return `<article>
              <h3>${mark.position}. ${escapeHtml(mark.prompt)}</h3>
              <p>제출 답안 ${escapeHtml(mark.response || '미입력')} · 정답 ${escapeHtml(mark.answer_key)} · ${mark.awarded_points}/${mark.points}점</p>
              ${
                practice.length
                  ? `<p>${escapeHtml(mark.problem_type)} 복습 문항</p><ul>${practice
                      .map(({ prompt }) => `<li>${escapeHtml(prompt)}</li>`)
                      .join('')}</ul>`
                  : '<p>같은 유형의 확정된 복습 문항이 없습니다.</p>'
              }
            </article>`;
            })
            .join('')
        : '<p>확정 결과에서 오답이 없습니다.</p>'
    }
  </section>`;
}

function renderSubmission(ctx: PageContext, id: string): string {
  const submission = submissionFor(ctx, id);
  const staff = isStaff(ctx.actor.role);
  if (!staff && !submission.confirmed_at) {
    return '<section class="panel"><h2>채점 검수 대기</h2><p>강사가 결과를 확정하면 확인할 수 있습니다.</p><a href="/homework">목록</a></section>';
  }
  const marks = markedAnswers(ctx, id);
  if (submission.submission_mode === 'workbook')
    return `<section class="panel"><h2>${escapeHtml(submission.assignment_title)}</h2><p>${escapeHtml(submission.student_name)} · 학생 제출 · ${submission.total}문항 중 ${submission.score}문항 정답</p><ul>${marks.map((q) => `<li>${escapeHtml(q.prompt)} · ${escapeHtml(q.response)}</li>`).join('')}</ul><a href="/homework">숙제 목록</a></section>`;
  const revisions =
    staff && submission.confirmed_at
      ? rows<{ version: number; finalized_at: string; reason: string | null }>(
          ctx.db,
          'SELECT version, finalized_at, reason FROM homework_grade_revisions WHERE submission_id = ? ORDER BY version DESC',
          id,
        )
      : [];
  const table = `<div class="table-wrap"><table>
    <thead><tr><th>문항</th><th>제출 답안</th><th>정답</th><th>자동 점수</th><th>검수 점수</th></tr></thead>
    <tbody>${marks
      .map(
        (mark) => `<tr><td>${mark.position}. ${escapeHtml(mark.prompt)}</td>
          <td>${escapeHtml(mark.response || '미입력')}</td><td>${escapeHtml(mark.answer_key)}</td>
          <td>${mark.automatic_points} / ${mark.points}</td>
          <td>${
            staff
              ? `<input type="number" name="score-${escapeHtml(mark.id)}" min="0" max="${mark.points}"
                     value="${mark.awarded_points}" aria-label="${mark.position}번 검수 점수" required> / ${mark.points}`
              : `${mark.awarded_points} / ${mark.points}`
          }</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  return `<section class="panel"><h2>${escapeHtml(submission.assignment_title)}</h2>
    ${staff ? renderPhoto(ctx, submission.assignment_id) : ''}
    <p>${escapeHtml(submission.student_name)} · ${submission.score}/${submission.total}점</p>
    ${
      staff
        ? `<form method="post" action="/homework">
        <input type="hidden" name="action" value="review">
        <input type="hidden" name="submissionId" value="${escapeHtml(id)}">
        <input type="hidden" name="reviewVersion" value="${submission.review_version}">
        ${table}
        ${
          submission.confirmed_at
            ? '<label>정정 사유 <input name="reason" maxlength="500" required></label><div class="actions"><button type="submit" name="decision" value="correct">정정 확정</button>'
            : '<div class="actions"><button type="submit" name="decision" value="save">검수 저장</button><button type="submit" name="decision" value="confirm">점수 확정</button>'
        }<a href="/homework">목록</a></div>
      </form>`
        : `${table}<div class="actions"><a href="/homework">목록</a></div>`
    }
    </section>${
      revisions.length
        ? `<section class="panel"><h2>점수 확정·정정 이력</h2>
      <ul>${revisions
        .map(
          ({ version, finalized_at, reason }) =>
            `<li>${version}차 · ${escapeHtml(finalized_at)}${reason ? ' · ' + escapeHtml(reason) : ''}</li>`,
        )
        .join('')}</ul></section>`
        : ''
    }
    ${submission.confirmed_at ? renderWrongAnswers(ctx, submission, marks) : ''}`;
}

function visibleHomework(ctx: PageContext, pendingOnly = false) {
  const { actor, db } = ctx;
  const staff = isStaff(actor.role);
  const classes = new Set(accessibleClasses(db, actor).map(({ id }) => id));
  const students = new Set(accessibleStudents(db, actor).map(({ id }) => id));
  const submissions = rows<Submission>(
    db,
    submissionsSql +
      (pendingOnly ? ' AND s.confirmed_at IS NULL\n' : '') +
      submissionsOrder,
    actor.academyId,
  ).filter(
    ({ student_id, class_id }) =>
      students.has(student_id) && (!staff || classes.has(class_id)),
  );
  const assignments =
    !pendingOnly && (staff || actor.role === 'student')
      ? rows<Assignment>(
          db,
          assignmentsSql + ' ORDER BY a.due_date DESC, a.title',
          actor.academyId,
        ).filter(({ class_id }) => classes.has(class_id))
      : [];
  return { assignments, submissions };
}

export function homeworkOverview(ctx: PageContext) {
  const staff = isStaff(ctx.actor.role);
  const { assignments, submissions } = visibleHomework(ctx, staff);
  const submitted = new Set(
    submissions.map(({ assignment_id }) => assignment_id),
  );
  const catalog = workbookRecipients(ctx);
  const pending = new Map(
    catalog
      .filter((r) => r.submission_id && !r.confirmed_at)
      .map((r) => [r.submission_id!, r]),
  );
  return {
    review: staff
      ? [
          ...submissions,
          ...[...pending.values()].map((r) => ({
            id: r.submission_id!,
            assignment_id: r.id,
            assignment_title: r.title,
            student_name: r.student_name!,
            submission_mode: 'catalog',
          })),
        ]
      : [],
    due: [
      ...assignments,
      ...[
        ...groupHomework(catalog.filter((r) => !r.submitted_at)).values(),
      ].map(([r]) => ({ ...r, submission_mode: 'catalog' })),
    ]
      .filter(
        ({ id, due_date, submission_mode }) =>
          !submitted.has(id) &&
          (submission_mode !== 'answers' || !isLate(due_date)),
      )
      .sort(
        (a, b) =>
          a.due_date.localeCompare(b.due_date) ||
          a.title.localeCompare(b.title),
      ),
    results: staff
      ? []
      : submissions.filter(({ confirmed_at }) => confirmed_at).slice(0, 4),
  };
}

export const homeworkModule: OperationModule = {
  path: '/homework',
  label: '숙제',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS homework_assignments (
        id TEXT PRIMARY KEY,
        academy_id TEXT NOT NULL,
        class_id TEXT NOT NULL REFERENCES classes(id),
        title TEXT NOT NULL,
        due_date TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS homework_assignments_academy
        ON homework_assignments(academy_id, class_id);
      CREATE TABLE IF NOT EXISTS homework_analysis_drafts (
        id TEXT PRIMARY KEY, academy_id TEXT NOT NULL,teacher_id TEXT NOT NULL,subject TEXT NOT NULL,result TEXT NOT NULL,expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS homework_photos (
        assignment_id TEXT PRIMARY KEY REFERENCES homework_assignments(id),
        mime TEXT NOT NULL, bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS homework_questions (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES homework_assignments(id),
        position INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        answer_key TEXT NOT NULL,
        points INTEGER NOT NULL CHECK (points BETWEEN 1 AND 100),
        problem_type TEXT NOT NULL,
        type_key TEXT NOT NULL,
        UNIQUE (assignment_id, position)
      );
      CREATE TABLE IF NOT EXISTS homework_submissions (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES homework_assignments(id),
        student_id TEXT NOT NULL REFERENCES students(id),
        submitted_at TEXT NOT NULL,
        confirmed_at TEXT,
        review_version INTEGER NOT NULL DEFAULT 0,
        UNIQUE (assignment_id, student_id)
      );
      CREATE INDEX IF NOT EXISTS homework_submissions_student
        ON homework_submissions(student_id, confirmed_at);
      CREATE TABLE IF NOT EXISTS homework_marks (
        submission_id TEXT NOT NULL REFERENCES homework_submissions(id),
        question_id TEXT NOT NULL REFERENCES homework_questions(id),
        response TEXT NOT NULL,
        automatic_points INTEGER NOT NULL CHECK (automatic_points >= 0),
        awarded_points INTEGER NOT NULL CHECK (awarded_points >= 0),
        PRIMARY KEY (submission_id, question_id)
      );
      CREATE TABLE IF NOT EXISTS homework_grade_revisions (
        submission_id TEXT NOT NULL REFERENCES homework_submissions(id),
        version INTEGER NOT NULL,
        finalized_at TEXT NOT NULL,
        reviewer_id TEXT REFERENCES accounts(id),
        reason TEXT,
        scores TEXT NOT NULL,
        PRIMARY KEY (submission_id, version)
      );
    `);
    if (
      !rows<{ name: string }>(
        db,
        'PRAGMA table_info(homework_assignments)',
      ).some((c) => c.name === 'submission_mode')
    )
      db.exec(
        "ALTER TABLE homework_assignments ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'answers'",
      );
    if (
      !rows<{ name: string }>(
        db,
        'PRAGMA table_info(homework_submissions)',
      ).some(({ name }) => name === 'review_version')
    ) {
      db.exec(
        'ALTER TABLE homework_submissions ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0',
      );
    }
    setupWorkbookCatalog(db);
  },
  render(ctx) {
    const { actor, url } = ctx;
    const view = url.searchParams.get('view'),
      detail = url.searchParams.get('detail');
    if (detail) return renderWorkbookDetail(ctx, detail);
    if (view === 'analysis') return workbookAnalytics(ctx, true);
    if (view === 'books') return renderBookList(ctx);
    if (view === 'create') return renderWorkbookForm(ctx);
    const submissionId = url.searchParams.get('submission');
    if (submissionId) return renderSubmission(ctx, submissionId);
    const assignmentId = url.searchParams.get('assignment');
    if (assignmentId) return renderStudentForm(ctx, assignmentId);

    const staff = isStaff(actor.role);
    const saved = url.searchParams.get('saved');
    if (staff && saved) {
      const a = one<Assignment>(
        ctx.db,
        assignmentsSql + ' AND a.id=?',
        actor.academyId,
        saved,
      );
      if (
        !a ||
        !accessibleClasses(ctx.db, actor).some((c) => c.id === a.class_id)
      )
        throw new OperationError('숙제를 찾을 수 없습니다.', 404);
      return `<section class="panel"><h1>숙제 배정 완료</h1><p>${escapeHtml(a.class_name)} · ${escapeHtml(a.title)} · ${questionsFor(ctx, saved).length}문항</p><div class="actions"><a href="/briefing?assignment=${encodeURIComponent(saved)}">이 숙제 브리핑</a><a href="/homework?view=create">새 숙제 등록</a><a href="/homework">숙제 목록</a></div></section>`;
    }
    const pending = staff && url.searchParams.get('view') === 'review';
    const { assignments, submissions } = visibleHomework(ctx, pending);
    const catalog = workbookRecipients(ctx);
    const needsReview = new Set(
      catalog
        .filter((r) => r.submission_id && !r.confirmed_at)
        .map((r) => r.id),
    );
    return [
      '<div class="workspace-heading"><h1>숙제</h1>' +
        (staff
          ? '<a class="button-link" href="/homework?view=create#homework-create">숙제 등록</a>'
          : '') +
        '</div>',
      staff
        ? `<nav class="view-tabs page-tabs" aria-label="숙제 보기"><a href="/homework"${!pending ? ' aria-current="page"' : ''}>전체 숙제</a><a href="/homework?view=review"${pending ? ' aria-current="page"' : ''}>확인할 제출물</a></nav>`
        : '',
      staff
        ? '<nav class="actions"><a href="/homework?view=books">교재 목록</a><a href="/homework?view=analysis">학생별 분석</a><a href="/briefing">반 브리핑</a></nav>'
        : '',
      staff || actor.role === 'student'
        ? renderCatalogList(
            pending ? catalog.filter((r) => needsReview.has(r.id)) : catalog,
            staff,
          )
        : '',
      !pending && assignments.length > 0 && (staff || actor.role === 'student')
        ? renderAssignments(assignments, submissions, staff)
        : '',
      submissions.length || actor.role === 'guardian'
        ? renderSubmissions(submissions, staff)
        : '',
    ].join('');
  },
  submit(ctx, data) {
    switch (field(data, 'action', 20)) {
      case 'register-book':
        return registerBook(ctx, data);
      case 'assign-workbook':
        return assignWorkbook(ctx, data);
      case 'approve-workbook':
        return approvedReview(ctx, data);
      case 'create':
        return createAssignment(ctx, data);
      case 'report':
      case 'submit':
        return submitAnswers(ctx, data);
      case 'review':
        return reviewScores(ctx, data);
      default:
        throw new OperationError('숙제 처리 요청을 확인해 주세요.');
    }
  },
};
