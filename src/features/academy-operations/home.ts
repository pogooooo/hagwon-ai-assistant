import { visibleCalendarEntries } from './calendar.ts';
import { consultationOverview } from './consultation.ts';
import { recentPublishedDocuments } from './documents.ts';
import { homeworkOverview } from './homework.ts';
import { recentLearningReports } from './learning.ts';
import { pendingMakeupNotices } from './makeup-polls.ts';
import { selectedCharacter } from './preferences.ts';
import { serviceIcon } from './service-navigation.ts';
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
          ${date ? `<time datetime="${date}"><strong>${Number(date.slice(8))}</strong><small>${Number(date.slice(5, 7))}월</small></time>` : ''}
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
  return `<section class="panel dashboard-panel${items.length ? '' : ' is-empty'}">
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
  const heading = `<div class="workspace-heading dashboard-heading"><div><h1>${staff ? '학원 현황' : '나의 학원'}</h1><p class="home-account">${h(actor.name)}님</p></div><div class="home-heading-tools"><time datetime="${today}">${h(date)}</time>${
    staff
      ? `<div class="actions">${actor.role === 'admin' ? '<a class="button-link subtle-link" href="/documents?view=create#document-edit">자료 등록</a>' : ''}<a class="button-link" href="/schedule?view=makeup">휴·보강 관리</a></div>`
      : ''
  }</div></div>`;
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

  const shortcuts = `<nav class="home-shortcuts" aria-label="자주 사용하는 서비스">${[
    ['/consultation', '학원 상담'],
    ...(!visitor
      ? [
          ['/schedule', '수업 일정'],
          ['/homework', staff ? '숙제 관리' : '숙제 확인'],
          ['/learning', '학습 기록'],
        ]
      : []),
    ['/documents', '학원 자료'],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}">${serviceIcon(href)}<span>${label}</span></a>`,
    )
    .join('')}</nav>`;
  const search = `<section class="home-search" aria-label="학원에 물어보기">
    <div class="home-search-heading"><div><p class="home-search-kicker">우리 학원 상담</p><h2>궁금한 건<br>편하게 물어보세요.</h2><p>학원에서 확인한 자료로 안내해 드려요.</p></div><img src="/assets/${selectedCharacter(ctx)}.png" alt=""></div>
    <form action="/consultation" method="get"><label class="visually-hidden" for="home-question">상담할 질문</label><input id="home-question" name="q" maxlength="500" required placeholder="궁금한 내용을 입력하세요" autocomplete="off"><button aria-label="상담 시작"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button></form>
    <div class="home-search-bottom"><span>일정 · 수강료 · 학원 안내</span><a class="home-consultation-link" href="/consultation">상담 내역 <span aria-hidden="true">↗</span></a></div>
  </section>`;
  if (staff && homework) {
    return `${heading}
      <div class="home-overview is-staff"><section class="work-queue" aria-labelledby="work-queue-title">
        <div class="work-queue-heading"><span class="work-status-dot" aria-hidden="true"></span><h2 id="work-queue-title">오늘 확인할 업무</h2></div>
        <div class="queue-grid">
          <a href="/consultation?view=inbox"><span class="queue-label">${serviceIcon('/consultation')}처리 중인 상담</span><strong>${pending.length}<small>건</small></strong><span class="queue-action">상담 확인 <span aria-hidden="true">↗</span></span></a>
          <a href="/homework?view=review"><span class="queue-label">${serviceIcon('/homework')}확인할 제출물</span><strong>${homework.review.length}<small>건</small></strong><span class="queue-action">숙제 확인 <span aria-hidden="true">↗</span></span></a>
        </div>
      </section>${search}</div>
      ${shortcuts}<div class="home-columns">
        <div class="home-primary">${agenda}${panel(
          '상담 요청',
          '/consultation?view=inbox',
          pending.slice(0, 4).map(({ id, title, label }) => ({
            href: '/consultation?id=' + encodeURIComponent(id) + '&view=inbox',
            title,
            meta: label,
          })),
          '현재 처리할 상담이 없습니다.',
        )}${panel(
          '확인할 숙제 제출물',
          '/homework?view=review',
          homework.review
            .slice(0, 4)
            .map(
              ({
                id,
                assignment_id,
                submission_mode,
                assignment_title,
                student_name,
              }) => ({
                href:
                  submission_mode === 'catalog'
                    ? '/homework?detail=' + encodeURIComponent(assignment_id)
                    : '/homework?submission=' + encodeURIComponent(id),
                title: assignment_title,
                meta: student_name,
              }),
            ),
          '확인할 제출물이 없습니다.',
        )}</div>
        <div class="home-secondary">${documentList()}${recentConsultations()}</div>
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
  return `${heading}${pendingMakeupNotices(ctx)}${visitor ? `<div class="home-overview">${search}</div>` : ''}${shortcuts}<div class="home-columns${visitor ? '' : ' home-family'}">
    <div class="home-primary">${visitor ? documentList() : `${agenda}${homeworkPanel || ''}${learning}`}</div>
    ${visitor ? '' : `<div class="home-help">${search}</div>`}
    <div class="home-secondary">${visitor ? '' : documentList()}${recentConsultations()}</div>
  </div>`;
}
