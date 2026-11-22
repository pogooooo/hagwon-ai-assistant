import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNaverGrader, type GradeProvider } from './provider.ts';
import { gradingModule } from './module.ts';
import { fixture, item, photo, reading } from './test-fixtures.ts';
import { assignmentFor, newId } from './service.ts';
import { aggregate } from './scoring.ts';
import {
  comparePhotoAnswer,
  solveVerifiedCalculation,
} from './photo-solution.ts';
import { GradingError, type PhotoSolution } from './contracts.ts';

const reference: PhotoSolution = {
  problem: '3x + 2 = 14. x의 값은?',
  answer: '4',
  explanation: '양변에서 2를 빼고 3으로 나눈다.',
  comparison: 'number',
};
test('teacher receives the specific safe provider failure and the page is not reread after denial', async (t) => {
  let retries = 0;
  const f = fixture(t, {
    provider: {
      modelId: 'test',
      inputAllowed: true,
      read: async () => {
        throw new GradingError('PROVIDER_AUTHENTICATION_FAILED');
      },
      verifyPage: async () => {
        retries++;
        return [];
      },
    },
  });
  const id = await f.upload(f.register());
  const url = new URL('/grading?submission=' + id, 'http://localhost');
  assert.equal(retries, 0);
  assert.match(
    await gradingModule.render({ ...f.ctx(), url }),
    /네이버가 이 배포의 API 키/,
  );
  assert.doesNotMatch(
    await gradingModule.render({ ...f.ctx('TA_STUDENT_001'), url }),
    /이 배포의 API 키/,
  );
});
test('scoped practice provider runs only for opted-in practice uploads by the seeded demo actors', async (t) => {
  let calls = 0;
  const f = fixture(t, {
    provider: {
      inputAllowed: false,
      modelId: 'off',
      read: async () => {
        throw Error('disabled');
      },
    },
    practiceProvider: {
      inputAllowed: true,
      modelId: 'synthetic-practice',
      read: async (_p, a) => {
        calls++;
        return a.items.map((i) => reading(i, '4'));
      },
      solvePage: async (_p, items) => new Map([[items[0].item_ref, reference]]),
    },
  });
  const assignment = f.register([
    item('MATH', { key: null, grading_mode: 'photo_solution' }),
  ]);
  const ctx = f.ctx('TA_STUDENT_001');
  const payload = {
    ...assignment,
    expected_page_count: 1,
    student_ref: 'TA_STU_001',
  };
  const practiceId = f.service.create(
    ctx,
    { ...payload, practice_consent: true },
    newId('request'),
  ).submission_id;
  assert.throws(
    () =>
      f.service.create(
        f.ctx('TA_GUARDIAN_E_MATH'),
        { ...payload, practice_consent: true },
        newId('request'),
      ),
    /PRACTICE_SCOPE/,
  );
  assert.throws(
    () =>
      f.service.create(
        ctx,
        { ...payload, ...f.register(), practice_consent: true },
        newId('request'),
      ),
    /PRACTICE_SCOPE/,
  );
  assert.equal(
    f.service.allowsPersonalPractice({
      ...ctx,
      actor: { ...ctx.actor, academyId: 'other_academy' },
    }),
    false,
  );
  const regular = f.service.create(
    ctx,
    payload,
    newId('request'),
  ).submission_id;
  for (const id of [regular, practiceId]) {
    await f.service.upload(ctx, id, [photo()]);
    await f.service.process(ctx, id);
  }
  assert.equal(calls, 1);
  assert.equal(
    (await f.service.draft(f.ctx(), regular)).items[0].proposed.score,
    null,
  );
  assert.equal(
    (await f.service.draft(f.ctx(), practiceId)).items[0].proposed.outcome,
    'correct',
  );
});
test('independent solver sees only printed questions and rejects incomplete, duplicate or mismatched items', async () => {
  const defs = Array.from({ length: 5 }, (_, i) =>
    item('MATH', {
      key: null,
      grading_mode: 'photo_solution',
      item_no: String(i + 1),
    }),
  );
  let requests = 0;
  const provider = createNaverGrader(
    {
      CLOVA_STUDIO_API_KEY: 'fixture',
      AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
      AXR_GRADING_INPUT_POLICY_REF: 'fixture',
    },
    undefined,
    async (url, init) => {
      const msg = JSON.parse(String(init?.body)).messages[1].content;
      let entries;
      if (++requests === 1) {
        assert.match(String(url), /HCX-005$/);
        assert.equal(msg[0].type, 'image_url');
        entries = [1, 2, 3, 3, 4, 5].map((i) => ({
          ref: 'q' + i,
          no: String(i),
          complete: i !== 2,
          problem: reference.problem + ' Answer: 5',
        }));
      } else if (requests === 2) {
        assert.match(String(url), /HCX-007$/);
        const config = JSON.parse(String(init?.body)).responseFormat;
        assert.deepEqual(
          config.schema.properties.items.items.properties.ref.enum,
          ['q1', 'q4', 'q5'],
        );
        assert.equal(typeof msg, 'string');
        assert.deepEqual(
          JSON.parse(msg).questions.map((q: { no: string }) => q.no),
          ['1', '4', '5'],
        );
        assert.doesNotMatch(msg, /image_url|answer_observed|student_ref/);
        assert.ok(!msg.includes('Answer: 5'));
        entries = [
          ['q5', '5'],
          ['q4', '1'],
          ['q1', '1'],
          ['q2', '2'],
        ].map(([ref, no]) => ({
          ref,
          no,
          comparison: 'number',
          answer: '4',
          explanation: reference.explanation,
        }));
      } else {
        const { checks } = JSON.parse(msg);
        assert.deepEqual(
          checks.map((c: { ref: string }) => c.ref),
          ['q5', 'q1'],
        );
        assert.doesNotMatch(msg, /"answer"|"reference"|image_url/);
        entries = checks.map((c: { ref: string; no: string }) => ({
          ref: c.ref,
          no: c.no,
          supported: true,
          answer: c.ref === 'q5' ? '5' : '4',
        }));
      }
      return Response.json({
        result: {
          message: {
            content: JSON.stringify(
              requests === 1 ? entries : { items: entries },
            ),
          },
        },
      });
    },
  );
  const results = await provider.solvePage!({ ...photo(), page_no: 1 }, defs);
  assert.deepEqual([...results.keys()].sort(), [defs[0].item_ref]);
  assert.equal(results.get(defs[0].item_ref)?.problem, reference.problem);
  assert.equal(requests, 3);
});

test('register without a key → student photo → teacher corrects or withholds → guardian receives only confirmed scores', async (t) => {
  const f = fixture(t, {
    provider: {
      modelId: 'synthetic',
      inputAllowed: true,
      async read(_pages, a) {
        return a.items.map((i) => reading(i, i.item_no === '1' ? '5' : '4'));
      },
      async solvePage(_page, defs) {
        return new Map([[defs[0].item_ref, reference]]);
      },
    },
  });
  const teacher = f.ctx(),
    student = f.ctx('TA_STUDENT_001'),
    guardian = f.ctx('TA_GUARDIAN_E_MATH');
  const form = (data: Record<string, string>) => {
    const values = new FormData();
    for (const [k, v] of Object.entries(data)) values.set(k, v);
    return values;
  };
  const registration = form({
    action: 'register',
    mode: 'photo_solution',
    approved: 'yes',
    rights_basis: '가상 자체 제작',
    class_id: 'TA_E_MATH',
    subject: 'MATH',
    title: '일차방정식',
    question_pages: '1-2',
    request_key: newId('request'),
  });
  const target = async (ctx: typeof teacher, path: string) =>
    gradingModule.render({ ...ctx, url: new URL(path, ctx.url) });
  assert.match(
    await target(teacher, '/grading?view=register'),
    /교재로 과제 만들기/,
  );
  // 새 과제 등록 화면은 AI가 문제를 푸는 과제를 더 만들지 않는다.
  assert.doesNotMatch(
    await target(teacher, '/grading?view=register'),
    /AI 풀이로 채점할 과제/,
  );
  registration.set('question_pages', '1-2\n2-3');
  await assert.rejects(
    async () => gradingModule.submit!(teacher, registration),
    /중복/,
  );
  registration.set('question_pages', '1-2');
  const loc = (await gradingModule.submit!(teacher, registration)) as string;
  const aid = new URL(loc, teacher.url).searchParams.get('assignment')!;
  const defs = assignmentFor(f.db, teacher.actor.academyId, aid, 1).items;
  assert.ok(
    defs.every((d) => d.grading_mode === 'photo_solution' && d.key === null),
  );
  const upload = form({
    action: 'upload',
    assignment: aid,
    student: 'TA_STU_001',
    pages: '1',
    request_key: newId('request'),
  });
  upload.set(
    'photos',
    new Blob([new Uint8Array(photo().bytes)], { type: 'image/png' }),
    '숙제.png',
  );
  const link = (await gradingModule.submit!(student, upload)) as string;
  const id = new URL(link, teacher.url).searchParams.get('submission')!;
  let draft = await f.service.draft(teacher, id);
  assert.deepEqual(
    draft.items.map((i) => i.proposed.outcome),
    ['incorrect', 'ungradable'],
  );
  assert.equal(draft.items[1].proposed.exclusion_reason, 'PROBLEM_UNRESOLVED');
  assert.match(await target(teacher, link), /AI가 푼 답/);
  assert.doesNotMatch(await target(guardian, link), /양변에서|AI가 푼 답/);
  await assert.rejects(
    f.service.confirm(teacher, id, 1, newId('request')),
    /TEACHER_REVIEW_REQUIRED/,
  );
  const second = defs[1];
  const full = aggregate(
    second,
    second.criteria.map((c) => ({
      criterion_id: c.criterion_id,
      max_score: c.max_score,
      score: c.max_score,
    })),
  );
  await assert.rejects(
    f.service.patch(teacher, id, 1, [
      draft.items[0],
      {
        ...draft.items[1],
        reviewed: true,
        proposed: full,
        solution: reference,
      },
    ]),
    /REVIEW_REFERENCE_REQUIRED/,
  );
  const review = form({ action: 'review', revision: '1', submission: id });
  for (let n = 0; n < 2; n++) {
    for (const [k, v] of Object.entries({
      answer: n ? '4' : '5',
      answer_status: 'readable',
      located: 'yes',
      reviewed: 'yes',
      outcome: n ? 'correct' : 'incorrect',
      score_0: n ? '1' : '0',
      reference: n ? '4' : '',
    }))
      review.set('r' + n + '_' + k, v);
  }
  await gradingModule.submit!(teacher, review);
  draft = await f.service.draft(teacher, id);
  assert.equal(draft.items[0].solution?.answer, '4');
  assert.equal(draft.items[1].review_reference, '4');
  assert.equal(draft.items[1].initial_proposal?.outcome, 'ungradable');
  const result = await f.service.confirm(
    teacher,
    id,
    draft.draft_revision,
    newId('request'),
  );
  await f.service.purge(id);
  const published = f.service.result(guardian, result.result_set_id);
  assert.deepEqual(
    published.items.map((i) => i.score),
    ['0', '1'],
  );
  assert.doesNotMatch(
    JSON.stringify(published),
    /양변에서|3x|review_reference|answer_observed/,
  );
  assert.throws(() =>
    f.service.result(f.ctx('TA_GUARDIAN_M2'), result.result_set_id),
  );
});

test('independent comparison handles equivalent values, single choices, blank, ambiguous writing and criteria', async () => {
  const def = item('MATH', { grading_mode: 'photo_solution', key: null });
  let calls = 0;
  const provider: GradeProvider = {
    modelId: 'fixture',
    inputAllowed: true,
    read: async () => [],
    semantic: async (d, r) => {
      calls++;
      assert.ok(
        d.criteria[0].teacher_instruction.includes(reference.explanation),
      );
      assert.equal(r.unit_observed, 'cm');
      return d.criteria.map((c) => ({
        criterion_id: c.criterion_id,
        max_score: c.max_score,
        score: '1',
      }));
    },
  };
  const run = (
    answer: string,
    ref: PhotoSolution = reference,
    extra: Partial<ReturnType<typeof reading>> = {},
  ) => comparePhotoAnswer(def, reading(def, answer, extra), ref, provider);
  assert.equal((await run('8/2')).outcome, 'correct');
  assert.equal(
    (await run('②', { ...reference, comparison: 'choice', answer: '2' }))
      .outcome,
    'correct',
  );
  assert.equal(
    (await run('', reference, { answer_status: 'blank' })).outcome,
    'blank',
  );
  assert.equal(
    (await run('4', reference, { answer_status: 'ambiguous' })).score,
    null,
  );
  assert.equal(
    (await run('4', reference, { unit_observed: 'cm' })).outcome,
    'partial',
  );
  assert.equal(calls, 1);
});

test('direct computation requires agreement on the same standalone printed calculation', () => {
  assert.equal(solveVerifiedCalculation('3 × 3 =', '3*3')?.answer, '9');
  assert.equal(solveVerifiedCalculation('14−5', '14 - 5')?.answer, '9');
  assert.equal(solveVerifiedCalculation('14-5', '10-1'), undefined);
  assert.equal(solveVerifiedCalculation('1 2 + 3', '12+3'), undefined);
  assert.equal(solveVerifiedCalculation('7+5 cm', '7+5 cm'), undefined);
});
