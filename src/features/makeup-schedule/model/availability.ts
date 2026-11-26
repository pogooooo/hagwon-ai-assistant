/**
 * 학생별 보강 가능 시간(주간 반복). 보강 후보마다 누가 올 수 있는지 코드로 계산한다.
 */
import { studentOf } from './notice.ts';
import { dayName, dayOfWeek, fromMinutes, isTime, toMinutes } from './time.ts';
import type {
  AcademyConfig,
  Attendance,
  AvailabilityWindow,
  ScheduleState,
} from './types.ts';

export type AvailabilityResult =
  | { ok: true; state: ScheduleState; windows: AvailabilityWindow[] }
  | { ok: false; error: string };

/** 같은 요일의 겹치거나 맞닿은 시간대를 합치고 요일·시각 순으로 정렬한다. */
export function normalizeWindows(
  windows: AvailabilityWindow[],
): AvailabilityWindow[] {
  const sorted = [...windows].sort(
    (a, b) => a.day - b.day || toMinutes(a.start) - toMinutes(b.start),
  );
  const merged: AvailabilityWindow[] = [];
  for (const window of sorted) {
    const last = merged.at(-1);
    if (
      last &&
      last.day === window.day &&
      toMinutes(window.start) <= toMinutes(last.end)
    ) {
      if (toMinutes(window.end) > toMinutes(last.end)) last.end = window.end;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/** 학생의 보강 가능 시간을 통째로 바꾼다(빈 배열이면 미등록으로 되돌린다). */
export function setAvailability(
  academy: AcademyConfig,
  state: ScheduleState,
  studentId: string,
  windows: AvailabilityWindow[],
): AvailabilityResult {
  if (!academy.students.some((s) => s.studentId === studentId))
    return { ok: false, error: '원생을 선택하세요.' };
  for (const window of windows) {
    if (!Number.isInteger(window.day) || window.day < 0 || window.day > 6)
      return { ok: false, error: '요일을 확인하세요.' };
    if (!isTime(window.start) || !isTime(window.end))
      return { ok: false, error: '시작·종료 시각을 확인하세요.' };
    if (toMinutes(window.start) >= toMinutes(window.end))
      return { ok: false, error: '종료 시각은 시작 시각보다 늦어야 합니다.' };
  }
  const normalized = normalizeWindows(windows);
  const availability = { ...(state.availability ?? {}) };
  if (normalized.length === 0) delete availability[studentId];
  else availability[studentId] = normalized;
  return { ok: true, state: { ...state, availability }, windows: normalized };
}

/**
 * 그 날짜·시간 전체에 올 수 있는지. 가능 시간을 등록하지 않았으면 null(모름).
 * 보강 시간이 등록한 시간대 하나 안에 다 들어가야 가능으로 본다.
 */
export function isAvailable(
  state: ScheduleState,
  studentId: string,
  date: string,
  start: string,
  end: string,
): boolean | null {
  const windows = state.availability?.[studentId];
  if (!windows || windows.length === 0) return null;
  const day = dayOfWeek(date);
  return windows.some(
    (w) =>
      w.day === day &&
      toMinutes(w.start) <= toMinutes(start) &&
      toMinutes(end) <= toMinutes(w.end),
  );
}

export function attendanceOf(
  state: ScheduleState,
  studentIds: string[],
  date: string,
  start: string,
  end: string,
): Attendance {
  const result: Attendance = { available: [], unavailable: [], unknown: [] };
  for (const id of studentIds) {
    const ok = isAvailable(state, id, date, start, end);
    if (ok === null) result.unknown.push(id);
    else if (ok) result.available.push(id);
    else result.unavailable.push(id);
  }
  return result;
}

export function formatWindows(windows: AvailabilityWindow[]): string {
  return windows.map((w) => `${dayName(w.day)} ${w.start}~${w.end}`).join(', ');
}

export function namesOf(academy: AcademyConfig, ids: string[]): string {
  return ids.map((id) => studentOf(academy, id).name).join(', ');
}

/** 후보 시각 목록(분). 평일은 학교 끝난 뒤, 주말은 오전부터, 교습 종료 시각 안에서 30분 간격 */
export function candidateStarts(
  academy: AcademyConfig,
  date: string,
  durationMinutes: number,
): string[] {
  const weekend = dayOfWeek(date) === 0 || dayOfWeek(date) === 6;
  const first = toMinutes(weekend ? '09:00' : '14:00');
  const last = toMinutes(academy.closeTime) - durationMinutes;
  const starts: string[] = [];
  for (let m = first; m <= last; m += 30) starts.push(fromMinutes(m));
  return starts;
}
