/** Explicit operational acceptance runner. No live calls unless --live-neis is supplied. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  initializeIdentity,
  getActor,
} from '../src/features/academy-operations/directory.ts';
import { documentsModule } from '../src/features/academy-operations/documents.ts';
import { consultationModule } from '../src/features/academy-operations/consultation.ts';
import {
  knowledgeModule,
  createKnowledgeDraft,
} from '../src/features/academy-operations/knowledge.ts';
import {
  schoolsModule,
  rankSchoolSuggestions,
  isExamCandidate,
  type SchoolExam,
} from '../src/features/academy-operations/schools.ts';
import { publicDataModule } from '../src/features/academy-operations/public-data.ts';
import { scheduleModule } from '../src/features/academy-operations/schedule.ts';
import {
  voiceModule,
  spokenAnswer,
} from '../src/features/academy-operations/voice.ts';
import { createExternalServices } from '../src/features/academy-operations/external-services.ts';
import {
  createNeisClient,
  neisText,
} from '../src/features/academy-operations/neis.ts';
import type { RagAnswer } from '../src/features/rag-consultation/contract.ts';
import type { PageContext } from '../src/features/academy-operations/shared.ts';

export const cases: readonly (readonly [string, string])[] = [
  ['학원 주소가 어디예요?', '합성로 37'],
  ['학원 주소 알려줘.', '합성로 37'],
  ['방문할 주소는?', '합성로 37'],
  ['등록된 주소를 알려주세요.', '합성로 37'],
  ['학원 위치와 주소 알려주세요.', '합성로 37'],
  ['주차 가능한가요?', '건물 지하'],
  ['주차 공간이 있나요?', '건물 지하'],
  ['주차 안내를 알려주세요.', '건물 지하'],
  ['학원 주차는 어떻게 하나요?', '건물 지하'],
  ['주차장을 이용할 수 있나요?', '건물 지하'],
  ['와이파이가 있나요?', '이용할 수 있습니다'],
  ['무선인터넷 이용 가능한가요?', '이용할 수 있습니다'],
  ['학원 와이파이 안내해주세요.', '이용할 수 있습니다'],
  ['인터넷을 사용할 수 있나요?', '이용할 수 있습니다'],
  ['wifi 사용 가능해요?', '이용할 수 있습니다'],
  ['자습실이 있나요?', '로비 옆'],
  ['자습 공간은 어디인가요?', '로비 옆'],
  ['학원 자습실 위치 알려줘.', '로비 옆'],
  ['독서실 위치를 알려주세요.', '로비 옆'],
  ['자습 안내 부탁해요.', '로비 옆'],
  ['환불은 어떻게 신청하나요?', '안내 데스크'],
  ['환불 신청 안내해주세요.', '안내 데스크'],
  ['환급 신청 방법은?', '안내 데스크'],
  ['수강을 그만두면 어떻게 하나요?', '안내 데스크'],
  ['환불 규정 알려주세요.', '안내 데스크'],
  ['셔틀 이용 방법 알려줘.', '안내 데스크'],
  ['통학버스는 어떻게 신청해요?', '안내 데스크'],
  ['셔틀 신청 안내해주세요.', '안내 데스크'],
  ['학원 셔틀을 이용할 수 있나요?', '안내 데스크'],
  ['통학버스 이용 안내 부탁합니다.', '안내 데스크'],
];
const makeForm = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const out = resolve(
  process.argv[process.argv.indexOf('--out') + 1] ||
    '.git/new-features-srs/acceptance',
);
if (!process.argv.includes('--out')) throw new Error('Use --out <folder>');
mkdirSync(out, { recursive: true });
const db = new DatabaseSync(':memory:');
initializeIdentity(db, 'acceptance-synthetic-only');
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
const services = createExternalServices();
const ctx = (who = 'TA_DIRECTOR'): PageContext => ({
  db,
  actor: getActor(db, who)!,
  url: new URL('http://localhost/'),
  services,
});
async function ask(question: string, who = 'TA_VISITOR') {
  const id = randomUUID(),
    started = performance.now();
  await consultationModule.submit(
    ctx(who),
    makeForm({ action: 'ask', conversationId: id, question }),
  );
  return {
    id,
    ms: performance.now() - started,
    answer: JSON.parse(
      String(
        db
          .prepare(
            "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer' ORDER BY id DESC LIMIT 1",
          )
          .get(id)!.response,
      ),
    ) as RagAnswer,
  };
}
const compact = (s: string) => s.replace(/\s/g, '');
// Approved synthetic public document; no conversation-to-knowledge feature.
const draftId = createKnowledgeDraft(ctx(), {
  kind: 'registration',
  title: '합성 학원 운영 안내',
  question: '합성 학원 운영 안내',
  provenance: '합성 평가 자료',
  body: [
    '## 주소\n주소: 충청남도 아산시 합성로 37',
    '## 주차\n주차장은 건물 지하에 있습니다.',
    '## 와이파이\n와이파이는 학원에서 이용할 수 있습니다.',
    '## 자습실\n자습실은 로비 옆에 있습니다.',
    '## 환불\n환불 신청은 안내 데스크에서 접수합니다.',
    '## 셔틀\n셔틀 신청은 안내 데스크에서 접수합니다.',
  ].join('\n\n'),
});
await knowledgeModule.submit(
  ctx(),
  makeForm({
    action: 'approve',
    id: draftId,
    version: '1',
    visibility: 'academy_public',
    from: '2020-01-01',
    until: '2030-12-31',
  }),
);
const voice = [];
for (const [question, expected] of cases) {
  const who = ctx('TA_GUARDIAN_E_MATH'),
    started = performance.now();
  const location = await voiceModule.submit(
    who,
    makeForm({ action: 'input', text: question }),
  );
  const id = new URL(String(location), 'http://localhost').searchParams.get(
    'id',
  )!;
  const turn = db
    .prepare('SELECT id FROM op_voice_turns WHERE session_id=?')
    .get(id)!;
  await voiceModule.submit(
    who,
    makeForm({ action: 'confirm', sessionId: id, turnId: String(turn.id) }),
  );
  const answer = JSON.parse(
    String(
      db.prepare('SELECT response FROM op_voice_turns WHERE id=?').get(turn.id)!
        .response,
    ),
  ) as RagAnswer;
  const chat = await ask(question, 'TA_GUARDIAN_E_MATH');
  voice.push({
    question,
    pass:
      answer.status === 'answered' &&
      compact(answer.answer).includes(compact(expected)),
    sameAsChat:
      answer.answer === chat.answer.answer &&
      JSON.stringify(answer.citations) ===
        JSON.stringify(chat.answer.citations),
    spoken: spokenAnswer(answer, question),
    answer,
    ms: performance.now() - started,
  });
}
const rankings = [];
for (let i = 0; i < 20; i++) {
  const start = new Date(Date.UTC(2026, 11, 5 + i)).toISOString().slice(0, 10),
    end = new Date(Date.parse(start) + 2 * 86400000).toISOString().slice(0, 10),
    canceled = new Date(Date.parse(start) - 7 * 86400000)
      .toISOString()
      .slice(0, 10);
  const dates = [
    start,
    end,
    new Date(Date.parse(start) - 86400000).toISOString().slice(0, 10),
    new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10),
  ];
  const source = dates.map((date, n) => ({
    slot: {
      date,
      start: n % 2 ? '16:00' : '17:00',
      end: n % 2 ? '17:00' : '18:00',
      room: '교실 ' + ((i % 3) + 1),
    },
    attendance: { available: [], unavailable: [], unknown: [] },
  }));
  const result = rankSchoolSuggestions(
    i % 2 ? source.toReversed() : source,
    [{ name: '합성 시험 ' + i, start, end } as SchoolExam],
    canceled,
  );
  rankings.push({
    start,
    end,
    canceled,
    pass:
      !result[0].examConflicts.length &&
      result[0].beforeExam &&
      result.length === source.length,
    result,
  });
}
// Fixed synthetic school calendar: two grades, multiple days and semesters.
db.prepare('INSERT INTO op_schools VALUES(?,?,?,?,?)').run(
  'N10:synthetic',
  'AC_TEST_A',
  '새봄중학교',
  'N10',
  'synthetic',
);
for (const [classId, grade] of [
  ['TA_M2_EXAM', 2],
  ['TA_M3', 3],
] as const) {
  await schoolsModule.submit(
    ctx(),
    makeForm({
      action: 'link',
      schoolId: 'N10:synthetic',
      classId,
      grade: String(grade),
    }),
  );
  for (const [name, date] of [
    ['중간고사', `2027-04-${grade === 2 ? '20' : '22'}`],
    ['기말고사', `2027-07-${grade === 2 ? '01' : '03'}`],
    ['기말고사', `2027-12-${grade === 2 ? '10' : '15'}`],
    ['기말고사', `2027-12-${grade === 2 ? '11' : '16'}`],
  ]) {
    await schoolsModule.submit(
      ctx(),
      makeForm({
        action: 'manual',
        schoolId: 'N10:synthetic',
        name,
        from: date,
        until: date,
        grades: String(grade),
        source: 'https://school.example.invalid/calendar',
      }),
    );
    const exam = db
      .prepare('SELECT id FROM op_school_exams ORDER BY rowid DESC LIMIT 1')
      .get()!;
    await schoolsModule.submit(
      ctx(),
      makeForm({
        action: 'approve',
        id: String(exam.id),
        version: '1',
        grades: String(grade),
      }),
    );
  }
}
const schoolDates = [];
for (const grade of [2, 3]) {
  const mid = [`2027-04-${grade === 2 ? '20' : '22'}`],
    firstFinal = [`2027-07-${grade === 2 ? '01' : '03'}`],
    lastFinal = [
      `2027-12-${grade === 2 ? '10' : '15'}`,
      `2027-12-${grade === 2 ? '11' : '16'}`,
    ];
  const prefix = `새봄중학교 ${grade}학년`;
  const questions: [string, string[]][] = [
    [`${prefix} 2027년 중간고사 날짜는 언제인가요?`, mid],
    [`2027년 ${prefix} 중간고사 일정 알려주세요.`, mid],
    [`${prefix} 2027년 4월 시험 일정은?`, mid],
    [`${prefix} 2027년 4월 고사 기간 알려줘.`, mid],
    [`${prefix} 2027년 7월 기말고사 날짜는?`, firstFinal],
    [`2027년 7월 ${prefix} 시험 일정 알려주세요.`, firstFinal],
    [`${prefix} 2027년 12월 기말고사 날짜는 언제인가요?`, lastFinal],
    [`2027년 12월 ${prefix} 기말고사 일정 알려줘.`, lastFinal],
    [`${prefix} 2027년 12월 시험 기간은?`, lastFinal],
    [`${prefix} 2027년 12월 고사는 언제인가요?`, lastFinal],
  ];
  for (const [question, expectedDates] of questions) {
    const result = await ask(question, 'TA_DIRECTOR');
    const actualDates = [
      ...new Set(result.answer.answer.match(/2027-\d{2}-\d{2}/g) ?? []),
    ].sort();
    schoolDates.push({
      question,
      expectedDates,
      actualDates,
      pass:
        result.answer.status === 'answered' &&
        JSON.stringify(actualDates) === JSON.stringify(expectedDates) &&
        result.answer.citations.length > 0 &&
        result.answer.citations.every(
          (c) =>
            c.documentId.startsWith('school-') &&
            c.title.includes(grade + '학년'),
        ),
      ...result,
    });
  }
}
const report = {
  kind: 'synthetic-operational-acceptance',
  realVoiceRecordings: false,
  voice: {
    pass: voice.filter((r) => r.pass).length,
    sameAsChat: voice.filter((r) => r.sameAsChat).length,
    total: 30,
    results: voice,
  },
  rankings: {
    pass: rankings.filter((r) => r.pass).length,
    total: 20,
    results: rankings,
  },
  schoolDates: {
    pass: schoolDates.filter((r) => r.pass).length,
    total: 20,
    results: schoolDates,
  },
};
writeFileSync(join(out, 'acceptance.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    voice: {
      pass: report.voice.pass,
      sameAsChat: report.voice.sameAsChat,
      total: 30,
    },
    rankings: { pass: report.rankings.pass, total: 20 },
    schoolDates: { pass: report.schoolDates.pass, total: 20 },
  }),
);
if (process.argv.includes('--live-neis')) {
  const neis = createNeisClient(process.env.AXR_NEIS_API_KEY),
    names = [
      '아산중학교',
      '온양중학교',
      '온양여자중학교',
      '온양용화중학교',
      '아산고등학교',
      '온양고등학교',
      '온양여자고등학교',
      '설화고등학교',
      '배방고등학교',
      '충남외국어고등학교',
    ];
  const schools = [];
  for (const name of names) {
    const info = await neis.query('schoolInfo', {
      ATPT_OFCDC_SC_CODE: 'N10',
      SCHUL_NM: name,
    });
    const school = info.rows.find((r) => neisText(r, 'SCHUL_NM') === name);
    if (!school) {
      schools.push({ name, error: 'exact school not returned' });
      continue;
    }
    const schedule = await neis.query('SchoolSchedule', {
      ATPT_OFCDC_SC_CODE: 'N10',
      SD_SCHUL_CODE: neisText(school, 'SD_SCHUL_CODE'),
      AA_FROM_YMD: '20260801',
      AA_TO_YMD: '20261231',
    });
    schools.push({
      name,
      address: neisText(school, 'ORG_RDNMA'),
      ...schedule,
      examCandidates: schedule.rows.filter((r) =>
        isExamCandidate(neisText(r, 'EVENT_NM')),
      ),
    });
  }
  const academies = await neis.query('acaInsTiInfo', {
    ATPT_OFCDC_SC_CODE: 'N10',
    ADMST_ZONE_NM: '아산시',
    ACA_NM: '삼성',
  });
  writeFileSync(
    join(out, 'live-neis.json'),
    JSON.stringify({ schools, academies }, null, 2),
  );
  console.log(
    JSON.stringify({
      liveSchools: schools.length,
      completeSchools: schools.filter((s) => 'complete' in s && s.complete)
        .length,
      academies: academies.rows.length,
      academySearchComplete: academies.complete,
    }),
  );
}
db.close();
