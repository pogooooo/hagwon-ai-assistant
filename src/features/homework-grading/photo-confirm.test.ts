import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { homeworkModule } from '../academy-operations/homework.ts';
import { fixture } from './test-fixtures.ts';
import { gradingModule } from './module.ts';
import { assignmentFor, newId, readSubmission } from './service.ts';
import type { GradeProvider } from './provider.ts';
import type { OcrLayout } from './ocr.ts';

function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values))
    for (const value of [v].flat()) data.append(k, value);
  return data;
}

/** 보기 기호 다섯 개를 한 줄에 그리고, markX가 있으면 그 자리에 펜 표시를 그린 쪽 사진. */
function sheet(markX?: number, tone = '#fff') {
  const canvas = createCanvas(300, 200),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, 300, 200);
  ctx.fillStyle = '#111';
  for (const x of [20, 70, 120, 170, 220]) ctx.fillRect(x + 3, 103, 4, 4);
  if (markX !== undefined) {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(markX - 2, 95);
    ctx.lineTo(markX + 4, 108);
    ctx.lineTo(markX + 14, 90);
    ctx.stroke();
  }
  return {
    bytes: new Uint8Array(canvas.toBuffer('image/png')),
    mime: 'image/png',
  };
}
const row = (unread: number[], y = 100) => ({
  width: 10,
  height: 10,
  positions: [20, 70, 120, 170, 220].map((x, i) => ({
    choice: i + 1,
    x,
    y,
  })),
  unread,
});

test('workbook photos are matched to book pages, prefill marked choices, and are confirmed by the student', async (t) => {
  // 학생은 11쪽 사진을 먼저, 10쪽 사진을 나중에 올린다. 10쪽 1번에는 ③에 펜 표시가 있다.
  const page11 = sheet(undefined, '#fefefe');
  const page10 = sheet(120);
  const layouts = new Map<number, OcrLayout>([
    [
      11,
      {
        // 쪽수를 못 읽은 사진은 찾은 문항 번호(3번)로 11쪽에 맞춘다.
        printedPage: null,
        numbers: [3],
        regions: new Map([[3, [0, 0, 1, 1]]]),
        choices: new Map(),
      },
    ],
    [
      10,
      {
        printedPage: 10,
        numbers: [1, 2],
        regions: new Map([
          [1, [0, 0, 1, 0.5]],
          [2, [0, 0.5, 1, 1]],
        ]),
        // 2번은 보기 배치는 찾았지만 표시가 없다.
        choices: new Map([
          [1, row([3])],
          [2, row([], 160)],
        ]),
      },
    ],
  ]);
  let read = 0;
  const provider: GradeProvider = {
    modelId: 'fixture',
    inputAllowed: true,
    async locateItems(page) {
      read++;
      // 사진 내용으로 어느 쪽인지 구분한다(10쪽만 펜 표시가 있다).
      return layouts.get(page.bytes.length === page10.bytes.length ? 10 : 11)!;
    },
    async read() {
      throw new Error('workbook photos must not be read by AI');
    },
    async solvePage() {
      throw new Error('workbook photos must not be solved by AI');
    },
  };
  const f = fixture(t, { provider });
  homeworkModule.setup(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const book = String(
    await gradingModule.submit!(
      teacher,
      form({ action: 'register-book', subject: 'M', book: '사진 확인 교재' }),
    ),
  );
  const assigned = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'assign-workbook',
        request_key: newId('request'),
        subject: 'M',
        bookId: new URL(book, teacher.url).searchParams.get('book')!,
        items: JSON.stringify([
          { page: 10, number: '1', tagIds: [], answer: '③' },
          { page: 10, number: '2', tagIds: [], answer: '②' },
          { page: 11, number: '3', tagIds: [], answer: 'x+3' },
        ]),
        title: '사진 확인 과제',
        classId: 'TA_E_MATH',
        rights_basis: '직접 만든 자료',
        approved: 'yes',
      }),
    ),
  );
  const id = new URL(assigned, teacher.url).searchParams.get('assignment')!;
  const a = assignmentFor(f.db, teacher.actor.academyId, id, 1);
  const student = f.ctx('TA_STUDENT_001');
  const upload = form({
    action: 'upload',
    request_key: newId('request'),
    assignment: id,
  });
  for (const photo of [page11, page10])
    upload.append(
      'photos',
      new File([Buffer.from(photo.bytes)], 'page.png', { type: 'image/png' }),
    );
  const next = String(await gradingModule.submit!(student, upload));
  assert.match(next, /view=confirm/);
  assert.equal(read, 2);
  const submission = new URL(next, student.url).searchParams.get('submission')!;
  // 사진 순서가 책 쪽 순서로 바뀐다: 1번 사진이 10쪽.
  const first = await f.service.photo(teacher, submission, 1);
  assert.equal(first.bytes.length, page10.bytes.length);
  const confirm = await gradingModule.render({
    ...student,
    url: new URL(next, student.url),
  });
  assert.match(confirm, /사진에서 ③\(으\)로 읽었습니다/);
  assert.match(confirm, /value="③" checked/);
  assert.match(confirm, /사진에서 읽지 못했습니다/);
  await gradingModule.submit!(
    student,
    form({
      action: 'answer',
      request_key: newId('request'),
      submission,
      ['ans_' + a.items[0].item_ref]: '③',
      ['ans_' + a.items[1].item_ref]: '④',
      ['ans_' + a.items[2].item_ref]: 'x+3',
    }),
  );
  const draft = await f.service.draft(teacher, submission);
  assert.deepEqual(
    a.items.map((item) => {
      const d = draft.items.find(
        (x) => x.extraction.item_ref === item.item_ref,
      )!;
      return [d.extraction.source, d.proposed.outcome];
    }),
    [
      ['photo', 'correct'],
      ['typed', 'incorrect'],
      ['typed', 'correct'],
    ],
  );
  // 사진은 검수 화면에서 볼 수 있게 남는다.
  assert.equal(readSubmission(teacher, submission, true).expected_pages, 2);
  const review = await gradingModule.render({
    ...teacher,
    url: new URL('/grading?submission=' + submission, teacher.url),
  });
  assert.match(review, /사진에서 읽은 답 · 학생 확인/);
  // 정답 비교로 채점했으므로 AI 초안이 아니라 자동 채점으로 표시하고, 못 읽은 문항을 먼저 알린다.
  assert.match(review, /자동 채점 · 정답/);
  assert.doesNotMatch(review, /AI 초안/);
  assert.match(review, /사진에서 못 읽은 문항 10쪽 2번, 11쪽 3번/);
  assert.match(review, /class="grade-attention"/);
});

test('a student who changes a photo-read answer is flagged for the teacher', async (t) => {
  const marked = sheet(120);
  const provider: GradeProvider = {
    modelId: 'fixture',
    inputAllowed: true,
    async locateItems() {
      return {
        printedPage: 5,
        numbers: [1],
        regions: new Map([[1, [0, 0, 1, 1]]]),
        choices: new Map([[1, row([3])]]),
      };
    },
    async read() {
      throw new Error('workbook photos must not be read by AI');
    },
  };
  const f = fixture(t, { provider });
  homeworkModule.setup(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const book = String(
    await gradingModule.submit!(
      teacher,
      form({ action: 'register-book', subject: 'M', book: '수정 확인 교재' }),
    ),
  );
  const assigned = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'assign-workbook',
        request_key: newId('request'),
        subject: 'M',
        bookId: new URL(book, teacher.url).searchParams.get('book')!,
        items: JSON.stringify([
          { page: 5, number: '1', tagIds: [], answer: '②' },
        ]),
        title: '수정 확인 과제',
        classId: 'TA_E_MATH',
        rights_basis: '직접 만든 자료',
        approved: 'yes',
      }),
    ),
  );
  const id = new URL(assigned, teacher.url).searchParams.get('assignment')!;
  const a = assignmentFor(f.db, teacher.actor.academyId, id, 1);
  const student = f.ctx('TA_STUDENT_001');
  const upload = form({
    action: 'upload',
    request_key: newId('request'),
    assignment: id,
  });
  upload.append(
    'photos',
    new File([Buffer.from(marked.bytes)], 'page.png', { type: 'image/png' }),
  );
  const next = String(await gradingModule.submit!(student, upload));
  const submission = new URL(next, student.url).searchParams.get('submission')!;
  await gradingModule.submit!(
    student,
    form({
      action: 'answer',
      request_key: newId('request'),
      submission,
      ['ans_' + a.items[0].item_ref]: '②',
    }),
  );
  const draft = await f.service.draft(teacher, submission);
  assert.equal(draft.items[0].extraction.source, 'photo_edited');
  assert.equal(draft.items[0].proposed.outcome, 'correct');
  assert.match(
    await gradingModule.render({
      ...teacher,
      url: new URL('/grading?submission=' + submission, teacher.url),
    }),
    /학생이 고친 답 · 사진에서 읽은 답과 다름/,
  );
  assert.match(
    await gradingModule.render({
      ...teacher,
      url: new URL('/grading?submission=' + submission, teacher.url),
    }),
    /학생이 고친 문항 5쪽 1번/,
  );
});

test('teachers can confirm several checked workbook submissions at once', async (t) => {
  const marked = sheet(120);
  const provider: GradeProvider = {
    modelId: 'fixture',
    inputAllowed: true,
    async locateItems() {
      return {
        printedPage: 5,
        numbers: [1],
        regions: new Map([[1, [0, 0, 1, 1]]]),
        choices: new Map([[1, row([3])]]),
      };
    },
    async read() {
      throw new Error('workbook photos must not be read by AI');
    },
  };
  const f = fixture(t, { provider });
  homeworkModule.setup(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const book = String(
    await gradingModule.submit!(
      teacher,
      form({ action: 'register-book', subject: 'M', book: '일괄 확정 교재' }),
    ),
  );
  const assigned = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'assign-workbook',
        request_key: newId('request'),
        subject: 'M',
        bookId: new URL(book, teacher.url).searchParams.get('book')!,
        items: JSON.stringify([
          { page: 5, number: '1', tagIds: [], answer: '③' },
        ]),
        title: '일괄 확정 과제',
        classId: 'TA_E_MATH',
        rights_basis: '직접 만든 자료',
        approved: 'yes',
      }),
    ),
  );
  const id = new URL(assigned, teacher.url).searchParams.get('assignment')!;
  const a = assignmentFor(f.db, teacher.actor.academyId, id, 1);
  const submissions: string[] = [];
  // 같은 학생이 두 번 제출한다(교사 대리 제출).
  for (let n = 0; n < 2; n++) {
    const upload = form({
      action: 'upload',
      request_key: newId('request'),
      assignment: id,
      student: 'TA_STU_001',
    });
    upload.append(
      'photos',
      new File([Buffer.from(marked.bytes)], 'page.png', { type: 'image/png' }),
    );
    const next = String(await gradingModule.submit!(teacher, upload));
    const submission = new URL(next, teacher.url).searchParams.get(
      'submission',
    )!;
    await gradingModule.submit!(
      teacher,
      form({
        action: 'answer',
        request_key: newId('request'),
        submission,
        ['ans_' + a.items[0].item_ref]: '③',
      }),
    );
    submissions.push(submission);
  }
  const queue = await gradingModule.render({
    ...teacher,
    url: new URL('/grading?queue=review', teacher.url),
  });
  assert.match(queue, /name="submissions"/);
  assert.match(queue, /선택한 제출 확정/);
  await assert.rejects(
    async () =>
      gradingModule.submit!(
        teacher,
        form({
          action: 'confirm_many',
          request_key: newId('request'),
          submissions,
        }),
      ),
    /확인 항목/,
  );
  const done = String(
    await gradingModule.submit!(
      teacher,
      form({
        action: 'confirm_many',
        request_key: newId('request'),
        review_complete: 'yes',
        submissions,
      }),
    ),
  );
  assert.match(done, /confirmed=2&skipped=0/);
  for (const submission of submissions)
    assert.equal(readSubmission(teacher, submission, true).current_revision, 1);
  // 학생은 일괄 확정을 쓸 수 없다.
  await assert.rejects(async () =>
    gradingModule.submit!(
      f.ctx('TA_STUDENT_001'),
      form({
        action: 'confirm_many',
        request_key: newId('request'),
        review_complete: 'yes',
        submissions,
      }),
    ),
  );
});
