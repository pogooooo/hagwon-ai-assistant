import { photoReportStats } from './report-adapter.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { solveVerifiedCalculation } from './photo-solution.ts';
import { fixture, photo, reading } from './test-fixtures.ts';
import { gradingModule } from './module.ts';
import {
  assignmentFor,
  newId,
  readSubmission,
  submissionAssignment,
} from './service.ts';
import { type PrintedPage } from './assigned-work.ts';
import { createNaverGrader, type GradeProvider } from './provider.ts';

for (const material of ['workbook', 'worksheet']) {
  test(
    material + ' assignment → student photos → scoped items → reviewed result',
    async (t) => {
      let page: PrintedPage = { printedPage: 42, numbers: [3, 7] };
      const provider: GradeProvider = {
        modelId: 'fixture',
        inputAllowed: true,
        async discoverPage() {
          return page;
        },
        async read(_, a) {
          return a.items.map((i) => reading(i, '4'));
        },
        async solvePage(_, items) {
          return new Map(
            items.map((i) => [
              i.item_ref,
              {
                problem: '2+2',
                answer: '4',
                explanation: '합은 4',
                comparison: 'number' as const,
              },
            ]),
          );
        },
      };
      const f = fixture(t, { provider });
      const teacher = f.ctx('TA_TEACHER');
      const form = new FormData();
      for (const [k, v] of Object.entries({
        action: 'register',
        request_key: newId('request'),
        material,
        material_name: '가상 연습',
        subject: 'MATH',
        class_id: 'TA_E_MATH',
        rights_basis: '자체 제작',
        approved: 'yes',
        page_from: '42',
        page_to: '45',
      }))
        form.set(k, v);
      const next = String(await gradingModule.submit!(teacher, form));
      const id = new URL(next, teacher.url).searchParams.get('assignment')!;
      const a = { assignment_id: id, assignment_version: 1 };
      assert.equal(
        assignmentFor(f.db, teacher.actor.academyId, id, 1).items.length,
        0,
      );
      const student = f.ctx('TA_STUDENT_001');
      const uploadForm = await gradingModule.render({
        ...student,
        url: new URL('/grading?view=upload&assignment=' + id, student.url),
      });
      assert.match(
        uploadForm,
        material === 'workbook' ? /42–45쪽/ : /가상 연습/,
      );
      assert.doesNotMatch(uploadForm, /· 0문항/);
      const first = await f.upload(a);
      const defs = () =>
        submissionAssignment(f.db, readSubmission(teacher, first)).items;
      assert.deepEqual(
        defs().map((i) => i.item_no),
        ['3', '7'],
      );
      const r = await f.confirm(first);
      assert.equal(f.service.result(student, r.result_set_id).items.length, 2);
      page = { printedPage: 43, numbers: [9] };
      const second = await f.upload(a);
      assert.deepEqual(
        submissionAssignment(f.db, readSubmission(teacher, second)).items.map(
          (i) => i.item_no,
        ),
        ['9'],
      );
      assert.deepEqual(
        defs().map((i) => i.item_no),
        ['3', '7'],
      );
      const stats = () =>
        photoReportStats(
          f.db,
          teacher.actor.academyId,
          'TA_STU_001',
          'TA_E_MATH',
          '2026-11',
        );
      await f.confirm(second);
      assert.equal(stats().total, material === 'workbook' ? 3 : 1);
      if (material === 'workbook') {
        page = { printedPage: 42, numbers: [3, 7] };
        const retry = await f.upload(a);
        assert.equal(stats().total, 1);
        assert.equal(stats().unknown, 2);
        await f.confirm(retry);
        assert.equal(stats().total, 3);
      }
      page =
        material === 'workbook'
          ? { printedPage: 77, numbers: [1] }
          : { printedPage: null, numbers: [2, 2] };
      const bad = await f.upload(a);
      const draft = await f.service.draft(teacher, bad);
      assert.equal(draft.items.length, 0);
      await assert.rejects(
        f.service.confirm(teacher, bad, draft.draft_revision, newId('request')),
        /TEACHER_REVIEW_REQUIRED/,
      );
      await assert.rejects(
        f.service.correctPhotoMap(student, bad, draft.draft_revision, [
          { printedPage: 42, numbers: [1] },
        ]),
      );
      await f.service.correctPhotoMap(teacher, bad, draft.draft_revision, [
        { printedPage: 42, numbers: [1] },
      ]);
      assert.equal((await f.service.draft(teacher, bad)).items.length, 1);
    },
  );
}

test('CLOVA page discovery reads the printed page and requires a complete numbered manifest', async () => {
  const page = { ...photo(), page_no: 1 };
  for (const [content, valid] of [
    ['{printedPage: 42, numbers: [7], complete: true}', true],
    ['{"printedPage":42,"numbers":[7],"complete":true}', true],
    ['[7]', false],
    ['{"printedPage":42,"numbers":[7],"complete":false}', false],
  ] as const) {
    const provider = createNaverGrader(
      {
        RAG_CLOVA_API_KEY: 'fixture',
        AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
        AXR_GRADING_INPUT_POLICY_REF: 'fixture',
      },
      undefined,
      async () => Response.json({ result: { message: { content } } }),
    );
    const result = provider.discoverPage!(page);
    if (valid)
      assert.deepEqual(await result, {
        printedPage: 42,
        numbers: [7],
        complete: true,
      });
    else await assert.rejects(result, /PHOTO_SCOPE_UNCLEAR/);
  }
});

for (const direct of [false, true])
  test(
    direct
      ? 'a worksheet with matching printed expressions only needs two vision calls'
      : 'one worksheet photo binds several answers by number and reads missing items again',
    async (t) => {
      const calls: string[] = [];
      const boxes = [
        [0.1, 0.15, 0.35, 0.25],
        [0.1, 0.4, 0.35, 0.5],
        [0.1, 0.65, 0.35, 0.75],
      ];
      const numbers = ['2', '5', '8'];
      const answers = ['12', '7', '9'];
      const expressions = ['Calculate 7 + 5.', '계산하세요: 14 − 5', '3 × 3 ='];
      const provider = createNaverGrader(
        {
          CLOVA_STUDIO_API_KEY: 'fixture',
          AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
          AXR_GRADING_INPUT_POLICY_REF: 'fixture',
        },
        undefined,
        async (url, init) => {
          assert.match(String(url), /HCX-005$/);
          const request = JSON.parse(String(init?.body));
          const data = JSON.parse(request.messages[1].content[1].text);
          let content: unknown;
          if (data.format) {
            const exact = data.verifyNumbers !== undefined;
            calls.push(exact ? 'verify' : 'discovery');
            if (exact) assert.deepEqual(data.verifyNumbers, numbers);
            const equations = exact
              ? ['6 + 6', '14 - 5', '3*3']
              : ['6+6', '14−5', '3×3'];
            content = {
              printedPage: null,
              complete: true,
              numbers,
              readings: (exact || direct ? [2, 0, 1] : [2, 0, 2]).map((i) => ({
                number: numbers[i],
                answer_observed: exact ? Number(answers[i]) : answers[i],
                answer_status: 'readable',
                ...(direct ? { printed_calculation: equations[i] } : {}),
                ...(!exact ? { bbox: boxes[i] } : {}),
              })),
            };
          } else if (data.manifest[0]?.ref) {
            calls.push('printed');
            content = {
              items: data.manifest.map(
                ({ ref, no }: { ref: string; no: string }) => ({
                  ref,
                  no,
                  complete: true,
                  problem: expressions[numbers.indexOf(no)],
                }),
              ),
            };
          } else {
            calls.push('missing');
            assert.deepEqual(
              data.manifest.map(({ item_no }: { item_no: string }) => item_no),
              ['5', '8'],
            );
            content = data.manifest.map(
              ({
                item_ref,
                item_no,
              }: {
                item_ref: string;
                item_no: string;
              }) => {
                const i = numbers.indexOf(item_no);
                return {
                  item_ref,
                  answer_observed: answers[i],
                  unit_observed: '',
                  answer_status: 'readable',
                  association_status: 'matched',
                  regions: [{ page_no: 1, bbox: boxes[i] }],
                  ambiguity_codes: [],
                };
              },
            );
          }
          return Response.json({
            result: { message: { content: JSON.stringify(content) } },
          });
        },
      );
      const f = fixture(t, {
        provider: { ...provider, readWorksheetPrint: undefined },
      });
      const a = f.service.register(
        f.ctx(),
        {
          title: '한 장에 여러 문항',
          class_id: 'TA_E_MATH',
          rights_ref: 'rights_synthetic',
          scope: { kind: 'worksheet', subject: 'MATH', skill: '계산' },
          items: [],
        },
        newId('request'),
      );
      const id = await f.upload(a);
      const draft = await f.service.draft(f.ctx(), id);
      assert.deepEqual(
        calls,
        direct
          ? ['discovery', 'verify']
          : ['discovery', 'missing', 'verify', 'printed'],
      );
      assert.deepEqual(
        draft.items.map((entry) => entry.extraction.answer_observed),
        answers,
      );
      assert.deepEqual(
        draft.items.map((entry) => entry.proposed.outcome),
        direct
          ? ['correct', 'incorrect', 'correct']
          : ['ungradable', 'ungradable', 'ungradable'],
      );
      assert.deepEqual(
        draft.items.map((entry) => entry.solution?.answer),
        direct ? ['12', '9', '9'] : [undefined, undefined, undefined],
      );
    },
  );

test('worksheet grading uses actual labels, print agreement and a separate handwriting check', async (t) => {
  const passes: string[] = [];
  const numbers = ['2', '5', '8'];
  const observed = ['24', '8', '12'];
  const provider = createNaverGrader(
    {
      CLOVA_STUDIO_API_KEY: 'fixture',
      AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
      AXR_GRADING_INPUT_POLICY_REF: 'fixture',
    },
    undefined,
    async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const data = JSON.parse(request.messages[1].content[1].text);
      let content;
      if (data.example) {
        passes.push('print');
        content = [
          { number: '2.', expression: 'Calculate 4 x 6.' },
          { number: '5번', expression: '15 - 4' },
          { number: '8)', expression: passes.length === 1 ? '8 + 4' : '9 + 3' },
          { number: 3, expression: '17 + 2' },
          { number: 3 },
        ];
      } else if (data.verifyNumbers) {
        passes.push('verify');
        assert.deepEqual(data.verifyNumbers, numbers);
        content = {
          printedPage: null,
          numbers,
          complete: true,
          readings: numbers.map((number, index) => ({
            number,
            answer_observed: ['24', 'II', '12'][index],
            answer_status: index === 0 ? 'incorrect' : 'correct',
          })),
        };
      } else {
        passes.push('read');
        content = data.manifest.map(
          ({ item_ref }: { item_ref: string }, index: number) => ({
            item_ref,
            answer_observed: observed[index],
            unit_observed: '',
            answer_status: 'readable',
            association_status: 'matched',
            ambiguity_codes: [],
            regions: [{ page_no: 1, bbox: [0.1, 0.1, 0.3, 0.2] }],
          }),
        );
      }
      return Response.json({
        result: { message: { content: JSON.stringify(content) } },
      });
    },
  );
  const f = fixture(t, { provider });
  const assignment = f.service.register(
    f.ctx(),
    {
      title: '번호가 연속되지 않은 계산 학습지',
      class_id: 'TA_E_MATH',
      rights_ref: 'rights_synthetic',
      scope: { kind: 'worksheet', subject: 'MATH', skill: '계산' },
      items: [],
    },
    newId('request'),
  );
  const student = f.ctx('TA_STUDENT_001');
  const { submission_id } = f.service.create(
    student,
    { ...assignment, student_ref: 'TA_STU_001', expected_page_count: 1 },
    newId('request'),
  );
  const canvas = createCanvas(600, 800);
  await f.service.upload(student, submission_id, [
    { bytes: new Uint8Array(canvas.toBuffer('image/png')), mime: 'image/png' },
  ]);
  await f.service.process(student, submission_id);
  const draft = await f.service.draft(f.ctx(), submission_id);
  assert.deepEqual(passes, ['print', 'print', 'print', 'read', 'verify']);
  assert.deepEqual(
    draft.items.map((item) => item.proposed.outcome),
    ['correct', 'ungradable', 'ungradable'],
  );
  assert.deepEqual(
    draft.items.map((item) => item.solution?.answer),
    ['24', '11', undefined],
  );
  assert.ok(
    draft.items[1].extraction.ambiguity_codes.includes('MODEL_DISAGREEMENT'),
  );
});

test('printed calculation agreement preserves decimals, notation and operands', () => {
  assert.equal(
    solveVerifiedCalculation('Calculate 4 x 6.', '4 × 6 = ?')?.answer,
    '24',
  );
  assert.equal(
    solveVerifiedCalculation('1.25 + 3.5', '1.25+3.5')?.answer,
    '19/4',
  );
  assert.equal(solveVerifiedCalculation('8+4', '9+3'), undefined);
  assert.equal(solveVerifiedCalculation('2. 18 + 1', '2.18+1'), undefined);
  assert.equal(solveVerifiedCalculation('1² + 4', '1² + 4'), undefined);
});
