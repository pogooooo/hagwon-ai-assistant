import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fixture, item, reading } from './test-fixtures.ts';
import { approveReport, readReport } from './facts.ts';
import { newId, readSubmission } from './service.ts';
import { gradingModule } from './module.ts';

test('report retries never block deletion receipts or duplicate a draft', async (t) => {
  const f = fixture(t),
    submission = await f.upload(f.register());
  const result = await f.confirm(submission, false);
  f.db.exec(
    "CREATE TRIGGER fail_test_report BEFORE INSERT ON grading_v3_reports BEGIN SELECT RAISE(FAIL,'injected'); END;",
  );
  assert.equal(await f.service.purge(submission), true);
  assert.equal(
    f.service.result(f.ctx('TA_STUDENT_001'), result.result_set_id).revision,
    1,
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM grading_v3_report_queue').get()!.n,
    1,
  );
  f.db.exec('DROP TRIGGER fail_test_report');
  f.advance(61000);
  await f.service.sweep();
  await f.service.sweep();
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM grading_v3_result_reports').get()!
      .n,
    1,
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM grading_v3_report_queue').get()!.n,
    0,
  );
});

test('consented demo submission with two photos creates one assignment report, visible only after approval', async (t) => {
  let reads = 0;
  const f = fixture(t, {
    provider: {
      modelId: 'off',
      inputAllowed: false,
      read: async () => {
        throw Error('unexpected general upload');
      },
    },
    practicePolicy: 'demo-academy-deidentified-v2',
    practiceProvider: {
      modelId: 'fixture',
      inputAllowed: true,
      read: async (pages, a) => {
        reads++;
        assert.deepEqual(
          pages.map((p) => p.page_no),
          [1, 2],
        );
        return a.items.map((i) => reading(i));
      },
    },
  });
  const a = f.register([
    item(),
    item('MATH', { item_no: '2', expected_page_no: 2 }),
  ]);
  const parent = f.ctx('TA_GUARDIAN_E_MATH'),
    student = f.ctx('TA_STUDENT_001'),
    staff = f.ctx('TA_TEACHER'),
    other = f.ctx('TA_GUARDIAN_M2');
  const data = { ...a, student_ref: 'TA_STU_001', expected_page_count: 2 };
  assert.throws(
    () => f.service.create(parent, data, newId('request')),
    /PHOTO_CONSENT_REQUIRED/,
  );
  assert.throws(
    () =>
      f.service.create(
        other,
        { ...data, practice_consent: true },
        newId('request'),
      ),
    /RESOURCE_NOT_FOUND/,
  );
  const form = new FormData();
  for (const [k, v] of Object.entries({
    action: 'upload',
    student: 'TA_STU_001',
    assignment: a.assignment_id,
    practice: 'yes',
    request_key: newId('request'),
  }))
    form.set(k, v);
  for (const n of [1, 2])
    form.append(
      'photos',
      new Blob(
        [
          new Uint8Array(
            readFileSync(
              new URL(
                '../academy-operations/assets/practice-math-' + n + '.png',
                import.meta.url,
              ),
            ),
          ),
        ],
        { type: 'image/png' },
      ),
      'p' + n + '.png',
    );
  const next = await gradingModule.submit(parent, form);
  const id = new URL(String(next), 'http://localhost').searchParams.get(
    'submission',
  )!;
  assert.equal(readSubmission(staff, id).expected_pages, 2);
  assert.equal(reads, 1);
  await f.confirm(id, false);
  const count = () =>
    f.db.prepare('SELECT count(*) AS n FROM grading_v3_result_reports').get()!
      .n;
  assert.equal(count(), 0);
  assert.equal(await f.service.purge(id), true);
  assert.equal(await f.service.purge(id), true);
  assert.equal(count(), 1);
  const rid = String(
    f.db.prepare('SELECT report FROM grading_v3_result_reports').get()!.report,
  );
  const draft = readReport(staff, rid);
  assert.match(draft.rendered_text, /2문항 중 2문항 정답/);
  assert.throws(() => readReport(parent, rid));
  assert.throws(() => readReport(student, rid));
  approveReport(
    staff,
    rid,
    draft.revision,
    draft.source_generation,
    draft.facts_hash,
  );
  for (const actor of [parent, student])
    assert.equal(readReport(actor, rid).status, 'approved');
  assert.throws(() => readReport(other, rid), /RESOURCE_NOT_FOUND/);
  const newIdForSameStudent = f.service.create(
    parent,
    { ...data, practice_consent: true },
    newId('request'),
  ).submission_id;
  await f.service.cancel(staff, newIdForSameStudent);
  assert.equal(readReport(parent, rid).status, 'approved');
  f.db
    .prepare('DELETE FROM guardian_students WHERE guardian_id=?')
    .run(parent.actor.id);
  assert.throws(() => readReport(parent, rid), /RESOURCE_NOT_FOUND/);
});

test('the report list repairs a missing draft without waiting for unrelated queued reports', async (t) => {
  const f = fixture(t);
  const id = await f.upload(f.register());
  const result = await f.confirm(id, false);
  f.db.exec(
    "CREATE TRIGGER fail_test_report BEFORE INSERT ON grading_v3_reports BEGIN SELECT RAISE(FAIL,'injected'); END;",
  );
  assert.equal(await f.service.purge(id), true);
  const teacher = f.ctx('TA_TEACHER');
  const parent = f.ctx('TA_GUARDIAN_E_MATH');
  const detailUrl = new URL('/grading?submission=' + id, teacher.url);
  assert.match(
    await gradingModule.render({ ...teacher, url: detailUrl }),
    /과제 리포트 초안 다시 만들기/,
  );
  const retryForm = new FormData();
  retryForm.set('action', 'retry_report');
  retryForm.set('submission', id);
  await assert.rejects(async () => gradingModule.submit(parent, retryForm));

  f.db.exec('DROP TRIGGER fail_test_report');
  f.db
    .prepare('DELETE FROM grading_v3_report_queue WHERE result=?')
    .run(result.result_set_id);
  for (let i = 0; i < 6; i++)
    f.db
      .prepare('INSERT INTO grading_v3_report_queue VALUES(?,?,0)')
      .run('unrelated', newId('result'));
  const reportsUrl = new URL('/grading?view=reports', teacher.url);
  const staffList = await gradingModule.render({ ...teacher, url: reportsUrl });
  const link = staffList.match(/href="\/grading\?report=([^"]+)"/);
  assert.ok(link);
  assert.equal(readReport(teacher, link[1]).status, 'draft');
  assert.throws(() => readReport(parent, link[1]));
  assert.equal(
    await gradingModule.submit(teacher, retryForm),
    '/grading?report=' + link[1],
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM grading_v3_result_reports').get()!
      .n,
    1,
  );
});
