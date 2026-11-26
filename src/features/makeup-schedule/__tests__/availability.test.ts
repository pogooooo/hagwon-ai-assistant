/**
 * 학생 보강 가능 시간과 보강 추천 검증(가상 데이터).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  attendanceOf,
  isAvailable,
  normalizeWindows,
  setAvailability,
} from '../model/availability.ts';
import {
  checkMakeup,
  createEvent,
  emptyState,
  suggestMakeups,
} from '../model/schedule.ts';
import type {
  AcademyConfig,
  AvailabilityWindow,
  ScheduleState,
} from '../model/types.ts';

const NOW = '2026-11-09T10:00:00+09:00';

/** 원장 1명·교실 1개, 중2반 원생 3명(월·수 18:00~19:50) */
const ACADEMY: AcademyConfig = {
  academyId: 'AC_AV',
  name: '[가상] 가능시간 교습소',
  capacity: 9,
  closeTime: '22:00',
  rooms: ['교실1'],
  holidays: { '2026-11-21': '임시 휴일' },
  classes: [
    {
      classId: 'M2',
      name: '중2반',
      days: [1, 3],
      start: '18:00',
      end: '19:50',
      teacher: '원장',
      room: '교실1',
    },
    {
      classId: 'M3',
      name: '중3반',
      days: [2, 4],
      start: '18:00',
      end: '19:50',
      teacher: '원장',
      room: '교실1',
    },
  ],
  students: [
    { studentId: 'S1', name: '학생1', classIds: ['M2'] },
    { studentId: 'S2', name: '학생2', classIds: ['M2'] },
    { studentId: 'S3', name: '학생3', classIds: ['M2'] },
    { studentId: 'S4', name: '학생4', classIds: ['M3'] },
  ],
};

function withAvailability(
  entries: Record<string, AvailabilityWindow[]>,
): ScheduleState {
  let state = emptyState();
  for (const [id, windows] of Object.entries(entries)) {
    const result = setAvailability(ACADEMY, state, id, windows);
    if (!result.ok) assert.fail(result.error);
    state = result.state;
  }
  return state;
}

const SAT = 6;
const SUN = 0;
const TUE = 2;

describe('가능 시간 등록', () => {
  test('잘못된 입력은 거부한다', () => {
    const s = emptyState();
    assert.equal(setAvailability(ACADEMY, s, 'NOPE', []).ok, false);
    assert.equal(
      setAvailability(ACADEMY, s, 'S1', [
        { day: 7, start: '10:00', end: '12:00' },
      ]).ok,
      false,
    );
    assert.equal(
      setAvailability(ACADEMY, s, 'S1', [
        { day: 1, start: '25:00', end: '26:00' },
      ]).ok,
      false,
    );
    assert.equal(
      setAvailability(ACADEMY, s, 'S1', [
        { day: 1, start: '12:00', end: '12:00' },
      ]).ok,
      false,
    );
  });

  test('겹치거나 맞닿은 시간대는 합치고, 빈 목록은 미등록으로 되돌린다', () => {
    assert.deepEqual(
      normalizeWindows([
        { day: SAT, start: '13:00', end: '15:00' },
        { day: SAT, start: '10:00', end: '12:00' },
        { day: SAT, start: '12:00', end: '13:30' },
        { day: SUN, start: '10:00', end: '11:00' },
      ]),
      [
        { day: SUN, start: '10:00', end: '11:00' },
        { day: SAT, start: '10:00', end: '15:00' },
      ],
    );
    const set = withAvailability({
      S1: [{ day: SAT, start: '10:00', end: '12:00' }],
    });
    const cleared = setAvailability(ACADEMY, set, 'S1', []);
    assert.ok(cleared.ok);
    assert.equal(cleared.ok && cleared.state.availability?.S1, undefined);
  });

  test('보강 시간 전체가 한 시간대 안에 들어가야 가능으로 본다', () => {
    const s = withAvailability({
      S1: [{ day: SAT, start: '10:00', end: '12:00' }],
    });
    assert.equal(isAvailable(s, 'S1', '2026-11-14', '10:00', '11:50'), true);
    assert.equal(isAvailable(s, 'S1', '2026-11-14', '10:30', '12:20'), false);
    assert.equal(isAvailable(s, 'S1', '2026-11-15', '10:00', '11:50'), false);
    assert.equal(isAvailable(s, 'S2', '2026-11-14', '10:00', '11:50'), null);
    assert.deepEqual(
      attendanceOf(s, ['S1', 'S2'], '2026-11-14', '10:00', '11:50'),
      {
        available: ['S1'],
        unavailable: [],
        unknown: ['S2'],
      },
    );
  });
});

describe('보강 충돌 검사와 가능 시간', () => {
  const s = withAvailability({
    S1: [{ day: SAT, start: '10:00', end: '13:00' }],
    S2: [{ day: SAT, start: '14:00', end: '18:00' }],
    S4: [{ day: SAT, start: '14:00', end: '18:00' }],
  });

  test('반 보강은 못 오는 학생 수를 경고하고 확정은 막지 않는다', () => {
    const { issues, attendance } = checkMakeup(ACADEMY, s, {
      scope: 'class',
      classId: 'M2',
      studentId: null,
      date: '2026-11-14',
      start: '10:00',
      room: '교실1',
    });
    assert.deepEqual(
      issues.map((i) => [i.type, i.blocking]),
      [['가능시간', false]],
    );
    assert.match(issues[0].message, /3명 중 1명.*학생2/);
    assert.deepEqual(attendance, {
      available: ['S1'],
      unavailable: ['S2'],
      unknown: ['S3'],
    });
  });

  test('결석 보강은 그 학생이 못 오는 시간이면 확정을 막는다', () => {
    const blocked = checkMakeup(ACADEMY, s, {
      scope: 'student',
      classId: 'M3',
      studentId: 'S4',
      date: '2026-11-14',
      start: '10:00',
      room: '교실1',
    });
    assert.ok(blocked.issues.some((i) => i.type === '가능시간' && i.blocking));
    const rejected = createEvent(
      ACADEMY,
      s,
      {
        scope: 'student',
        classId: 'M3',
        studentId: 'S4',
        date: '2026-11-10',
        makeup: { date: '2026-11-14', start: '10:00', room: '교실1' },
        confirm: true,
      },
      NOW,
    );
    assert.equal(rejected.ok, false);

    const allowed = createEvent(
      ACADEMY,
      s,
      {
        scope: 'student',
        classId: 'M3',
        studentId: 'S4',
        date: '2026-11-10',
        makeup: { date: '2026-11-14', start: '14:00', room: '교실1' },
        confirm: true,
      },
      NOW,
    );
    assert.ok(allowed.ok);
  });

  test('가능 시간을 아무도 등록하지 않았으면 경고하지 않는다', () => {
    const { issues } = checkMakeup(ACADEMY, emptyState(), {
      scope: 'class',
      classId: 'M2',
      studentId: null,
      date: '2026-11-14',
      start: '10:00',
      room: '교실1',
    });
    assert.deepEqual(issues, []);
  });
});

describe('보강 추천', () => {
  const request = {
    scope: 'class' as const,
    classId: 'M2',
    studentId: null,
    room: '교실1',
  };

  test('가장 많은 학생이 올 수 있는 시간을 먼저 추천한다', () => {
    // 11/14(토) 14:00~ 는 3명 모두 가능, 그 전 평일은 아무도 등록하지 않음
    const s = withAvailability({
      S1: [{ day: SAT, start: '09:00', end: '18:00' }],
      S2: [{ day: SAT, start: '14:00', end: '18:00' }],
      S3: [
        { day: SAT, start: '13:00', end: '17:00' },
        { day: TUE, start: '16:00', end: '18:00' },
      ],
    });
    const [first, second] = suggestMakeups(ACADEMY, s, {
      ...request,
      after: '2026-11-11',
    });
    assert.equal(first.slot.date, '2026-11-14');
    assert.equal(first.slot.start, '14:00');
    assert.equal(first.slot.end, '15:50');
    assert.deepEqual(first.attendance.available, ['S1', 'S2', 'S3']);
    assert.ok(
      second.attendance.unavailable.length >=
        first.attendance.unavailable.length,
    );
  });

  test('결석 보강은 등록한 시간대 안에서만, 평일 이른 시간도 등록했으면 추천한다', () => {
    const s = withAvailability({
      S4: [{ day: 3, start: '14:00', end: '16:00' }],
    });
    const suggestions = suggestMakeups(ACADEMY, s, {
      scope: 'student',
      classId: 'M3',
      studentId: 'S4',
      room: '교실1',
      after: '2026-11-10',
    });
    assert.ok(suggestions.length > 0);
    for (const { slot, attendance } of suggestions) {
      assert.equal(new Date(`${slot.date}T00:00:00Z`).getUTCDay(), 3);
      assert.equal(slot.start, '14:00');
      assert.deepEqual(attendance.available, ['S4']);
    }
  });

  test('추천은 충돌·공휴일을 피하고 교습 종료 시각 안에 끝난다', () => {
    const suggestions = suggestMakeups(
      ACADEMY,
      emptyState(),
      { ...request, after: '2026-11-15' },
      14,
    );
    assert.ok(suggestions.length > 0);
    for (const { slot } of suggestions) {
      assert.notEqual(slot.date, '2026-11-21');
      assert.ok(slot.end <= '22:00');
      const { issues } = checkMakeup(ACADEMY, emptyState(), {
        ...request,
        ...slot,
      });
      assert.ok(!issues.some((i) => i.blocking), JSON.stringify(issues));
    }
  });

  test('이미 확정한 보강 시간은 다음 추천에서 빠진다', () => {
    const s = withAvailability({
      S1: [{ day: SAT, start: '14:00', end: '16:00' }],
    });
    const [top] = suggestMakeups(ACADEMY, s, {
      ...request,
      after: '2026-11-11',
    });
    const booked = createEvent(
      ACADEMY,
      s,
      {
        scope: 'class',
        classId: 'M2',
        date: '2026-11-11',
        makeup: { date: top.slot.date, start: top.slot.start, room: '교실1' },
        confirm: true,
      },
      NOW,
    );
    assert.ok(booked.ok);
    const next = suggestMakeups(
      ACADEMY,
      booked.ok ? booked.state : s,
      {
        scope: 'student',
        classId: 'M3',
        studentId: 'S4',
        room: '교실1',
        after: '2026-11-11',
      },
      14,
    );
    assert.ok(
      next.every(
        ({ slot }) =>
          !(
            slot.date === top.slot.date &&
            slot.start < top.slot.end &&
            top.slot.start < slot.end
          ),
      ),
    );
  });
});
