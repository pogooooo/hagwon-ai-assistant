import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { createOperationsServer } from '../academy-operations/application.ts';
import {
  configureOperationsGeneration,
  createOperationsGeneration,
} from '../academy-operations/runtime-generation.ts';
import {
  getActor,
  initializeIdentity,
} from '../academy-operations/directory.ts';
import type { PageContext } from '../academy-operations/shared.ts';
import { GradingService, newId, readSubmission } from './service.ts';
import { configureGrading } from './module.ts';
import { createNaverGrader } from './provider.ts';
import { MemoryRawStore } from './raw-store.ts';
import { type Assignment, kstDate, extractionSchema } from './contracts.ts';
import { readSnapshot, observationSchema, type Report } from './facts.ts';
import { z } from 'zod';
import {
  evaluateGrading,
  type GoldItem,
  type Prediction,
} from './evaluation.ts';
import {
  renderValidationPage,
  validationCases as developmentCases,
  holdoutValidationCases,
} from './validation-fixtures.ts';

/** Explicitly opt-in real network validation; normal npm test never calls this. No credentials or raw responses are written. */
export async function runLiveValidation(
  env: Record<string, string | undefined>,
) {
  if (env.AXR_GRADING_LIVE_VALIDATION !== 'synthetic-only')
    throw new Error(
      'Set AXR_GRADING_LIVE_VALIDATION=synthetic-only to run this paid, synthetic-only validation.',
    );
  if (!(env.CLOVA_STUDIO_API_KEY || env.RAG_CLOVA_API_KEY))
    throw new Error('NAVER_KEY_NOT_CONFIGURED');
  const root = resolve('.local/grading-validation');
  const setId =
    env.AXR_GRADING_VALIDATION_SET === 'holdout' ? 'holdout' : 'development';
  const validationCases =
    setId === 'holdout' ? holdoutValidationCases : developmentCases;
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(':memory:');
  const budget = new DatabaseSync(resolve(root, 'usage.sqlite'));
  initializeIdentity(db, 'grading-live-validation-only');
  const calls: {
    model: string;
    http_status: number;
    provider_status?: string;
    duration_ms: number;
    input_tokens?: number;
    output_tokens?: number;
    output_shape?: unknown;
  }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const started = Date.now();
    try {
      const response = await fetch(url, init);
      const data = await response
        .clone()
        .json()
        .catch(() => ({}));
      let shape: unknown;
      try {
        const content = JSON.parse(
          String(data.result?.message?.content)
            .trim()
            .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'),
        );
        const semantic = JSON.parse(String(init?.body)).responseFormat?.schema
          ?.properties?.scores;
        const schema = new URL(String(url)).pathname.endsWith('HCX-005')
          ? extractionSchema
          : semantic
            ? z
                .object({
                  scores: z.array(
                    z
                      .object({
                        criterion_id: z.string(),
                        score: z.string(),
                        quote: z.string(),
                      })
                      .strict(),
                  ),
                })
                .strict()
            : z.object({ observations: z.array(observationSchema) }).strict();
        const validation = schema.safeParse(content);
        shape = validation.success
          ? { valid: true }
          : {
              valid: false,
              issues: validation.error.issues.map((i) => ({
                code: i.code,
                path: i.path,
              })),
            };
      } catch {
        shape = { valid: false, format: 'invalid_json' };
      }
      calls.push({
        model: new URL(String(url)).pathname.split('/').at(-1)!,
        http_status: response.status,
        provider_status: data.status?.code,
        duration_ms: Date.now() - started,
        input_tokens: data.result?.usage?.promptTokens,
        output_tokens: data.result?.usage?.completionTokens,
        output_shape: shape,
      });
      process.stdout.write(
        JSON.stringify({
          phase: 'provider_response',
          call: calls.length,
          ...calls.at(-1),
        }) + '\n',
      );
      return response;
    } catch (error) {
      calls.push({
        model: new URL(String(url)).pathname.split('/').at(-1)!,
        http_status: 0,
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  };
  const provider = createNaverGrader(
    {
      ...env,
      RAG_GENERATION_DAILY_CALL_LIMIT: '60',
      AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
      AXR_GRADING_INPUT_POLICY_REF:
        'validation:self-authored-synthetic-only-v1',
    },
    budget,
    transport,
  );
  const raw = new MemoryRawStore();
  const service = new GradingService(db, {
    provider,
    rawStore: raw,
    inputPolicyRef: 'validation:self-authored-synthetic-only-v1',
  });
  configureGrading(db, service);
  const ctx: PageContext = {
    db,
    actor: getActor(db, 'TA_DIRECTOR')!,
    url: new URL('http://localhost/grading'),
  };
  const server = createOperationsServer({
    db,
    demoPassword: 'grading-live-validation-only',
    assetsRoot: null,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const result: Record<string, unknown> = {
    schema_version: 'grading-live-validation-1.0',
    started_at: new Date().toISOString(),
    dataset:
      'Fixed self-authored synthetic cases; font-rendered writing, not real student handwriting',
    set_id: setId,
    n_cases: validationCases.length,
    validation_status: 'running',
    calls,
  };
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
  async function login(username: string) {
    const response = await send(
      '/login',
      '',
      new URLSearchParams({
        username,
        password: 'grading-live-validation-only',
      }),
    );
    assert.equal(response.status, 303, 'LOGIN_FAILED');
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function post(cookie: string, body: FormData | URLSearchParams) {
    const response = await send('/grading', cookie, body);
    assert.equal(response.status, 303, 'GRADING_HTTP_' + response.status);
    return response.headers.get('location')!;
  }
  try {
    const teacher = await login('TA_DIRECTOR'),
      student = await login('TA_STUDENT_001'),
      guardian = await login('TA_GUARDIAN_E_MATH');
    const form = new URLSearchParams({
      action: 'register',
      request_key: newId('request'),
      approved: 'yes',
      count: String(validationCases.length),
      title: '국영수 합성 예제 실제 NAVER 검증',
      class_id: 'TA_E_MATH',
      rights_basis: '직접 작성한 비식별 검증 예제',
    });
    for (const [n, c] of validationCases.entries()) {
      const values = {
        subject: c.subject,
        type: c.type,
        max: '2',
        key: c.key,
        skill: c.id,
        scores: c.form ? '' : '0,1,2',
        rubric: c.rubric ?? '등록한 정답·단위·형식을 비교한다.',
        no: String(n + 1),
        page: String(c.page),
        form: c.form ?? '',
        form_points: c.formPoints ?? '0',
        units: c.units ?? '',
        convert: c.convert ? 'yes' : 'no',
        case: 'yes',
      };
      for (const [key, value] of Object.entries(values))
        form.set('q' + n + '_' + key, value);
    }
    await post(teacher, form);
    const assignment = JSON.parse(
      (
        db
          .prepare(
            'SELECT payload FROM grading_v3_assignments ORDER BY rowid DESC LIMIT 1',
          )
          .get() as { payload: string }
      ).payload,
    ) as Assignment;
    const upload = new FormData();
    for (const [key, value] of Object.entries({
      action: 'upload',
      request_key: newId('request'),
      assignment: assignment.assignment_id,
      student: 'TA_STU_001',
      pages: '3',
    }))
      upload.set(key, value);
    const pages = [1, 2, 3].map((page) =>
      renderValidationPage(
        page,
        env.AXR_GRADING_VALIDATION_FONT,
        validationCases,
      ),
    );
    const pdf = await PDFDocument.create(),
      embedded = await pdf.embedPng(pages[2]);
    pdf
      .addPage([1400, 1900])
      .drawImage(embedded, { x: 0, y: 0, width: 1400, height: 1900 });
    const files = [pages[0], pages[1], await pdf.save()];
    for (const [n, bytes] of files.entries())
      upload.append(
        'photos',
        new Blob([new Uint8Array(bytes)], {
          type: ['image/png', 'image/jpeg', 'application/pdf'][n],
        }),
        ['korean.png', 'english.jpg', 'math-scanned.pdf'][n],
      );
    const location = await post(student, upload);
    for (const bytes of [...pages, ...files]) bytes.fill(0);
    const submission = new URL(location, origin).searchParams.get(
      'submission',
    )!;
    const head = readSubmission(ctx, submission),
      draft = await service.draft(ctx, submission);
    const gold: GoldItem[] = validationCases.map((c, n) => ({
      case_id: c.id,
      student_ref: 'TA_STU_001',
      assignment_id: assignment.assignment_id,
      item_ref: assignment.items[n].item_ref,
      subject_id: c.subject,
      max_score: '2',
      outcome: c.outcome,
      score: c.score,
    }));
    const predictions: Prediction[] = draft.items.map((d, n) => ({
      ...gold[n],
      outcome: d.proposed.outcome,
      score: d.proposed.score,
      run_status: 'ok',
      low_risk: false,
    }));
    result.draft_evaluation = evaluateGrading(gold, predictions);
    result.draft_items = draft.items.map((d, n) => ({
      case_id: gold[n].case_id,
      subject: gold[n].subject_id,
      expected_outcome: gold[n].outcome,
      expected_score: gold[n].score,
      actual_outcome: d.proposed.outcome,
      actual_score: d.proposed.score,
      answer_status: d.extraction.answer_status,
      association_status: d.extraction.association_status,
      ambiguity_codes: d.extraction.ambiguity_codes,
      exclusion_reason: d.proposed.exclusion_reason,
    }));
    process.stdout.write(
      JSON.stringify({
        phase: 'draft',
        calls: calls.length,
        evaluation: result.draft_evaluation,
      }) + '\n',
    );
    assert.equal(
      draft.items.length,
      validationCases.length,
      'MANIFEST_ITEM_LOSS',
    );
    const rawPath = '/grading/photo?submission=' + submission + '&page=1';
    assert.equal(
      (await send(rawPath, teacher)).status,
      200,
      'TEACHER_PHOTO_UNAVAILABLE',
    );
    assert.equal(
      (await send(rawPath, student)).status,
      403,
      'STUDENT_RAW_ACCESS',
    );
    const confirm = (revision: number) =>
      new URLSearchParams({
        action: 'confirm',
        request_key: newId('request'),
        submission,
        revision: String(revision),
        review_complete: 'yes',
      });
    assert.notEqual(
      (await send('/grading', teacher, confirm(draft.draft_revision))).status,
      303,
      'UNREVIEWED_CONFIRM_ALLOWED',
    );
    const review = new URLSearchParams({
      action: 'review',
      submission,
      revision: String(draft.draft_revision),
    });
    let teacherCorrections = 0;
    for (const [n, c] of validationCases.entries()) {
      const d = draft.items[n];
      if (d.proposed.outcome !== c.outcome || d.proposed.score !== c.score)
        teacherCorrections++;
      const criterionScores = c.form ? ['1.5', '0'] : [c.score ?? '0'];
      const answer =
        c.reviewAnswer ?? (c.answer === '[scribble]' ? '' : c.answer);
      const values = {
        answer,
        unit: c.reviewUnit ?? '',
        answer_status:
          c.outcome === 'ungradable'
            ? 'unreadable'
            : c.outcome === 'blank'
              ? 'blank'
              : 'readable',
        located: 'yes',
        outcome: c.outcome,
        reviewed: 'yes',
      };
      for (const [key, value] of Object.entries(values))
        review.set('r' + n + '_' + key, value);
      criterionScores.forEach((score, i) =>
        review.set('r' + n + '_score_' + i, score),
      );
    }
    await post(teacher, review);
    await post(teacher, confirm(draft.draft_revision + 1));
    result.teacher_corrected_items = teacherCorrections;
    assert.equal(
      readSubmission(ctx, submission).raw_state,
      'VERIFIED',
      'PURGE_NOT_VERIFIED',
    );
    assert.equal((await raw.list(head.scope)).length, 0, 'RAW_RESIDUE');
    assert.equal(
      (await send(rawPath, teacher)).status,
      410,
      'RAW_READ_AFTER_DELETE',
    );
    const final = service.result(
      ctx,
      readSubmission(ctx, submission).result_id!,
    );
    const serialized = JSON.stringify(final);
    assert.doesNotMatch(
      serialized,
      /answer_observed|regions|data:image|quote|teacher_instruction/,
      'RAW_IN_RETAINED_RESULT',
    );
    assert.deepEqual(
      final.items.map((i) => [i.outcome, i.score]),
      gold.map((g) => [g.outcome, g.score]),
      'TEACHER_RESULT_MISMATCH',
    );
    const today = kstDate(service.now()),
      from = today.slice(0, 8) + '01',
      next = new Date(today.slice(0, 7) + '-01T00:00:00Z');
    next.setUTCMonth(next.getUTCMonth() + 1);
    const reportForm = new URLSearchParams({
      action: 'report',
      student: 'TA_STU_001',
      from,
      to: next.toISOString().slice(0, 10),
      attempt: 'latest_in_window',
    });
    for (const s of ['KOR', 'ENG', 'MATH']) reportForm.append('subject', s);
    const reportPath = await post(teacher, reportForm),
      reportId = new URL(reportPath, origin).searchParams.get('report')!;
    const report = JSON.parse(
      (
        db
          .prepare('SELECT payload FROM grading_v3_reports WHERE id=?')
          .get(reportId) as { payload: string }
      ).payload,
    ) as Report;
    result.report = {
      model_id: report.model_id,
      generation_error: report.generation_error,
      text: report.rendered_text,
      observations: report.observations,
    };
    assert.notEqual(
      report.model_id,
      'deterministic-template',
      'REPORT_FELL_BACK_WITHOUT_AI',
    );
    assert.equal(
      (await send(reportPath, guardian)).status,
      403,
      'UNAPPROVED_REPORT_PUBLIC',
    );
    const facts = readSnapshot(ctx, report.snapshot_id);
    result.confirmed_overall_facts = facts.facts.filter(
      (f) => f.primary_skill_id === null,
    );
    for (const subject of ['KOR', 'ENG', 'MATH']) {
      const expected = gold.filter((g) => g.subject_id === subject),
        f = facts.facts.find(
          (f) => f.subject_id === subject && f.primary_skill_id === null,
        )!;
      assert.equal(
        f.n_evaluable,
        expected.filter((g) => g.outcome !== 'ungradable').length,
        'FACT_DENOMINATOR_MISMATCH',
      );
      assert.equal(
        f.n_correct,
        expected.filter((g) => g.outcome === 'correct').length,
        'FACT_CORRECT_COUNT_MISMATCH',
      );
    }
    await post(
      teacher,
      new URLSearchParams({
        action: 'approve_report',
        report: reportId,
        revision: '1',
        generation: String(report.source_generation),
        hash: report.facts_hash,
        review_complete: 'yes',
      }),
    );
    assert.equal(
      (await send(reportPath, guardian)).status,
      200,
      'APPROVED_REPORT_UNAVAILABLE',
    );
    // Numeric lookup needs no extra generation call. Verify the real consultation route and citations.
    configureOperationsGeneration(
      createOperationsGeneration({ RAG_GENERATION_PROVIDER: 'disabled' }),
    );
    const ragResults = [];
    for (const [subject, label] of [
      ['KOR', '국어'],
      ['ENG', '영어'],
      ['MATH', '수학'],
    ]) {
      const expected = gold.filter(
        (g) => g.subject_id === subject && g.outcome !== 'ungradable',
      );
      const count = expected.filter((g) => g.outcome === 'correct').length;
      const thread = randomUUID(),
        body = new FormData();
      for (const [k, v] of Object.entries({
        action: 'ask',
        conversationId: thread,
        studentId: 'TA_STU_001',
        question: `${Number(today.slice(5, 7))}월 ${label} 전체 정답률 알려줘`,
      }))
        body.set(k, v);
      assert.equal(
        (await send('/consultation', guardian, body)).status,
        303,
        'RAG_HTTP_FAILURE',
      );
      const answer = JSON.parse(
        (
          db
            .prepare(
              "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
            )
            .get(thread) as { response: string }
        ).response,
      );
      assert.equal(answer.status, 'answered', 'RAG_ABSTAINED');
      assert.ok(
        answer.answer.includes(`${expected.length}문항 중 ${count}문항 정답`),
        'RAG_VALUE_MISMATCH',
      );
      assert.ok(
        answer.citations.some((c: { documentId: string }) =>
          c.documentId.endsWith('-' + subject),
        ),
        'RAG_CITATION_MISMATCH',
      );
      ragResults.push({
        subject,
        expected_n: expected.length,
        expected_correct: count,
        citation_matches: true,
      });
    }
    result.rag = ragResults;
    result.checks = {
      http_registration: true,
      png_jpeg_scanned_pdf: true,
      teacher_review_gate: true,
      teacher_confirmed_scores: true,
      raw_deleted: true,
      student_raw_denied: true,
      report_used_real_naver: true,
      report_requires_approval: true,
      report_fact_counts: true,
      rag_fact_values_and_citations: true,
    };
    result.validation_status = 'passed';
  } catch (error) {
    result.validation_status = 'failed';
    result.failure =
      error instanceof Error
        ? error.message.slice(0, 180)
        : 'VALIDATION_FAILED';
    process.exitCode = 1;
  } finally {
    for (const row of db
      .prepare("SELECT id FROM grading_v3_submissions WHERE raw_state='OPEN'")
      .all() as { id: string }[])
      await service.cancel(ctx, row.id);
    await service.sweep();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    result.finished_at = new Date().toISOString();
    await writeFile(
      resolve(root, 'latest-' + setId + '.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    await writeFile(
      resolve(root, 'latest-result.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    process.stdout.write(
      JSON.stringify({
        phase: 'complete',
        status: result.validation_status,
        calls: calls.length,
        failure: result.failure,
        result_file: resolve(root, 'latest-result.json'),
      }) + '\n',
    );
    db.close();
    budget.close();
  }
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runLiveValidation(process.env);
