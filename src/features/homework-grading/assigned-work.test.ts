import { photoReportStats } from './report-adapter.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
                answer_observed: answers[i],
                answer_status: 'readable',
                ...(direct ? { printed_calculation: equations[i] } : {}),
                bbox: boxes[i],
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
      const f = fixture(t, { provider });
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
        ['correct', 'incorrect', 'correct'],
      );
      assert.deepEqual(
        draft.items.map((entry) => entry.solution?.answer),
        ['12', '9', '9'],
      );
    },
  );
