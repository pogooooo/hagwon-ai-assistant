import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { OperationsDatabase } from './database.ts';
import {
  createExternalServices,
  type ExternalServices,
} from './external-services.ts';
import { publicDataModule } from './public-data.ts';
import { knowledgeModule } from './knowledge.ts';
import { schoolsModule } from './schools.ts';
import { voiceModule, voiceAudio } from './voice.ts';

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
  maxDocumentBytes as defaultMaxDocumentBytes,
} from './documents.ts';
import { homeworkModule } from './homework.ts';
import { renderWorkbookSource } from './workbook-publication.ts';
import {
  gradingLearning,
  gradingBriefing,
} from '../homework-grading/records-page.ts';
import {
  gradingModule,
  gradingPhoto,
  gradingService,
} from '../homework-grading/module.ts';
import { setupLearning, renderLearningPublication } from './learning.ts';
import { parentMessagesModule } from './parent-messages.ts';
import { unreadParentCount } from './parent-messages-model.ts';
import { calendarModule } from './calendar.ts';
import { makeupPollsModule } from './makeup-polls.ts';
import { studentReportsModule } from './student-reports.ts';
import { previewTeamSchedule } from './team-schedule.ts';
import { renderHome } from './home.ts';
import { serviceNavigation } from './service-navigation.ts';
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

const modules: OperationModule[] = [
  directoryModule,
  gradingModule,
  {
    path: '/learning',
    label: '학습 기록',
    roles: gradingModule.roles,
    setup: setupLearning,
    render: (ctx) =>
      ctx.url.searchParams.has('publication')
        ? renderLearningPublication(
            ctx,
            ctx.url.searchParams.get('publication')!,
          )
        : gradingLearning(ctx),
    submit() {
      throw new OperationError('사진 채점의 확정 기록은 조회 전용입니다.', 405);
    },
  },
  {
    path: '/briefing',
    label: '브리핑',
    roles: ['admin', 'teacher'],
    setup() {},
    render: gradingBriefing,
    submit() {
      throw new OperationError('브리핑은 조회 전용입니다.', 405);
    },
  },
  calendarModule,
  makeupPollsModule,
  studentReportsModule,
  documentsModule,
  consultationModule,
  preferencesModule,
  publicDataModule,
  knowledgeModule,
  schoolsModule,
  voiceModule,
  parentMessagesModule,
];
const sessionSeconds = 8 * 60 * 60;
const sessionCookie = 'axr_operations';
const menuOrder = [
  '/consultation',
  '/schedule',
  '/makeup-votes',
  '/student-reports',
  '/documents',
  '/learning',
  '/briefing',
  '/grading',
  '/directory',
  '/settings',
  '/public-data',
  '/knowledge',
  '/schools',
  '/voice',
  '/messages',
];

export interface OperationsServerOptions {
  services?: ExternalServices;
  db: OperationsDatabase;
  publicOrigin?: URL;
  demoPassword: string;
  showDefaultPassword?: boolean;
  showDemoAccounts?: boolean;
  assetsRoot?: URL | null;
  fixturesRoot?: URL;
  documentsRoot?: string;
  maxDocumentBytes?: number;
  scanVision?: import('../rag-consultation/server/ingest/parsers/types.ts').ScanVision;
  scanPdfAvailable?: boolean;
}

export function createOperationsServer({
  services,
  db,
  publicOrigin,
  demoPassword,
  showDefaultPassword = false,
  showDemoAccounts = showDefaultPassword,
  assetsRoot = new URL('./', import.meta.url),
  fixturesRoot,
  documentsRoot,
  maxDocumentBytes = defaultMaxDocumentBytes,
  scanVision,
  scanPdfAvailable = true,
}: OperationsServerOptions) {
  services ??= createExternalServices(process.env, fetch, db);
  if (
    publicOrigin &&
    (publicOrigin.protocol !== 'https:' ||
      publicOrigin.href !== publicOrigin.origin + '/')
  ) {
    throw new Error('AXR_OPERATIONS_PUBLIC_ORIGIN must be an HTTPS origin.');
  }
  if (publicOrigin && demoPassword === 'axr-demo') {
    throw new Error(
      'Set a separate demo password for the public HTTPS origin.',
    );
  }
  const staticFiles = new Map<string, { contentType: string; bytes: Buffer }>();
  if (assetsRoot) {
    for (const path of [
      'operations.css',
      'service-design.css',
      'service-ui.js',
      'grading-ui.js',
      'app.webmanifest',
      '.well-known/assetlinks.json',
      'service-worker.js',
      'workbook-ui.js',
      'voice-ui.js',
      'voice-worklet.js',
      'assets/walnut.png',
      'assets/water.png',
      'assets/owl.png',
      'assets/ondap-logo.png',
      'assets/ondap-review.png',
      'assets/ondap-report.png',
      'assets/app-192.png',
      'assets/app-512.png',
      'assets/study-room.webp',
      'assets/fonts/noto-korean-400.woff2',
      'assets/fonts/noto-korean-700.woff2',
      'assets/fonts/noto-latin-400.woff2',
      'assets/fonts/noto-latin-700.woff2',
    ]) {
      const contentType = path.endsWith('.webp')
        ? 'image/webp'
        : path.endsWith('.woff2')
          ? 'font/woff2'
          : path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : path.endsWith('.json')
              ? 'application/json; charset=utf-8'
              : path.endsWith('.webmanifest')
                ? 'application/manifest+json; charset=utf-8'
                : path.endsWith('.js')
                  ? 'text/javascript; charset=utf-8'
                  : 'image/png';
      staticFiles.set('/' + path, {
        contentType,
        bytes: readFileSync(new URL(path, assetsRoot)),
      });
    }
  }
  initializeIdentity(db, demoPassword, fixturesRoot);
  // Historical publications and monthly reports still reference workbook tables.
  homeworkModule.setup(db, documentsRoot);
  for (const operation of modules) operation.setup(db, documentsRoot);
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

  function serviceMenu(actor: Actor) {
    const pages = visibleModules(actor);
    return menuOrder.flatMap((path) =>
      pages.filter((page) => page.path === path),
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
    const pages = actor ? serviceMenu(actor) : [];
    const staff = actor?.role === 'admin' || actor?.role === 'teacher';
    const character = actor ? selectedCharacter({ db, actor }) : 'walnut';
    const navigation = serviceNavigation(pages, current, staff);
    const brand = `<a class="brand" href="/"><img src="/assets/ondap-logo.png" alt="온답"></a>`;
    const title =
      pages.find((p) => p.path === current)?.label ?? (actor ? '홈' : '로그인');
    return (
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>' +
      h(title) +
      ' · 온답</title><meta name="theme-color" content="#fbfbf6"><link rel="manifest" href="/app.webmanifest"><link rel="apple-touch-icon" href="/assets/app-192.png"><link rel="icon" href="/assets/app-192.png"><link rel="stylesheet" href="/operations.css?v=10"><link rel="stylesheet" href="/service-design.css?v=ondap2"></head><body data-account="' +
      h(actor?.id ?? '') +
      '" data-page="' +
      h(current ?? 'login') +
      '" data-role="' +
      h(actor?.role ?? 'guest') +
      '"><script src="/service-ui.js?v=ondap2" defer></script><a class="skip-link" href="#main-content">본문으로 이동</a>' +
      '<header class="topbar"><div class="shell topbar-inner">' +
      brand +
      (actor && academyName
        ? '<span class="academy-name">' + h(academyName) + '</span>'
        : '') +
      (actor
        ? '<select class="section-jump" data-section-jump aria-label="현재 화면의 항목으로 이동" hidden><option value="">바로가기</option></select><div class="session">' +
          (['admin', 'guardian'].includes(actor.role)
            ? `<a class="parent-inbox-link" href="/messages" aria-label="학원 알림${unreadParentCount({ db, actor, url: new URL('http://localhost/') }) ? ' · 읽지 않은 알림 있음' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 5h16v14H4Z"/><path d="m4 6 8 7 8-7"/></svg>${unreadParentCount({ db, actor, url: new URL('http://localhost/') }) ? '<span class="unread-dot" aria-hidden="true"></span>' : ''}</a>`
            : '') +
          '<a class="profile-link" href="/settings" aria-label="계정 설정"><img src="/assets/' +
          character +
          '.png" alt=""></a><span>' +
          h(actor.name) +
          (actor.name === roleLabels[actor.role]
            ? ''
            : '<small>' + h(roleLabels[actor.role]) + '</small>') +
          '</span><form method="post" action="/logout"><button class="secondary">로그아웃</button></form></div>'
        : '') +
      '</div>' +
      '</header>' +
      (actor
        ? `<div class="shell signed-in">${navigation.sidebar}<main class="workspace" id="main-content" tabindex="-1">${content}</main></div>${navigation.mobile}`
        : `<main class="sign-in" id="main-content">${content}</main>`) +
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
    return `<div class="sign-in-layout"><section class="sign-in-story" aria-label="온답"><img class="login-logo" src="/assets/ondap-logo.png" alt="온답"><h2>학원 업무를 한눈에</h2><p>수업 일정, 숙제 확인, 학습 상담</p><img class="login-owl" src="/assets/ondap-review.png" alt=""></section><div class="sign-in-content"><section class="panel sign-in-form">
    <div class="sign-in-heading"><h1>학원 로그인</h1><p>학원에서 발급받은 계정으로 로그인하세요.</p></div>
    ${message ? `<p class="notice" role="alert">${h(message)}</p>` : ''}
    <form method="post" action="/login">
      <label>계정 <input name="username" autocomplete="username" required maxlength="100"></label>
      <label>비밀번호 <input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
      <button type="submit">로그인</button>
    </form>
  </section>
  ${
    showDemoAccounts
      ? `<details class="sign-in-accounts">
    <summary>체험 계정 보기</summary>
    ${showDefaultPassword ? '<p>초기 비밀번호 <code>axr-demo</code></p>' : ''}
    <dl class="demo-accounts">${demoAccounts
      .map(
        ([label, username]) =>
          `<div><dt>${h(label)}</dt><dd><code>${h(username)}</code></dd></div>`,
      )
      .join('')}</dl>
  </details>`
      : ''
  }</div></div>`;
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
      "default-src 'none'; style-src 'self'; font-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
      const staticFile =
        request.method === 'GET' && staticFiles.get(url.pathname);
      if (staticFile) {
        response.writeHead(200, { 'Content-Type': staticFile.contentType });
        response.end(staticFile.bytes);
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
        sendPage(response, 200, renderHome({ db, actor, url }), actor, '/');
        return;
      }
      if (url.pathname === '/homework' || url.pathname === '/homework/photo') {
        if (!gradingModule.roles.includes(actor.role))
          throw new OperationError('이 기능에 접근할 수 없습니다.', 403);
        if (request.method !== 'GET')
          throw new OperationError('사진 채점에서 숙제를 제출해 주세요.', 405);
        const view = url.searchParams.get('view');
        if (url.pathname === '/homework' && view === 'source') {
          sendPage(
            response,
            200,
            renderWorkbookSource(
              { db, actor, url },
              url.searchParams.get('publication') ?? '',
            ),
            actor,
            '/learning',
          );
        } else if (url.pathname === '/homework/photo') {
          throw new OperationError(
            '기존 제출 사진은 이 화면에서 제공하지 않습니다.',
            410,
          );
        } else {
          const staff = actor.role === 'admin' || actor.role === 'teacher';
          redirect(
            response,
            view === 'analysis'
              ? '/learning'
              : staff && view === 'create'
                ? '/grading?view=register'
                : staff && view === 'review'
                  ? '/grading?queue=review'
                  : '/grading',
          );
        }
        return;
      }
      if (url.pathname === '/grading/photo' && request.method === 'GET') {
        const photo = await gradingPhoto({
          db,
          actor,
          url,
          assertCurrentAccess: () => assertCurrentSession(request, actor!),
        });
        assertCurrentSession(request, actor);
        response.writeHead(200, {
          'Content-Type': photo.mime,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(Buffer.from(photo.bytes));
        photo.bytes.fill(0);
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
      if (!operation)
        throw new OperationError('페이지를 찾을 수 없습니다.', 404);
      if (!visibleModules(actor).includes(operation)) {
        throw new OperationError('이 기능에 접근할 수 없습니다.', 403);
      }
      const form =
        request.method === 'POST' ? await readForm(request, url) : undefined;
      const sessionActor = actor;
      const assertCurrentAccess = () =>
        assertCurrentSession(request, sessionActor);
      assertCurrentAccess();
      const ctx = {
        services,
        db,
        actor: sessionActor,
        url,
        assertCurrentAccess,
        maxDocumentBytes,
        scanVision,
        scanPdfAvailable,
      };
      if (
        form &&
        operation === voiceModule &&
        field(form, 'action') === 'audio'
      ) {
        const bytes = await voiceAudio(ctx, form);
        assertCurrentAccess();
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end(bytes);
        return;
      }
      if (form) {
        try {
          if (
            operation === calendarModule &&
            url.searchParams.get('preview') === '1'
          ) {
            previewTeamSchedule(ctx, form);
            response.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
            });
            response.end(
              JSON.stringify({
                ok: true,
                message:
                  '현재 등록 내용과 충돌하지 않습니다. 저장할 때 다시 확인합니다.',
              }),
            );
            return;
          }
          const target = await operation.submit(ctx, form);
          redirect(response, target ?? url.pathname + url.search);
        } catch (error) {
          if (
            ![calendarModule, parentMessagesModule].includes(operation) ||
            !(error instanceof OperationError) ||
            ![400, 409, 422, 502, 503].includes(error.status)
          )
            throw error;
          assertCurrentAccess();
          if (url.searchParams.get('preview') === '1') {
            response.writeHead(error.status, {
              'Content-Type': 'application/json; charset=utf-8',
            });
            response.end(JSON.stringify({ ok: false, message: error.message }));
            return;
          }
          const content = await operation.render({
            ...ctx,
            submittedForm: form,
            formError: error.message,
          });
          sendPage(response, error.status, content, actor, operation.path);
        }
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
  const maintenance = setInterval(() => {
    void gradingService(db)
      .sweep()
      .catch(() => {});
  }, 30000);
  maintenance.unref?.();
  server.on('close', () => clearInterval(maintenance));
  return server;
}
