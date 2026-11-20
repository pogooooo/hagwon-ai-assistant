import { accessibleClasses } from './directory.ts';
import {
  groupHomework,
  uniqueRecipients,
  workbookRecipients,
} from './workbook-results.ts';
import { readWorkbookAnalysis } from './workbook-analysis.ts';
import { escapeHtml as h, type PageContext } from './shared.ts';

export function homeworkDashboard(ctx: PageContext) {
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const ids = new Set(classes.map((c) => c.id));
  const requested = ctx.url.searchParams.get('class') ?? '';
  const classId = ids.has(requested) ? requested : '';
  const subject = ctx.url.searchParams.get('subject') ?? '';
  const pendingOnly = ctx.url.searchParams.get('tasks') === 'pending';
  const records = workbookRecipients(ctx).filter(
    (r) =>
      (!classId || r.class_id === classId) &&
      (!subject || r.subject === subject),
  );
  const list = [...groupHomework(records).values()].map((group) => {
    const recipients = uniqueRecipients(group);
    const submitted = recipients.filter((r) => r.submitted_at);
    return {
      assignment: group[0],
      total: recipients.length,
      submitted: submitted.length,
      pending: submitted.filter((r) => !r.confirmed_at).length,
    };
  });
  const options = (values: { id: string; name: string }[], selected: string) =>
    values
      .map(
        (v) =>
          `<option value="${h(v.id)}"${selected === v.id ? ' selected' : ''}>${h(v.name)}</option>`,
      )
      .join('');
  const tabs = (pending: boolean) => {
    const search = new URLSearchParams({
      tasks: pending ? 'pending' : 'all',
      class: classId,
      subject,
    });
    return `<a href="/?${h(search.toString())}#task-list"${pending === pendingOnly ? ' aria-current="page"' : ''}>${pending ? '확인 대기' : '전체 숙제'}</a>`;
  };
  const visible = list.filter((r) => !pendingOnly || r.pending).slice(0, 6);
  const table = `<section class="panel task-board" id="task-list"><div class="panel-heading"><h2>숙제 확인</h2><a href="/homework?view=create">＋ 숙제 등록</a></div>
    <nav class="task-tabs" aria-label="숙제 상태">${tabs(true)}${tabs(false)}</nav>
    <form class="task-filters" method="get" action="/#task-list"><input type="hidden" name="tasks" value="${pendingOnly ? 'pending' : 'all'}"><label>과목<select name="subject"><option value="">전체 과목</option>${options(
      [
        { id: 'M', name: '수학' },
        { id: 'E', name: '영어' },
      ],
      subject,
    )}</select></label><label>반<select name="class"><option value="">전체 반</option>${options(classes, classId)}</select></label><button class="secondary">조회</button></form>
    ${visible.length ? `<div class="table-wrap"><table><thead><tr><th>숙제</th><th>제출</th><th>확인 대기</th><th>마감</th><th>작업</th></tr></thead><tbody>${visible.map(({ assignment: a, total, submitted, pending }) => `<tr><th scope="row">${h(a.title)}</th><td>${submitted} / ${total}명</td><td><span class="task-status${pending ? ' waiting' : ''}">${pending ? pending + '명' : submitted ? '확인 완료' : '제출 전'}</span></td><td>${h(a.due_date.slice(5).replace('-', '.'))}</td><td><a href="/homework?detail=${encodeURIComponent(a.id)}">확인<span class="visually-hidden"> · ${h(a.title)}</span> ›</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="dashboard-empty">이 조건에 해당하는 교재 숙제가 없습니다.</p>'}</section>`;
  const results = readWorkbookAnalysis(
    ctx.db,
    ctx.actor.academyId,
  ).results.filter(
    (r) =>
      r.classes.some((c) => ids.has(c.id) && (!classId || c.id === classId)) &&
      (!subject || r.subject === subject),
  );
  const bySubject = new Map<string, { correct: number; total: number }>();
  for (const r of results) {
    const n = bySubject.get(r.subject) ?? { correct: 0, total: 0 };
    for (const q of r.questions) {
      n.total++;
      n.correct += q.correct;
    }
    bySubject.set(r.subject, n);
  }
  const summary = `<section class="panel ondap-summary"><h2>반 학습 요약</h2>${[...bySubject].map(([s, n]) => `<div class="summary-bar"><strong>${s === 'M' ? '수학' : '영어'}</strong><progress aria-label="${s === 'M' ? '수학' : '영어'} 정답 문항" value="${n.correct}" max="${n.total || 1}"></progress><span>${n.correct}/${n.total}</span></div>`).join('') || '<p class="dashboard-empty">교재 숙제의 확인된 학습 기록이 없습니다.</p>'}<small>교사가 확인한 교재 숙제 기준</small></section>`;
  return { table, summary };
}
