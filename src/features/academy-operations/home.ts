import { visibleCalendarEntries } from './calendar.ts';
import { consultationOverview } from './consultation.ts';
import { recentPublishedDocuments } from './documents.ts';
import { homeworkOverview } from './homework.ts';
import { recentLearningReports } from './learning.ts';
import { selectedCharacter } from './preferences.ts';
import { escapeHtml as h, type PageContext } from './shared.ts';

interface DashboardItem {
  href: string;
  title: string;
  meta?: string;
  date?: string;
  kind?: string;
}

function records(items: DashboardItem[], empty: string) {
  if (!items.length) return `<p class="dashboard-empty">${h(empty)}</p>`;
  return `<ul class="record-list">${items
    .map(
      ({ href, title, meta, date, kind }) =>
        `<li><a href="${h(href)}">
          ${date ? `<time datetime="${date}">${Number(date.slice(5, 7))}.${date.slice(8)}</time>` : ''}
          <span class="record-copy">${kind ? `<i class="event-dot calendar-${h(kind)}" aria-hidden="true"></i>` : ''}<strong>${h(title)}</strong>${meta ? `<small>${h(meta)}</small>` : ''}</span>
          <span class="record-arrow" aria-hidden="true">›</span>
        </a></li>`,
    )
    .join('')}</ul>`;
}

function panel(
  title: string,
  href: string,
  items: DashboardItem[],
  empty: string,
  linkLabel = '전체 보기',
) {
  return `<section class="panel dashboard-panel">
    <div class="panel-heading"><h2>${title}</h2><a href="${href}">${linkLabel}</a></div>
    ${records(items, empty)}
  </section>`;
}

function schedulePanel(ctx: PageContext, from: string) {
  const end = new Date(Date.parse(from + 'T00:00:00Z') + 13 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const agenda = visibleCalendarEntries(ctx, from, end)
    .slice(0, 6)
    .map(({ date, title, kind }) => ({
      href:
        '/schedule?' +
        new URLSearchParams({ month: date.slice(0, 7), day: date }),
      title,
      date,
      kind,
    }));
  return panel(
    '다가오는 일정',
    '/schedule',
    agenda,
    '앞으로 2주간 등록된 일정이 없습니다.',
    '달력 보기',
  );
}

function consultationCard(ctx: PageContext) {
  return `<section class="panel consultation-shortcut">
    <img src="/assets/${selectedCharacter(ctx)}.png" alt="">
    <div><h2>학원 상담</h2><p>수업 일정이나 학원 생활에 대해 질문해 보세요.</p></div>
    <a class="button-link" href="/consultation">새 상담</a>
  </section>`;
}

export function renderHome(ctx: PageContext) {
  const { actor } = ctx;
  const staff = actor.role === 'admin' || actor.role === 'teacher';
  const visitor = actor.role === 'visitor';
  const now = new Date();
  const date = now.toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  const today = new Date(now.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const heading = `<div class="workspace-heading dashboard-heading"><div><h1>${staff ? '학원 운영' : '우리 학원'}</h1><time datetime="${today}">${h(date)}</time></div>${
    staff
      ? `<div class="actions">${actor.role === 'admin' ? '<a class="button-link subtle-link" href="/documents?view=create#document-edit">자료 등록</a>' : ''}<a class="button-link" href="/schedule?view=makeup">휴·보강 관리</a></div>`
      : ''
  }</div>`;
  const { pending, recent } = consultationOverview(ctx);
  const homework = visitor ? undefined : homeworkOverview(ctx);
  const agenda = visitor ? '' : schedulePanel(ctx, today);
  const documentList = () =>
    panel(
      '최근 공개 자료',
      '/documents',
      recentPublishedDocuments(ctx).map(({ documentId, revision, title }) => ({
        href:
          '/documents?' +
          new URLSearchParams({ id: documentId, revision: String(revision) }),
        title,
      })),
      '열람할 수 있는 공개 자료가 없습니다.',
    );
  const recentConsultations = () =>
    panel(
      '최근 내 상담',
      '/consultation',
      recent.map(({ id, title, label }) => ({
        href: '/consultation?id=' + encodeURIComponent(id),
        title,
        meta: label,
      })),
      '아직 남긴 상담이 없습니다.',
    );

  if (staff && homework) {
    return `${heading}
      <section class="work-queue" aria-labelledby="work-queue-title">
        <h2 id="work-queue-title">처리할 업무</h2>
        <div class="queue-grid">
          <a href="/consultation?view=inbox"><span>처리 중인 상담</span><strong>${pending.length}<small>건</small></strong><span aria-hidden="true">›</span></a>
          <a href="/homework?view=review"><span>숙제 채점 검수</span><strong>${homework.review.length}<small>건</small></strong><span aria-hidden="true">›</span></a>
        </div>
      </section>
      <div class="dashboard-grid">
        <div>${panel(
          '상담 요청',
          '/consultation?view=inbox',
          pending.slice(0, 4).map(({ id, title, label }) => ({
            href: '/consultation?id=' + encodeURIComponent(id) + '&view=inbox',
            title,
            meta: label,
          })),
          '현재 처리할 상담이 없습니다.',
        )}${panel(
          '검수 대기 숙제',
          '/homework?view=review',
          homework.review
            .slice(0, 4)
            .map(({ id, assignment_title, student_name }) => ({
              href: '/homework?submission=' + encodeURIComponent(id),
              title: assignment_title,
              meta: student_name,
            })),
          '검수할 제출물이 없습니다.',
        )}</div>
        <div>${agenda}${documentList()}</div>
      </div>`;
  }

  const homeworkPanel =
    homework &&
    (actor.role === 'student'
      ? panel(
          '제출할 숙제',
          '/homework',
          homework.due.slice(0, 4).map(({ id, title, due_date }) => ({
            href: '/homework?assignment=' + encodeURIComponent(id),
            title,
            meta: due_date + ' 마감',
          })),
          '제출할 숙제가 없습니다.',
        )
      : panel(
          '최근 숙제 결과',
          '/homework',
          homework.results.map(
            ({ id, assignment_title, student_name, score, total }) => ({
              href: '/homework?submission=' + encodeURIComponent(id),
              title: assignment_title,
              meta: student_name + ' · ' + score + ' / ' + total + '점',
            }),
          ),
          '확정된 숙제 결과가 없습니다.',
        ));
  const learning = visitor
    ? ''
    : panel(
        '최근 학습 기록',
        '/learning',
        recentLearningReports(ctx).map(({ id, name, period }) => ({
          href: '/learning?publication=' + encodeURIComponent(id),
          title: name + ' 학습 기록',
          meta: period,
        })),
        '확정된 학습 기록이 없습니다.',
      );
  return `${heading}<div class="dashboard-grid family-dashboard">
    <div class="dashboard-agenda">${agenda || documentList()}</div>
    <div class="dashboard-chat">${consultationCard(ctx)}</div>
    ${visitor ? '' : `<div class="dashboard-records">${homeworkPanel || ''}${learning}${documentList()}</div>`}
    <div class="dashboard-history">${recentConsultations()}</div>
  </div>`;
}
