import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeworkModule } from '../academy-operations/homework.ts';
import { fixture, photo } from './test-fixtures.ts';
import { gradingModule } from './module.ts';
import {
  assignmentFor,
  newId,
  readSubmission,
  submissionAssignment,
} from './service.ts';
import { keyFromAnswer } from './workbook-assign.ts';
import type { GradeProvider } from './provider.ts';

test('teacher answers become deterministic keys', () => {
  assert.deepEqual(keyFromAnswer('3', true).key.accepted_choice_sets, [['3']]);
  assert.equal(keyFromAnswer('3', false).answer_type, 'numeric');
  assert.equal(keyFromAnswer('3번', false).answer_type, 'numeric');
  assert.throws(() => keyFromAnswer('10', true));
  assert.throws(() => keyFromAnswer('3|', true));
  assert.deepEqual(keyFromAnswer('③').key.accepted_choice_sets, [['3']]);
  assert.equal(keyFromAnswer('③').answer_type, 'choice_single');
  assert.deepEqual(keyFromAnswer('② | ④').key.accepted_choice_sets, [
    ['2'],
    ['4'],
  ]);
  const quantity = keyFromAnswer('5/6 L');
  assert.equal(quantity.answer_type, 'numeric');
  assert.equal(quantity.key.numeric_target, '5/6');
  assert.deepEqual(quantity.key.accepted_units, ['L']);
  const text = keyFromAnswer("Let's meet on Saturday.|Let's meet Saturday.");
  assert.equal(text.answer_type, 'text_exact');
  assert.equal(text.key.accepted_texts.length, 2);
  assert.equal(text.key.normalization.case_sensitive, false);
  assert.throws(() => keyFromAnswer(' | '), /EMPTY_KEY/);
});

function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values))
    for (const value of [v].flat()) data.append(k, value);
  return data;
}

test('a workbook assignment keeps page, representative type and answer, and grades without AI', async (t) => {
  const readings = new Map<string, [string, string]>([
    ['1', ['③', '']],
    ['2', ['5/6', 'L']],
    ['3', ['x+2', '']],
  ]);
  const provider: GradeProvider = {
    modelId: 'fixture',
    inputAllowed: true,
    async read(_pages, a) {
      return a.items.map((i) => ({
        item_ref: i.item_ref,
        answer_observed: readings.get(i.item_no)![0],
        unit_observed: readings.get(i.item_no)![1],
        answer_status: 'readable' as const,
        association_status: 'matched' as const,
        regions: [{ page_no: i.expected_page_no, bbox: [0.1, 0.1, 0.3, 0.2] }],
        ambiguity_codes: [],
      }));
    },
    async solvePage() {
      throw new Error('registered answers must not be solved by AI');
    },
  };
  const f = fixture(t, { provider });
  homeworkModule.setup(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const next = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'register-book',
        subject: 'M',
        book: '가상 수학 교재',
        grade: '고2',
      }),
    ),
  );
  const bookId = new URL(next, teacher.url).searchParams.get('book')!;
  assert.match(next, /^\/grading\?view=register&book=/);
  const register = await gradingModule.render({
    ...teacher,
    url: new URL(next, teacher.url),
  });
  assert.match(register, /data-require-answer="1"/);
  assert.match(register, /data-answer/);
  const items = [
    { page: 43, number: '3', tagIds: [], answer: 'x+3' },
    {
      page: 42,
      number: '1',
      tagIds: ['math-03', 'math-01'],
      answer: '3',
      isChoice: true,
    },
    { page: 43, number: '2', tagIds: ['math-02'], answer: '5/6 L' },
  ];
  const assigned = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'assign-workbook',
        request_key: newId('request'),
        subject: 'M',
        bookId,
        items: JSON.stringify(items),
        title: '가상 교재 42~43쪽',
        classId: 'TA_E_MATH',
        rights_basis: '직접 만든 자료',
        approved: 'yes',
      }),
    ),
  );
  const id = new URL(assigned, teacher.url).searchParams.get('assignment')!;
  const a = assignmentFor(f.db, teacher.actor.academyId, id, 1);
  assert.deepEqual(
    a.items.map((i) => [
      i.book_page,
      i.item_no,
      i.expected_page_no,
      i.answer_type,
    ]),
    [
      [42, '1', 1, 'choice_single'],
      [43, '2', 2, 'numeric'],
      [43, '3', 2, 'text_exact'],
    ],
  );
  // 처음 고른 유형이 대표 유형이다.
  assert.equal(a.items[0].primary_skill_id, 'math-03');
  assert.equal(a.items[0].skill_label, '이해 · 수학적 표현 해석');
  assert.match(a.items[2].skill_label, /유형 미지정/);
  // 공용 교재 목록에 정답이 저장된다.
  assert.deepEqual(
    f.db
      .prepare(
        'SELECT page,number,answer,is_choice FROM book_questions WHERE book_id=? ORDER BY page,number',
      )
      .all(bookId)
      .map((r) => [r.page, r.number, r.answer, r.is_choice]),
    [
      [42, '1', '3', 1],
      [43, '2', '5/6 L', null],
      [43, '3', 'x+3', null],
    ],
  );
  const input = f.service.create(
    teacher,
    {
      assignment_id: id,
      assignment_version: 1,
      student_ref: 'TA_STU_001',
      expected_page_count: 2,
    },
    newId('request'),
  );
  await f.service.upload(teacher, input.submission_id, [photo(), photo()]);
  await f.service.process(teacher, input.submission_id);
  const defs = submissionAssignment(
    f.db,
    readSubmission(teacher, input.submission_id),
  ).items;
  const draft = await f.service.draft(teacher, input.submission_id);
  assert.deepEqual(
    defs.map(
      (d) =>
        draft.items.find((x) => x.extraction.item_ref === d.item_ref)!.proposed
          .outcome,
    ),
    ['correct', 'correct', 'incorrect'],
  );
});

test('workbook assignments require an answer for every item and an assigned class', async (t) => {
  const f = fixture(t);
  homeworkModule.setup(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const next = String(
    await gradingModule.submit!(
      teacher,
      form({ action: 'register-book', subject: 'M', book: '정답 확인 교재' }),
    ),
  );
  const bookId = new URL(next, teacher.url).searchParams.get('book')!;
  const base = {
    action: 'assign-workbook',
    subject: 'M',
    bookId,
    title: '정답 확인',
    rights_basis: '직접 만든 자료',
    approved: 'yes',
  };
  await assert.rejects(
    async () =>
      gradingModule.submit!(
        teacher,
        form({
          ...base,
          request_key: newId('request'),
          classId: 'TA_E_MATH',
          items: JSON.stringify([
            { page: 1, number: '1', tagIds: [], answer: '' },
          ]),
        }),
      ),
    /입력값을 확인/,
  );
  await assert.rejects(
    async () =>
      gradingModule.submit!(
        teacher,
        form({
          ...base,
          request_key: newId('request'),
          items: JSON.stringify([
            { page: 1, number: '1', tagIds: [], answer: '③' },
          ]),
        }),
      ),
    /입력값을 확인/,
  );
});

async function workbookAssignment(
  f: ReturnType<typeof fixture>,
  items: { page: number; number: string; tagIds: string[]; answer: string }[],
) {
  homeworkModule.setup(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const next = String(
    await gradingModule.submit!(
      teacher,
      form({ action: 'register-book', subject: 'M', book: '직접 입력 교재' }),
    ),
  );
  const bookId = new URL(next, teacher.url).searchParams.get('book')!;
  const assigned = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'assign-workbook',
        request_key: newId('request'),
        subject: 'M',
        bookId,
        items: JSON.stringify(items),
        title: '직접 입력 과제',
        classId: 'TA_E_MATH',
        rights_basis: '직접 만든 자료',
        approved: 'yes',
      }),
    ),
  );
  return new URL(assigned, teacher.url).searchParams.get('assignment')!;
}

test('workbook assignments accept answers only through a photo submission', async (t) => {
  const f = fixture(t);
  const id = await workbookAssignment(f, [
    { page: 10, number: '1', tagIds: ['math-01'], answer: '③' },
  ]);
  const student = f.ctx('TA_STUDENT_001');
  const upload = await gradingModule.render({
    ...student,
    url: new URL('/grading?view=upload&assignment=' + id, student.url),
  });
  // 사진 없이 답만 내는 입력 칸은 없다.
  assert.doesNotMatch(upload, /사진 없이 답 입력하기/);
  assert.doesNotMatch(upload, /type="radio"/);
  await assert.rejects(
    async () =>
      gradingModule.submit!(
        student,
        form({
          action: 'answer',
          request_key: newId('request'),
          assignment: id,
        }),
      ),
    /찾을 수 없|RESOURCE_NOT_FOUND/,
  );
  // 사진을 올리지 않은 제출에는 답을 받지 않는다.
  const input = f.service.create(
    student,
    {
      assignment_id: id,
      assignment_version: 1,
      student_ref: 'TA_STU_001',
      expected_page_count: 1,
    },
    newId('request'),
  );
  const a = assignmentFor(f.db, student.actor.academyId, id, 1);
  await assert.rejects(
    f.service.submitAnswers(student, input.submission_id, {
      [a.items[0].item_ref]: '③',
    }),
    /STATE_CONFLICT/,
  );
});

test('answer confirmation is refused for assignments that still need AI solving', async (t) => {
  const f = fixture(t);
  const teacher = f.ctx('TA_TEACHER');
  const legacy = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'register',
        request_key: newId('request'),
        mode: 'photo_solution',
        title: '이전 방식',
        class_id: 'TA_E_MATH',
        subject: 'MATH',
        question_pages: '1-2',
        rights_basis: '직접 만든 자료',
        approved: 'yes',
      }),
    ),
  );
  const id = new URL(legacy, teacher.url).searchParams.get('assignment')!;
  const student = f.ctx('TA_STUDENT_001');
  assert.doesNotMatch(
    await gradingModule.render({
      ...student,
      url: new URL('/grading?view=upload&assignment=' + id, student.url),
    }),
    /사진 없이 답 입력하기/,
  );
  await assert.rejects(
    async () =>
      gradingModule.submit!(
        student,
        form({
          action: 'answer',
          request_key: newId('request'),
          assignment: id,
        }),
      ),
    /찾을 수 없|RESOURCE_NOT_FOUND/,
  );
});
