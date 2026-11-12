import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  analyze,
  parseClassification,
  outcomesFromWrongList,
} from './classification.ts';
import {
  getActor,
  initializeIdentity,
  accessibleStudents,
  directoryModule,
} from './directory.ts';
import { documentsModule } from './documents.ts';
import { scheduleModule } from './schedule.ts';
import { consultationModule } from './consultation.ts';
import { learningModule, learningEvidence } from './learning.ts';
import { type OperationModule } from './shared.ts';

const tag = (tagId: string, status = 'adopted') => ({
  tagId,
  status,
  evidenceKind: 'text',
  agreement: { same: 2, runs: 3 },
});
export function classification() {
  return {
    formatVersion: '1.0',
    assignmentId: 'team-homework-01',
    subject: 'M',
    rubricVersion: '1.0',
    classifiedAt: '2026-11-10T18:30:00+09:00',
    items: [
      {
        itemId: 'one',
        page: 42,
        displayNumber: '1',
        itemStatus: 'classified',
        tags: [tag('math-01'), tag('math-02'), tag('math-09', 'reference')],
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
        tags: [tag('math-07', 'held')],
      },
      {
        itemId: 'four',
        page: 44,
        displayNumber: '1',
        itemStatus: 'unreadable',
        tags: [],
      },
    ],
  };
}
function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'learning-test');
  documentsModule.setup(db);
  scheduleModule.setup(db);
  consultationModule.setup(db);
  learningModule.setup(db);
  const ctx = (username: string, query = '') => {
    const actor = getActor(db, username);
    assert.ok(actor);
    return { db, actor, url: new URL('http://localhost/learning' + query) };
  };
  const submit = async (
    module: OperationModule,
    username: string,
    values: Record<string, string>,
  ) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(k, v);
    return module.submit(ctx(username), f);
  };
  const upload = (data = classification(), revision = '0') =>
    submit(learningModule, 'TA_DIRECTOR', {
      action: 'import',
      classification: JSON.stringify(data),
      title: '분류 연동 숙제',
      classId: 'TA_E_MATH',
      period: '2026-11',
      revision,
    });
  const result = (
    action: string,
    revision: string,
    extra: Record<string, string> = {},
    username = 'TA_DIRECTOR',
  ) =>
    submit(learningModule, username, {
      action,
      assignmentId: 'team-homework-01',
      studentId: 'TA_STU_001',
      classificationRevision: '1',
      revision,
      reason: '시험용 검수',
      ...extra,
    });
  const ask = async (username: string, question: string, studentId = '') => {
    const conversationId = randomUUID();
    await submit(consultationModule, username, {
      action: 'ask',
      question,
      studentId,
      conversationId,
    });
    return JSON.parse(
      String(
        db
          .prepare(
            "SELECT response FROM op_consultation_messages WHERE thread_id = ? AND kind = 'answer'",
          )
          .get(conversationId)!.response,
      ),
    );
  };
  return { db, ctx, submit, upload, result, ask };
}

test('분류 규약: 확장 필드는 무시하고 페이지·번호, 버전, 과목, 채택 여부를 검증한다', () => {
  const raw = classification();
  const parsed = parseClassification({ ...raw, internal: { secret: true } });
  assert.ok(!('internal' in parsed));
  assert.equal(parsed.items[2].tags[0].status, 'held');
  for (const change of [
    { formatVersion: '2.0' },
    { rubricVersion: '9.0' },
    { subject: 'E' },
    { classifiedAt: '2026-02-30T10:00:00+09:00' },
  ])
    assert.throws(() => parseClassification({ ...raw, ...change }));
  assert.throws(() =>
    parseClassification({
      ...raw,
      items: [raw.items[0], { ...raw.items[1], page: 42 }],
    }),
  );
  assert.throws(() =>
    parseClassification({
      ...raw,
      items: [{ ...raw.items[0], tags: [tag('math-01', 'held')] }],
    }),
  );
  assert.throws(() =>
    parseClassification({
      ...raw,
      items: [
        {
          ...raw.items[0],
          tags: [{ ...tag('math-01'), agreement: { same: 4, runs: 3 } }],
        },
      ],
    }),
  );
});
test('집계: 채택만 포함, 태그별 1회·영역별 중복 제거, 미분류와 미확인 제외', () => {
  const data = parseClassification(classification());
  const outcomes = outcomesFromWrongList(data, '43 | 1\n43 | 2', true);
  assert.equal(outcomes.one, 'correct');
  assert.equal(outcomes.two, 'incorrect');
  const result = analyze(data, outcomes);
  assert.equal(result.assessed, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.unclassifiedWrong, 1);
  assert.equal(result.unclassified, 2);
  assert.deepEqual(
    result.areas.find((a) => a.name === '계산'),
    { name: '계산', correct: 1, incorrect: 1, total: 2 },
  );
  assert.equal(result.tags.find((t) => t.tagId === 'math-09')!.total, 1);
  assert.equal(result.tags.find((t) => t.tagId === 'math-02')!.total, 1);
  assert.ok(result.tags.every((t) => t.referenceOnly));
  const partial = analyze(data, outcomesFromWrongList(data, '42 | 1', false));
  assert.equal(partial.assessed, 1);
  assert.equal(partial.unknown, 3);
  assert.throws(() => outcomesFromWrongList(data, '1', true));
  assert.throws(() => outcomesFromWrongList(data, '42 | 1\n42 | 1', true));
  assert.throws(() => outcomesFromWrongList(data, '99 | 1', true));
});
test('영어 채택 유형은 참고용이 아니며 범위 밖 듣기 문항을 제외한다', () => {
  const raw = classification();
  const data = parseClassification({
    ...raw,
    subject: 'E',
    items: [
      { ...raw.items[0], tags: [tag('eng-06')] },
      { ...raw.items[1], itemStatus: 'out_of_scope', tags: [] },
    ],
  });
  const summary = analyze(data, { one: 'correct', two: 'incorrect' });
  assert.equal(summary.assessed, 1);
  assert.equal(summary.tags[0].referenceOnly, false);
});
test('분류 업로드 → 학생 결과 → 검수 → DB 분석 → 실제 상담과 출처, 수정·철회', async (t) => {
  const s = setup(t);
  await s.upload();
  await s.upload();
  assert.equal(
    s.db
      .prepare('SELECT COUNT(*) n FROM op_learning_classification_versions')
      .get()!.n,
    1,
  );
  await s.result(
    'results',
    '0',
    { wrongItems: '43 | 1\n43 | 2', complete: 'yes' },
    'TA_STUDENT_001',
  );
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').facts.length, 0);
  await assert.rejects(
    s.result('confirm', '1', {}, 'TA_GUARDIAN_E_MATH'),
    /권한/,
  );
  await s.result('confirm', '1');
  const first = learningEvidence(s.db, 'AC_TEST_A');
  assert.ok(first.facts.length);
  assert.equal(first.documents[0].revision, 1);
  const answer = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 전체 정답률 알려줘',
    'TA_STU_001',
  );
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /2문항 중 1문항/);
  assert.ok(
    answer.citations.every((c: { documentId: string }) =>
      c.documentId.startsWith('learning-'),
    ),
  );
  const label = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 식 정리 유형 정답률 알려줘',
    'TA_STU_001',
  );
  assert.equal(label.status, 'answered', label.answer);
  assert.match(label.answer, /참고용/);
  const outsider = await s.ask(
    'TA_GUARDIAN_M2',
    '가상학생A의 11월 정답률 알려줘',
  );
  assert.equal(outsider.citations.length, 0);
  assert.notEqual(outsider.status, 'answered');
  await assert.rejects(s.result('results', '1', { complete: 'yes' }), /변경/);
  await s.result('results', '2', { complete: 'yes' });
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').facts.length, 0);
  await s.result('confirm', '3');
  const corrected = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 전체 정답률 알려줘',
    'TA_STU_001',
  );
  assert.match(corrected.answer, /2문항 중 2문항/);
  assert.match(corrected.answer, /분석 갱신본/);
  assert.ok(corrected.citations[0].revision > answer.citations[0].revision);
  await s.result('withdraw', '4');
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').documents.length, 0);
});
test('재분류는 기존 분석을 무효화하고 이전 결과·원문은 이력에 보존한다', async (t) => {
  const s = setup(t);
  await s.upload();
  await s.result('results', '0', { complete: 'yes' });
  await s.result('confirm', '1');
  const changed = classification();
  changed.classifiedAt = '2026-11-11T18:30:00+09:00';
  changed.items[0].tags = [tag('math-09')];
  await s.upload(changed, '1');
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').facts.length, 0);
  await assert.rejects(s.result('confirm', '2'), /변경/);
  assert.equal(
    s.db
      .prepare('SELECT COUNT(*) n FROM op_learning_classification_versions')
      .get()!.n,
    2,
  );
  assert.equal(
    s.db.prepare('SELECT COUNT(*) n FROM op_learning_results').get()!.n,
    2,
  );
  await assert.rejects(s.upload(classification(), '2'), /새 시각/);
});
test('다른 반·보호자의 결과 쓰기는 차단하고 반 이동 후 본인 학습 이력은 보존한다', async (t) => {
  const s = setup(t);
  await s.upload();
  await assert.rejects(
    s.result('results', '0', { complete: 'yes' }, 'TA_GUARDIAN_E_MATH'),
    /등록/,
  );
  await assert.rejects(
    s.result('results', '0', { studentId: 'TA_STU_002', complete: 'yes' }),
    /권한/,
  );
  await s.result('results', '0', { complete: 'yes' });
  await s.result('confirm', '1');
  s.db
    .prepare(
      "UPDATE students SET class_id = 'TA_M2_EXAM' WHERE id = 'TA_STU_001'",
    )
    .run();
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').documents.length, 1);
  const parent = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 전체 정답률 알려줘',
    'TA_STU_001',
  );
  assert.equal(parent.status, 'answered', parent.answer);
  assert.match(parent.answer, /100/);
  const formerTeacher = await s.ask('TA_TEACHER', '11월 전체 정답률 알려줘');
  assert.equal(
    formerTeacher.citations.some((c: { documentId: string }) =>
      c.documentId.startsWith('learning-'),
    ),
    false,
  );
  await assert.rejects(s.result('results', '2', { complete: 'yes' }), /권한/);
});
test('확정 숙제 여러 건은 문항 수로 가중 집계하며 확인 없는 결과를 정답으로 간주하지 않는다', async (t) => {
  const s = setup(t);
  await s.upload();
  await s.result('results', '0', { wrongItems: '42 | 1', complete: 'yes' });
  await s.result('confirm', '1');
  const second = classification();
  second.assignmentId = 'second';
  second.items = second.items.slice(0, 1);
  await s.upload(second);
  await s.result('results', '0', { assignmentId: 'second', complete: 'yes' });
  await s.result('confirm', '1', { assignmentId: 'second' });
  const evidence = learningEvidence(s.db, 'AC_TEST_A');
  const overall = evidence.facts.find(
    (f) => f.value.kind === 'accuracy' && f.value.dimension === 'overall',
  )!;
  assert.equal(overall.value.kind, 'accuracy');
  assert.equal((overall.value as { total: number }).total, 3);
  assert.equal((overall.value as { correct: number }).correct, 2);
  assert.equal(overall.assignments!.length, 2);
});

test('다른 학원에 같은 숙제 ID가 있어도 분류·분석은 분리한다', async (t) => {
  const s = setup(t);
  await s.upload();
  await s.result('results', '0', { complete: 'yes' });
  await s.result('confirm', '1');
  s.db.exec(
    "INSERT INTO academies VALUES ('OTHER','다른 가상 학원'); INSERT INTO classes VALUES ('OTHER_CLASS','OTHER','다른 수학반','수학','초등'); INSERT INTO students VALUES ('OTHER_STUDENT','OTHER','OTHER_CLASS','다른 가상 학생');",
  );
  s.db.exec(
    "INSERT INTO accounts SELECT 'OTHER_ADMIN','OTHER','OTHER_ADMIN','다른 관리자','admin',NULL,password_hash FROM accounts WHERE id='TA_DIRECTOR';",
  );
  const form = {
    action: 'import',
    classification: JSON.stringify(classification()),
    title: '다른 학원 숙제',
    classId: 'OTHER_CLASS',
    period: '2026-11',
    revision: '0',
  };
  await s.submit(learningModule, 'OTHER_ADMIN', form);
  assert.equal(
    s.db.prepare('SELECT COUNT(*) n FROM op_learning_assignments').get()!.n,
    2,
  );
  await assert.rejects(
    s.submit(learningModule, 'OTHER_ADMIN', {
      action: 'results',
      assignmentId: 'team-homework-01',
      studentId: 'TA_STU_001',
      revision: '0',
      classificationRevision: '1',
      reason: '시험',
      complete: 'yes',
    }),
    /권한/,
  );
  assert.equal(learningEvidence(s.db, 'OTHER').documents.length, 0);
  assert.ok(
    learningEvidence(s.db, 'AC_TEST_A').documents.every(
      (d) => d.academyId === 'AC_TEST_A',
    ),
  );
});

test('상담 인용 문단은 유형 이름·정답 수·전체 수가 함께 있는 문단이다', async (t) => {
  const s = setup(t);
  await s.upload();
  await s.result('results', '0', { wrongItems: '43 | 1', complete: 'yes' });
  await s.result('confirm', '1');
  const source = learningEvidence(s.db, 'AC_TEST_A').documents[0];
  const { splitIntoBlocks } =
    await import('../rag-consultation/server/ingest/chunking.ts');
  const block = splitIntoBlocks(source.text).find((b) =>
    b.text.includes('식 정리 (참고용): 2문항 중 1문항 정답'),
  );
  assert.ok(block);
  const answer = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 식 정리 유형 정답률 알려줘',
    'TA_STU_001',
  );
  assert.equal(answer.status, 'answered', answer.answer);
  assert.equal(answer.citations[0].location, block.location.label);
});

test('혼합 과목 반의 분류를 합산하거나 기존 분석의 과목을 바꾸지 않는다', async (t) => {
  const s = setup(t);
  s.db
    .prepare("UPDATE classes SET subject = '수학·영어' WHERE id = ?")
    .run('TA_E_MATH');
  await assert.rejects(s.upload(), /과목/);
  s.db
    .prepare("UPDATE classes SET subject = '수학' WHERE id = ?")
    .run('TA_E_MATH');
  await s.upload();
  const { directoryModule } = await import('./directory.ts');
  await assert.rejects(
    s.submit(directoryModule, 'TA_DIRECTOR', {
      action: 'class_save',
      id: 'TA_E_MATH',
      name: '변경 반',
      subject: '영어',
      grade: '초등',
    }),
    /과목/,
  );
  assert.equal(
    s.db.prepare('SELECT subject FROM classes WHERE id = ?').get('TA_E_MATH')!
      .subject,
    '수학',
  );
});

test('팀 채점 결과 수신은 자동 채점 없이 문항 좌표를 검증하고 미전달 결과를 미확인으로 보존한다', async (t) => {
  const s = setup(t);
  await s.upload();
  const graded = {
    formatVersion: '1.0',
    assignmentId: 'team-homework-01',
    studentId: 'TA_STU_001',
    classificationRevision: 1,
    results: [{ page: 42, displayNumber: '1', outcome: 'incorrect' }],
  };
  for (const bad of [
    { ...graded, studentId: 'TA_STU_002' },
    { ...graded, classificationRevision: 2 },
    { ...graded, results: [...graded.results, ...graded.results] },
    {
      ...graded,
      results: [{ page: 99, displayNumber: '1', outcome: 'correct' }],
    },
  ])
    await assert.rejects(
      s.result('results-import', '0', { gradedResults: JSON.stringify(bad) }),
      /결과|문항/,
    );
  await s.result('results-import', '0', {
    gradedResults: JSON.stringify(graded),
  });
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  await s.result('confirm', '1');
  const answer = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 전체 정답률 알려줘',
    'TA_STU_001',
  );
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /0%/);
  const facts = learningEvidence(s.db, 'AC_TEST_A').facts;
  const value = facts.find(
    (f) => f.value.kind === 'accuracy' && f.value.dimension === 'overall',
  )!.value as { total: number; correct: number };
  assert.equal(value.total, 1);
  assert.equal(value.correct, 0);
});

test('복수 반 수강은 과목 담당 교사의 학습 자료 범위를 넓히지 않는다', async (t) => {
  const s = setup(t);
  await s.upload();
  await s.result('results', '0', { complete: 'yes' });
  await s.result('confirm', '1');
  const form = new FormData();
  for (const [k, v] of Object.entries({
    action: 'student_save',
    id: 'TA_STU_001',
    name: '가상원생',
    classId: 'TA_M2_EXAM',
    membershipsPresent: 'yes',
    extraClasses: 'TA_E_MATH',
  }))
    form.set(k, v);
  await directoryModule.submit(s.ctx('TA_DIRECTOR'), form);
  const student = accessibleStudents(
    s.db,
    s.ctx('TA_GUARDIAN_E_MATH').actor,
  ).find((x) => x.id === 'TA_STU_001')!;
  assert.deepEqual([...student.classIds].sort(), ['TA_E_MATH', 'TA_M2_EXAM']);
  const teacher = accessibleStudents(s.db, s.ctx('TA_TEACHER').actor).find(
    (x) => x.id === 'TA_STU_001',
  )!;
  assert.deepEqual(teacher.classIds, ['TA_E_MATH']);
  form.delete('extraClasses');
  await directoryModule.submit(s.ctx('TA_DIRECTOR'), form);
  assert.equal(
    accessibleStudents(s.db, s.ctx('TA_TEACHER').actor).some(
      (x) => x.id === 'TA_STU_001',
    ),
    false,
  );
  const parent = await s.ask(
    'TA_GUARDIAN_E_MATH',
    '11월 전체 정답률 알려줘',
    'TA_STU_001',
  );
  assert.equal(parent.status, 'answered', parent.answer);
});
