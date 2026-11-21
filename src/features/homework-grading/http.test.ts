import { configureGrading } from './module.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createOperationsServer } from '../academy-operations/application.ts';
import { fixture, item, photo } from './test-fixtures.ts';
import { GradingService, newId, readSubmission } from './service.ts';
import { consultationModule } from '../academy-operations/consultation.ts';
import {
  configureOperationsGeneration,
  createOperationsGeneration,
} from '../academy-operations/runtime-generation.ts';

test('HTTP photo upload → teacher review → purge → approved report with live student access', async (t) => {
  const f = fixture(t),
    a = f.register([
      item('KOR'),
      { ...item('ENG'), item_no: '2' },
      { ...item('MATH'), item_no: '3' },
    ]);
  const server = createOperationsServer({
    db: f.db,
    demoPassword: 'grading-fixture-password',
    assetsRoot: null,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  async function send(
    path: string,
    cookie: string,
    body?: FormData | URLSearchParams,
  ) {
    return fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, origin },
      body,
      redirect: 'manual',
    });
  }
  async function login(user: string) {
    const r = await send(
      '/login',
      '',
      new URLSearchParams({
        username: user,
        password: 'grading-fixture-password',
      }),
    );
    assert.equal(r.status, 303);
    return r.headers.get('set-cookie')!.split(';')[0];
  }
  const teacher = await login('TA_DIRECTOR'),
    student = await login('TA_STUDENT_001');
  const instructor = await login('TA_TEACHER'),
    parent = await login('TA_GUARDIAN_E_MATH'),
    other = await login('TA_GUARDIAN_M2');
  for (const actor of [teacher, instructor, student, parent]) {
    for (const path of ['/', '/grading', '/learning']) {
      const page = await send(path, actor);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(
        !html.includes('href="/homework') &&
          !html.includes('action="/homework"'),
      );
      assert.ok(html.includes('href="/grading'));
    }
    assert.equal(
      (await send('/homework', actor)).headers.get('location'),
      '/grading',
    );
    assert.equal(
      (
        await send(
          '/homework',
          actor,
          new URLSearchParams({ action: 'report' }),
        )
      ).status,
      405,
    );
    assert.equal(
      (
        await send(
          '/learning',
          actor,
          new URLSearchParams({ action: 'results' }),
        )
      ).status,
      405,
    );
  }
  assert.equal(
    (await send('/homework?view=review', instructor)).headers.get('location'),
    '/grading?queue=review',
  );
  const teacherPage = await (await send('/grading', instructor)).text();
  assert.match(teacherPage, /제출·검수 현황/);
  assert.doesNotMatch(teacherPage, /name="photos"/);
  assert.match(
    await (await send('/grading?view=register', instructor)).text(),
    /과제 등록/,
  );
  assert.equal((await send('/grading?view=register', student)).status, 404);
  const selected = await (
    await send('/grading?view=upload&assignment=' + a.assignment_id, student)
  ).text();
  assert.ok(selected.includes('value="' + a.assignment_id + '"'));
  assert.match(selected, /name="photos"/);
  assert.match(
    await (await send('/grading', parent)).text(),
    /<h2>공개된 채점 결과/,
  );
  const upload = new FormData();
  for (const [k, v] of Object.entries({
    action: 'upload',
    request_key: newId('request'),
    assignment: a.assignment_id,
    student: 'TA_STU_001',
    pages: '1',
  }))
    upload.set(k, v);
  const p = photo();
  upload.set(
    'photos',
    new Blob([new Uint8Array(p.bytes)], { type: p.mime }),
    'homework.png',
  );
  const uploaded = await send('/grading', student, upload);
  assert.equal(uploaded.status, 303, await uploaded.text());
  const location = uploaded.headers.get('location')!,
    submission = new URL(location, origin).searchParams.get('submission')!;
  const rawPath = '/grading/photo?submission=' + submission + '&page=1';
  assert.ok((await (await send('/', instructor)).text()).includes(location));
  assert.ok(
    !(await (await send('/learning', parent)).text()).includes(location),
  );
  assert.equal((await send(location, other)).status, 404);
  const reviewPage = await (await send(location, teacher)).text();
  assert.ok(
    reviewPage.includes(rawPath),
    'teacher review must link the whole page, not just an inferred crop',
  );
  assert.match(reviewPage, /1쪽 전체 사진/);
  assert.match(reviewPage, /data-review-item="0"/);
  assert.match(reviewPage, /등록 정답/);
  assert.match(reviewPage, /<button disabled>확정하고 원문 삭제/);
  const studentDetail = await (await send(location, student)).text();
  assert.doesNotMatch(
    studentDetail,
    /data-review-item|grade-key|class="grade-paper"/,
  );
  const raw = await send(rawPath, teacher);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('cache-control'), 'no-store');
  assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.equal((await send(rawPath, student)).status, 403);
  const draft = await f.service.draft(f.ctx(), submission),
    review = new URLSearchParams({
      action: 'review',
      submission,
      revision: String(draft.draft_revision),
    });
  for (let n = 0; n < draft.items.length; n++) {
    const d = draft.items[n],
      prefix = 'r' + n + '_';
    for (const [k, v] of Object.entries({
      answer: d.extraction.answer_observed,
      unit: '',
      answer_status: 'readable',
      located: 'yes',
      outcome: 'correct',
      score_0: '2',
      reviewed: 'yes',
    }))
      review.set(prefix + k, v);
  }
  const reviewed = await send('/grading', teacher, review);
  assert.equal(reviewed.status, 303, await reviewed.text());
  const approved = await send(
    '/grading',
    teacher,
    new URLSearchParams({
      action: 'confirm',
      request_key: newId('request'),
      submission,
      revision: String(draft.draft_revision + 1),
      review_complete: 'yes',
    }),
  );
  assert.equal(approved.status, 303, await approved.text());
  assert.equal(readSubmission(f.ctx(), submission).raw_state, 'VERIFIED');
  assert.equal((await send(rawPath, teacher)).status, 410);
  for (const actor of [instructor, student, parent])
    assert.ok(
      (await (await send('/learning', actor)).text()).includes(location),
    );
  assert.ok(
    !(await (await send('/learning', other)).text()).includes(location),
  );
  const briefing = await send(
    '/briefing?class=TA_E_MATH&month=2026-11',
    instructor,
  );
  assert.equal(briefing.status, 200);
  assert.ok((await briefing.text()).includes(location));
  const publicResult = await send(location, student);
  assert.equal(publicResult.status, 200);
  assert.match(await publicResult.text(), /원문은 삭제되었습니다/);
  const report = await send(
    '/grading',
    teacher,
    new URLSearchParams({
      action: 'report',
      student: 'TA_STU_001',
      from: '2026-11-01',
      to: '2026-12-01',
      subject: 'MATH',
      attempt: 'latest_in_window',
    }),
  );
  assert.equal(report.status, 303, await report.text());
  const reportPath = report.headers.get('location')!,
    reportId = new URL(reportPath, origin).searchParams.get('report')!;
  assert.equal((await send(reportPath, student)).status, 403);
  const row = f.db
      .prepare('SELECT payload FROM grading_v3_reports WHERE id=?')
      .get(reportId) as { payload: string },
    payload = JSON.parse(row.payload);
  const published = await send(
    '/grading',
    teacher,
    new URLSearchParams({
      action: 'approve_report',
      report: reportId,
      revision: '1',
      generation: String(payload.source_generation),
      hash: payload.facts_hash,
      review_complete: 'yes',
    }),
  );
  assert.equal(published.status, 303);
  assert.equal((await send(reportPath, student)).status, 200);
  const restart = (restoredBackup: boolean) =>
    configureGrading(
      f.db,
      new GradingService(f.db, {
        provider: f.service.provider,
        now: f.service.now,
        restoredBackup,
      }),
    );
  restart(false);
  assert.equal((await send(reportPath, parent)).status, 200);
  assert.ok(
    (await (await send('/grading?view=reports', parent)).text()).includes(
      reportId,
    ),
  );
  assert.equal((await send(reportPath, other)).status, 404);
  restart(true);
  assert.equal((await send(reportPath, parent)).status, 409);
  assert.ok(
    !(await (await send('/grading?view=reports', parent)).text()).includes(
      reportId,
    ),
  );
});

test('RAG consultation keeps KOR, ENG and MATH facts and actual citations separate', async (t) => {
  const f = fixture(t),
    defs = [
      item('KOR'),
      { ...item('ENG'), item_no: '2' },
      { ...item('MATH'), item_no: '3' },
    ];
  f.answers.set(defs[1].item_ref, { answer_observed: 'want' });
  const server = createOperationsServer({
    db: f.db,
    demoPassword: 'grading-fixture-password',
    assetsRoot: null,
  });
  t.after(() => {
    server.close();
  });
  configureOperationsGeneration(
    createOperationsGeneration({ RAG_GENERATION_PROVIDER: 'disabled' }),
  );
  await f.confirm(await f.upload(f.register(defs)));
  for (const [subject, expected, source] of [
    ['국어', '1문항 중 1문항 정답', 'KOR'],
    ['영어', '1문항 중 0문항 정답', 'ENG'],
    ['수학', '1문항 중 1문항 정답', 'MATH'],
  ]) {
    const thread = randomUUID(),
      form = new FormData();
    for (const [k, v] of Object.entries({
      action: 'ask',
      conversationId: thread,
      question: `11월 ${subject} 전체 정답률 알려줘`,
      studentId: 'TA_STU_001',
    }))
      form.set(k, v);
    await consultationModule.submit(f.ctx('TA_GUARDIAN_E_MATH'), form);
    const row = f.db
      .prepare(
        "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
      )
      .get(thread) as { response: string };
    const answer = JSON.parse(row.response);
    assert.equal(answer.status, 'answered', JSON.stringify(answer));
    assert.ok(answer.answer.includes(expected), answer.answer);
    assert.ok(
      answer.citations.some((c: { documentId: string }) =>
        c.documentId.endsWith('-' + source),
      ),
      JSON.stringify(answer.citations),
    );
  }
});
