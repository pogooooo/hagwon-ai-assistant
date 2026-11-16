import { teamScheduleModule, calendarSessions } from './team-schedule.ts';
import { scheduleModule, calendarNotices } from './schedule.ts';
import {
  escapeHtml as h,
  field,
  OperationError,
  type PageContext,
  type OperationModule,
} from './shared.ts';

export function visibleCalendarEntries(
  ctx: PageContext,
  from: string,
  to: string,
) {
  return [
    ...calendarSessions(ctx, from, to).map(({ date, label, kind }) => ({
      date,
      title: label,
      kind,
    })),
    ...calendarNotices(ctx, from, to),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function calendar(ctx: PageContext) {
  const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  const month = ctx.url.searchParams.get('month') ?? today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new OperationError('달력 월을 확인해 주세요.', 422);
  const start = month + '-01';
  const date = new Date(start + 'T00:00:00Z');
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  )
    .toISOString()
    .slice(0, 10);
  const previous = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  const events = visibleCalendarEntries(ctx, start, end);
  const days = Number(end.slice(-2));
  const requestedDay = ctx.url.searchParams.get('day') ?? '';
  const selected =
    /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) &&
    requestedDay >= start &&
    requestedDay <= end
      ? requestedDay
      : month === today.slice(0, 7)
        ? today
        : start;
  const entries = (day: string) => events.filter((event) => event.date === day);
  return `<div class="calendar-workspace"><section class="panel calendar-panel"><div class="calendar-heading"><h2>${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월</h2><nav aria-label="달력 월 이동"><a href="/schedule?month=${previous}" aria-label="이전 달">‹</a><a href="/schedule">오늘</a><a href="/schedule?month=${next}" aria-label="다음 달">›</a></nav></div><div class="calendar-grid" aria-label="월간 일정">${[...'일월화수목금토'].map((d) => `<div class="calendar-weekday">${d}</div>`).join('')}${'<div class="calendar-empty"></div>'.repeat(date.getUTCDay())}${Array.from(
    { length: days },
    (_, i) => {
      const day = month + '-' + String(i + 1).padStart(2, '0');
      const items = entries(day);
      return `<a class="calendar-day${day === today ? ' today' : ''}${day === selected ? ' selected' : ''}" href="/schedule?month=${month}&amp;day=${day}" aria-label="${day} 일정 ${items.length}건"${day === selected ? ' aria-current="date"' : ''}><strong>${i + 1}</strong>${items
        .slice(0, 3)
        .map(
          (s) => `<small class="calendar-${h(s.kind)}">${h(s.title)}</small>`,
        )
        .join(
          '',
        )}${items.length > 3 ? `<small>외 ${items.length - 3}건</small>` : ''}</a>`;
    },
  ).join(
    '',
  )}${'<div class="calendar-empty"></div>'.repeat((7 - ((date.getUTCDay() + days) % 7)) % 7)}</div></section>
  <section class="panel day-detail"><div class="panel-heading"><h2>${Number(selected.slice(5, 7))}월 ${Number(selected.slice(8))}일 일정</h2></div>
  ${
    entries(selected).length
      ? `<ul class="record-list">${entries(selected)
          .map(
            (e) =>
              `<li><span><i class="event-dot calendar-${h(e.kind)}" aria-hidden="true"></i>${h(e.title)}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">등록된 일정이 없습니다.</p>'
  }
  </section></div>`;
}
const teamActions = new Set([
  'create',
  'confirm',
  'change',
  'clear',
  'withdraw',
  'availability',
  'config',
  'class-config',
]);
const bookingEditFields = ['edit_notice', 'edit_slot', 'edit_booking'];
export const calendarModule: OperationModule = {
  path: '/schedule',
  label: '일정·예약',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup(db) {
    scheduleModule.setup(db);
    teamScheduleModule.setup(db);
  },
  async render(ctx) {
    const search = ctx.url.searchParams;
    const view =
      search.get('view') ??
      (bookingEditFields.some((field) => search.has(field))
        ? 'bookings'
        : 'calendar');
    return `<div class="page-heading"><h1>일정·예약</h1></div>
      <nav class="view-tabs page-tabs" aria-label="일정 보기">
        <a href="/schedule"${view !== 'makeup' && view !== 'bookings' ? ' aria-current="page"' : ''}>월간 달력</a>
        <a href="/schedule?view=makeup"${view === 'makeup' ? ' aria-current="page"' : ''}>휴·보강</a>
        <a href="/schedule?view=bookings"${view === 'bookings' ? ' aria-current="page"' : ''}>공지·상담 예약</a>
      </nav>${
        view === 'makeup'
          ? `<section id="makeup">${await teamScheduleModule.render(ctx)}</section>`
          : view === 'bookings'
            ? `<section id="notices-bookings">${await scheduleModule.render(ctx)}</section>`
            : calendar(ctx)
      }`;
  },
  async submit(ctx, form) {
    const makeup = teamActions.has(field(form, 'action'));
    if (makeup) await teamScheduleModule.submit(ctx, form);
    else await scheduleModule.submit(ctx, form);
    const target = new URL(ctx.url);
    target.searchParams.set('view', makeup ? 'makeup' : 'bookings');
    return '/schedule' + target.search;
  },
};
