import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { consultationModule } from './consultation.ts';
import {
  authenticate,
  directoryModule,
  getSessionActor,
  initializeIdentity,
} from './directory.ts';
import {
  documentDownload,
  documentsModule,
  maxDocumentBytes,
} from './documents.ts';
import { homeworkModule } from './homework.ts';
import { learningModule } from './learning.ts';
import { calendarModule } from './calendar.ts';
import { preferencesModule, selectedCharacter } from './preferences.ts';
import {
  escapeHtml as h,
  field,
  one,
  OperationError,
  roleLabels,
  transaction,
  type Actor,
  type OperationModule,
} from './shared.ts';

const port = Number(process.env.AXR_OPERATIONS_PORT ?? '8791');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('AXR_OPERATIONS_PORT must be a valid port number.');
}
const publicOrigin = process.env.AXR_OPERATIONS_PUBLIC_ORIGIN
  ? new URL(process.env.AXR_OPERATIONS_PUBLIC_ORIGIN)
  : undefined;
if (
  publicOrigin &&
  (publicOrigin.protocol !== 'https:' ||
    publicOrigin.href !== publicOrigin.origin + '/')
) {
  throw new Error('AXR_OPERATIONS_PUBLIC_ORIGIN must be an HTTPS origin.');
}
const filename = resolve(
  process.env.AXR_OPERATIONS_DB ?? '.local/academy-operations.sqlite',
);
const demoPassword = process.env.AXR_OPERATIONS_DEMO_PASSWORD ?? 'axr-demo';
if (publicOrigin && demoPassword === 'axr-demo') {
  throw new Error('Set a separate demo password for the public HTTPS origin.');
}
const db = openDatabase(filename);
const stylesheet = readFileSync(new URL('./operations.css', import.meta.url));
const serviceUi = readFileSync(new URL('./service-ui.js', import.meta.url));
const serviceStyle = readFileSync(
  new URL('./service-design.css', import.meta.url),
);
const mascots = new Map(
  ['walnut', 'water', 'owl'].map((name) => [
    name,
    readFileSync(new URL('./assets/' + name + '.png', import.meta.url)),
  ]),
);
const modules = [
  directoryModule,
  homeworkModule,
  learningModule,
  calendarModule,
  documentsModule,
  consultationModule,
  preferencesModule,
];
initializeIdentity(db, demoPassword);
for (const operation of modules) operation.setup(db);

const sessionSeconds = 8 * 60 * 60;
const sessionCookie = 'axr_operations';
const academyDescriptions: Record<string, string> = {
  '/directory': '반 편성, 원생 정보, 담당 강사',
  '/learning': '숙제 결과와 영역별 학습 기록',
  '/homework': '숙제 제출과 채점 결과',
  '/documents': '수업 안내, 공지, 등록 자료',
  '/consultation': '질문하기, 지난 상담 보기',
  '/schedule': '수업, 휴·보강, 상담 예약',
  '/settings': '상담 캐릭터 선택',
};

function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);
  return database;
}

function hashSession(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function getToken(request: IncomingMessage) {
  return request.headers.cookie
    ?.split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(sessionCookie + '='))
    ?.slice(sessionCookie.length + 1);
}

function findSession(request: IncomingMessage) {
  const token = getToken(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  return getSessionActor(db, hashSession(token), Date.now());
}

function requireSession(request: IncomingMessage): Actor {
  const account = findSession(request);
  if (!account) throw new OperationError('로그인이 필요합니다.', 401);
  return account;
}

function assertCurrentSession(request: IncomingMessage, original: Actor) {
  const account = requireSession(request);
  if (
    account.id !== original.id ||
    account.academyId !== original.academyId ||
    account.role !== original.role ||
    account.studentId !== original.studentId
  ) {
    throw new OperationError(
      '접근 권한이 변경되었습니다. 다시 접속해 주세요.',
      403,
    );
  }
}

function createSession(actor: Actor) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM op_sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare(
    'INSERT INTO op_sessions (digest, account_id, expires_at) VALUES (?, ?, ?)',
  ).run(hashSession(token), actor.id, Date.now() + sessionSeconds * 1000);
  return token;
}

function setSessionCookie(
  response: ServerResponse,
  secure: boolean,
  token = '',
) {
  response.setHeader(
    'Set-Cookie',
    `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionSeconds : 0}${secure ? '; Secure' : ''}`,
  );
}

function deleteSession(request: IncomingMessage) {
  const token = getToken(request);
  if (token)
    db.prepare('DELETE FROM op_sessions WHERE digest = ?').run(
      hashSession(token),
    );
}

function visibleModules(actor: Actor): OperationModule[] {
  return modules.filter((operation) =>
    (operation.roles as readonly string[]).includes(actor.role),
  );
}

function layout(content: string, actor?: Actor, current?: string) {
  const academyName = actor
    ? one<{ name: string }>(
        db,
        'SELECT name FROM academies WHERE id = ?',
        actor.academyId,
      )?.name
    : 'AXR 학원';
  const pages = actor ? visibleModules(actor) : [];
  const character = actor ? selectedCharacter({ db, actor }) : 'walnut';
  const nav = (path: string, label: string) =>
    '<a href="' +
    h(path) +
    '"' +
    (current === path ? ' aria-current="page"' : '') +
    '>' +
    h(label) +
    '</a>';
  const brand = '<a class="brand" href="/">' + h(academyName) + '</a>';
  const title =
    pages.find((p) => p.path === current)?.label ?? (actor ? '홈' : '로그인');
  return (
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>' +
    h(title) +
    ' · AXR</title><link rel="stylesheet" href="/operations.css"><link rel="stylesheet" href="/service-design.css"></head><body data-account="' +
    h(actor?.id ?? '') +
    '"><script src="/service-ui.js" defer></script><a class="skip-link" href="#main-content">본문으로 이동</a>' +
    '<header class="topbar ' +
    (actor ? '' : 'login-top') +
    '">' +
    (actor ? '<span class="topbar-title">' + h(title) + '</span>' : brand) +
    (actor
      ? '<div class="session"><a class="profile-link" href="/settings" aria-label="설정"><img src="/assets/' +
        character +
        '.png" alt=""></a><span>' +
        h(actor.name) +
        ' · ' +
        h(roleLabels[actor.role]) +
        '</span><form method="post" action="/logout"><button class="secondary">로그아웃</button></form></div>'
      : '') +
    '</header>' +
    (actor
      ? '<div class="workspace"><aside class="sidebar">' +
        brand +
        '<nav aria-label="학원 운영">' +
        nav('/', '홈') +
        pages.map((p) => nav(p.path, p.label)).join('') +
        '</nav></aside><main id="main-content">' +
        content +
        '</main></div><nav class="mobile-nav" aria-label="주요 메뉴">' +
        nav('/', '홈') +
        pages
          .filter((p) =>
            ['/consultation', '/documents', '/schedule', '/learning'].includes(
              p.path,
            ),
          )
          .map((p) =>
            nav(
              p.path,
              p.path === '/consultation'
                ? '상담'
                : p.path === '/documents'
                  ? '학원 자료'
                  : p.label,
            ),
          )
          .join('') +
        '</nav>'
      : '<main class="sign-in" id="main-content">' + content + '</main>') +
    '</body></html>'
  );
}

function loginPage(message = '') {
  const demoAccounts = [
    ['관리자', 'TA_DIRECTOR'],
    ['강사', 'TA_TEACHER'],
    ['학생', 'TA_STUDENT_001'],
    ['보호자', 'TA_GUARDIAN_E_MATH'],
    ['방문자', 'TA_VISITOR'],
  ];
  return `<section class="panel">
    <h1>학원 운영 로그인</h1>
    ${message ? `<p class="notice" role="alert">${h(message)}</p>` : ''}
    <form method="post" action="/login">
      <label>계정 <input name="username" autocomplete="username" required maxlength="100"></label>
      <label>비밀번호 <input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
      <button type="submit">로그인</button>
    </form>
  </section>
  <section class="panel">
    <h2>가상 학원 계정</h2>
    ${process.env.AXR_OPERATIONS_DEMO_PASSWORD === undefined ? '<p>초기 비밀번호 <code>axr-demo</code></p>' : ''}
    <dl class="demo-accounts">${demoAccounts
      .map(
        ([label, username]) =>
          `<div><dt>${h(label)}</dt><dd><code>${h(username)}</code></dd></div>`,
      )
      .join('')}</dl>
  </section>`;
}

function home(actor: Actor) {
  return `<div class="page-heading"><h1>${actor.role === 'admin' || actor.role === 'teacher' ? '학원 운영' : '우리 학원'}</h1></div>
    <div class="module-grid home-cards">${visibleModules(actor)
      .map(
        (
          operation,
        ) => `<a class="panel module-card" href="${h(operation.path)}">
      <h2>${h(operation.label)}</h2>
      <p>${h(academyDescriptions[operation.path])}</p>
    </a>`,
      )
      .join('')}</div>`;
}

function sendPage(
  response: ServerResponse,
  status: number,
  content: string,
  actor?: Actor,
  current?: string,
) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(layout(content, actor, current));
}

function redirect(response: ServerResponse, target: string) {
  response.writeHead(303, { Location: target });
  response.end();
}

const maxFormBytes = maxDocumentBytes + 512 * 1024;
async function readForm(request: IncomingMessage, url: URL) {
  const contentType = request.headers['content-type'] ?? '';
  if (
    !/^(?:application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(
      contentType,
    )
  ) {
    throw new OperationError('폼으로 요청해 주세요.', 415);
  }
  if (Number(request.headers['content-length'] ?? 0) > maxFormBytes) {
    throw new OperationError('파일 크기가 업로드 제한을 넘었습니다.', 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxFormBytes)
      throw new OperationError('요청이 너무 큽니다.', 413);
    chunks.push(chunk);
  }
  try {
    return await new Request(url, {
      method: 'POST',
      body: new Uint8Array(Buffer.concat(chunks)),
      headers: { 'Content-Type': contentType },
    }).formData();
  } catch {
    throw new OperationError('입력 형식을 읽을 수 없습니다.');
  }
}

function verifyOrigin(request: IncomingMessage, url: URL) {
  const origin =
    request.headers.origin ??
    (url.protocol === 'http:' ? url.origin : undefined);
  if (
    origin !== url.origin ||
    request.headers['sec-fetch-site'] === 'cross-site'
  ) {
    throw new OperationError('이 화면에서 다시 요청해 주세요.', 403);
  }
}

async function serve(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  const host = request.headers.host;
  const localPort = request.socket.localPort;
  const requestOrigin =
    publicOrigin && host === publicOrigin.host
      ? publicOrigin.origin
      : host === `127.0.0.1:${localPort}` || host === `localhost:${localPort}`
        ? `http://${host}`
        : undefined;
  if (!requestOrigin) {
    response.writeHead(400).end();
    return;
  }
  let actor: Actor | undefined;
  try {
    const url = new URL(request.url ?? '/', requestOrigin);
    if (url.origin !== requestOrigin)
      throw new OperationError('올바른 주소에서 접속해 주세요.');
    if (request.method === 'GET' && url.pathname === '/service-ui.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
      });
      response.end(serviceUi);
      return;
    }
    const mascotName = /^\/assets\/(walnut|water|owl)\.png$/.exec(
      url.pathname,
    )?.[1];
    if (
      request.method === 'GET' &&
      (url.pathname === '/service-design.css' || mascotName)
    ) {
      response.writeHead(200, {
        'Content-Type': url.pathname.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'image/png',
      });
      response.end(mascotName ? mascots.get(mascotName) : serviceStyle);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/operations.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      response.end(stylesheet);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      throw new OperationError('지원하지 않는 요청입니다.', 405);
    }
    if (request.method === 'POST') verifyOrigin(request, url);
    actor = findSession(request);
    if (url.pathname === '/login') {
      if (request.method === 'GET') {
        if (actor) redirect(response, '/');
        else sendPage(response, 200, loginPage());
        return;
      }
      const form = await readForm(request, url);
      const password = form.get('password');
      const token = transaction(db, () => {
        const account =
          typeof password === 'string' && password.length <= 200
            ? authenticate(db, field(form, 'username', 100), password)
            : undefined;
        if (!account) return;
        deleteSession(request);
        return createSession(account);
      });
      if (!token) {
        sendPage(
          response,
          401,
          loginPage('계정 또는 비밀번호를 확인해 주세요.'),
        );
        return;
      }
      setSessionCookie(response, url.protocol === 'https:', token);
      redirect(response, '/');
      return;
    }
    if (!actor) {
      if (request.method === 'POST')
        throw new OperationError('로그인이 필요합니다.', 401);
      redirect(response, '/login');
      return;
    }
    if (url.pathname === '/logout' && request.method === 'POST') {
      deleteSession(request);
      setSessionCookie(response, url.protocol === 'https:');
      redirect(response, '/login');
      return;
    }
    if (url.pathname === '/' && request.method === 'GET') {
      sendPage(response, 200, home(actor), actor, '/');
      return;
    }
    if (url.pathname === '/documents/download' && request.method === 'GET') {
      const file = documentDownload({ db, actor, url });
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition':
          "attachment; filename*=UTF-8''" +
          encodeURIComponent(file.name).replace(
            /[!'()*]/g,
            (character) =>
              '%' + character.charCodeAt(0).toString(16).toUpperCase(),
          ),
      });
      response.end(file.content);
      return;
    }
    if (url.pathname === '/makeup' || url.pathname === '/makeup-schedule') {
      if (request.method === 'GET') {
        redirect(response, '/schedule' + url.search);
        return;
      }
      url.pathname = '/schedule';
    }
    const operation = modules.find((item) => item.path === url.pathname);
    if (!operation) throw new OperationError('페이지를 찾을 수 없습니다.', 404);
    if (!visibleModules(actor).includes(operation)) {
      throw new OperationError('이 기능에 접근할 수 없습니다.', 403);
    }
    const form =
      request.method === 'POST' ? await readForm(request, url) : undefined;
    const sessionActor = actor;
    const assertCurrentAccess = () =>
      assertCurrentSession(request, sessionActor);
    assertCurrentAccess();
    const ctx = { db, actor: sessionActor, url, assertCurrentAccess };
    if (form) {
      const target = await operation.submit(ctx, form);
      redirect(response, target ?? url.pathname + url.search);
    } else {
      const content = await operation.render(ctx);
      assertCurrentAccess();
      sendPage(response, 200, content, actor, operation.path);
    }
  } catch (error) {
    const expected = error instanceof OperationError;
    if (!expected) console.error('AXR operations request failed:', error);
    actor = findSession(request);
    const message = expected
      ? error.message
      : '요청을 처리하는 중 문제가 발생했습니다.';
    sendPage(
      response,
      expected ? error.status : 500,
      `<section class="panel"><h1>요청 확인</h1><p role="alert">${h(message)}</p><a href="${actor ? '/' : '/login'}">돌아가기</a></section>`,
      actor,
    );
  }
}

const server = createServer((request, response) => {
  void serve(request, response);
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') {
    console.log(`AXR 학원 운영 http://127.0.0.1:${address.port}`);
  }
});
