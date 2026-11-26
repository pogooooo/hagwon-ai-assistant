import { accessibleClasses } from '../academy-operations/directory.ts';
import {
  escapeHtml as h,
  OperationError,
  type PageContext,
} from '../academy-operations/shared.ts';
import { gradingOverview } from './overview.ts';
import { computeFacts } from './facts.ts';
import { kstDate, subjects } from './contracts.ts';

export function gradingLearning(ctx: PageContext) {
  const { results } = gradingOverview(ctx);
  return `<div class="workspace-heading"><h1>학습 기록</h1><a class="workspace-link" href="/grading?view=reports">학습 리포트 <span aria-hidden="true">›</span></a></div><section class="panel learning-records"><h2>공개된 사진 채점 결과</h2>
    ${results.length ? `<ul class="record-card-list">${results.map((s) => `<li><a class="record-card-link" href="${h(s.href)}"><span><strong>${h(s.title)}</strong><small>${h(s.studentName)} · ${h(s.assessment_date)}</small></span><span aria-hidden="true">›</span></a></li>`).join('')}</ul>` : '<p class="muted">교사 검수와 원본 삭제 확인을 마친 결과가 없습니다.</p>'}</section>`;
}

export function gradingBriefing(ctx: PageContext) {
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const classId = ctx.url.searchParams.get('class') ?? classes[0]?.id;
  const from =
    ctx.url.searchParams.get('month') ?? kstDate(Date.now()).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from))
    throw new OperationError('분석 월을 확인해 주세요.', 400);
  if (classId && !classes.some((c) => c.id === classId))
    throw new OperationError('조회 가능한 반이 아닙니다.', 404);
  const header =
    '<div class="workspace-heading"><h1>반 브리핑</h1><a class="workspace-link" href="/student-reports">학생 분석·월간 리포트 <span aria-hidden="true">›</span></a></div>';
  if (!classId) return header + '<p>조회 가능한 반이 없습니다.</p>';
  const { students, results } = gradingOverview(ctx);
  const [year, month] = from.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const pupils = students.filter((s) => s.classIds.includes(classId));
  const studentId = ctx.url.searchParams.get('student') ?? '';
  const selected = pupils.find((s) => s.id === studentId);
  if (studentId && !selected)
    throw new OperationError(
      '이 반에서 조회할 수 있는 학생을 선택해 주세요.',
      404,
    );
  const items = (selected ? [selected] : pupils).map((s) => {
    const stats = computeFacts(
      ctx.db,
      ctx.actor.academyId,
      {
        student_ref: s.id,
        from_date: from + '-01',
        to_date_exclusive: end,
        comparison_period: null,
        subjects: [...subjects],
        attempt_policy: 'latest_in_window',
        statistics_policy_version: 'grading-stats-3.0',
      },
      Date.now(),
      new Set([classId]),
    );
    const totals = stats.facts.filter(
      (f) => f.period_role === 'primary' && f.primary_skill_id === null,
    );
    const correct = totals.reduce((n, f) => n + f.n_correct, 0),
      evaluated = totals.reduce((n, f) => n + f.n_evaluable, 0);
    const records = results.filter(
      (r) =>
        r.student === s.id &&
        r.classId === classId &&
        r.assessment_date.startsWith(from),
    );
    return `<article class="briefing-student-card"><header><h3>${h(s.name)}</h3><p>${evaluated ? `정답 ${correct} / 평가 가능 ${evaluated}문항` : '집계할 확정 문항이 없습니다.'}</p></header>${
      records.length
        ? `<ul class="record-card-list">${records.map((r) => `<li><a class="record-card-link" href="${h(r.href)}"><span><strong>${h(r.title)}</strong><small>${h(r.assessment_date)}</small></span><span aria-hidden="true">›</span></a></li>`).join('')}</ul>`
        : ''
    }</article>`;
  });
  return (
    header +
    `<section class="panel briefing-results"><form method="get" action="/briefing" class="briefing-filters" data-briefing-filters><label>반<select name="class">${classes.map((c) => `<option value="${h(c.id)}"${c.id === classId ? ' selected' : ''}>${h(c.name)}</option>`).join('')}</select></label><label>학생<select name="student"><option value="">반 전체</option>${pupils.map((s) => `<option value="${h(s.id)}"${s === selected ? ' selected' : ''}>${h(s.name)}</option>`).join('')}</select></label><label>분석 월<input type="month" name="month" required value="${h(from)}"></label><button>조회</button></form><h2>사진 채점 결과</h2><p class="muted">과제별 최근 풀이 중 확정·공개된 결과를 집계합니다.</p><div class="briefing-students">${items.join('') || '<p>이 반에 조회 가능한 학생이 없습니다.</p>'}</div></section>`
  );
}
