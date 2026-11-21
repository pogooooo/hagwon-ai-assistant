import { escapeHtml as h } from './shared.ts';

const symbols: Record<string, [string, string]> = {
  '/grading': [
    'homework',
    '<path d="M5 3h14v18H5Z"/><path d="m8 12 3 3 5-6M8 6h5"/>',
  ],
  '/messages': ['chat', '<path d="M3 5h18v14H3Z"/><path d="m3 6 9 7 9-7"/>'],
  '/': [
    'home',
    '<path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  ],
  '/consultation': [
    'chat',
    '<path d="M4 4h16v12H9l-5 4Z"/><path d="M8 8h8M8 12h5"/>',
  ],
  '/schedule': [
    'calendar',
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 11h18m-13 4h3m3 0h3"/>',
  ],
  '/homework': [
    'homework',
    '<path d="M5 3h14v18H5Z"/><path d="m8 12 3 3 5-6M8 6h5"/>',
  ],
  '/learning': ['learning', '<path d="M4 3v18h17M8 17v-5m5 5V7m5 10V3"/>'],
  '/briefing': [
    'learning',
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  ],
  '/documents': [
    'documents',
    '<path d="M3 6h7l2 3h9v12H3Z"/><path d="M4 6V3h9l3 3"/>',
  ],
  '/directory': [
    'people',
    '<circle cx="9" cy="8" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m1-17a4 4 0 0 1 0 8m2 3a5 5 0 0 1 3 5"/>',
  ],
  '/settings': [
    'settings',
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3"/>',
  ],
  '/public-data': [
    'public',
    '<path d="m3 8 9-5 9 5ZM4 21h16M6 10v8m6-8v8m6-8v8"/>',
  ],
  '/exam-builder': [
    'documents',
    '<path d="M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4"/>',
  ],
  '/knowledge': [
    'documents',
    '<path d="M4 3h16v18H4Z"/><path d="m8 11 3 3 5-5M8 18h8"/>',
  ],
  '/schools': [
    'calendar',
    '<path d="m2 9 10-6 10 6-10 6ZM5 11v7l7 4 7-4v-7M22 9v9"/>',
  ],
  '/voice': [
    'chat',
    '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  ],
};

export function serviceIcon(path: string) {
  const [tone, paths] = symbols[path] ?? symbols['/'];
  return `<span class="service-icon tone-${tone}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`;
}

interface MenuPage {
  path: string;
  label: string;
}
export function serviceNavigation(
  pages: MenuPage[],
  current: string | undefined,
  staff: boolean,
) {
  const link = (p: MenuPage, short = false) => {
    const href =
      staff && p.path === '/consultation' ? '/consultation?view=inbox' : p.path;
    const label =
      p.path === '/consultation'
        ? staff
          ? '상담함'
          : '상담'
        : short && p.path === '/schedule'
          ? '일정'
          : p.label;
    return `<a href="${h(href)}"${current === p.path ? ' aria-current="page"' : ''}>${serviceIcon(p.path)}<span>${h(label)}</span></a>`;
  };
  const groups = [
    [
      '오늘의 업무',
      [
        '/',
        '/grading',
        '/learning',
        '/briefing',
        '/student-reports',
        '/exam-builder',
      ],
    ],
    [
      '소통과 일정',
      [
        '/messages',
        '/consultation',
        '/voice',
        '/schedule',
        '/makeup-votes',
        '/documents',
      ],
    ],
    ['운영 관리', ['/directory', '/schools', '/public-data', '/knowledge']],
    ['계정', ['/settings']],
  ] as const;
  const all = [{ path: '/', label: '홈' }, ...pages];
  const grouped = groups
    .map(([label, paths]) => {
      const items = paths.flatMap((path) => all.filter((p) => p.path === path));
      return items.length
        ? `<div class="nav-group"><p class="nav-group-label">${label}</p>${items.map((p) => link(p)).join('')}</div>`
        : '';
    })
    .join('');
  const primary = ['/', '/consultation', '/schedule', '/grading'].flatMap(
    (path) => all.filter((p) => p.path === path),
  );
  const secondarySelected = !primary.some((p) => p.path === current);
  return {
    sidebar: `<aside class="sidebar"><a class="rail-brand" href="/" aria-label="온답 홈"><span aria-hidden="true"></span></a><nav class="service-nav" aria-label="학원 메뉴">${grouped}</nav></aside>`,
    mobile: `<nav class="mobile-nav" aria-label="주요 메뉴">${primary.map((p) => link(p, true)).join('')}<button type="button" data-open-menu aria-haspopup="dialog" aria-controls="mobile-menu"${secondarySelected ? ' class="selected"' : ''}><span class="more-icon" aria-hidden="true">···</span><span>전체</span></button></nav><dialog id="mobile-menu" class="mobile-menu"><div class="mobile-menu-heading"><h2>전체 메뉴</h2><form method="dialog"><button class="secondary" aria-label="전체 메뉴 닫기" autofocus>닫기</button></form></div><nav class="service-nav" aria-label="전체 학원 메뉴">${grouped}</nav></dialog><noscript><details class="mobile-fallback"><summary>전체 메뉴</summary>${all.map((p) => link(p)).join('')}</details></noscript>`,
  };
}
