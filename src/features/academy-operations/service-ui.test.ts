import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { serviceNavigation } from './service-navigation.ts';

test('navigation preserves role-filtered pages, staff inbox and current state', () => {
  const menu = serviceNavigation(
    [
      { path: '/consultation', label: '상담' },
      { path: '/settings', label: '설정' },
    ],
    '/settings',
    true,
  );
  assert.match(menu.sidebar, /href="\/consultation\?view=inbox"/);
  assert.match(menu.sidebar, /href="\/settings" aria-current="page"/);
  assert.doesNotMatch(menu.mobile, /href="\/directory"/);
  assert.doesNotMatch(menu.mobile, /href="\/schedule"/);
  assert.match(menu.mobile, /class="selected"/);
  assert.match(menu.mobile, /<dialog id="mobile-menu"/);
});

test('navigation escapes page labels and URLs', () => {
  const menu = serviceNavigation(
    [{ path: '/documents', label: '<img onerror="x">' }],
    '/documents',
    false,
  );
  assert.doesNotMatch(menu.sidebar, /<img/);
  assert.match(menu.sidebar, /&lt;img/);
});

test('microphone pending permission cannot start twice or leak after leaving page', async () => {
  const listeners = new Map<string, () => Promise<void>>();
  const windowListeners = new Map<string, () => void>();
  const start = {
    hidden: false,
    disabled: false,
    addEventListener: (name: string, fn: () => Promise<void>) =>
      listeners.set(name, fn),
  };
  const stop = { hidden: true, addEventListener: () => {} };
  const status = { textContent: '' };
  let permissionCalls = 0,
    stopped = 0,
    contexts = 0;
  let grant!: (stream: unknown) => void;
  const permission = new Promise((resolve) => {
    grant = resolve;
  });
  runInNewContext(
    readFileSync(new URL('./voice-ui.js', import.meta.url), 'utf8'),
    {
      document: {
        querySelector: (selector: string) =>
          selector === '[data-record]'
            ? start
            : selector === '[data-stop]'
              ? stop
              : selector === '[data-voice-status]'
                ? status
                : {},
        querySelectorAll: () => [],
      },
      window: {
        isSecureContext: true,
        addEventListener: (name: string, fn: () => void) =>
          windowListeners.set(name, fn),
      },
      navigator: {
        mediaDevices: {
          getUserMedia: () => {
            permissionCalls++;
            return permission;
          },
        },
      },
      AudioContext: class {
        constructor() {
          contexts++;
        }
      },
      clearTimeout,
      setTimeout,
    },
  );
  const first = listeners.get('click')!();
  await listeners.get('click')!();
  assert.equal(permissionCalls, 1);
  assert.equal(start.disabled, true);
  windowListeners.get('pagehide')!();
  grant({
    getTracks: () => [
      {
        stop: () => {
          stopped++;
        },
      },
    ],
  });
  await first;
  assert.equal(stopped, 1);
  assert.equal(contexts, 0);
  assert.equal(start.disabled, false);
});

test('mobile offline response never stores private data or replays writes', async () => {
  let listener!: (event: {
    request: { mode: string; method: string };
    respondWith: (response: Promise<Response>) => void;
  }) => void;
  let fetches = 0;
  runInNewContext(
    readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8'),
    {
      self: {
        addEventListener: (_name: string, fn: typeof listener) => {
          listener = fn;
        },
      },
      fetch: () => {
        fetches++;
        return Promise.reject(new Error('offline'));
      },
      Response,
      caches: {
        open: () => {
          throw new Error('Must not cache private data');
        },
      },
    },
  );
  let response!: Promise<Response>;
  listener({
    request: { mode: 'navigate', method: 'POST' },
    respondWith: (p) => {
      response = p;
    },
  });
  assert.equal(fetches, 0);
  listener({
    request: { mode: 'navigate', method: 'GET' },
    respondWith: (p) => {
      response = p;
    },
  });
  const offline = await response;
  assert.equal(offline.status, 503);
  assert.equal(offline.headers.get('cache-control'), 'no-store');
  assert.match(await offline.text(), /인터넷 연결/);
});
