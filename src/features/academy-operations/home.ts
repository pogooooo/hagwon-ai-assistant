import { homeworkDashboard } from './homework-dashboard.ts';
import { visibleParentMessages } from './parent-messages-model.ts';
import { visibleCalendarEntries } from './calendar.ts';
import { canAskConsultation, consultationOverview } from './consultation.ts';
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
  const showChat = canAskConsultation(actor);
  const guardian = actor.role === 'guardian';
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
  const title =
    actor.role === 'teacher'
      ? '오늘, 확인할 일부터'
      : actor.role === 'admin'
        ? '학원 운영'
        : actor.role === 'guardian'
          ? '오늘의 학원 소식'
          : actor.role === 'student'
            ? '나의 학원'
            : '학원 안내';
  const heading = `<div class="ondap-heading"><h1>${title}</h1><time datetime="${today}">${h(date)}</time></div>`;
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
    ...(showChat ? [['/consultation', '학원 상담']] : []),
    ...(!visitor
      ? [
          ['/schedule', '수업 일정'],
          ['/homework', staff ? '숙제 관리' : '숙제 확인'],
          guardian
            ? ['/student-reports', '학습 리포트']
            : ['/learning', '학습 기록'],
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
    const board = homeworkDashboard(ctx);
    const dayEntries = visibleCalendarEntries(ctx, today, today);
    const dayPanel = panel(
      '오늘 일정',
      '/schedule?day=' + today,
      dayEntries
        .slice(0, 4)
        .map((e) => ({ title: e.title, href: '/schedule?day=' + today })),
      '오늘 등록된 일정이 없습니다.',
      '달력 보기',
    );
    const links = (title: string, items: [string, string, string][]) =>
      `<section class="panel next-actions"><h2>${title}</h2>${items.map(([path, label, icon]) => `<a href="${h(path)}">${serviceIcon(icon)}${label}<span aria-hidden="true">›</span></a>`).join('')}</section>`;
    const review = homework.review;
    const queue = panel(
      `제출 확인 대기 · ${review.length}건`,
      '/homework?view=review',
      review.slice(0, 4).map((r) => ({
        title: r.student_name + ' · ' + r.assignment_title,
        meta: '제출 내용 확인',
        href:
          r.submission_mode === 'catalog'
            ? '/homework?detail=' + encodeURIComponent(r.assignment_id)
            : '/homework?submission=' + encodeURIComponent(r.id),
      })),
      '확인 대기 중인 제출물이 없습니다.',
    );
    const inbox = panel(
      `상담 요청 · ${pending.length}건`,
      '/consultation?view=inbox',
      pending.slice(0, 3).map((r) => ({
        title: r.title,
        meta: r.label,
        href: '/consultation?id=' + encodeURIComponent(r.id) + '&view=inbox',
      })),
      '처리할 상담이 없습니다.',
    );
    const work = (review.length ? queue : '') + (pending.length ? inbox : '');
    const upcoming = dayEntries.length
      ? schedulePanel(
          ctx,
          new Date(Date.parse(today + 'T00:00:00Z') + 86_400_000)
            .toISOString()
            .slice(0, 10),
        )
      : agenda;
    return `${heading}<div class="ondap-board"><div class="ondap-column">
       ${work || '<p class="home-clear">지금 확인할 제출과 상담이 없습니다.</p>'}
       ${board.table}
       </div><div class="ondap-column">${dayEntries.length ? dayPanel : ''}${links(
         '학습 관리',
         [
           ['/briefing', '반 브리핑 보기', '/briefing'],
           ['/learning', '학습 기록 검수', '/learning'],
         ],
       )}
       ${
         actor.role === 'admin'
           ? links('운영 관리', [
               ['/directory', '원생·반 관리', '/directory'],
               ['/messages', '학부모 안내', '/messages'],
               ['/makeup-votes', '보강 투표 결과 확인', '/makeup-votes'],
               ['/schools', '학교 시험 일정', '/schools'],
             ])
           : ''
       }
       ${board.summary}${upcoming}${documentList()}</div></div>`;
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
      : guardian
        ? ''
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
  const learning =
    visitor || guardian
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
  const messages = guardian ? visibleParentMessages(ctx) : [];
  const familyHero = guardian
    ? `<section class="family-highlight"><img src="/assets/ondap-report.png" alt=""><div><h2>학습 리포트</h2><p>과제별 결과와 월간 학습 기록을 확인하세요.</p><a class="button-link assessment-entry" href="/student-reports">학습 리포트 보기 <span aria-hidden="true">›</span></a></div></section>${panel(
        '학원 알림',
        '/messages',
        messages.slice(0, 3).map((m) => ({
          title: m.title,
          href: '/messages?id=' + encodeURIComponent(m.id),
        })),
        '도착한 알림이 없습니다.',
      )}`
    : '';
  return `${heading}${pendingMakeupNotices(ctx)}${familyHero}${shortcuts}<div class="home-columns${visitor ? '' : ' home-family'}">
    <div class="home-primary">${visitor ? documentList() : `${agenda}${homeworkPanel || ''}${learning}`}</div>
    ${showChat ? `<div class="home-help">${search}</div>` : ''}
    <div class="home-secondary">${visitor ? '' : documentList()}${showChat ? recentConsultations() : ''}</div>
  </div>`;
}
