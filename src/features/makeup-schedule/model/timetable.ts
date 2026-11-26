import type { AcademyConfig, ClassDefinition, ScheduleEvent } from './types.ts';

/** Timetable periods use an inclusive start and exclusive end. */
export function classOnDate(
  academy: Pick<AcademyConfig, 'classes'>,
  classId: string,
  date: string,
): ClassDefinition | undefined {
  const current = academy.classes.find((c) => c.classId === classId);
  if (!current) return undefined;
  const period = [...(current.history ?? []), current].find(
    (p) =>
      (!p.effectiveFrom || date >= p.effectiveFrom) &&
      (!p.effectiveUntil || date < p.effectiveUntil),
  );
  return period
    ? { ...period, classId, name: current.name, history: undefined }
    : undefined;
}

export function classesOnDate(
  academy: Pick<AcademyConfig, 'classes'>,
  date: string,
) {
  return academy.classes.flatMap(
    (c) => classOnDate(academy, c.classId, date) ?? [],
  );
}

export function eventClass(
  academy: Pick<AcademyConfig, 'classes'>,
  event: ScheduleEvent,
) {
  const klass =
    event.classSnapshot ?? classOnDate(academy, event.classId, event.date);
  if (!klass) throw new Error('일정의 원본 시간표를 찾을 수 없습니다.');
  return klass;
}
