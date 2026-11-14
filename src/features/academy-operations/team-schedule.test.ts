import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { getActor, initializeIdentity } from './directory.ts';
import { classOnDate } from '../makeup-schedule/model/timetable.ts';
import type { AcademyConfig } from '../makeup-schedule/model/types.ts';
import { documentsModule } from './documents.ts';
import { scheduleModule } from './schedule.ts';
import { consultationModule } from './consultation.ts';
import { teamScheduleModule, teamScheduleEvidence } from './team-schedule.ts';

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'team-schedule-tests');
  documentsModule.setup(db);
  scheduleModule.setup(db);
  consultationModule.setup(db);
  teamScheduleModule.setup(db);
  const ctx = (id: string) => {
    const actor = getActor(db, id);
    assert.ok(actor);
    return { db, actor, url: new URL('http://localhost/makeup') };
  };
  const version = () =>
    String(
      db
        .prepare('SELECT version FROM op_team_schedule WHERE academy_id = ?')
        .get('AC_TEST_A')?.version ?? 0,
    );
  const submit = async (
    fields: Record<string, string>,
    who = 'TA_DIRECTOR',
  ) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ version: version(), ...fields }))
      f.set(k, v);
    return teamScheduleModule.submit(ctx(who), f);
  };
  const config = () =>
    submit({
      action: 'config',
      config: JSON.stringify({
        capacity: 20,
        closeTime: '22:00',
        rooms: ['1강의실'],
        classes: [
          {
            classId: 'TA_E_MATH',
            days: [1, 3],
            start: '16:00',
            end: '17:00',
            room: '1강의실',
            teacher: 'TA_TEACHER',
          },
        ],
        holidays: {},
      }),
    });
  const ask = async (
    question: string,
    who = 'TA_GUARDIAN_E_MATH',
    studentId = 'TA_STU_001',
  ) => {
    const f = new FormData();
    const id = randomUUID();
    for (const [k, v] of Object.entries({
      action: 'ask',
      conversationId: id,
      question,
      studentId,
    }))
      f.set(k, v);
    await consultationModule.submit(ctx(who), f);
    return JSON.parse(
      String(
        db
          .prepare(
            "SELECT response FROM op_consultation_messages WHERE thread_id = ? AND kind='answer'",
          )
          .get(id)!.response,
      ),
    );
  };
  return { db, ctx, submit, config, ask, version };
}
test('팀 일정은 DB에 저장하며 임시·확정·변경·취소가 운영 상담에 반영된다', async (t) => {
  const s = setup(t);
  await s.config();
  await s.submit({
    action: 'create',
    scope: 'class',
    classId: 'TA_E_MATH',
    date: '2026-11-23',
    makeupDate: '2026-11-28',
    makeupStart: '10:00',
    room: '1강의실',
  });
  assert.equal(teamScheduleEvidence(s.db, 'AC_TEST_A').length, 0);
  await s.submit({ action: 'confirm', eventId: 'EV-001' });
  assert.equal(teamScheduleEvidence(s.db, 'AC_TEST_A').length, 2);
  const first = await s.ask('11월 23일 휴강 보강 언제예요?');
  assert.equal(first.status, 'answered', first.answer);
  assert.match(first.answer, /11월 28일/);
  assert.match(first.answer, /10:00/);
  const outdated = s.version();
  await s.submit({
    action: 'change',
    eventId: 'EV-001',
    makeupDate: '2026-11-28',
    makeupStart: '13:00',
    room: '1강의실',
  });
  await assert.rejects(
    s.submit({ action: 'withdraw', eventId: 'EV-001', version: outdated }),
    /변경/,
  );
  const second = await s.ask('11월 23일 휴강 보강 언제예요?');
  assert.match(second.answer, /13:00/);
  assert.doesNotMatch(second.answer, /10:00/);
  assert.ok(
    second.citations.every((c: { revision: number }) => c.revision === 2),
  );
  await s.submit({ action: 'clear', eventId: 'EV-001' });
  const pending = await s.ask('11월 23일 휴강 보강 언제예요?');
  assert.equal(pending.status, 'partial', pending.answer);
  assert.doesNotMatch(pending.answer, /13:00/);
  await s.submit({ action: 'withdraw', eventId: 'EV-001' });
  assert.equal(teamScheduleEvidence(s.db, 'AC_TEST_A').length, 0);
  assert.ok(
    Number(
      s.db.prepare('SELECT COUNT(*) n FROM op_team_schedule_history').get()!.n,
    ) >= 5,
  );
});
test('학생 결석 보강은 본인만 답하고 날짜 불일치·여러 결석·보강 미정은 단정하지 않는다', async (t) => {
  const s = setup(t);
  await s.config();
  await s.submit({
    action: 'create',
    scope: 'student',
    classId: 'TA_E_MATH',
    studentId: 'TA_STU_001',
    date: '2026-11-23',
    confirm: 'yes',
    makeupDate: '2026-11-28',
    makeupStart: '10:00',
    room: '1강의실',
  });
  const own = await s.ask('결석한 거 보강 언제예요?');
  assert.equal(own.status, 'answered', own.answer);
  assert.match(own.answer, /11월 28일/);
  assert.match(own.answer, /10:00/);
  const other = await s.ask(
    '결석한 거 보강 언제예요?',
    'TA_GUARDIAN_M2',
    'TA_STU_002',
  );
  assert.notEqual(other.status, 'answered');
  assert.equal(other.citations.length, 0);
  const wrong = await s.ask('11월 24일 결석 보강 언제예요?');
  assert.notEqual(wrong.status, 'answered');
  await s.submit({
    action: 'create',
    scope: 'student',
    classId: 'TA_E_MATH',
    studentId: 'TA_STU_001',
    date: '2026-11-25',
    confirm: 'yes',
  });
  assert.equal((await s.ask('결석한 거 보강 언제예요?')).status, 'clarify');
  const pending = await s.ask('11월 25일 결석 보강 언제예요?');
  assert.equal(pending.status, 'partial', pending.answer);
});
test('새 일정 생성 후에도 가능 시간을 보존하고 다른 학생·확정 권한·충돌을 검사한다', async (t) => {
  const s = setup(t);
  await s.config();
  await s.submit(
    {
      action: 'availability',
      studentId: 'TA_STU_001',
      windows: JSON.stringify([{ day: 6, start: '12:00', end: '14:00' }]),
    },
    'TA_GUARDIAN_E_MATH',
  );
  await assert.rejects(
    s.submit({
      action: 'create',
      scope: 'student',
      studentId: 'TA_STU_001',
      classId: 'TA_E_MATH',
      date: '2026-11-23',
      confirm: 'yes',
      makeupDate: '2026-11-28',
      makeupStart: '10:00',
      room: '1강의실',
    }),
    /충돌/,
  );
  await s.submit(
    {
      action: 'create',
      scope: 'class',
      classId: 'TA_E_MATH',
      date: '2026-11-23',
    },
    'TA_TEACHER',
  );
  const state = JSON.parse(
    String(s.db.prepare('SELECT state FROM op_team_schedule').get()!.state),
  );
  assert.equal(state.availability.TA_STU_001[0].start, '12:00');
  await assert.rejects(
    s.submit({ action: 'confirm', eventId: 'EV-001' }, 'TA_TEACHER'),
    /관리자/,
  );
  await assert.rejects(
    s.submit(
      { action: 'availability', studentId: 'TA_STU_002', windows: '[]' },
      'TA_GUARDIAN_E_MATH',
    ),
    /권한/,
  );
});

test('보강 횟수 규정 질문을 개인 결석 일정 확인으로 가로채지 않는다', async (t) => {
  const s = setup(t);
  const answer = await s.ask(
    '결석하면 보강은 한 달에 몇 번까지 받을 수 있어요?',
    'TA_DIRECTOR',
    '',
  );
  assert.notEqual(answer.status, 'clarify', answer.answer);
  assert.ok(
    answer.citations.every(
      (c: { documentId: string }) => !c.documentId.includes('EV'),
    ),
  );
});

test('새 보강일을 비운 변경 요청은 기존 보강을 취소하지 않는다', async (t) => {
  const s = setup(t);
  await s.config();
  await s.submit({
    action: 'create',
    scope: 'class',
    classId: 'TA_E_MATH',
    date: '2026-11-23',
    confirm: 'yes',
    makeupDate: '2026-11-28',
    makeupStart: '10:00',
    room: '1강의실',
  });
  const before = s.version();
  await assert.rejects(
    s.submit({ action: 'change', eventId: 'EV-001' }),
    /보강일/,
  );
  assert.equal(s.version(), before);
  assert.equal(teamScheduleEvidence(s.db, 'AC_TEST_A').length, 2);
});

test('시간표 개정은 적용일 전 수업과 기존 휴강 원본·보강 길이를 보존한다', async (t) => {
  const s = setup(t);
  await s.config();
  await s.submit({
    action: 'create',
    scope: 'class',
    classId: 'TA_E_MATH',
    date: '2026-11-23',
    confirm: 'yes',
  });
  await s.submit({
    action: 'class-config',
    classId: 'TA_E_MATH',
    days: '2',
    start: '18:00',
    end: '20:00',
    teacher: 'TA_TEACHER',
    room: '1강의실',
    capacity: '20',
    closeTime: '22:00',
    effectiveFrom: '2099-01-01',
  });
  const row = s.db
    .prepare('SELECT config,state FROM op_team_schedule WHERE academy_id=?')
    .get('AC_TEST_A')!;
  const config = JSON.parse(String(row.config)) as AcademyConfig;
  assert.equal(classOnDate(config, 'TA_E_MATH', '2026-11-23')?.start, '16:00');
  assert.equal(classOnDate(config, 'TA_E_MATH', '2099-01-01')?.start, '18:00');
  const original = teamScheduleEvidence(s.db, 'AC_TEST_A')[0];
  assert.match(original.document.text, /16:00~17:00/);
  assert.doesNotMatch(original.document.text, /18:00~20:00/);
  await s.submit({
    action: 'change',
    eventId: 'EV-001',
    makeupDate: '2099-01-03',
    makeupStart: '10:00',
    room: '1강의실',
  });
  const state = JSON.parse(
    String(
      s.db
        .prepare('SELECT state FROM op_team_schedule WHERE academy_id=?')
        .get('AC_TEST_A')!.state,
    ),
  );
  assert.equal(state.events[0].makeup.end, '11:00');
  await assert.rejects(
    s.submit({
      action: 'class-config',
      classId: 'TA_E_MATH',
      days: '3',
      start: '18:00',
      end: '20:00',
      teacher: 'TA_TEACHER',
      room: '1강의실',
      capacity: '20',
      closeTime: '22:00',
      effectiveFrom: '2098-01-01',
    }),
    /적용일/,
  );
});

test('일반 공지와 팀 휴강이 겹치면 양방향으로 중복 등록을 차단한다', async (t) => {
  const s = setup(t);
  await s.config();
  await s.submit({
    action: 'create',
    scope: 'class',
    classId: 'TA_E_MATH',
    date: '2026-11-23',
    confirm: 'yes',
  });
  const form = new FormData();
  for (const [k, v] of Object.entries({
    action: 'save_notice',
    class_id: 'TA_E_MATH',
    title: '겹치는 공지',
    closure_start: '2026-11-23T16:00',
    closure_end: '2026-11-23T17:00',
    makeup_kind: 'pending',
  }))
    form.set(k, v);
  await assert.rejects(
    Promise.resolve().then(() =>
      scheduleModule.submit(s.ctx('TA_DIRECTOR'), form),
    ),
    /겹칩니다/,
  );
});
