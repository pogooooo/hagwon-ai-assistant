/**
 * 휴·보강 등록·변경·취소·학생별 조회 규칙 테스트(가상 데이터).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEMO_ACADEMY } from '../model/demo-academy.ts';
import { ragDocumentsOf } from '../model/notice.ts';
import {
  changeMakeup,
  checkMakeup,
  confirmEvent,
  createEvent,
  emptyState,
  recipientsOf,
  studentSchedule,
  suggestMakeups,
  withdrawEvent,
} from '../model/schedule.ts';
import type {
  AcademyConfig,
  ScheduleResult,
  ScheduleState,
} from '../model/types.ts';

const NOW = '2026-11-09T10:00:00+09:00';
const LATER = '2026-11-09T15:00:00+09:00';

/** 원생 여러 명·강사 2명·교실 2개인 가상 학원(충돌 검사용) */
const ACADEMY_B: AcademyConfig = {
  academyId: 'AC_TEST_B',
  name: '[가상] 테스트 학원',
  capacity: 20,
  closeTime: '22:00',
  rooms: ['교실1', '교실2'],
  holidays: { '2026-12-25': '성탄절' },
  classes: [
    {
      classId: 'B_M1',
      name: '중1 수학',
      days: [1, 3],
      start: '18:00',
      end: '19:30',
      teacher: '강사A',
      room: '교실1',
    },
    {
      classId: 'B_E1',
      name: '중1 영어',
      days: [1, 3],
      start: '18:00',
      end: '19:30',
      teacher: '강사B',
      room: '교실2',
    },
    {
      classId: 'B_M2',
      name: '중2 수학',
      days: [2, 4],
      start: '18:00',
      end: '19:30',
      teacher: '강사A',
      room: '교실1',
    },
  ],
  students: [
    { studentId: 'B_S1', name: '원생1', classIds: ['B_M1'] },
    { studentId: 'B_S2', name: '원생2', classIds: ['B_M1', 'B_M2'] },
    { studentId: 'B_S3', name: '원생3', classIds: ['B_E1'] },
    { studentId: 'B_S4', name: '원생4', classIds: ['B_M2'] },
  ],
};

function ok(result: ScheduleResult) {
  if (!result.ok)
    assert.fail(`${result.error} ${JSON.stringify(result.issues)}`);
  return result;
}

describe('휴강·결석 등록', () => {
  test('수업이 없는 요일·중복 휴강은 등록하지 않는다', () => {
    const wrongDay = createEvent(
      DEMO_ACADEMY,
      emptyState(),
      {
        scope: 'class',
        classId: 'TA_M2_EXAM',
        date: '2026-11-12',
        confirm: true,
      },
      NOW,
    );
    assert.equal(wrongDay.ok, false);
    assert.match(!wrongDay.ok ? wrongDay.error : '', /수업이 없습니다/);

    const first = ok(
      createEvent(
        DEMO_ACADEMY,
        emptyState(),
        {
          scope: 'class',
          classId: 'TA_M2_EXAM',
          date: '2026-11-11',
          confirm: true,
        },
        NOW,
      ),
    );
    const dup = createEvent(
      DEMO_ACADEMY,
      first.state,
      {
        scope: 'class',
        classId: 'TA_M2_EXAM',
        date: '2026-11-11',
        confirm: true,
      },
      NOW,
    );
    assert.equal(dup.ok, false);
  });

  test('확정하면 revision 1, 안내문은 반 원생 전원에게 대기한다', () => {
    const { state, event } = ok(
      createEvent(
        ACADEMY_B,
        emptyState(),
        {
          scope: 'class',
          classId: 'B_M1',
          date: '2026-11-16',
          makeup: { date: '2026-11-21', start: '14:00', room: '교실1' },
          confirm: true,
        },
        NOW,
      ),
    );
    assert.equal(event.revision, 1);
    assert.equal(event.makeup?.end, '15:30');
    assert.deepEqual(state.outbox[0].recipientStudentIds, ['B_S1', 'B_S2']);
    assert.equal(state.outbox[0].kind, '휴강 안내');
    assert.match(state.outbox[0].text, /2026년 11월 21일 토요일 14:00~15:30/);
  });

  test('임시 저장은 안내·상담 자료를 만들지 않고, 확정할 때 만든다', () => {
    const draft = ok(
      createEvent(
        DEMO_ACADEMY,
        emptyState(),
        {
          scope: 'class',
          classId: 'TA_H1',
          date: '2026-11-26',
          makeup: { date: '2026-11-28', start: '14:00', room: '교실1' },
          confirm: false,
        },
        NOW,
      ),
    );
    assert.equal(draft.event.revision, 0);
    assert.equal(draft.state.outbox.length, 0);
    assert.deepEqual(ragDocumentsOf(DEMO_ACADEMY, draft.event), []);

    const confirmed = ok(
      confirmEvent(DEMO_ACADEMY, draft.state, draft.event.eventId, LATER),
    );
    assert.equal(confirmed.event.status, 'confirmed');
    assert.equal(confirmed.event.revision, 1);
    assert.equal(confirmed.state.outbox.length, 1);
    assert.equal(ragDocumentsOf(DEMO_ACADEMY, confirmed.event).length, 2);
  });

  test('학생 결석은 그 학생만 대상이고, 소속 반이 아니면 거부한다', () => {
    const notMember = createEvent(
      ACADEMY_B,
      emptyState(),
      {
        scope: 'student',
        classId: 'B_E1',
        studentId: 'B_S1',
        date: '2026-11-16',
        confirm: true,
      },
      NOW,
    );
    assert.equal(notMember.ok, false);

    const { event, state } = ok(
      createEvent(
        ACADEMY_B,
        emptyState(),
        {
          scope: 'student',
          classId: 'B_M1',
          studentId: 'B_S1',
          date: '2026-11-16',
          makeup: { date: '2026-11-17', start: '20:00', room: '교실2' },
          confirm: true,
        },
        NOW,
      ),
    );
    assert.deepEqual(recipientsOf(ACADEMY_B, event), ['B_S1']);
    assert.equal(state.outbox[0].kind, '결석 보강 안내');
    const docs = ragDocumentsOf(ACADEMY_B, event);
    assert.ok(docs.every((doc) => doc.studentId === 'B_S1'));
  });

  test('반 전체 휴강일에는 같은 반 결석을 따로 등록하지 않는다', () => {
    const { state } = ok(
      createEvent(
        ACADEMY_B,
        emptyState(),
        {
          scope: 'class',
          classId: 'B_M1',
          date: '2026-11-16',
          confirm: true,
        },
        NOW,
      ),
    );
    const absence = createEvent(
      ACADEMY_B,
      state,
      {
        scope: 'student',
        classId: 'B_M1',
        studentId: 'B_S1',
        date: '2026-11-16',
        confirm: true,
      },
      NOW,
    );
    assert.equal(absence.ok, false);
  });
});

describe('보강 충돌 검사', () => {
  const base = { scope: 'class' as const, studentId: null };

  test('같은 강사·같은 교실·같은 원생이 겹치면 확정할 수 없다', () => {
    // 화 18:00 중2 수학(강사A, 교실1, 원생2·4)과 겹치는 중1 수학 보강
    const { issues } = checkMakeup(ACADEMY_B, emptyState(), {
      ...base,
      classId: 'B_M1',
      date: '2026-11-17',
      start: '18:30',
      room: '교실1',
    });
    const types = issues.map((issue) => issue.type).sort();
    assert.deepEqual(types, ['강사', '교실', '원생']);
    assert.ok(issues.every((issue) => issue.blocking));
  });

  test('겹치지 않는 시간은 충돌이 없다(오경보 없음)', () => {
    const { issues, slot } = checkMakeup(ACADEMY_B, emptyState(), {
      ...base,
      classId: 'B_M1',
      date: '2026-11-17',
      start: '16:00',
      room: '교실2',
    });
    assert.deepEqual(issues, []);
    assert.equal(slot?.end, '17:30');
  });

  test('교습 종료 시각·정원을 넘으면 막고, 공휴일은 경고만 한다', () => {
    const late = checkMakeup(DEMO_ACADEMY, emptyState(), {
      ...base,
      classId: 'TA_H1',
      date: '2026-11-21',
      start: '21:00',
      room: '교실1',
    });
    assert.ok(late.issues.some((i) => i.type === '시간' && i.blocking));

    const crowded: AcademyConfig = { ...ACADEMY_B, capacity: 1 };
    const full = checkMakeup(crowded, emptyState(), {
      ...base,
      classId: 'B_M1',
      date: '2026-11-21',
      start: '10:00',
      room: '교실1',
    });
    assert.ok(full.issues.some((i) => i.type === '정원'));

    const holiday = checkMakeup(ACADEMY_B, emptyState(), {
      ...base,
      classId: 'B_M1',
      date: '2026-12-25',
      start: '10:00',
      room: '교실1',
    });
    assert.deepEqual(
      holiday.issues.map((i) => [i.type, i.blocking]),
      [['공휴일', false]],
    );
  });

  test('휴강한 정규 수업 자리와 이미 확정한 보강도 계산에 넣는다', () => {
    // 화 중2 수학을 휴강하면 그 자리에 중1 수학 보강을 넣을 수 있다
    const canceled = ok(
      createEvent(
        ACADEMY_B,
        emptyState(),
        {
          scope: 'class',
          classId: 'B_M2',
          date: '2026-11-17',
          confirm: true,
        },
        NOW,
      ),
    );
    const free = checkMakeup(ACADEMY_B, canceled.state, {
      ...base,
      classId: 'B_M1',
      date: '2026-11-17',
      start: '18:00',
      room: '교실1',
    });
    assert.deepEqual(free.issues, []);

    // 그 자리에 보강을 확정하면, 다른 보강은 같은 시간에 겹친다
    const withMakeup = ok(
      createEvent(
        ACADEMY_B,
        canceled.state,
        {
          scope: 'class',
          classId: 'B_M1',
          date: '2026-11-16',
          makeup: { date: '2026-11-17', start: '18:00', room: '교실1' },
          confirm: true,
        },
        NOW,
      ),
    );
    const clash = checkMakeup(ACADEMY_B, withMakeup.state, {
      scope: 'student',
      classId: 'B_E1',
      studentId: 'B_S3',
      date: '2026-11-17',
      start: '18:00',
      room: '교실1',
    });
    assert.ok(clash.issues.some((i) => i.type === '교실'));
  });

  test('충돌이 있으면 확정 등록을 거부하고, 추천 시간은 충돌이 없다', () => {
    const rejected = createEvent(
      ACADEMY_B,
      emptyState(),
      {
        scope: 'class',
        classId: 'B_M1',
        date: '2026-11-16',
        makeup: { date: '2026-11-17', start: '18:30', room: '교실1' },
        confirm: true,
      },
      NOW,
    );
    assert.equal(rejected.ok, false);
    assert.ok(!rejected.ok && rejected.issues.length > 0);

    const suggestions = suggestMakeups(ACADEMY_B, emptyState(), {
      ...base,
      classId: 'B_M1',
      room: '교실1',
      after: '2026-11-16',
    });
    assert.equal(suggestions.length, 3);
    for (const { slot } of suggestions) {
      const { issues } = checkMakeup(ACADEMY_B, emptyState(), {
        ...base,
        classId: 'B_M1',
        ...slot,
      });
      assert.deepEqual(issues, []);
    }
  });
});

describe('변경·취소', () => {
  function seeded(): { state: ScheduleState; eventId: string } {
    const { state, event } = ok(
      createEvent(
        DEMO_ACADEMY,
        emptyState(),
        {
          scope: 'class',
          classId: 'TA_E_MATH',
          date: '2026-11-16',
          makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
          confirm: true,
        },
        NOW,
      ),
    );
    return { state, eventId: event.eventId };
  }

  test('보강 변경은 revision 을 올리고 변경 안내를 만든다', () => {
    const { state, eventId } = seeded();
    const changed = ok(
      changeMakeup(
        DEMO_ACADEMY,
        state,
        eventId,
        { date: '2026-11-21', start: '13:00', room: '교실1' },
        LATER,
      ),
    );
    assert.equal(changed.event.revision, 2);
    assert.equal(changed.event.makeup?.end, '14:20');
    assert.equal(changed.state.outbox[0].kind, '보강 변경 안내');
    assert.equal(changed.event.history.at(-1)?.action, 'makeup_changed');
    const docs = ragDocumentsOf(DEMO_ACADEMY, changed.event);
    assert.ok(docs.every((doc) => !doc.text.includes('10:00')));
  });

  test('보강 취소는 보강 문서를 없애고, 휴강 문서는 미확정으로 바뀐다', () => {
    const { state, eventId } = seeded();
    const cleared = ok(changeMakeup(DEMO_ACADEMY, state, eventId, null, LATER));
    assert.equal(cleared.event.makeup, null);
    assert.equal(cleared.state.outbox[0].kind, '보강 취소 안내');
    const docs = ragDocumentsOf(DEMO_ACADEMY, cleared.event);
    assert.deepEqual(
      docs.map((d) => d.role),
      ['cancel'],
    );
    assert.match(docs[0].text, /아직 확정되지 않았습니다/);
  });

  test('휴강 취소는 이력을 남기고 상담 자료에서 빠진다', () => {
    const { state, eventId } = seeded();
    const withdrawn = ok(withdrawEvent(DEMO_ACADEMY, state, eventId, LATER));
    assert.equal(withdrawn.event.status, 'withdrawn');
    assert.equal(withdrawn.state.events.length, 1);
    assert.equal(withdrawn.state.outbox[0].kind, '휴강 취소 안내');
    assert.deepEqual(ragDocumentsOf(DEMO_ACADEMY, withdrawn.event), []);
    // 취소한 날짜에는 다시 휴강을 등록할 수 있다
    ok(
      createEvent(
        DEMO_ACADEMY,
        withdrawn.state,
        {
          scope: 'class',
          classId: 'TA_E_MATH',
          date: '2026-11-16',
          confirm: true,
        },
        LATER,
      ),
    );
  });
});

describe('학생별 조회', () => {
  test('정규·휴강·결석·보강을 날짜순으로 보여 주고 다른 학생 결석은 섞지 않는다', () => {
    let state = emptyState();
    state = ok(
      createEvent(
        ACADEMY_B,
        state,
        {
          scope: 'class',
          classId: 'B_M2',
          date: '2026-11-17',
          makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
          confirm: true,
        },
        NOW,
      ),
    ).state;
    state = ok(
      createEvent(
        ACADEMY_B,
        state,
        {
          scope: 'student',
          classId: 'B_M1',
          studentId: 'B_S2',
          date: '2026-11-18',
          confirm: true,
        },
        NOW,
      ),
    ).state;
    state = ok(
      createEvent(
        ACADEMY_B,
        state,
        {
          scope: 'student',
          classId: 'B_M1',
          studentId: 'B_S1',
          date: '2026-11-16',
          makeup: { date: '2026-11-20', start: '16:00', room: '교실2' },
          confirm: true,
        },
        NOW,
      ),
    ).state;

    const s2 = studentSchedule(
      ACADEMY_B,
      state,
      'B_S2',
      '2026-11-16',
      '2026-11-21',
    );
    assert.deepEqual(
      s2.map((s) => [s.date, s.className, s.kind, s.makeupPending]),
      [
        ['2026-11-16', '중1 수학', 'regular', false],
        ['2026-11-17', '중2 수학', 'canceled', false],
        ['2026-11-18', '중1 수학', 'absent', true],
        ['2026-11-19', '중2 수학', 'regular', false],
        ['2026-11-21', '중2 수학', 'makeup', false],
      ],
    );
    assert.equal(s2.at(-1)?.makeupFor, '2026-11-17');

    const s1 = studentSchedule(
      ACADEMY_B,
      state,
      'B_S1',
      '2026-11-16',
      '2026-11-21',
    );
    assert.deepEqual(
      s1.map((s) => [s.date, s.kind]),
      [
        ['2026-11-16', 'absent'],
        ['2026-11-18', 'regular'],
        ['2026-11-20', 'makeup'],
      ],
    );
  });
});

test('서로 다른 교실·강사여도 학원 동시 수용 인원을 합산한다', () => {
  const academy = { ...ACADEMY_B, capacity: 2 };
  const checked = checkMakeup(academy, emptyState(), {
    scope: 'class',
    classId: 'B_E1',
    studentId: null,
    date: '2026-11-17',
    start: '18:00',
    room: '교실2',
  });
  assert.ok(checked.issues.some((i) => i.type === '정원' && i.blocking));
});

test('동시 정원은 겹치지 않는 앞뒤 수업 인원을 중복 합산하지 않는다', () => {
  const academy: AcademyConfig = {
    ...ACADEMY_B,
    capacity: 3,
    classes: ACADEMY_B.classes.map((c) =>
      c.classId === 'B_M1'
        ? { ...c, days: [2], start: '18:00', end: '18:45' }
        : c.classId === 'B_M2'
          ? { ...c, start: '18:45', end: '19:30' }
          : c,
    ),
  };
  const checked = checkMakeup(academy, emptyState(), {
    scope: 'class',
    classId: 'B_E1',
    studentId: null,
    date: '2026-11-17',
    start: '18:00',
    room: '교실2',
  });
  assert.equal(checked.issues.filter((i) => i.blocking).length, 0);
});

test('개인 결석 뒤 같은 수업 전체 휴강을 추가해 보강을 중복 확정하지 않는다', () => {
  const absent = ok(
    createEvent(
      ACADEMY_B,
      emptyState(),
      {
        scope: 'student',
        classId: 'B_M1',
        studentId: 'B_S1',
        date: '2026-11-16',
        confirm: true,
        makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
      },
      NOW,
    ),
  );
  const canceled = createEvent(
    ACADEMY_B,
    absent.state,
    {
      scope: 'class',
      classId: 'B_M1',
      date: '2026-11-16',
      confirm: true,
      makeup: { date: '2026-11-21', start: '14:00', room: '교실1' },
    },
    NOW,
  );
  assert.equal(canceled.ok, false);
  assert.match(!canceled.ok ? canceled.error : '', /결석/);
});

test('휴강 철회로 정규 수업이 복구될 때 확정 보강과 충돌하면 거부한다', () => {
  const closure = ok(
    createEvent(
      ACADEMY_B,
      emptyState(),
      {
        scope: 'class',
        classId: 'B_M1',
        date: '2026-11-16',
        confirm: true,
      },
      NOW,
    ),
  );
  const next = ok(
    createEvent(
      ACADEMY_B,
      closure.state,
      {
        scope: 'class',
        classId: 'B_M2',
        date: '2026-11-17',
        confirm: true,
        makeup: { date: '2026-11-16', start: '18:00', room: '교실1' },
      },
      NOW,
    ),
  );
  const withdrawn = withdrawEvent(
    ACADEMY_B,
    next.state,
    closure.event.eventId,
    LATER,
  );
  assert.equal(withdrawn.ok, false);
  assert.match(!withdrawn.ok ? withdrawn.error : '', /충돌/);
  assert.equal(next.state.events[0].status, 'confirmed');
});
