import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  analyzeHomeworkPhoto,
  reviewHomeworkReading,
} from './homework-classifier.ts';
import { getActor, initializeIdentity } from './directory.ts';
import { homeworkModule } from './homework.ts';
import { briefingModule } from './briefing.ts';
import { setupLearning } from './learning.ts';
import { assignedQuestions } from './workbook-results.ts';

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
  let rejectClassification = false;
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
            : {
                displayNumber,
                printedPage: 42,
                text:
                  displayNumber === '01'
                    ? text
                    : body.messages[0].content[1].text.includes(
                          '작은 글자 검수',
                        )
                      ? 'a³'
                      : 'a²',
              },
        );
      } else {
        if (rejectClassification) return new Response('', { status: 503 });
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
  const photo = form({ subject: 'M' });
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
  const held = second[1];
  assert.equal(held.text, '');
  assert.deepEqual(held.review?.candidates, ['a²', 'a³']);
  assert.match(held.review!.reason, /일치하지 않음/);
  const correction = form({
    subject: 'M',
    sourceId: held.sourceId,
    text: 'a²를 간단히 하시오.',
  });
  await assert.rejects(reviewHomeworkReading(student, correction), /권한/);
  rejectClassification = true;
  await assert.rejects(reviewHomeworkReading(teacher, correction), /다시 시도/);
  rejectClassification = false;
  const corrected = await reviewHomeworkReading(teacher, correction);
  assert.equal(corrected.status, 'classified');
  assert.equal(corrected.text, correction.get('text'));
  assert.equal(first[0].page, 42);
  assert.deepEqual(corrected.tagIds, ['math-01']);
  const id = randomUUID(),
    reviewed = [
      { page: 42, number: '01', tagIds: first[0].tagIds },
      { page: 43, number: '03', tagIds: ['math-02', 'math-01'] },
    ];
  const save = form({
    action: 'assign-workbook',
    assignmentId: id,
    subject: 'M',
    book: '중등 수학',
    grade: '중1',
    targetKind: 'class',
    classId: 'TA_E_MATH',
    date: '2020-01-10',
    title: '교재 숙제',
    items: JSON.stringify([reviewed[0], reviewed[0]]),
  });
  assert.throws(() => homeworkModule.submit(teacher, save), /중복/);
  save.set('items', JSON.stringify([{ ...reviewed[0], tagIds: ['eng-01'] }]));
  assert.throws(() => homeworkModule.submit(teacher, save), /과목/);
  assert.equal(db.prepare('SELECT count(*) n FROM books').get()?.n, 0);
  save.set('items', JSON.stringify(reviewed));
  assert.equal(homeworkModule.submit(teacher, save), '/homework?detail=' + id);
  assert.throws(() => homeworkModule.submit(teacher, save), /이미 등록/);
  const questions = assignedQuestions(teacher, id);
  const view = (user: string, path: string) =>
    String(homeworkModule.render(ctx(user, path)));
  assert.match(
    view('TA_STUDENT_001', '/homework?assignment=' + id),
    /모두 맞았어요/,
  );
  const report = form({
    assignmentId: id,
    action: 'report',
    wrong: questions[1].id,
    allCorrect: 'yes',
  });
  assert.throws(() => homeworkModule.submit(student, report), /체크/);
  report.delete('allCorrect');
  homeworkModule.submit(student, report);
  assert.throws(() => homeworkModule.submit(student, report), /이미 제출/);
  const brief = () =>
    String(
      briefingModule.render(
        ctx('TA_TEACHER', '/briefing?workbook=' + id + '&class=TA_E_MATH'),
      ),
    );
  assert.match(brief(), /확인한 제출물이 없습니다/);
  const detail = view('TA_TEACHER', '/homework?detail=' + id);
  assert.match(detail, /지각 제출/);
  assert.match(detail, />제출 내용 확인 완료<\/button>/);
  assert.match(detail, />선택한 제출물 확인 완료<\/button>/);
  assert.match(
    view('TA_STUDENT_001', '/homework?assignment=' + id),
    /지각 제출 · 선생님 확인 대기/,
  );
  const sub = String(
    db.prepare('SELECT id FROM homework_submissions').get()?.id,
  );
  const approval = form({
    action: 'approve-workbook',
    assignmentId: id,
    selected: sub,
    ['version-' + sub]: '0',
    ['wrong-' + sub]: questions[0].id,
  });
  assert.throws(() => homeworkModule.submit(student, approval), /교사/);
  approval.append('selected', 'unknown');
  assert.throws(
    () => homeworkModule.submit(teacher, approval),
    /찾을 수 없습니다/,
  );
  assert.equal(
    db.prepare('SELECT confirmed_at FROM homework_submissions').get()
      ?.confirmed_at,
    null,
  );
  approval.delete('selected');
  approval.append('selected', sub);
  homeworkModule.submit(teacher, approval);
  assert.match(brief(), /50\.0%/);
  assert.match(
    view('TA_STUDENT_001', '/homework?assignment=' + id),
    /지각 제출 · 선생님 확인 완료/,
  );
  assert.match(
    view('TA_TEACHER', '/homework?view=analysis'),
    /계산 · 정답 1\/2/,
  );
  assert.throws(() => homeworkModule.submit(teacher, approval), /다른 교사/);
  const points = db
    .prepare(
      'SELECT automatic_points,awarded_points FROM homework_marks WHERE question_id=?',
    )
    .get(questions[0].id);
  assert.deepEqual([points?.automatic_points, points?.awarded_points], [1, 0]);
  db.prepare(
    'INSERT INTO students(id,academy_id,class_id,name) VALUES(?,?,?,?)',
  ).run('new-student', teacher.actor.academyId, 'TA_E_MATH', '추가 학생');
  db.prepare(
    "INSERT INTO accounts(id,academy_id,username,name,role,student_id,password_hash) VALUES(?,?,?,?,'student',?,'test')",
  ).run(
    'TA_STUDENT_002',
    teacher.actor.academyId,
    'TA_STUDENT_002',
    '추가 학생',
    'new-student',
  );
  const next = randomUUID();
  save.set('assignmentId', next);
  save.set(
    'items',
    JSON.stringify([
      { page: 42, number: '01', tagIds: ['math-03'], version: 1 },
    ]),
  );
  save.set('targetKind', 'student');
  save.set('recipient', 'TA_E_MATH|TA_STU_001');
  homeworkModule.submit(teacher, save);
  assert.equal(assignedQuestions(teacher, id)[0].tag_ids, '["math-01"]');
  assert.equal(assignedQuestions(teacher, next)[0].tag_ids, '["math-03"]');
  assert.doesNotMatch(view('TA_STUDENT_002', '/homework'), new RegExp(next));
  assert.throws(
    () =>
      homeworkModule.submit(
        ctx('TA_STUDENT_002'),
        form({ assignmentId: next, action: 'report', allCorrect: 'yes' }),
      ),
    /찾을 수 없습니다/,
  );
  assert.throws(
    () => view('TA_STUDENT_001', '/homework?view=analysis'),
    /교사/,
  );
  assert.equal(
    db.prepare('SELECT count(*) n FROM homework_photos').get()?.n,
    0,
  );
  assert.equal(
    db.prepare('SELECT count(*) n FROM op_learning_publications').get()?.n,
    0,
  );

  const extraClass = 'extra-math';
  db.prepare(
    'INSERT INTO classes(id,academy_id,name,subject) VALUES(?,?,?,?)',
  ).run(extraClass, teacher.actor.academyId, '추가 반', '수학');
  db.prepare(
    'INSERT INTO teacher_classes(teacher_id,class_id) VALUES(?,?)',
  ).run(teacher.actor.id, extraClass);
  db.prepare(
    'INSERT INTO student_class_memberships(student_id,class_id,academy_id) VALUES(?,?,?)',
  ).run(student.actor.studentId, extraClass, teacher.actor.academyId);
  const shared = randomUUID();
  save.set('assignmentId', shared);
  save.set('date', '2026-12-15');
  save.set('time', '17:30');
  save.set('targetKind', 'class');
  save.append('classId', extraClass);
  homeworkModule.submit(teacher, save);
  for (const username of ['TA_STUDENT_001', 'TA_STUDENT_002'])
    homeworkModule.submit(
      ctx(username),
      form({ action: 'report', assignmentId: shared, allCorrect: 'yes' }),
    );
  const bulk = form({ action: 'approve-workbook', assignmentId: shared });
  for (const s of db
    .prepare('SELECT id FROM homework_submissions WHERE assignment_id=?')
    .all(shared)) {
    bulk.append('selected', String(s.id));
    bulk.set('version-' + s.id, '0');
  }
  homeworkModule.submit(teacher, bulk);
  const period = (classId: string) =>
    String(
      briefingModule.render(
        ctx(
          'TA_TEACHER',
          '/briefing?class=' + classId + '&from=2026-12-01&to=2026-12-31',
        ),
      ),
    );
  assert.match(period('TA_E_MATH'), /확인 완료 2건 · 정답 2\/2/);
  assert.match(period(extraClass), /확인 완료 1건 · 정답 1\/1/);
  assert.match(
    view(
      'TA_TEACHER',
      '/homework?view=analysis&student=TA_STU_001&from=2026-12-01',
    ),
    /확인 완료 1건/,
  );
  assert.match(
    view('TA_TEACHER', '/homework?view=analysis&subject=E'),
    /확인한 제출물이 없습니다/,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('OCR 판독으로 수학 대분류를 추천하고, 배정해도 문항 원문은 남기지 않는다', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'workbook-ocr-test');
  homeworkModule.setup(db);
  setupLearning(db);
  const teacher = {
    db,
    actor: getActor(db, 'TA_TEACHER')!,
    url: new URL('http://localhost/homework'),
  };
  const saved = { ...process.env };
  process.env.CLOVA_STUDIO_API_KEY = 'test';
  process.env.CLOVA_OCR_INVOKE_URL = 'https://ocr.example.test/general';
  process.env.CLOVA_OCR_SECRET = 'test-secret';
  t.after(() => {
    for (const k of [
      'CLOVA_STUDIO_API_KEY',
      'CLOVA_OCR_INVOKE_URL',
      'CLOVA_OCR_SECRET',
    ])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  });
  // OCR 한 줄: 낱말마다 위치와 줄 끝 표시.
  const line = (text: string, x: number, y: number) =>
    text.split(' ').map((w, n, all) => ({
      inferText: w,
      inferConfidence: 0.99,
      lineBreak: n === all.length - 1,
      boundingPoly: {
        vertices: [
          { x: x + n * 40, y },
          { x: x + (n + 1) * 40, y },
          { x: x + (n + 1) * 40, y: y + 30 },
          { x: x + n * 40, y: y + 30 },
        ],
      },
    }));
  const fields = [
    ...line('5. 등차수열 a_n에서 a_2=5일 때 a_10의 값은?', 40, 40),
    ...line('6. 등차수열 a_n의 합을 구하시오.', 40, 300),
    ...line('7', 440, 720),
  ];
  const areaPrompts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (String(url).includes('ocr.example.test'))
      return Response.json({ images: [{ inferResult: 'SUCCESS', fields }] });
    const body = JSON.parse(String(init.body));
    const content = (text: string) =>
      Response.json({ result: { message: { content: text } } });
    // 문항 잘라 읽기(HCX-005)
    if (body.messages.length === 1)
      return content(
        '등차수열 $\{a_{n}\}$에서 $a_{2}=5$일 때 $a_{10}$의 값은?',
      );
    // 대분류 추천
    if (String(body.messages[1].content).startsWith('문항:')) {
      areaPrompts.push(body.messages[0].content);
      return content('{"area":"이해"}');
    }
    // 기존 분류(소분류 태그): 계산·이해 태그를 함께 내도 대분류 추천과 같은 묶음만 남아야 한다.
    const items = JSON.parse(body.messages[1].content).map(
      (i: { itemId: string }) => ({
        itemId: i.itemId,
        disposition: 'assessed',
        reasoning: '등차수열의 일반항',
        tags: ['math-02', 'math-04'].map((tagId) => ({
          tagId,
          quote: '등차수열',
          action: '일반항',
          reason: '',
          status: 'adopted',
        })),
      }),
    );
    return content(JSON.stringify({ items }));
  });
  const photo = new FormData();
  photo.set('subject', 'M');
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
  const analyzed = await analyzeHomeworkPhoto(teacher, photo);
  assert.deepEqual(
    analyzed.map((a) => [a.number, a.page, a.area, a.tagIds]),
    [
      ['5', 7, '이해', ['math-04']],
      ['6', 7, '이해', ['math-04']],
    ],
  );
  assert.equal(areaPrompts.length, 2);
  // 교사가 확인해 배정해도 문항 원문은 어디에도 남지 않는다(교재 문항은 쪽·번호·유형만).
  const save = new FormData();
  for (const [k, v] of Object.entries({
    action: 'assign-workbook',
    assignmentId: randomUUID(),
    subject: 'M',
    book: '고등 수학',
    grade: '고3',
    targetKind: 'class',
    classId: 'TA_E_MATH',
    date: '2020-01-10',
    title: '교재 숙제',
    items: JSON.stringify([
      { page: 7, number: '5', tagIds: ['math-04'] },
      { page: 7, number: '6', tagIds: ['math-02', 'math-04'] },
    ]),
  }))
    save.set(k, v);
  homeworkModule.submit(teacher, save);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='classification_examples'",
      )
      .get()?.n,
    0,
  );
  const stored = /에서 \$a_\{2\}=5\$일 때/;
  for (const table of ['book_questions', 'homework_question_snapshots'])
    assert.doesNotMatch(
      JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
      stored,
    );
  // 다음 분석의 대분류 추천도 지어낸 예시만 쓰므로 지시문이 그대로다.
  await analyzeHomeworkPhoto(teacher, photo);
  assert.equal(areaPrompts.at(-1), areaPrompts[0]);
  assert.doesNotMatch(areaPrompts.at(-1)!, stored);
});

test('영어도 OCR 글로 대분류를 추천하고, 추천 대분류 안의 소분류만 남긴다', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'workbook-ocr-english-test');
  homeworkModule.setup(db);
  setupLearning(db);
  db.prepare(
    "INSERT INTO classes (id, academy_id, name, subject, grade) VALUES ('TA_E_ENG','AC_TEST_A','초등 영어반','영어','초등')",
  ).run();
  db.prepare(
    "INSERT INTO teacher_classes (teacher_id, class_id) VALUES ('TA_TEACHER','TA_E_ENG')",
  ).run();
  const teacher = {
    db,
    actor: getActor(db, 'TA_TEACHER')!,
    url: new URL('http://localhost/homework'),
  };
  const saved = { ...process.env };
  process.env.CLOVA_STUDIO_API_KEY = 'test';
  process.env.CLOVA_OCR_INVOKE_URL = 'https://ocr.example.test/general';
  process.env.CLOVA_OCR_SECRET = 'test-secret';
  t.after(() => {
    for (const k of [
      'CLOVA_STUDIO_API_KEY',
      'CLOVA_OCR_INVOKE_URL',
      'CLOVA_OCR_SECRET',
    ])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  });
  const line = (text: string, x: number, y: number) =>
    text.split(' ').map((w, n, all) => ({
      inferText: w,
      inferConfidence: 0.99,
      lineBreak: n === all.length - 1,
      boundingPoly: {
        vertices: [
          { x: x + n * 40, y },
          { x: x + (n + 1) * 40, y },
          { x: x + (n + 1) * 40, y: y + 30 },
          { x: x + n * 40, y: y + 30 },
        ],
      },
    }));
  const fields = [
    ...line('18. 다음 글의 목적으로 가장 적절한 것은?', 40, 40),
    ...line('Dear residents, the pool will close.', 40, 80),
    ...line('① 수영장 휴장을 안내하려고', 40, 120),
    ...line('19. 다음 글의 주제로 가장 적절한 것은?', 40, 300),
    ...line('Sleep helps memory.', 40, 340),
  ];
  const areaCalls: { system: string; user: string }[] = [];
  let visionCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (String(url).includes('ocr.example.test'))
      return Response.json({ images: [{ inferResult: 'SUCCESS', fields }] });
    const body = JSON.parse(String(init.body));
    const content = (text: string) =>
      Response.json({ result: { message: { content: text } } });
    if (body.messages.length === 1) {
      visionCalls++;
      return content('');
    }
    if (String(body.messages[1].content).startsWith('문항:')) {
      areaCalls.push({
        system: body.messages[0].content,
        user: body.messages[1].content,
      });
      return content(
        /목적/.test(body.messages[1].content)
          ? '{"area":"맥락 파악"}'
          : '{"area":"중심 내용 파악"}',
      );
    }
    // 기존 분류는 두 문항 모두 '목적·의견·주장 파악'(맥락 파악)으로 낸다.
    const items = JSON.parse(body.messages[1].content).map(
      (i: { itemId: string }) => ({
        itemId: i.itemId,
        disposition: 'assessed',
        reasoning: '글을 쓴 목적',
        tags: [
          {
            tagId: 'eng-04',
            quote: '다음 글의',
            action: '목적 파악',
            reason: '',
            status: 'adopted',
          },
        ],
      }),
    );
    return content(JSON.stringify({ items }));
  });
  const photo = new FormData();
  photo.set('subject', 'E');
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
  const analyzed = await analyzeHomeworkPhoto(teacher, photo);
  assert.deepEqual(
    analyzed.map((a) => [a.number, a.area, a.tagIds]),
    [
      ['18', '맥락 파악', ['eng-04']],
      // 추천 대분류(중심 내용 파악) 밖의 소분류는 빼고 교사가 고르게 둔다.
      ['19', '중심 내용 파악', []],
    ],
  );
  // 영어는 문항을 잘라 다시 읽지 않고, 선택지까지 OCR 글을 그대로 보낸다.
  assert.equal(visionCalls, 0);
  assert.equal(areaCalls.length, 2);
  assert.match(areaCalls[0].user, /① 수영장 휴장을 안내하려고/);
  assert.match(areaCalls[0].system, /발문\(무엇을 고르라고 하는지\)/);
  assert.match(areaCalls[0].system, /다음 글의 목적으로 가장 적절한 것은\?/);
});
