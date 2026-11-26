'use client';

/**
 * 관리 화면 상태. 앱이 정적 빌드(서버 없음)라 브라우저에 저장한다.
 * 운영에서는 백엔드 일정 DB + server/rag-sync.ts 로 바꾼다.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { setAvailability } from './model/availability.ts';
import { DEMO_ACADEMY } from './model/demo-academy.ts';
import { changeMakeup, createEvent, emptyState } from './model/schedule.ts';
import type { ScheduleResult, ScheduleState } from './model/types.ts';

interface ScheduleStore {
  schedule: ScheduleState;
  apply: (result: ScheduleResult) => ScheduleResult;
  reset: () => void;
  loadExample: () => void;
}

/** 예시: 휴강+보강, 보강 변경, 보강 미정, 결석 보강, 임시 저장 */
function exampleState(): ScheduleState {
  const a = DEMO_ACADEMY;
  const t0 = '2026-11-09T10:00:00+09:00';
  const t1 = '2026-11-09T15:00:00+09:00';
  let state = emptyState();
  const step = (result: ScheduleResult) => {
    if (result.ok) state = result.state;
    return result;
  };
  step(
    createEvent(
      a,
      state,
      {
        scope: 'class',
        classId: 'TA_M2_EXAM',
        date: '2026-11-11',
        reason: '원장 연수',
        makeup: { date: '2026-11-14', start: '14:00', room: '교실1' },
        confirm: true,
      },
      t0,
    ),
  );
  const em = step(
    createEvent(
      a,
      state,
      {
        scope: 'class',
        classId: 'TA_E_MATH',
        date: '2026-11-16',
        reason: '학교 행사',
        makeup: { date: '2026-11-21', start: '10:00', room: '교실1' },
        confirm: true,
      },
      t0,
    ),
  );
  if (em.ok)
    step(
      changeMakeup(
        a,
        state,
        em.event.eventId,
        { date: '2026-11-21', start: '13:00', room: '교실1' },
        t1,
      ),
    );
  step(
    createEvent(
      a,
      state,
      {
        scope: 'class',
        classId: 'TA_M3',
        date: '2026-11-19',
        reason: '시설 점검',
        confirm: true,
      },
      t0,
    ),
  );
  step(
    createEvent(
      a,
      state,
      {
        scope: 'student',
        classId: 'TA_H1',
        studentId: 'TA_STU_004',
        date: '2026-11-17',
        reason: '병결',
        makeup: { date: '2026-11-21', start: '15:00', room: '교실1' },
        confirm: true,
      },
      t1,
    ),
  );
  step(
    createEvent(
      a,
      state,
      {
        scope: 'class',
        classId: 'TA_H1',
        date: '2026-11-26',
        reason: '시험 대비 일정 조정 검토',
        makeup: { date: '2026-11-28', start: '14:00', room: '교실1' },
        confirm: false,
      },
      t1,
    ),
  );
  // 보강 가능 시간(가상): 중2 내신반은 토 14시 이후에 모두 가능
  const windows: Record<string, { day: number; start: string; end: string }[]> =
    {
      TA_STU_002: [{ day: 6, start: '10:00', end: '18:00' }],
      TA_STU_005: [
        { day: 6, start: '14:00', end: '18:00' },
        { day: 2, start: '16:00', end: '18:00' },
      ],
      TA_STU_006: [{ day: 6, start: '13:00', end: '17:00' }],
      TA_STU_004: [{ day: 6, start: '14:00', end: '18:00' }],
    };
  for (const [id, list] of Object.entries(windows)) {
    const result = setAvailability(a, state, id, list);
    if (result.ok) state = result.state;
  }
  return state;
}

export const useScheduleStore = create<ScheduleStore>()(
  persist(
    (set) => ({
      schedule: emptyState(),
      apply: (result) => {
        if (result.ok) set({ schedule: result.state });
        return result;
      },
      reset: () => set({ schedule: emptyState() }),
      loadExample: () => set({ schedule: exampleState() }),
    }),
    {
      name: 'makeup-schedule-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (store) => ({ schedule: store.schedule }),
    },
  ),
);
