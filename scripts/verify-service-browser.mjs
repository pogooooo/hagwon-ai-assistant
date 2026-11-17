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
import {
  createKnowledgeDraft,
  knowledgeModule,
} from '../src/features/academy-operations/knowledge.ts';
import { getActor } from '../src/features/academy-operations/directory.ts';
import {
  configureOperationsGeneration,
  createOperationsGeneration,
} from '../src/features/academy-operations/runtime-generation.ts';

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
const livePublic = process.argv.includes('--live-public');
if (livePublic) {
  if (!process.env.RAG_CLOVA_API_KEY)
    throw new Error('Live browser check needs a NAVER server key');
  configureOperationsGeneration(
    createOperationsGeneration(process.env, fetch, db),
  );
  const context = {
    db,
    actor: getActor(db, 'TA_DIRECTOR'),
    url: new URL('http://localhost/'),
  };
  const id = createKnowledgeDraft(context, {
    kind: 'registration',
    title: '합성 검증 휴게 라운지',
    question: '라운지 이용',
    body: '## 휴게 라운지\n휴게 라운지는 6층 602호입니다. 이용 시간은 평일 12:30~17:30입니다.',
    provenance: '가상 브라우저 검증',
  });
  const form = new FormData();
  for (const [k, v] of Object.entries({
    action: 'approve',
    id,
    version: '1',
    visibility: 'academy_public',
    from: '2020-01-01',
    until: '2030-12-31',
  }))
    form.set(k, v);
  await knowledgeModule.submit(context, form);
}
await prepareQADemo(db);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = { pages: [], accessibility: [], interactions: [] };
const responsive = process.argv.includes('--responsive');
const widths = responsive
  ? [1440, 1024, 820, 768, 390, 360, 320]
  : [1440, 390, 360];
try {
  if (responsive) {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 950 });
      const response = await page.goto(origin + '/login');
      results.pages.push({
        role: 'login',
        width,
        href: '/login',
        status: response.status(),
        overflow: await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        errors: [],
      });
      if (width === 390) {
        const audit = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        results.accessibility.push({
          role: 'login',
          href: '/login',
          violations: audit.violations,
        });
      }
      if ([390, 1440].includes(width))
        await page.screenshot({
          path: resolve(out, 'login-' + width + '.png'),
          fullPage: true,
        });
    }
    await context.close();
  }
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
    for (const width of widths) {
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
      await page.goto(origin + '/');
      if (responsive) {
        const schedule = page.locator('.home-primary');
        const consultation = page.locator('.home-help');
        assert.ok(
          (await schedule.boundingBox()).y <
            (await consultation.boundingBox()).y,
        );
        await page.locator('#home-question').focus();
        assert.equal(await page.locator('.mobile-nav').isVisible(), false);
        await page.locator('h1').click();
        assert.equal(await page.locator('.mobile-nav').isVisible(), true);
        results.interactions.push({
          role,
          check: 'mobile task order and input focus/navigation visibility',
          pass: true,
        });
      }
      await page.locator('#home-question').fill('자습실 위치와 이용 시간은?');
      await Promise.all([
        page.waitForURL(/consultation\?q=/),
        page.getByRole('button', { name: '상담 시작', exact: true }).click(),
      ]);
      assert.equal(
        await page.locator('[name=question]').inputValue(),
        '자습실 위치와 이용 시간은?',
      );
      if (responsive) {
        await page.setViewportSize({ width: 320, height: 550 });
        await page.locator('[name=question]').focus();
        assert.equal(await page.locator('.mobile-nav').isVisible(), false);
        await page.locator('[name=question]').fill('편집 가능한 질문');
        assert.equal(
          await page.locator('[name=question]').inputValue(),
          '편집 가능한 질문',
        );
        await page.locator('h1').click();
        await page.locator('.consultation-history-jump').click();
        assert.ok(new URL(page.url()).hash === '#consultation-history');
        await page.setViewportSize({ width: 320, height: 950 });
        results.interactions.push({
          role,
          check: 'short viewport composer and conversation-list anchor',
          pass: true,
        });
      }
      await page.locator('[data-question]').first().click();
      assert.equal(
        await page.locator('[name=question]').inputValue(),
        '학원 위치와 주차 안내가 궁금해요.',
      );
      results.interactions.push({
        role,
        check: 'home question transfer and editable suggestion',
        pass: true,
      });
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
      await page.locator('.source-details summary').click();
      assert.equal(await page.locator('.citations').isVisible(), true);
      results.interactions.push({
        role,
        check: 'submit question, saved answer, schedule and citation',
        pass: true,
      });
      if (livePublic) {
        await page.goto(origin + '/consultation');
        await page
          .locator('[name=question]')
          .fill('휴게 라운지 위치와 이용 시간을 알려주세요.');
        await page
          .getByRole('button', { name: '질문하기', exact: true })
          .click({ noWaitAfter: true });
        await page.waitForURL(/id=/, { timeout: 35000 });
        const answer = await page.locator('.message.answer').textContent();
        assert.match(answer, /602호/);
        assert.match(answer, /12:30/);
        assert.match(answer, /17:30/);
        await page.locator('.source-details summary').click();
        assert.equal(await page.locator('.citations').isVisible(), true);
        assert.equal(
          db
            .prepare(
              "SELECT calls FROM op_external_usage WHERE kind='clova-consultation'",
            )
            .get().calls,
          1,
        );
        await page.screenshot({
          path: resolve(out, 'guardian-live-naver.png'),
          fullPage: true,
        });
        results.interactions.push({
          role,
          check:
            'live NAVER HTTP consultation: two requirements, source and persisted call count',
          pass: true,
        });
      }
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
