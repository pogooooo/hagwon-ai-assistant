/**
 * Disposable browser acceptance. Tooling stays outside production dependencies:
 * npm install --prefix .local/audit-tools --ignore-scripts playwright @axe-core/playwright
 * node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-service-browser.mjs --out .local/service-browser
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOperationsServer } from '../src/features/academy-operations/application.ts';
import { prepareQADemo } from '../src/features/academy-operations/qa-demo.ts';

const at = process.argv.indexOf('--out');
if (at < 0 || !process.argv[at + 1]) throw new Error('Use --out <folder>');
const out = resolve(process.argv[at + 1]);
mkdirSync(out, { recursive: true });
const toolRoot = resolve('.local/audit-tools/node_modules');
const { chromium } = await import(
  pathToFileURL(resolve(toolRoot, 'playwright/index.mjs')).href
);
const { default: AxeBuilder } = await import(
  pathToFileURL(resolve(toolRoot, '@axe-core/playwright/dist/index.mjs')).href
);
const db = new DatabaseSync(':memory:'),
  password = randomUUID();
const server = createOperationsServer({ db, demoPassword: password });
await prepareQADemo(db);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = { pages: [], accessibility: [], interactions: [] };
try {
  for (const [account, role] of [
    ['TA_DIRECTOR', 'admin'],
    ['TA_TEACHER', 'teacher'],
    ['TA_STUDENT_001', 'student'],
    ['TA_GUARDIAN_E_MATH', 'guardian'],
    ['TA_VISITOR', 'visitor'],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 950 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/login');
    await page.locator('[name=username]').fill(account);
    await page.locator('[name=password]').fill(password);
    await Promise.all([
      page.waitForURL(origin + '/'),
      page.getByRole('button', { name: '로그인', exact: true }).click(),
    ]);
    const links = await page
      .locator('.sidebar .service-nav a')
      .evaluateAll((a) => a.map((x) => x.getAttribute('href')));
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 950 });
      for (const href of links) {
        const response = await page.goto(origin + href);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        results.pages.push({
          role,
          width,
          href,
          status: response.status(),
          overflow,
          errors: [...errors],
        });
        if (width === 390) {
          const audit = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze();
          results.accessibility.push({
            role,
            href,
            violations: audit.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              nodes: v.nodes.map((n) => ({
                target: n.target,
                summary: n.failureSummary,
              })),
            })),
          });
        }
        if (
          ['admin', 'guardian'].includes(role) &&
          width !== 360 &&
          [
            '/',
            '/consultation',
            '/consultation?view=inbox',
            '/schedule',
          ].includes(href)
        ) {
          await page.screenshot({
            path: resolve(
              out,
              role +
                '-' +
                width +
                '-' +
                (href === '/' ? 'home' : href.slice(1).split('?')[0]) +
                '.png',
            ),
            fullPage: true,
          });
        }
      }
    }
    const open = page.locator('[data-open-menu]');
    await open.click();
    await page.locator('#mobile-menu').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#mobile-menu a').count(), links.length);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#mobile-menu').isVisible(), false);
    assert.equal(
      await open.evaluate((el) => el === document.activeElement),
      true,
    );
    results.interactions.push({
      role,
      check: 'menu, Escape, focus restoration',
      pass: true,
    });
    if (role === 'guardian') {
      await page.goto(origin + '/consultation');
      await page
        .locator('[name=question]')
        .fill('초등 수학반 시간표 알려주세요.');
      await Promise.all([
        page.waitForURL(/id=/),
        page.getByRole('button', { name: '질문하기', exact: true }).click(),
      ]);
      assert.match(
        await page.locator('.message.answer').textContent(),
        /16:00/,
      );
      assert.ok(await page.locator('.citations').count());
      results.interactions.push({
        role,
        check: 'submit question, saved answer, schedule and citation',
        pass: true,
      });
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.reload();
      const manifest = await (
        await context.newCDPSession(page)
      ).send('Page.getAppManifest');
      assert.equal(manifest.errors.length, 0);
      await context.setOffline(true);
      await page.goto(origin + '/consultation');
      assert.match(await page.locator('body').textContent(), /인터넷 연결/);
      assert.equal(
        await page.evaluate(async () => (await caches.keys()).length),
        0,
      );
      results.interactions.push({
        role,
        check: 'manifest, offline message, zero private caches',
        pass: true,
      });
    }
    await context.close();
  }
  assert.equal(
    results.pages.filter(
      (p) => p.status !== 200 || p.overflow || p.errors.length,
    ).length,
    0,
  );
  assert.equal(
    results.accessibility.filter((p) => p.violations.length).length,
    0,
  );
  console.log(
    JSON.stringify({
      pages: results.pages.length,
      accessibility: results.accessibility.length,
      interactions: results.interactions.length,
      pass: true,
    }),
  );
} finally {
  writeFileSync(
    resolve(out, 'browser-results.json'),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  server.close();
  db.close();
}
