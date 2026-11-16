import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { getActor, initializeIdentity } from './directory.ts';
import { homeworkModule } from './homework.ts';
import { documentsModule, documentsIndexVersion } from './documents.ts';
import { consultationModule } from './consultation.ts';
import { learningModule, learningEvidence } from './learning.ts';
import { scheduleModule } from './schedule.ts';
import { assignedQuestions, workbookAnalytics } from './workbook-results.ts';
import {
  readWorkbookAnalysis,
  summarizeWorkbookAnalysis,
  workbookFingerprint,
} from './workbook-analysis.ts';
import {
  publishWorkbookAnalysis,
  workbookEvidence,
  renderWorkbookSource,
} from './workbook-publication.ts';
import {
  createOperationsGeneration,
  configureOperationsGeneration,
} from './runtime-generation.ts';
import { splitIntoBlocks } from '../rag-consultation/server/ingest/chunking.ts';
import { InMemoryRagStore } from '../rag-consultation/server/index.ts';
import type { RagAnswer } from '../rag-consultation/contract.ts';

const form = (values: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values))
    for (const item of Array.isArray(v) ? v : [v]) data.append(k, item);
  return data;
};
function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'workbook-analysis-test');
  for (const feature of [
    homeworkModule,
    learningModule,
    documentsModule,
    scheduleModule,
    consultationModule,
  ])
    feature.setup(db);
  configureOperationsGeneration(
    createOperationsGeneration({ RAG_GENERATION_PROVIDER: 'disabled' }),
  );
  const ctx = (user = 'TA_TEACHER', url = '/homework') => ({
    db,
    actor: getActor(db, user)!,
    url: new URL('http://localhost' + url),
  });
  const assign = (extra: Record<string, string | string[]> = {}) => {
    const id = randomUUID();
    homeworkModule.submit(
      ctx(),
      form({
        action: 'assign-workbook',
        assignmentId: id,
        subject: 'M',
        book: '공통 수학',
        grade: '중1',
        edition: '2026판',
        title: '월간 교재 숙제',
        date: '2026-11-15',
        targetKind: 'class',
        classId: 'TA_E_MATH',
        items: JSON.stringify([
          { page: 11, number: '1', tagIds: ['math-01', 'math-02'] },
          { page: 12, number: '1', tagIds: [] },
        ]),
        ...extra,
      }),
    );
    return id;
  };
  const submit = (id: string, wrong: number[] = []) => {
    const questions = assignedQuestions(ctx(), id);
    homeworkModule.submit(
      ctx('TA_STUDENT_001'),
      form({
        action: 'report',
        assignmentId: id,
        ...(wrong.length
          ? { wrong: wrong.map((i) => questions[i].id) }
          : { allCorrect: 'yes' }),
      }),
    );
    return String(
      db
        .prepare(
          'SELECT id FROM homework_submissions WHERE assignment_id=? AND student_id=?',
        )
        .get(id, 'TA_STU_001')!.id,
    );
  };
  const approve = (
    id: string,
    sub: string,
    wrong: number[] = [],
    version = 0,
  ) => {
    const questions = assignedQuestions(ctx(), id);
    return homeworkModule.submit(
      ctx(),
      form({
        action: 'approve-workbook',
        assignmentId: id,
        single: sub,
        ['version-' + sub]: String(version),
        ['wrong-' + sub]: wrong.map((i) => questions[i].id),
        ...(version ? { ['reason-' + sub]: '교사 확인 후 정정' } : {}),
      }),
    );
  };
  const publicationForm = (
    revision = 0,
    classId = 'TA_E_MATH',
    period = '2026-11',
  ) =>
    form({
      action: 'publish-analysis',
      studentId: 'TA_STU_001',
      classId,
      period,
      publicationRevision: String(revision),
      fingerprint: workbookFingerprint(
        readWorkbookAnalysis(db, 'AC_TEST_A').results.filter(
          (r) =>
            r.studentId === 'TA_STU_001' &&
            r.classes.some((c) => c.id === classId) &&
            r.dueDate.slice(0, 7) === period,
        ),
      ),
    });
  const ask = async (
    question: string,
    user = 'TA_GUARDIAN_E_MATH',
    studentId = 'TA_STU_001',
  ) => {
    const conversationId = randomUUID();
    await consultationModule.submit(
      ctx(user),
      form({ action: 'ask', conversationId, question, studentId }),
    );
    const answer = JSON.parse(
      String(
        db
          .prepare(
            "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
          )
          .get(conversationId)!.response,
      ),
    ) as RagAnswer;
    return { answer, conversationId };
  };
  return { db, ctx, assign, submit, approve, publicationForm, ask };
}

test('새 DB → 승인 분석 → 별도 공개 → 상담 값과 인용 문단, 기존 학습 기록·스키마 유지', async (t) => {
  const s = setup(t),
    schema = s.db
      .prepare('SELECT name,sql FROM sqlite_master ORDER BY name')
      .all();
  const id = s.assign(),
    sub = s.submit(id, [0]);
  assert.equal(readWorkbookAnalysis(s.db, 'AC_TEST_A').results.length, 0);
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  await s.approve(id, sub, [0]);
  const analysis = summarizeWorkbookAnalysis(
    readWorkbookAnalysis(s.db, 'AC_TEST_A').results,
  );
  assert.deepEqual(
    [analysis.total, analysis.correct, analysis.unclassified],
    [2, 1, 1],
  );
  assert.equal(analysis.groups.get('M:계산')?.total, 1);
  assert.equal(analysis.types.get('math-01')?.total, 1);
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  const source = workbookEvidence(s.db, 'AC_TEST_A').documents[0];
  const { answer } = await s.ask('11월 수학 전체 정답률 알려줘');
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /2문항 중 1문항 정답/);
  assert.match(answer.answer, /유형 미지정 문항도 포함/);
  assert.equal(answer.citations[0].documentId, source.documentId);
  const block = splitIntoBlocks(source.text).find(
    (b) => b.text === '전체: 2문항 중 1문항 정답.',
  )!;
  const areaBlock = splitIntoBlocks(source.text).find(
    (b) => b.text === '계산 (참고용): 1문항 중 0문항 정답.',
  )!;
  assert.match(answer.answer, /계산.*1문항 중 0문항/);
  assert.equal(
    answer.citations[0].location,
    [block.location.label, areaBlock.location.label].join(', '),
  );
  const types = await s.ask('11월 식 정리 유형 정답률 알려줘');
  assert.equal(types.answer.status, 'answered', types.answer.answer);
  assert.match(types.answer.answer, /1문항 중 0문항/);
  const typeBlock = splitIntoBlocks(source.text).find(
    (b) => b.text === '식 정리 (참고용): 1문항 중 0문항 정답.',
  )!;
  assert.equal(types.answer.citations[0].location, typeBlock.location.label);
  assert.match(
    renderWorkbookSource(s.ctx('TA_GUARDIAN_E_MATH'), source.documentId),
    /11쪽 1번: 오답/,
  );
  assert.equal(learningEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  assert.equal(
    s.db.prepare('SELECT count(*) n FROM op_learning_assignments').get()!.n,
    0,
  );
  assert.deepEqual(
    s.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
    schema,
  );
});

test('교사 정정은 이전 근거·캐시·기존 상담 표시를 무효화하고 재공개·철회를 적용한다', async (t) => {
  const s = setup(t),
    id = s.assign(),
    sub = s.submit(id, [0]);
  await s.approve(id, sub, [0]);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  const before = workbookEvidence(s.db, 'AC_TEST_A'),
    source = before.documents[0];
  const version = documentsIndexVersion(
    s.db,
    'AC_TEST_A',
    before.documents,
    before.facts,
  );
  const { conversationId } = await s.ask('11월 수학 전체 정답률 알려줘');
  const staleForm = s.publicationForm(1);
  await s.approve(id, sub, [], 1);
  const after = workbookEvidence(s.db, 'AC_TEST_A');
  assert.equal(after.documents.length, 0);
  assert.notEqual(
    documentsIndexVersion(s.db, 'AC_TEST_A', after.documents, after.facts),
    version,
  );
  assert.throws(
    () => renderWorkbookSource(s.ctx('TA_GUARDIAN_E_MATH'), source.documentId),
    /최신/,
  );
  assert.throws(
    () =>
      learningModule.render(
        s.ctx(
          'TA_GUARDIAN_E_MATH',
          '/learning?publication=' + source.documentId,
        ),
      ),
    /최신/,
  );
  assert.match(
    String(
      await consultationModule.render(
        s.ctx('TA_GUARDIAN_E_MATH', '/consultation?id=' + conversationId),
      ),
    ),
    /답변을 표시할 수 없습니다/,
  );
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), staleForm),
    /승인 결과가 변경/,
  );
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm(1));
  const corrected = await s.ask('11월 수학 전체 정답률 알려줘');
  assert.equal(corrected.answer.status, 'answered', corrected.answer.answer);
  assert.match(corrected.answer.answer, /2문항 중 2문항/);
  assert.equal(corrected.answer.citations[0].revision, 2);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm(2), true);
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  assert.notEqual(
    (await s.ask('11월 수학 전체 정답률 알려줘')).answer.status,
    'answered',
  );
  assert.equal(
    s.db.prepare('SELECT count(*) n FROM op_learning_publications').get()!.n,
    3,
  );
});

test('복수 반은 실제 배정 관계를 사용하고 학생 합산은 제출 한 건만 센다', async (t) => {
  const s = setup(t);
  s.db
    .prepare('INSERT INTO classes(id,academy_id,name,subject) VALUES(?,?,?,?)')
    .run('extra', 'AC_TEST_A', '추가 수학반', '수학');
  s.db
    .prepare('INSERT INTO teacher_classes(teacher_id,class_id) VALUES(?,?)')
    .run(s.ctx().actor.id, 'extra');
  s.db
    .prepare(
      'INSERT INTO student_class_memberships(student_id,class_id,academy_id) VALUES(?,?,?)',
    )
    .run('TA_STU_001', 'extra', 'AC_TEST_A');
  const id = s.assign({ classId: ['TA_E_MATH', 'extra'] }),
    sub = s.submit(id, [0]);
  await s.approve(id, sub, [0]);
  const all = readWorkbookAnalysis(s.db, 'AC_TEST_A').results;
  assert.equal(all[0].classes.length, 2);
  assert.equal(summarizeWorkbookAnalysis([...all, ...all]).total, 2);
  assert.match(
    workbookAnalytics(s.ctx('TA_TEACHER', '/briefing?class=extra'), false),
    /확인 완료 1건 · 정답 1\/2/,
  );
  assert.match(
    workbookAnalytics(s.ctx('TA_TEACHER', '/homework?view=analysis'), true),
    /확인 완료 1건 · 정답 1\/2/,
  );
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm(0, 'extra'));
  assert.equal(
    workbookEvidence(s.db, 'AC_TEST_A').documents[0].classId,
    'extra',
  );
});

test('공용 유형 변경은 배정 사본에 영향을 주지 않고 기간·교재별 집계를 구분한다', async (t) => {
  const s = setup(t),
    id = s.assign(),
    sub = s.submit(id, [0]);
  await s.approve(id, sub, [0]);
  const old = readWorkbookAnalysis(s.db, 'AC_TEST_A').results[0];
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  s.db
    .prepare('DELETE FROM book_question_types WHERE question_id=?')
    .run(old.questions[0].bookQuestionId);
  s.db
    .prepare('INSERT INTO book_question_types(question_id,tag_id) VALUES(?,?)')
    .run(old.questions[0].bookQuestionId, 'math-03');
  assert.deepEqual(
    readWorkbookAnalysis(s.db, 'AC_TEST_A').results[0].questions[0].tags.map(
      (t) => t.tagId,
    ),
    ['math-01', 'math-02'],
  );
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 1);
  const next = s.assign({
      edition: '2027판',
      date: '2026-12-01',
      title: '다음 달 숙제',
    }),
    second = s.submit(next);
  await s.approve(next, second);
  const view = workbookAnalytics(
    s.ctx(
      'TA_TEACHER',
      '/homework?view=analysis&from=2026-11-01&to=2026-11-30',
    ),
    true,
  );
  assert.match(view, /확인 완료 1건 · 정답 1\/2/);
  assert.match(view, /2026판/);
  assert.match(view, /2027판/);
  assert.match(
    workbookAnalytics(
      s.ctx('TA_TEACHER', '/homework?view=analysis&book=' + old.bookId),
      true,
    ),
    /확인 완료 1건 · 정답 1\/2/,
  );
  assert.throws(
    () =>
      workbookAnalytics(
        s.ctx('TA_TEACHER', '/homework?view=analysis&from=2026-02-30'),
        true,
      ),
    /기간/,
  );
});

test('승인 기록 누락·점수 불일치는 일부 문항만 집계하거나 공개하지 않는다', async (t) => {
  const s = setup(t),
    id = s.assign(),
    sub = s.submit(id, [0]);
  await s.approve(id, sub, [0]);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  s.db
    .prepare('UPDATE homework_marks SET awarded_points=1 WHERE submission_id=?')
    .run(sub);
  assert.deepEqual(readWorkbookAnalysis(s.db, 'AC_TEST_A').rejected, [sub]);
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  assert.match(workbookAnalytics(s.ctx(), true), /집계에서 제외/);
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), s.publicationForm(1)),
    /승인 결과/,
  );
  const second = s.assign({ title: '승인 일치 숙제' }),
    sub2 = s.submit(second);
  await s.approve(second, sub2);
  assert.equal(readWorkbookAnalysis(s.db, 'AC_TEST_A').results.length, 1);
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), s.publicationForm(1)),
    /승인 결과/,
  );
});

test('개별 배정·학원·보호자·현재 수강 권한을 상담 공개와 조회에 동일 적용한다', async (t) => {
  const s = setup(t),
    id = s.assign({ targetKind: 'student', recipient: 'TA_E_MATH|TA_STU_001' }),
    sub = s.submit(id);
  await s.approve(id, sub);
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx('TA_STUDENT_001'), s.publicationForm()),
    /교사/,
  );
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx('TA_GUARDIAN_E_MATH'), s.publicationForm()),
    /교사/,
  );
  const other = s.publicationForm();
  other.set('classId', 'TA_M2');
  await assert.rejects(publishWorkbookAnalysis(s.ctx(), other), /권한/);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  const source = workbookEvidence(s.db, 'AC_TEST_A').documents[0];
  assert.equal(workbookEvidence(s.db, 'OTHER_ACADEMY').documents.length, 0);
  assert.throws(
    () => renderWorkbookSource(s.ctx('TA_GUARDIAN_M2'), source.documentId),
    /최신/,
  );
  const outsider = await s.ask(
    '가상학생A의 11월 수학 정답률 알려줘',
    'TA_GUARDIAN_M2',
    '',
  );
  assert.equal(outsider.answer.citations.length, 0);
  s.db
    .prepare(
      "UPDATE student_class_memberships SET ended_at='2026-11-16' WHERE student_id=? AND class_id=?",
    )
    .run('TA_STU_001', 'TA_E_MATH');
  assert.throws(() => renderWorkbookSource(s.ctx(), source.documentId), /최신/);
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), s.publicationForm(1)),
    /권한/,
  );
});

test('공개 검증 중 정정되면 원자적으로 거절하고 다른 교사의 이전 화면도 차단한다', async (t) => {
  const s = setup(t),
    id = s.assign(),
    sub = s.submit(id, [0]);
  await s.approve(id, sub, [0]);
  const original = InMemoryRagStore.prototype.upsertIndexedRevision;
  t.mock.method(
    InMemoryRagStore.prototype,
    'upsertIndexedRevision',
    async function (
      this: InMemoryRagStore,
      ...args: Parameters<typeof original>
    ) {
      const result = await original.apply(this, args);
      await s.approve(id, sub, [], 1);
      return result;
    },
  );
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), s.publicationForm()),
    /変更|변경/,
  );
  assert.equal(
    s.db.prepare('SELECT count(*) n FROM op_learning_publications').get()!.n,
    0,
  );
  t.mock.restoreAll();
  const form = s.publicationForm();
  await publishWorkbookAnalysis(s.ctx(), form);
  await assert.rejects(publishWorkbookAnalysis(s.ctx(), form), /공개 상태/);
});

test('같은 과목의 여러 반 분석은 질문에서 지정한 반만 선택하고 불명확한 합산은 보류한다', async (t) => {
  const s = setup(t);
  s.db
    .prepare('INSERT INTO classes(id,academy_id,name,subject) VALUES(?,?,?,?)')
    .run('extra', 'AC_TEST_A', '심화수학반', '수학');
  s.db
    .prepare('INSERT INTO teacher_classes(teacher_id,class_id) VALUES(?,?)')
    .run(s.ctx().actor.id, 'extra');
  s.db
    .prepare(
      'INSERT INTO student_class_memberships(student_id,class_id,academy_id) VALUES(?,?,?)',
    )
    .run('TA_STU_001', 'extra', 'AC_TEST_A');
  const shared = s.assign({ classId: ['TA_E_MATH', 'extra'] }),
    a = s.submit(shared, [0]);
  await s.approve(shared, a, [0]);
  const only = s.assign({ classId: 'extra', title: '심화반 추가 숙제' }),
    b = s.submit(only);
  await s.approve(only, b);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm(0, 'extra'));
  const specific = await s.ask('심화수학반 11월 전체 정답률 알려줘');
  assert.equal(specific.answer.status, 'answered', specific.answer.answer);
  assert.match(specific.answer.answer, /4문항 중 3문항/);
  const ambiguous = await s.ask('11월 수학 전체 정답률 알려줘');
  assert.notEqual(ambiguous.answer.status, 'answered');
});

test('반 과목 변경·승인 취소·누락 문항은 이전 공개 분석을 재사용하지 않는다', async (t) => {
  const s = setup(t),
    id = s.assign(),
    sub = s.submit(id);
  await s.approve(id, sub);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  s.db.prepare("UPDATE classes SET subject='영어' WHERE id='TA_E_MATH'").run();
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), s.publicationForm(1)),
    /승인 결과/,
  );
  s.db.prepare("UPDATE classes SET subject='수학' WHERE id='TA_E_MATH'").run();
  s.db
    .prepare('UPDATE homework_submissions SET confirmed_at=NULL WHERE id=?')
    .run(sub);
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
  s.db
    .prepare(
      'UPDATE homework_submissions SET confirmed_at=(SELECT finalized_at FROM homework_grade_revisions WHERE submission_id=? AND version=1) WHERE id=?',
    )
    .run(sub, sub);
  const q = assignedQuestions(s.ctx(), id)[0];
  s.db
    .prepare(
      'DELETE FROM homework_marks WHERE submission_id=? AND question_id=?',
    )
    .run(sub, q.id);
  assert.deepEqual(readWorkbookAnalysis(s.db, 'AC_TEST_A').rejected, [sub]);
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').facts.length, 0);
});

test('학생이 반에서 이동한 뒤에도 관리자는 이전 공개를 철회할 수 있고 이전 교사는 할 수 없다', async (t) => {
  const s = setup(t),
    id = s.assign(),
    sub = s.submit(id);
  await s.approve(id, sub);
  await publishWorkbookAnalysis(s.ctx(), s.publicationForm());
  s.db
    .prepare(
      "UPDATE student_class_memberships SET ended_at='2026-11-16' WHERE student_id=? AND class_id=?",
    )
    .run('TA_STU_001', 'TA_E_MATH');
  const adminView = workbookAnalytics(
    s.ctx('TA_DIRECTOR', '/homework?view=analysis&student=TA_STU_001'),
    true,
  );
  assert.match(adminView, /상담 공개 철회/);
  assert.doesNotMatch(adminView, /value="publish-analysis"/);
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx(), s.publicationForm(1), true),
    /권한/,
  );
  await assert.rejects(
    publishWorkbookAnalysis(s.ctx('TA_DIRECTOR'), s.publicationForm(1)),
    /권한/,
  );
  await publishWorkbookAnalysis(
    s.ctx('TA_DIRECTOR'),
    s.publicationForm(1),
    true,
  );
  assert.equal(workbookEvidence(s.db, 'AC_TEST_A').documents.length, 0);
});
