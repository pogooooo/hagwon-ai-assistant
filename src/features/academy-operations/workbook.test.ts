import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { analyzeHomeworkPhoto, saveWorkbook } from './homework-classifier.ts';
import { getActor, initializeIdentity } from './directory.ts';
import { homeworkModule } from './homework.ts';
import { briefingModule } from './briefing.ts';
import { setupLearning } from './learning.ts';
import { parseClassification } from './classification.ts';

test('두 쪽의 분석 결과와 수기 문항 검수·배정, 학생 오답 제출과 브리핑', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'workbook-test');
  homeworkModule.setup(db);
  setupLearning(db);
  const ctx = (username: string, path = '/homework') => ({
    db,
    actor: getActor(db, username)!,
    url: new URL('http://localhost' + path),
  });
  const teacher = ctx('TA_TEACHER'),
    student = ctx('TA_STUDENT_001');
  const originalKey = process.env.CLOVA_STUDIO_API_KEY;
  process.env.CLOVA_STUDIO_API_KEY = 'test';
  t.after(() => {
    if (originalKey === undefined) delete process.env.CLOVA_STUDIO_API_KEY;
    else process.env.CLOVA_STUDIO_API_KEY = originalKey;
  });
  const text = '식을 간단히 하시오.';
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      let items;
      if (body.messages.length === 1) {
        const cross = body.messages[0].content[1].text.includes('전사 목록');
        items = ['01', '02'].map((displayNumber) =>
          cross
            ? { displayNumber, verdict: '일치', note: '' }
            : { displayNumber, text },
        );
      } else {
        items = JSON.parse(body.messages[1].content).map(
          (i: { itemId: string }) => ({
            itemId: i.itemId,
            disposition: 'assessed',
            reasoning: '식 정리',
            tags: [
              {
                tagId: 'math-01',
                quote: '간단히',
                action: '식 정리',
                reason: '',
                status: 'adopted',
              },
            ],
          }),
        );
      }
      return Response.json({
        result: { message: { content: JSON.stringify({ items }) } },
      });
    },
  );
  const form = (data: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(data)) f.set(k, v);
    return f;
  };
  const photo = form({ subject: 'M', page: '42' });
  photo.set(
    'photo',
    new File(
      [
        readFileSync(
          new URL(
            '../question-classification/examples/math-page-demo.png',
            import.meta.url,
          ),
        ),
      ],
      'page.png',
    ),
  );
  await assert.rejects(analyzeHomeworkPhoto(student, photo), /권한/);
  const first = await analyzeHomeworkPhoto(teacher, photo);
  photo.set('page', '43');
  const second = await analyzeHomeworkPhoto(teacher, photo);
  const id = randomUUID();
  const q = {
    book: '중등 수학',
    segment: '기본',
    type: '식 정리',
    number: '01',
  };
  const reviewed = [
    { ...q, page: 42, sourceId: first[0].sourceId },
    {
      ...q,
      page: 43,
      number: '03',
      type: '교사 수정',
      sourceId: second[1].sourceId,
    },
    { ...q, segment: '심화', page: 42, sourceId: null },
  ];
  const save = form({
    assignmentId: id,
    subject: 'M',
    action: 'save-workbook',
    reviewed: 'yes',
    classId: 'TA_E_MATH',
    date: '2026-01-10',
    title: '교재 숙제',
    items: JSON.stringify([reviewed[0], reviewed[0]]),
  });
  assert.throws(() => saveWorkbook(teacher, save), /중복/);
  assert.equal(
    db.prepare('SELECT count(*) n FROM homework_assignments').get()?.n,
    0,
  );
  save.set('items', JSON.stringify(reviewed));
  assert.equal(saveWorkbook(teacher, save), '/homework?saved=' + id);
  const data = parseClassification(
    JSON.parse(
      String(
        db.prepare('SELECT classification FROM op_learning_assignments').get()
          ?.classification,
      ),
    ),
  );
  assert.deepEqual(
    data.items.map((i) => [
      i.page,
      i.displayNumber,
      i.reviewedType,
      i.tags[0]?.tagId,
    ]),
    [
      [42, '01', '식 정리', 'math-01'],
      [43, '03', '교사 수정', 'math-01'],
      [42, '01', '식 정리', undefined],
    ],
  );
  assert.equal(
    db.prepare('SELECT count(*) n FROM homework_photos').get()?.n,
    0,
  );
  const html = await homeworkModule.render(
    ctx('TA_STUDENT_001', '/homework?assignment=' + id),
  );
  assert.match(html, /심화/);
  assert.match(html, /모두 맞았어요/);
  const report = form({
    assignmentId: id,
    action: 'report',
    wrong: data.items[2].itemId,
    allCorrect: 'yes',
  });
  assert.throws(() => homeworkModule.submit(student, report), /체크/);
  report.delete('allCorrect');
  homeworkModule.submit(student, report);
  assert.throws(() => homeworkModule.submit(student, report), /이미 제출/);
  const briefing = await briefingModule.render(
    ctx('TA_TEACHER', '/briefing?assignment=' + id),
  );
  assert.match(briefing, /66.7%/);
  assert.match(briefing, /학생 제출/);
  assert.match(briefing, /심화/);
  assert.equal(
    db.prepare('SELECT state FROM op_learning_results').get()?.state,
    'draft',
  );
  assert.equal(
    db.prepare('SELECT count(*) n FROM op_learning_publications').get()?.n,
    0,
  );
});
