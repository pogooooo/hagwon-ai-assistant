import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { briefingModule, summarizeBriefing } from './briefing.ts';
import { parseClassification } from './classification.ts';
import { getActor, initializeIdentity } from './directory.ts';
import { learningModule } from './learning.ts';

const tag = (tagId: string, status = 'adopted') => ({
  tagId,
  status,
  evidenceKind: 'text',
  agreement: { same: 3, runs: 3 },
});
const classification = (assignmentId = 'briefing-homework') => ({
  formatVersion: '1.0',
  assignmentId,
  subject: 'M',
  rubricVersion: '1.0',
  classifiedAt: '2026-11-10T18:30:00+09:00',
  items: [
    {
      itemId: 'one',
      page: 42,
      displayNumber: '1',
      itemStatus: 'classified',
      tags: [tag('math-01'), tag('math-02')],
    },
    {
      itemId: 'two',
      page: 43,
      displayNumber: '1',
      itemStatus: 'classified',
      tags: [tag('math-01'), tag('math-09')],
    },
    {
      itemId: 'three',
      page: 43,
      displayNumber: '2',
      itemStatus: 'no_adopted',
      tags: [],
    },
    {
      itemId: 'four',
      page: 44,
      displayNumber: '1',
      itemStatus: 'unreadable',
      tags: [],
    },
  ],
});

test('브리핑 집계: 확정 결과만 세고 약한 유형과 많이 틀린 문항을 정렬한다', () => {
  const briefing = summarizeBriefing(parseClassification(classification()), [
    {
      studentId: 'a',
      name: '가',
      state: 'confirmed',
      outcomes: { one: 'correct', two: 'incorrect', three: 'incorrect' },
    },
    {
      studentId: 'b',
      name: '나',
      state: 'confirmed',
      outcomes: { one: 'incorrect', two: 'incorrect' },
    },
    // 검수 전 결과는 값이 있어도 집계하지 않는다.
    {
      studentId: 'c',
      name: '다',
      state: 'draft',
      outcomes: { one: 'incorrect' },
    },
    { studentId: 'd', name: '라', state: 'missing', outcomes: {} },
  ]);
  assert.deepEqual(briefing.stateCounts, {
    confirmed: 2,
    draft: 1,
    stale: 0,
    withdrawn: 0,
    missing: 1,
  });
  // 분류된 두 문항 × 확정 두 명 = 4건 중 1건 정답. 분류 제외 문항은 분모에 없다.
  assert.deepEqual(briefing.overall, { correct: 1, total: 4 });
  assert.equal(briefing.unclassified, 2);
  assert.deepEqual(
    briefing.reteach.map((t) => [t.tagId, t.correct, t.total]),
    [
      ['math-09', 0, 2],
      ['math-01', 1, 4],
      ['math-02', 1, 2],
    ],
  );
  // 분류 제외 문항(three)도 많이 틀린 문항에는 나온다. 미확인 학생은 분모에서 빠진다.
  assert.deepEqual(
    briefing.missedItems.map((i) => [i.itemId, i.incorrect, i.checked]),
    [
      ['two', 2, 2],
      ['three', 1, 1],
      ['one', 1, 2],
    ],
  );
  const [first, , draft] = briefing.students;
  assert.deepEqual([first.correct, first.total, first.unknown], [1, 2, 1]);
  assert.deepEqual(
    first.wrongItems.map((i) => i.itemId),
    ['two', 'three'],
  );
  assert.equal(first.wrongItems[1].label, '채택 태그 없음');
  assert.deepEqual(
    first.weakTypes.map((t) => t.tagId),
    ['math-09', 'math-01'],
  );
  assert.deepEqual([draft.total, draft.wrongItems.length], [0, 0]);
});

test('브리핑 집계: 오답이 없으면 다시 설명할 유형과 많이 틀린 문항이 비어 있다', () => {
  const briefing = summarizeBriefing(parseClassification(classification()), [
    {
      studentId: 'a',
      name: '가',
      state: 'confirmed',
      outcomes: { one: 'correct', two: 'correct' },
    },
  ]);
  assert.deepEqual(briefing.overall, { correct: 2, total: 2 });
  assert.deepEqual(briefing.reteach, []);
  assert.deepEqual(briefing.missedItems, []);
  assert.equal(briefing.types.length, 3);
});

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'briefing-test');
  learningModule.setup(db);
  briefingModule.setup(db);
  const ctx = (username: string, query = '') => {
    const actor = getActor(db, username);
    assert.ok(actor);
    return { db, actor, url: new URL('http://localhost/briefing' + query) };
  };
  const learn = (values: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(values)) form.set(k, v);
    return learningModule.submit(ctx('TA_DIRECTOR'), form);
  };
  const upload = (assignmentId: string, classId: string) =>
    learn({
      action: 'import',
      classification: JSON.stringify(classification(assignmentId)),
      title: '브리핑 숙제 ' + classId,
      classId,
      period: '2026-11',
      revision: '0',
    });
  const result = (action: string, revision: string) =>
    learn({
      action,
      assignmentId: 'for-teacher',
      studentId: 'TA_STU_001',
      classificationRevision: '1',
      revision,
      reason: '시험용',
      wrongItems: '43 | 1',
      complete: 'yes',
    });
  return { ctx, upload, result };
}

test('브리핑 화면: 검수 대기 결과는 빼고 확정 후에 반 요약과 학생 카드를 보여 준다', async (t) => {
  const { ctx, upload, result } = setup(t);
  await upload('for-teacher', 'TA_E_MATH');
  const view = () =>
    String(briefingModule.render(ctx('TA_TEACHER', '?assignment=for-teacher')));

  await result('results', '0');
  let html = view();
  assert.match(html, /아직 검수가 확정된 결과가 없습니다/);
  assert.match(html, /검수 대기 1명/);
  assert.doesNotMatch(html, /반 평균 정답률/);

  await result('confirm', '1');
  html = view();
  assert.match(html, /반 평균 정답률/);
  assert.match(html, /확정 1명/);
  assert.match(html, /50\.0%/);
  assert.match(html, /오답 1문항/);
  assert.match(html, /43쪽 1번/);
  assert.match(
    html,
    /href="\/learning\?assignment=for-teacher&amp;student=TA_STU_001"/,
  );
});

test('브리핑 화면: 강사는 담당 반 숙제만 보고, 조회 전용이다', async (t) => {
  const { ctx, upload } = setup(t);
  await upload('for-teacher', 'TA_E_MATH');
  await upload('other-class', 'TA_M3');

  const list = String(briefingModule.render(ctx('TA_TEACHER')));
  assert.match(list, /assignment=for-teacher/);
  assert.doesNotMatch(list, /other-class/);
  assert.throws(
    () => briefingModule.render(ctx('TA_TEACHER', '?assignment=other-class')),
    { status: 404 },
  );
  assert.match(
    String(
      briefingModule.render(ctx('TA_DIRECTOR', '?assignment=other-class')),
    ),
    /브리핑 숙제 TA_M3/,
  );
  assert.deepEqual(briefingModule.roles, ['admin', 'teacher']);
  assert.throws(
    () => briefingModule.submit(ctx('TA_DIRECTOR'), new FormData()),
    { status: 405 },
  );
});
