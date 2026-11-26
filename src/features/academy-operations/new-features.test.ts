import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { initializeIdentity, getActor } from './directory.ts';
import { documentsModule } from './documents.ts';
import { consultationModule } from './consultation.ts';
import {
  configureOperationsGeneration,
  operationsGeneration,
} from './runtime-generation.ts';
import { scheduleModule } from './schedule.ts';
import { createExternalServices } from './external-services.ts';
import { publicDataModule } from './public-data.ts';
import { academyRegistration, createNeisClient } from './neis.ts';
import {
  knowledgeModule,
  createKnowledgeDraft,
  knowledgeEvidence,
  dateInput,
} from './knowledge.ts';
import {
  schoolsModule,
  schoolEvidence,
  schoolQuerySelection,
  rankSchoolSuggestions,
  eventGrades,
  isExamCandidate,
  type SchoolExam,
} from './schools.ts';
import {
  voiceModule,
  spokenAnswer,
  redactPhones,
  voiceAudio,
} from './voice.ts';
import type { RagAnswer } from '../rag-consultation/contract.ts';
import type { PageContext } from './shared.ts';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
function setup(t: TestContext, fetchImpl?: typeof fetch) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  initializeIdentity(db, 'new-feature-test');
  for (const m of [
    documentsModule,
    scheduleModule,
    consultationModule,
    knowledgeModule,
    schoolsModule,
    publicDataModule,
    voiceModule,
  ])
    m.setup(db);
  const services = createExternalServices({}, fetchImpl);
  const ctx = (id = 'TA_DIRECTOR'): PageContext => ({
    db,
    actor: getActor(db, id)!,
    url: new URL('http://localhost/'),
    services,
  });
  async function ask(
    question: string,
    who = 'TA_GUARDIAN_E_MATH',
    studentId = '',
  ) {
    const id = randomUUID();
    await consultationModule.submit(
      ctx(who),
      form({ action: 'ask', conversationId: id, question, studentId }),
    );
    const answer = JSON.parse(
      String(
        db
          .prepare(
            "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer' ORDER BY id DESC LIMIT 1",
          )
          .get(id)!.response,
      ),
    ) as RagAnswer;
    return { id, answer };
  }
  async function approve(id: string, extra: Record<string, string> = {}) {
    await knowledgeModule.submit(
      ctx(),
      form({
        action: 'approve',
        id,
        version: '1',
        visibility: 'academy_public',
        from: '2020-01-01',
        until: '2030-12-31',
        ...extra,
      }),
    );
  }
  return { db, ctx, ask, approve, services };
}
function json(endpoint: string, rows: object[], total = rows.length) {
  return Response.json({
    [endpoint]: [
      { head: [{ list_total_count: total }, { RESULT: { CODE: 'INFO-000' } }] },
      { row: rows },
    ],
  });
}

test('F1 비공개 교습비는 응답에 금액이 있어도 삭제한다', () => {
  assert.equal(
    academyRegistration({
      ACA_ASNUM: 'A',
      ACA_NM: '학원',
      THCC_OTHBC_YN: 'N',
      PSNBY_THCC_CNTNT: '999999원',
    }).fee,
    '',
  );
});
test('F1 실제 형태 응답 → 선택 → 승인 → 상담 출처, 승인 전 차단', async (t) => {
  const s = setup(t, async () =>
    json('acaInsTiInfo', [
      {
        ACA_ASNUM: 'R001',
        ACA_NM: '합성학원',
        ATPT_OFCDC_SC_CODE: 'N10',
        FA_RDNMA: '충청남도 아산시 합성로 37',
        THCC_OTHBC_YN: 'N',
        PSNBY_THCC_CNTNT: '99999원',
      },
    ]),
  );
  const redirect = await publicDataModule.submit(
    s.ctx(),
    form({ action: 'search', office: 'N10', name: '합성학원' }),
  );
  const search = new URL(String(redirect), 'http://localhost').searchParams.get(
    'search',
  )!;
  await publicDataModule.submit(
    s.ctx(),
    form({ action: 'import', search, index: '0' }),
  );
  const draft = s.db.prepare('SELECT * FROM op_knowledge').get()!;
  assert.equal(knowledgeEvidence(s.db, 'AC_TEST_A').length, 0);
  assert.doesNotMatch(String(draft.body), /99999/);
  await s.approve(String(draft.id));
  const { answer } = await s.ask('학원 주소가 어디예요?');
  assert.equal(answer.status, 'answered', JSON.stringify(answer));
  assert.match(answer.answer, /합성로 37/);
  assert.ok(
    answer.citations.some(
      (c) =>
        c.title.includes('교육청 등록 정보') && c.title.includes('원장 확인'),
    ),
  );
});
test('나이스 키 없는 샘플을 전체 결과로 표시하지 않고 오류를 빈 목록으로 오인하지 않는다', async () => {
  let calls = 0;
  const client = createNeisClient('', async () => {
    calls++;
    return json('schoolInfo', [{ SD_SCHUL_CODE: '1' }], 100);
  });
  const a = await client.query('schoolInfo', {}),
    b = await client.query('schoolInfo', {});
  assert.equal(a.complete, false);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  const bad = createNeisClient('', async () =>
    Response.json({ RESULT: { CODE: 'ERROR-290' } }),
  );
  await assert.rejects(bad.query('schoolInfo', {}));
});
test('나이스 페이지를 모두 받으며 출처에 키를 남기지 않는다', async () => {
  const client = createNeisClient('test-only', async (url) => {
    const page = new URL(String(url)).searchParams.get('pIndex');
    return json('schoolInfo', [{ SD_SCHUL_CODE: page }], 2);
  });
  const result = await client.query('schoolInfo', {});
  assert.equal(result.rows.length, 2);
  assert.equal(result.complete, true);
  assert.doesNotMatch(result.source, /test-only|KEY/);
});
test('F1 등록 정보 만료와 미승인 자료는 색인 입력에서 제외된다', async (t) => {
  const s = setup(t),
    id = createKnowledgeDraft(s.ctx(), {
      kind: 'registration',
      title: '우산 대여',
      question: '우산 빌릴 수 있나요?',
      body: '우산은 안내 데스크에서 대여합니다.',
      provenance: '원장 답변',
    });
  await s.approve(id, { until: '2020-01-02' });
  assert.equal(knowledgeEvidence(s.db, 'AC_TEST_A').length, 0);
});
test('F1 기존 등록 정보 교체를 확인해야 하며 미래 적용 전까지 기존 답변을 유지한다', async (t) => {
  const s = setup(t);
  const input = {
    kind: 'registration' as const,
    title: '대여',
    question: '우산 대여?',
    body: '우산은 안내 데스크에서 빌립니다.',
    provenance: '원장 답변',
  };
  const a = createKnowledgeDraft(s.ctx(), input);
  await s.approve(a);
  const b = createKnowledgeDraft(s.ctx(), {
    ...input,
    body: '우산은 보관실에서 빌립니다.',
  });
  await assert.rejects(s.approve(b), /교체/);
  await s.approve(b, { from: '2029-01-01', replace: a + ':2' });
  assert.equal(
    knowledgeEvidence(s.db, 'AC_TEST_A')[0].documentId,
    'knowledge-' + a,
  );
  assert.equal(
    knowledgeEvidence(s.db, 'AC_TEST_A', Date.parse('2029-01-02'))[0]
      .documentId,
    'knowledge-' + b,
  );
});
test('공개 지식 관리 권한·날짜 오류·교차 학원 접근 차단', async (t) => {
  const s = setup(t);
  assert.throws(
    () =>
      createKnowledgeDraft(s.ctx('TA_VISITOR'), {
        kind: 'registration',
        title: 'x',
        question: 'x',
        body: 'x',
        provenance: 'x',
      }),
    /원장/,
  );
  for (const d of ['2026-13-01', '2026-02-30', '2026-00-00'])
    assert.throws(() => dateInput(d, '날짜'));
  const id = createKnowledgeDraft(s.ctx(), {
    kind: 'registration',
    title: 'x',
    question: 'x',
    body: '자료입니다.',
    provenance: 'x',
  });
  const other = s.ctx();
  other.actor = { ...other.actor, academyId: 'elsewhere' };
  await assert.rejects(async () =>
    knowledgeModule.submit(
      other,
      form({
        action: 'approve',
        id,
        version: '1',
        visibility: 'academy_public',
        from: '2020-01-01',
        until: '2030-01-01',
      }),
    ),
  );
});
test('F4 행사명 필터와 미확정 학년은 추측 없이 보존한다', () => {
  for (const name of ['중간고사', '기말시험', '전국연합학력평가'])
    assert.equal(isExamCandidate(name), true);
  for (const name of ['운동회', '방학식'])
    assert.equal(isExamCandidate(name), false);
  assert.deepEqual(
    eventGrades({ ONE_GRADE_EVENT_YN: 'Y', TW_GRADE_EVENT_YN: 'N' }),
    [1],
  );
  assert.deepEqual(eventGrades({}), []);
});
test('F4 학교 등록 → 일정 수집 → 반 연결 → 승인 전후 근거 범위', async (t) => {
  const s = setup(t, async (url) =>
    String(url).includes('schoolInfo')
      ? json('schoolInfo', [
          {
            SCHUL_NM: '합성중학교',
            ATPT_OFCDC_SC_CODE: 'N10',
            SD_SCHUL_CODE: 'S1',
          },
        ])
      : json('SchoolSchedule', [
          {
            SD_SCHUL_CODE: 'S1',
            AA_YMD: '20261210',
            EVENT_NM: '기말고사',
            TW_GRADE_EVENT_YN: 'Y',
          },
        ]),
  );
  const redirect = await schoolsModule.submit(
    s.ctx(),
    form({ action: 'search', office: 'N10', name: '합성중학교' }),
  );
  await schoolsModule.submit(
    s.ctx(),
    form({
      action: 'select',
      search: new URL(String(redirect), 'http://localhost').searchParams.get(
        'search',
      )!,
      index: '0',
    }),
  );
  await schoolsModule.submit(
    s.ctx(),
    form({
      action: 'import',
      schoolId: 'N10:S1',
      from: '2026-08-01',
      until: '2026-12-31',
    }),
  );
  await schoolsModule.submit(
    s.ctx(),
    form({
      action: 'link',
      schoolId: 'N10:S1',
      classId: 'TA_M2_EXAM',
      grade: '2',
    }),
  );
  assert.equal(schoolEvidence(s.db, 'AC_TEST_A').length, 0);
  const exam = s.db.prepare('SELECT id FROM op_school_exams').get()!;
  await schoolsModule.submit(
    s.ctx(),
    form({ action: 'approve', id: String(exam.id), version: '1', grades: '2' }),
  );
  const docs = schoolEvidence(s.db, 'AC_TEST_A');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].classId, 'TA_M2_EXAM');
  assert.ok(
    schoolQuerySelection(
      s.ctx('TA_GUARDIAN_M2'),
      '합성중학교 2학년 기말고사 날짜는 언제인가요?',
    ),
  );
  const { answer } = await s.ask(
    '합성중학교 2학년 기말고사 날짜는 언제인가요?',
    'TA_GUARDIAN_M2',
  );
  assert.equal(answer.status, 'answered', JSON.stringify(answer));
  assert.match(answer.answer, /2026-12-10/);
  assert.ok(
    answer.citations.every((c) => c.title.includes('학교 공지가 우선')),
  );
});
test('F4 추천 입력 순서에 무관하게 시험 겹침 후순위·시험 전 우선·후보 보존', () => {
  for (let i = 0; i < 2; i++) {
    const exams = [
      { start: '2026-12-10', end: '2026-12-12', name: '기말' } as SchoolExam,
    ];
    const suggestions = ['2026-12-11', '2026-12-15', '2026-12-08'].map(
      (date) => ({
        slot: { date, start: '16:00', end: '17:00', room: '교실' },
        attendance: { available: [], unavailable: [], unknown: [] },
      }),
    );
    const ranked = rankSchoolSuggestions(
      i % 2 ? suggestions.toReversed() : suggestions,
      exams,
      '2026-12-01',
    );
    assert.equal(ranked[0].slot.date, '2026-12-08');
    assert.equal(ranked[2].examConflicts.length, 1);
    assert.equal(ranked.length, 3);
  }
});
test('F6 글 입력 → 확인 전 답변 없음 → 확인 → 채팅과 같은 답변', async (t) => {
  const s = setup(t),
    guardian = s.ctx('TA_GUARDIAN_E_MATH');
  const id = createKnowledgeDraft(s.ctx(), {
    kind: 'registration',
    title: '분실물 안내',
    question: '학원 주소가 어디예요?',
    body: '## 주소\n주소: 충청남도 아산시 합성로 37',
    provenance: '원장 답변',
  });
  await s.approve(id);
  const redirect = await voiceModule.submit(
    guardian,
    form({ action: 'input', text: '학원 주소가 어디예요?' }),
  );
  const sessionId = new URL(
    String(redirect),
    'http://localhost',
  ).searchParams.get('id')!;
  const turn = s.db.prepare('SELECT * FROM op_voice_turns').get()!;
  assert.equal(turn.state, 'pending');
  assert.equal(
    s.db.prepare('SELECT count(*) AS n FROM op_consultation_messages').get()!.n,
    0,
  );
  await voiceModule.submit(
    guardian,
    form({ action: 'confirm', sessionId, turnId: String(turn.id) }),
  );
  const response = JSON.parse(
    String(s.db.prepare('SELECT response FROM op_voice_turns').get()!.response),
  ) as RagAnswer;
  const chat = await s.ask('학원 주소가 어디예요?', 'TA_GUARDIAN_E_MATH');
  assert.equal(response.answer, chat.answer.answer);
  assert.deepEqual(response.citations, chat.answer.citations);
  await assert.rejects(
    async () =>
      voiceModule.submit(
        guardian,
        form({ action: 'confirm', sessionId, turnId: String(turn.id) }),
      ),
    /변경/,
  );
});
test('F6 확인 두 번 실패하면 엔진 호출 없이 담당자에게 넘긴다', async (t) => {
  const s = setup(t),
    ctx = s.ctx('TA_GUARDIAN_E_MATH');
  let redirect = await voiceModule.submit(
    ctx,
    form({ action: 'input', text: '목요일 4시 맞나요?' }),
  );
  const sessionId = new URL(
    String(redirect),
    'http://localhost',
  ).searchParams.get('id')!;
  for (let n = 0; n < 2; n++) {
    const turn = s.db
      .prepare("SELECT id FROM op_voice_turns WHERE state='pending'")
      .get()!;
    await voiceModule.submit(
      ctx,
      form({ action: 'retry', sessionId, turnId: String(turn.id) }),
    );
    if (!n)
      redirect = await voiceModule.submit(
        ctx,
        form({ action: 'input', sessionId, text: '금요일 5시 맞나요?' }),
      );
  }
  assert.equal(
    s.db.prepare('SELECT closed FROM op_voice_sessions').get()!.closed,
    1,
  );
  assert.equal(
    s.db.prepare('SELECT status FROM op_consultation_threads').get()!.status,
    'requested',
  );
  assert.equal(
    s.db
      .prepare(
        "SELECT count(*) AS n FROM op_consultation_messages WHERE kind='answer'",
      )
      .get()!.n,
    0,
  );
});
test('F6 성적·채점 수치는 읽지 않고 다른 보호자 접근을 차단한다', async (t) => {
  const answer: RagAnswer = {
    status: 'answered',
    answer: '정답률 95%, 19문제 정답입니다.',
    citations: [
      { sourceId: 's', documentId: 'workbook-1', title: '결과', revision: 1 },
    ],
    requestId: 'r',
  };
  assert.doesNotMatch(spokenAnswer(answer, '결과 알려줘'), /95|19/);
  assert.doesNotMatch(
    redactPhones('연락처 010-1234-5678 또는 02 123 4567'),
    /1234|4567/,
  );
  const s = setup(t);
  await voiceModule.submit(
    s.ctx('TA_GUARDIAN_E_MATH'),
    form({ action: 'input', text: '수업 있나요?' }),
  );
  const turn = s.db.prepare('SELECT id FROM op_voice_turns').get()!;
  await assert.rejects(
    voiceAudio(s.ctx('TA_GUARDIAN_M2'), form({ turnId: String(turn.id) })),
    /찾을 수/,
  );
  await assert.rejects(
    async () =>
      voiceModule.submit(
        s.ctx('TA_VISITOR'),
        form({ action: 'input', text: '질문' }),
      ),
    /보호자/,
  );
});

test('F4 여러 시험일·다른 달·다른 학년을 구분하고 철회 시 인용 버전을 바꾼다', async (t) => {
  const s = setup(t);
  s.db
    .prepare('INSERT INTO op_schools VALUES(?,?,?,?,?)')
    .run('S', 'AC_TEST_A', '합성중학교', 'N10', 'S');
  for (const [classId, grade] of [
    ['TA_M2_EXAM', '2'],
    ['TA_M3', '3'],
  ])
    await schoolsModule.submit(
      s.ctx(),
      form({ action: 'link', schoolId: 'S', classId, grade }),
    );
  for (const [date, grade] of [
    ['2027-11-10', '2'],
    ['2027-12-10', '2'],
    ['2027-12-11', '2'],
    ['2027-12-20', '3'],
  ]) {
    await schoolsModule.submit(
      s.ctx(),
      form({
        action: 'manual',
        schoolId: 'S',
        name: '기말고사',
        from: date,
        until: date,
        grades: grade,
        source: 'https://school.example.invalid/notice',
      }),
    );
    const e = s.db
      .prepare('SELECT id FROM op_school_exams ORDER BY rowid DESC LIMIT 1')
      .get()!;
    await schoolsModule.submit(
      s.ctx(),
      form({
        action: 'approve',
        id: String(e.id),
        version: '1',
        grades: grade,
      }),
    );
  }
  const { answer } = await s.ask(
    '합성중학교 2학년 2027년 12월 시험 일정 알려줘.',
    'TA_GUARDIAN_M2',
  );
  const ambiguous = await s.ask(
    '합성중학교 2학년 2027년 기말고사 날짜는?',
    'TA_GUARDIAN_M2',
  );
  assert.equal(ambiguous.answer.status, 'clarify');
  assert.equal(ambiguous.answer.clarifyOptions?.length, 2);
  assert.deepEqual(ambiguous.answer.citations, []);
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /2027-12-10/);
  assert.match(answer.answer, /2027-12-11/);
  assert.doesNotMatch(answer.answer, /2027-11-10|2027-12-20/);
  assert.ok(answer.citations.some((c) => c.location?.includes('2행')));
  const first = schoolQuerySelection(
    s.ctx('TA_GUARDIAN_M2'),
    '합성중학교 2학년 2027년 12월 시험 일정은?',
  )!.documents[0];
  const complete = schoolEvidence(s.db, 'AC_TEST_A').find(
    (d) => d.documentId === first.documentId,
  )!;
  assert.equal(first.text, complete.text);
  assert.equal(first.revision, complete.revision);
  const e = s.db
    .prepare("SELECT id FROM op_school_exams WHERE start='2027-12-11'")
    .get()!;
  await schoolsModule.submit(
    s.ctx(),
    form({ action: 'revoke', id: String(e.id), version: '2' }),
  );
  assert.notEqual(
    schoolEvidence(s.db, 'AC_TEST_A').find(
      (d) => d.documentId === first.documentId,
    )!.revision,
    first.revision,
  );
  const after = await s.ask(
    '합성중학교 2학년 2027년 12월 시험 일정 알려줘.',
    'TA_GUARDIAN_M2',
  );
  assert.doesNotMatch(after.answer.answer, /2027-12-11/);
  for (const q of [
    '존재없는중학교 2학년 시험 날짜는?',
    '합성중학교 1학년 시험 날짜는?',
  ]) {
    const result = await s.ask(q, 'TA_GUARDIAN_M2');
    assert.notEqual(
      result.answer.status,
      'answered',
      JSON.stringify(result.answer),
    );
  }
  assert.deepEqual(
    schoolQuerySelection(
      s.ctx('TA_GUARDIAN_E_MATH'),
      '합성중학교 2학년 시험 날짜는?',
    )!.documents,
    [],
  );
});

test('F6 음성 합성 중 근거 철회가 발생하면 오디오를 반환하지 않는다', async (t) => {
  const s = setup(t),
    q = '학원 주소가 어디예요?';
  const id = createKnowledgeDraft(s.ctx(), {
    kind: 'registration',
    title: q,
    question: q,
    body: '## 주소\n주소: 충청남도 아산시 합성로 37',
    provenance: '원장 답변',
  });
  await s.approve(id);
  const who = s.ctx('TA_GUARDIAN_E_MATH');
  await voiceModule.submit(who, form({ action: 'input', text: q }));
  const turn = s.db.prepare('SELECT id,session_id FROM op_voice_turns').get()!;
  await voiceModule.submit(
    who,
    form({
      action: 'confirm',
      sessionId: String(turn.session_id),
      turnId: String(turn.id),
    }),
  );
  s.services.synthesize = async () => {
    await knowledgeModule.submit(
      s.ctx(),
      form({ action: 'revoke', id, version: '2' }),
    );
    return new Uint8Array([1]);
  };
  await assert.rejects(
    voiceAudio(who, form({ turnId: String(turn.id) })),
    /변경/,
  );
});

test('F6 인식 중 상담을 종료해도 뒤늦은 결과를 확인 대기로 저장하지 않는다', async (t) => {
  const s = setup(t),
    who = s.ctx('TA_GUARDIAN_E_MATH');
  s.services.transcribe = async () => {
    const session = s.db.prepare('SELECT id FROM op_voice_sessions').get()!;
    await voiceModule.submit(
      who,
      form({ action: 'end', sessionId: String(session.id) }),
    );
    return { text: '내일 수업 있나요?', confidence: 1 };
  };
  const input = form({ action: 'input' });
  input.set('audio', new File(['fixture'], 'q.wav', { type: 'audio/wav' }));
  await voiceModule.submit(who, input);
  assert.equal(
    s.db.prepare('SELECT state FROM op_voice_turns').get()!.state,
    'failed',
  );
  assert.equal(
    s.db.prepare('SELECT count(*) AS n FROM op_consultation_messages').get()!.n,
    0,
  );
});

test('F6 공통 채팅 엔진은 통학버스 신청을 셔틀 근거에 연결하고 와이파이를 답하지 않는다', async (t) => {
  const s = setup(t),
    id = createKnowledgeDraft(s.ctx(), {
      kind: 'registration',
      title: '합성 학원 운영 안내',
      question: '운영 안내',
      provenance: '합성 평가 자료',
      body: '## 셔틀\n셔틀 신청은 안내 데스크에서 접수합니다.\n\n## 와이파이\n와이파이는 학원에서 이용할 수 있습니다.',
    });
  await s.approve(id);
  for (const question of [
    '통학버스는 어떻게 신청해요?',
    '통학버스 이용 안내 부탁합니다.',
  ]) {
    const { answer } = await s.ask(question, 'TA_GUARDIAN_E_MATH');
    assert.equal(answer.status, 'answered');
    assert.match(answer.answer, /셔틀 신청/);
    assert.doesNotMatch(answer.answer, /와이파이/);
    assert.ok(answer.citations.some((c) => c.location?.includes('셔틀')));
  }
});

test('보호자 일반 상담은 공개된 상담 예약 시각만 해당 문서에서 인용한다', async (t) => {
  const s = setup(t);
  const originalProvider = operationsGeneration();
  t.after(() => configureOperationsGeneration(originalProvider));
  configureOperationsGeneration({
    providerId: 'clova:local-test',
    isExternal: false,
    personalDataApproved: false,
    availability: () => 'available',
    generateGroundedAnswer: async () =>
      assert.fail('예약 시각을 외부에 질의했습니다'),
  });
  const saveDocument = async (
    title: string,
    text: string,
    visibility = 'academy_public',
  ) => {
    await documentsModule.submit(
      s.ctx(),
      form({
        action: 'save',
        title,
        text,
        documentType: 'policy',
        visibility,
        validFrom: '2020-01-01T00:00',
      }),
    );
    const documentId = String(
      s.db
        .prepare(
          "SELECT document_id FROM op_document_versions WHERE json_extract(input, '$.title')=?",
        )
        .get(title)!.document_id,
    );
    await documentsModule.submit(
      s.ctx(),
      form({ action: 'approve', documentId, revision: '1' }),
    );
    return documentId;
  };
  const guardian = 'TA_GUARDIAN_E_MATH';
  const question = '가상 검증 상담 예약은 무슨 요일 몇 시인가요?';
  const year = new Date().getUTCFullYear() + 1;
  await scheduleModule.submit(
    s.ctx(),
    form({
      action: 'save_notice',
      class_id: 'TA_E_MATH',
      title: '초등 수학반 휴강과 보강',
      closure_start: year + '-12-01T16:00',
      closure_end: year + '-12-01T17:00',
      makeup_kind: 'scheduled',
      makeup_start: year + '-12-05T14:00',
      makeup_end: year + '-12-05T15:00',
    }),
  );
  const id = await saveDocument(
    '[가상 검증 전용] 11월 19일 브라우저 안내',
    '[가상 검증 자료] 브라우저 기능 확인 전용 안내입니다. 가상 검증 상담 예약은 매주 목요일 오후 7시입니다. 실제 학원 운영 안내나 학생 정보가 아닙니다.',
  );
  const other = await saveDocument(
    '운영 안내',
    '진학 상담 예약은 매주 화요일 11:30입니다.',
  );
  const table = await saveDocument(
    '업무별 시간',
    '| 구분 | 요일 | 시간 |\n|---|---|---|\n| 보강 | 월요일 | 13:15 |\n| 상담 예약 | 금요일 | 16:30~18:00 |',
  );
  await saveDocument(
    '직원 안내',
    '가상 검증 상담 예약은 매주 수요일 오전 8시입니다.',
    'staff_only',
  );
  await saveDocument(
    '보강 안내',
    '가상 검증 상담 예약은 추후 안내합니다. 초등 수학반 보강은 토요일 14:00~15:00입니다.',
  );
  for (const [q, expectedId, value] of [
    [question, id, '목요일 오후 7시'],
    ['진학 상담 예약은 무슨 요일 몇 시인가요?', other, '화요일 11:30'],
    ['학원 상담 예약은 무슨 요일 몇 시인가요?', table, '16:30~18:00'],
    ['우리 학원 상담 예약은 무슨 요일 몇 시인가요?', table, '금요일'],
    [
      '혹시 우리 학원 진학 상담 예약은 무슨 요일 몇 시인가요?',
      other,
      '화요일 11:30',
    ],
  ]) {
    const { answer } = await s.ask(q, guardian);
    assert.equal(answer.status, 'answered', answer.answer);
    assert.ok(answer.answer.includes(value), answer.answer);
    assert.deepEqual(
      answer.citations.map((c) => c.documentId),
      [expectedId],
    );
  }
  await documentsModule.submit(
    s.ctx(),
    form({ action: 'withdraw', documentId: id, revision: '1' }),
  );
  const { answer } = await s.ask(question, guardian);
  assert.equal(answer.status, 'abstained', answer.answer);
  assert.deepEqual(answer.citations, []);
  await assert.rejects(s.ask(question, 'TA_DIRECTOR'), /학생과 학부모만/);
  const { answer: makeup } = await s.ask(
    year + '년 12월 1일 초등 수학반 휴강 보강은 언제인가요?',
    guardian,
  );
  assert.equal(makeup.status, 'answered', makeup.answer);
  assert.match(makeup.answer, /14:00/);
  assert.ok(
    makeup.citations.some((c) => c.documentId.startsWith('ops-schedule-')),
  );
});
