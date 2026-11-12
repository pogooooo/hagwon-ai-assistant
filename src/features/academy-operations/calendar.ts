import { teamScheduleModule, calendarSessions } from './team-schedule.ts';
import { scheduleModule, calendarNotices } from './schedule.ts';
import {
  escapeHtml as h,
  field,
  OperationError,
  type PageContext,
  type OperationModule,
} from './shared.ts';

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
  const sessions = calendarSessions(ctx, start, end);
  const notices = calendarNotices(ctx, start, end);
  const days = Number(end.slice(-2));
  const selected = ctx.url.searchParams.get('day');
  const entries = (day: string) => [
    ...sessions
      .filter((s) => s.date === day)
      .map((s) => ({ title: s.label, kind: s.kind })),
    ...notices.filter((n) => n.date === day),
  ];
  return `<section class="panel"><div class="panel-heading"><a href="/schedule?month=${previous}">이전 달</a><h2>${h(month)} 일정</h2><a href="/schedule?month=${next}">다음 달</a></div><div class="calendar-grid" role="table" aria-label="월간 일정">${[...'일월화수목금토'].map((d) => `<div class="calendar-weekday" role="columnheader">${d}</div>`).join('')}${'<div class="calendar-empty"></div>'.repeat(date.getUTCDay())}${Array.from(
    { length: days },
    (_, i) => {
      const day = month + '-' + String(i + 1).padStart(2, '0');
      const items = entries(day);
      return `<a role="cell" class="calendar-day${day === today ? ' today' : ''}" href="/schedule?month=${month}&amp;day=${day}" aria-label="${day} 일정 ${items.length}건"><strong>${i + 1}</strong>${items
        .slice(0, 3)
        .map(
          (s) => `<small class="calendar-${h(s.kind)}">${h(s.title)}</small>`,
        )
        .join(
          '',
        )}${items.length > 3 ? `<small>외 ${items.length - 3}건</small>` : ''}</a>`;
    },
  ).join('')}</div>${
    selected && selected.startsWith(month + '-')
      ? `<section class="day-detail"><h3>${h(selected)} 상세</h3><ul>${
          entries(selected)
            .map((e) => `<li>${h(e.title)}</li>`)
            .join('') || '<li>등록된 일정이 없습니다.</li>'
        }</ul></section>`
      : ''
  }</section>`;
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
export const calendarModule: OperationModule = {
  path: '/schedule',
  label: '일정·예약',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup(db) {
    scheduleModule.setup(db);
    teamScheduleModule.setup(db);
  },
  async render(ctx) {
    return `<div class="page-heading"><h1>일정·예약</h1></div>${calendar(ctx)}<nav class="section-links"><a href="#makeup">휴·보강 관리</a><a href="#notices-bookings">공지·상담 예약</a></nav><section id="makeup">${await teamScheduleModule.render(ctx)}</section><section id="notices-bookings">${await scheduleModule.render(ctx)}</section>`;
  },
  async submit(ctx, form) {
    if (teamActions.has(field(form, 'action')))
      await teamScheduleModule.submit(ctx, form);
    else await scheduleModule.submit(ctx, form);
    return '/schedule' + ctx.url.search;
  },
};
