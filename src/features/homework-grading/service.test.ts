import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { fixture, item, photo, reading } from './test-fixtures.ts';
import { MemoryRawStore, type RawObject } from './raw-store.ts';
import { GradingError, type Reading } from './contracts.ts';
import { GradingService, newId, readSubmission } from './service.ts';
import {
  approveReport,
  computeFacts,
  generateReport,
  readReport,
  renderObservations,
  snapshot,
} from './facts.ts';
import { gradingEvidence } from './evidence.ts';
import { decodeUploads } from './media.ts';

function code(expected: string) {
  return (error: unknown) =>
    error instanceof GradingError && error.code === expected;
}

test('revoking the teacher class during an asynchronous photo read blocks its response', async (t) => {
  const f = fixture(t),
    id = await f.upload(f.register()),
    teacher = f.ctx('TA_TEACHER');
  const pending = f.service.photo(teacher, id, 1);
  f.db
    .prepare('DELETE FROM teacher_classes WHERE teacher_id=?')
    .run(teacher.actor.id);
  await assert.rejects(pending, code('RESOURCE_NOT_FOUND'));
});

test('declared backup restoration quarantines old publication heads until new evidence is reviewed', async (t) => {
  const f = fixture(t),
    a = f.register(),
    id = await f.upload(a),
    result = await f.confirm(id);
  const restored = new GradingService(f.db, {
    rawStore: f.raw,
    provider: {
      modelId: 'offline',
      inputAllowed: true,
      async read(_p, a) {
        return a.items.map((i) => reading(i));
      },
    },
    restoredBackup: true,
  });
  assert.throws(
    () => restored.result(f.ctx(), result.result_set_id),
    code('PURGE_NOT_VERIFIED'),
  );
  assert.equal(gradingEvidence(f.db, f.ctx().actor.academyId).facts.length, 0);
  const evidence = restored.create(
    f.ctx(),
    {
      ...a,
      student_ref: 'TA_STU_001',
      expected_page_count: 1,
      submission_purpose: 'correction_evidence',
      target_result_set_id: result.result_set_id,
      target_result_revision: 1,
    },
    newId('request'),
  );
  assert.ok(evidence.submission_id);
  assert.equal(
    readSubmission(f.ctx(), evidence.submission_id).purpose,
    'correction_evidence',
  );
});

test('raw store capacity is bounded and replacing an object does not retain its old bytes', async () => {
  const raw = new MemoryRawStore(8);
  await raw.put('scope', {
    key: 'a',
    mime: 'text/plain',
    bytes: new Uint8Array(6),
  });
  await assert.rejects(
    raw.put('scope', {
      key: 'b',
      mime: 'text/plain',
      bytes: new Uint8Array(4),
    }),
    code('RAW_CAPACITY_EXCEEDED'),
  );
  await raw.put('scope', {
    key: 'a',
    mime: 'text/plain',
    bytes: new Uint8Array(2),
  });
  await raw.put('scope', {
    key: 'b',
    mime: 'text/plain',
    bytes: new Uint8Array(4),
  });
  assert.deepEqual(await raw.list('scope'), ['a', 'b']);
});
test('photo → reading → all-item teacher review → purge → retained facts and RAG', async (t) => {
  const f = fixture(t),
    defs = [item('KOR'), item('ENG'), item('MATH')].map((d, n) => ({
      ...d,
      item_no: String(n + 1),
    }));
  const a = f.register(defs),
    id = await f.upload(a),
    draft = await f.service.draft(f.ctx(), id);
  assert.equal(draft.items.length, 3);
  assert.equal(
    draft.items.every((i) => i.proposed.outcome === 'correct'),
    true,
  );
  assert.throws(
    () => f.service.result(f.ctx(), 'not-a-result'),
    code('RESOURCE_NOT_FOUND'),
  );
  await assert.rejects(
    f.service.confirm(f.ctx(), id, draft.draft_revision, newId('request')),
    code('TEACHER_REVIEW_REQUIRED'),
  );
  const result = await f.confirm(id, false);
  assert.throws(
    () => f.service.result(f.ctx(), result.result_set_id),
    code('PURGE_NOT_VERIFIED'),
  );
  assert.equal(gradingEvidence(f.db, f.ctx().actor.academyId).facts.length, 0);
  assert.equal(await f.service.purge(id), true);
  assert.equal((await f.raw.list(readSubmission(f.ctx(), id).scope)).length, 0);
  const retained = f.service.result(f.ctx(), result.result_set_id);
  assert.equal(retained.items.length, 3);
  assert.equal(
    retained.items.every((i) => !i.criteria_scores.length),
    true,
  );
  assert.equal(JSON.stringify(retained).includes('answer_observed'), false);
  assert.equal(gradingEvidence(f.db, f.ctx().actor.academyId).facts.length, 6);
  await assert.rejects(f.service.draft(f.ctx(), id), code('RAW_CLOSED'));
  const payload = (
    f.db.prepare('SELECT payload FROM grading_v3_results').get() as {
      payload: string;
    }
  ).payload;
  assert.doesNotMatch(
    payload,
    /answer_observed|question_text|criterion_evidence|synthetic answer/,
  );
});
test('missing and duplicate model rows preserve expected manifest items without forced zeros', async (t) => {
  const defs = [item('KOR'), item('ENG')].map((d, n) => ({
    ...d,
    item_no: String(n + 1),
  }));
  const f = fixture(t, {
    provider: {
      modelId: 'offline',
      inputAllowed: true,
      async read() {
        return [reading(defs[0]), reading(defs[0])];
      },
    },
  });
  const id = await f.upload(f.register(defs)),
    draft = await f.service.draft(f.ctx(), id);
  assert.equal(draft.items.length, 2);
  assert.equal(
    draft.items.every((i) => i.proposed.score === null),
    true,
  );
});
test('student IDs come from server actor, raw photos and draft are staff-only', async (t) => {
  const f = fixture(t),
    a = f.register();
  const s = f.service.create(
    f.ctx('TA_STUDENT_001'),
    { ...a, student_ref: 'TA_STUDENT_004', expected_page_count: 1 },
    newId('request'),
  );
  assert.equal(readSubmission(f.ctx(), s.submission_id).student, 'TA_STU_001');
  await f.service.upload(f.ctx(), s.submission_id, [photo()]);
  await f.service.process(f.ctx(), s.submission_id);
  await assert.rejects(
    f.service.draft(f.ctx('TA_STUDENT_001'), s.submission_id),
    code('FORBIDDEN'),
  );
  await assert.rejects(
    f.service.photo(f.ctx('TA_STUDENT_001'), s.submission_id, 1),
    code('FORBIDDEN'),
  );
  const foreign = {
    ...f.ctx(),
    actor: { ...f.ctx().actor, academyId: 'foreign' },
  };
  assert.throws(
    () => readSubmission(foreign, s.submission_id),
    code('RESOURCE_NOT_FOUND'),
  );
});
test('bad bytes and page-count mismatch make no learning attempt', async (t) => {
  const f = fixture(t),
    a = f.register(),
    s = f.service.create(
      f.ctx(),
      { ...a, student_ref: 'TA_STU_001', expected_page_count: 1 },
      newId('request'),
    );
  await assert.rejects(
    f.service.upload(f.ctx(), s.submission_id, [
      { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
    ]),
  );
  assert.equal(readSubmission(f.ctx(), s.submission_id).attempt_no, null);
  const b = f.service.create(
    f.ctx(),
    { ...a, student_ref: 'TA_STU_001', expected_page_count: 2 },
    newId('request'),
  );
  await assert.rejects(
    f.service.upload(f.ctx(), b.submission_id, [photo()]),
    code('PAGE_COUNT_MISMATCH'),
  );
  assert.equal(readSubmission(f.ctx(), b.submission_id).attempt_no, null);
});
test('actual image decoding and text/scanned PDF rendering precede paid calls', async () => {
  const p = photo(),
    pdf = await PDFDocument.create(),
    page = pdf.addPage([300, 180]);
  page.drawImage(await pdf.embedPng(p.bytes), {
    x: 0,
    y: 0,
    width: 300,
    height: 180,
  });
  const images = await decodeUploads([
    { bytes: await pdf.save(), mime: 'application/pdf' },
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0].mime, 'image/png');
  assert.ok(images[0].bytes.length > 100);
  const textPdf = await PDFDocument.create();
  textPdf.addPage([300, 180]).drawText('Answer: 1/2', { x: 10, y: 60 });
  assert.equal(
    (
      await decodeUploads([
        { bytes: await textPdf.save(), mime: 'application/pdf' },
      ])
    ).length,
    1,
  );
});
test('optimistic revisions, complete review and idempotent confirm prevent duplicate grades/jobs', async (t) => {
  const f = fixture(t),
    id = await f.upload(f.register()),
    draft = await f.review(id);
  await assert.rejects(
    f.service.patch(f.ctx(), id, draft.draft_revision - 1, draft.items),
    code('REVISION_MISMATCH'),
  );
  const key = newId('request'),
    first = await f.service.confirm(f.ctx(), id, draft.draft_revision, key);
  assert.deepEqual(
    await f.service.confirm(f.ctx(), id, draft.draft_revision, key),
    first,
  );
  await assert.rejects(
    f.service.confirm(f.ctx(), id, draft.draft_revision + 1, key),
    code('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(
    (
      f.db.prepare('SELECT COUNT(*) n FROM grading_v3_results').get() as {
        n: number;
      }
    ).n,
    1,
  );
  assert.equal(
    (
      f.db.prepare('SELECT COUNT(*) n FROM grading_v3_jobs').get() as {
        n: number;
      }
    ).n,
    1,
  );
});
test('idempotent creation binds actor, endpoint and body', (t) => {
  const f = fixture(t),
    a = f.register(),
    key = newId('request'),
    input = { ...a, student_ref: 'TA_STU_001', expected_page_count: 1 };
  assert.deepEqual(
    f.service.create(f.ctx(), input, key),
    f.service.create(f.ctx(), input, key),
  );
  assert.throws(
    () => f.service.create(f.ctx(), { ...input, expected_page_count: 2 }, key),
    code('IDEMPOTENCY_CONFLICT'),
  );
});
test('delete 403 is a retry, never a verified receipt or visible result', async (t) => {
  class FailingStore extends MemoryRawStore {
    failing = true;
    override async delete(s: string, k: string) {
      if (this.failing) throw new Error('403');
      return super.delete(s, k);
    }
  }
  const raw = new FailingStore(),
    f = fixture(t, { raw }),
    id = await f.upload(f.register()),
    r = await f.confirm(id, false);
  assert.equal(await f.service.purge(id), false);
  assert.equal(readSubmission(f.ctx(), id).raw_state, 'PURGE_RETRY');
  assert.throws(
    () => f.service.result(f.ctx(), r.result_set_id),
    code('PURGE_NOT_VERIFIED'),
  );
  raw.failing = false;
  assert.equal(await f.service.purge(id), true);
  f.service.result(f.ctx(), r.result_set_id);
});
test('orphan raw objects are found by scope enumeration and deleted', async (t) => {
  const f = fixture(t),
    id = await f.upload(f.register()),
    scope = readSubmission(f.ctx(), id).scope;
  await f.raw.put(scope, {
    key: 'untracked_orphan',
    mime: 'text/plain',
    bytes: new TextEncoder().encode('must disappear'),
  });
  await f.confirm(id);
  assert.deepEqual(await f.raw.list(scope), []);
});
test('a late AI response after cancellation cannot recreate a draft or result', async (t) => {
  let release!: (value: Reading[]) => void, started!: () => void;
  const beginning = new Promise<void>((r) => {
    started = r;
  });
  const f = fixture(t, {
    provider: {
      modelId: 'delayed',
      inputAllowed: true,
      async read(_p, a) {
        started();
        return new Promise((resolve) => {
          release = () => resolve(a.items.map((i) => reading(i)));
        });
      },
    },
  });
  const a = f.register(),
    s = f.service.create(
      f.ctx(),
      { ...a, student_ref: 'TA_STU_001', expected_page_count: 1 },
      newId('request'),
    );
  await f.service.upload(f.ctx(), s.submission_id, [photo()]);
  const pending = f.service.process(f.ctx(), s.submission_id);
  await beginning;
  await f.service.cancel(f.ctx(), s.submission_id);
  assert.notEqual(
    readSubmission(f.ctx(), s.submission_id).raw_state,
    'VERIFIED',
  );
  release([]);
  await assert.rejects(pending);
  await f.service.sweep();
  assert.equal(readSubmission(f.ctx(), s.submission_id).raw_state, 'VERIFIED');
  assert.equal(
    (
      f.db.prepare('SELECT COUNT(*) n FROM grading_v3_results').get() as {
        n: number;
      }
    ).n,
    0,
  );
  assert.deepEqual(await f.raw.list(s.raw_scope_id), []);
});
test('a PUT started before closing cannot survive purge verification', async (t) => {
  let unblock!: () => void, started!: () => void;
  const begin = new Promise<void>((r) => {
    started = r;
  });
  class DelayedStore extends MemoryRawStore {
    first = true;
    override async put(s: string, value: RawObject) {
      if (this.first) {
        this.first = false;
        started();
        await new Promise<void>((r) => {
          unblock = r;
        });
      }
      await super.put(s, value);
    }
  }
  const f = fixture(t, { raw: new DelayedStore() }),
    a = f.register(),
    s = f.service.create(
      f.ctx(),
      { ...a, student_ref: 'TA_STU_001', expected_page_count: 1 },
      newId('request'),
    );
  const pending = f.service.upload(f.ctx(), s.submission_id, [photo()]);
  await begin;
  await f.service.cancel(f.ctx(), s.submission_id);
  assert.notEqual(
    readSubmission(f.ctx(), s.submission_id).raw_state,
    'VERIFIED',
  );
  unblock();
  await assert.rejects(pending);
  await f.service.sweep();
  assert.equal(readSubmission(f.ctx(), s.submission_id).raw_state, 'VERIFIED');
  assert.deepEqual(await f.raw.list(s.raw_scope_id), []);
});
test('expiry does not publish drafts, and restart never reopens old raw scopes', async (t) => {
  const f = fixture(t, { ttl: 1000 }),
    id = await f.upload(f.register());
  await f.review(id);
  f.advance(1001);
  await assert.rejects(
    f.service.confirm(f.ctx(), id, 2, newId('request')),
    code('RAW_EXPIRED'),
  );
  await f.service.sweep();
  assert.equal(readSubmission(f.ctx(), id).processing, 'EXPIRED');
  assert.deepEqual(await f.raw.list(readSubmission(f.ctx(), id).scope), []);
  const second = await f.upload(f.register());
  const restart = new GradingService(f.db, {
    provider: {
      modelId: 'disabled',
      inputAllowed: false,
      async read() {
        return [];
      },
    },
  });
  assert.equal(readSubmission(f.ctx(), second).processing, 'EXPIRED');
  await restart.sweep();
  await assert.rejects(restart.draft(f.ctx(), second), code('RAW_CLOSED'));
});
function query(student = 'TA_STU_001') {
  return {
    student_ref: student,
    from_date: '2026-11-01',
    to_date_exclusive: '2026-12-01',
    comparison_period: null,
    subjects: ['KOR', 'ENG', 'MATH'] as ('KOR' | 'ENG' | 'MATH')[],
    attempt_policy: 'latest_in_window' as const,
    statistics_policy_version: 'grading-stats-3.0' as const,
  };
}
test('empty facts preserve each requested subject and null denominators', async (t) => {
  const f = fixture(t),
    s = snapshot(f.ctx(), query());
  assert.equal(s.facts.length, 3);
  assert.equal(
    s.facts.every(
      (x) =>
        x.correct_rate === null && x.score_rate === null && x.n_evaluable === 0,
    ),
    true,
  );
  const r = await generateReport(f.ctx(), f.service, s.snapshot_id);
  assert.match(r.rendered_text, /기록 0문항/);
  assert.doesNotMatch(r.rendered_text, /집중력이 부족|성적이 향상/);
});
test('latest unreadable and pending attempts do not fall back to older correct results', async (t) => {
  const f = fixture(t),
    def = item(),
    a = f.register([def]);
  const first = await f.upload(a);
  await f.confirm(first);
  f.answers.set(def.item_ref, {
    answer_status: 'unreadable',
    answer_observed: '',
  });
  const second = await f.upload(a);
  await f.confirm(second);
  let s = computeFacts(f.db, f.ctx().actor.academyId, query());
  const fact = s.facts.find(
    (f) => f.subject_id === 'MATH' && !f.primary_skill_id,
  )!;
  assert.equal(fact.n_correct, 0);
  assert.equal(fact.n_ungradable, 1);
  assert.equal(fact.n_evaluable, 0);
  await f.upload(a);
  s = computeFacts(f.db, f.ctx().actor.academyId, query());
  assert.equal(
    s.availability.find((f) => f.subject_id === 'MATH')!.n_pending_items,
    1,
  );
  assert.equal(s.result_refs.length, 0);
});
test('first-ever selection precedes the date-window filter', async (t) => {
  const f = fixture(t),
    a = f.register();
  await f.confirm(await f.upload(a, '2026-10-30'));
  await f.confirm(await f.upload(a, '2026-11-10'));
  const s = computeFacts(f.db, f.ctx().actor.academyId, {
    ...query(),
    attempt_policy: 'first_ever',
  });
  assert.equal(s.result_refs.length, 0);
  assert.equal(
    s.availability.reduce((n, x) => n + x.n_selected_items, 0),
    0,
  );
});
test('partial, blank and ungradable use the same evaluable set for count and score denominators', async (t) => {
  const f = fixture(t),
    defs = [item(), item(), item(), item()].map((d, i) => ({
      ...d,
      item_no: String(i + 1),
    }));
  f.answers.set(defs[1].item_ref, {
    answer_observed: '',
    answer_status: 'blank',
  });
  f.answers.set(defs[2].item_ref, {
    answer_observed: '',
    answer_status: 'unreadable',
  });
  const id = await f.upload(f.register(defs)),
    draft = await f.service.draft(f.ctx(), id);
  draft.items[3].proposed = {
    ...draft.items[3].proposed,
    outcome: 'partial',
    score: '1',
    criteria_scores: [
      {
        criterion_id: defs[3].criteria[0].criterion_id,
        score: '1',
        max_score: '2',
      },
    ],
  };
  await f.service.patch(
    f.ctx(),
    id,
    draft.draft_revision,
    draft.items.map((i) => ({ ...i, reviewed: true })),
  );
  const ready = await f.service.draft(f.ctx(), id);
  await f.service.confirm(f.ctx(), id, ready.draft_revision, newId('request'));
  await f.service.purge(id);
  const fact = computeFacts(f.db, f.ctx().actor.academyId, query()).facts.find(
    (f) => f.subject_id === 'MATH' && !f.primary_skill_id,
  )!;
  assert.deepEqual(
    [
      fact.n_evaluable,
      fact.n_correct,
      fact.n_partial,
      fact.n_blank,
      fact.n_ungradable,
    ],
    [3, 1, 1, 1, 1],
  );
  assert.deepEqual(
    [fact.score_sum, fact.max_score_sum, fact.correct_rate, fact.score_rate],
    ['3', '6', '0.333333', '0.500000'],
  );
});
test('source change during report generation blocks completion and old approved reports', async (t) => {
  let release!: (value: unknown) => void, started!: () => void;
  const begin = new Promise<void>((r) => {
    started = r;
  });
  const f = fixture(t, {
    provider: {
      modelId: 'delayed-report',
      inputAllowed: true,
      async read(_p, a) {
        return a.items.map((i) => reading(i));
      },
      async report() {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const a = f.register();
  await f.confirm(await f.upload(a));
  const s = snapshot(f.ctx(), query());
  const pending = generateReport(f.ctx(), f.service, s.snapshot_id);
  await begin;
  await f.upload(a);
  release({ observations: [] });
  await assert.rejects(pending, code('SNAPSHOT_STALE'));
});
test('reports validate every fact and comparison pairing and require teacher approval', async (t) => {
  const f = fixture(t),
    result = await f.confirm(await f.upload(f.register())),
    s = snapshot(f.ctx(), query()),
    report = await generateReport(f.ctx(), f.service, s.snapshot_id);
  assert.throws(
    () => readReport(f.ctx('TA_STUDENT_001'), report.report_id),
    code('FORBIDDEN'),
  );
  assert.throws(
    () =>
      renderObservations(s, [
        {
          claim_type: 'observed_rate',
          template_key: 'rate',
          fact_ids: ['fake-fact'],
        },
      ]),
    code('REPORT_EVIDENCE_MISMATCH'),
  );
  assert.throws(
    () =>
      renderObservations(s, [
        {
          claim_type: 'observed_change',
          template_key: 'change',
          fact_ids: [s.facts[0].fact_id],
        },
      ]),
    code('REPORT_EVIDENCE_MISMATCH'),
  );
  approveReport(
    f.ctx(),
    report.report_id,
    1,
    s.source_generation,
    s.facts_hash,
  );
  assert.equal(
    readReport(f.ctx('TA_STUDENT_001'), report.report_id).status,
    'approved',
  );
  await f.service.revise(
    f.ctx(),
    result.result_set_id,
    {
      expected_result_revision: 1,
      reason_code: 'DATE_CORRECTION',
      assessment_date: '2026-10-20',
    },
    newId('request'),
  );
  assert.throws(
    () => readReport(f.ctx('TA_STUDENT_001'), report.report_id),
    code('SNAPSHOT_STALE'),
  );
});
test('new correction evidence is version-bound, separately purged and never a new attempt', async (t) => {
  const f = fixture(t),
    def = item(),
    a = f.register([def]),
    id = await f.upload(a),
    first = await f.confirm(id);
  const correction = f.service.create(
    f.ctx(),
    {
      ...a,
      student_ref: 'TA_STU_001',
      expected_page_count: 1,
      submission_purpose: 'correction_evidence',
      target_result_set_id: first.result_set_id,
      target_result_revision: 1,
    },
    newId('request'),
  );
  await f.service.upload(f.ctx(), correction.submission_id, [photo()]);
  await f.service.process(f.ctx(), correction.submission_id);
  const draft = await f.review(correction.submission_id);
  await assert.rejects(
    f.service.confirm(
      f.ctx(),
      correction.submission_id,
      draft.draft_revision,
      newId('request'),
    ),
    code('CORRECTION_REQUIRES_REVISION'),
  );
  const input = {
    expected_result_revision: 1,
    reason_code: 'SCORE_CORRECTION' as const,
    new_submission_id: correction.submission_id,
    expected_evidence_draft_revision: draft.draft_revision,
    expected_evidence_raw_generation: 1,
  };
  await assert.rejects(
    f.service.revise(
      f.ctx(),
      first.result_set_id,
      { ...input, expected_evidence_draft_revision: draft.draft_revision - 1 },
      newId('request'),
    ),
    code('REVISION_MISMATCH'),
  );
  await f.service.revise(f.ctx(), first.result_set_id, input, newId('request'));
  assert.throws(
    () => f.service.result(f.ctx(), first.result_set_id),
    code('PURGE_NOT_VERIFIED'),
  );
  await f.service.purge(correction.submission_id);
  assert.equal(f.service.result(f.ctx(), first.result_set_id).revision, 2);
  assert.equal(
    computeFacts(f.db, f.ctx().actor.academyId, query()).selection_refs.length,
    1,
  );
  assert.equal(
    readSubmission(f.ctx(), correction.submission_id).attempt_no,
    null,
  );
});
