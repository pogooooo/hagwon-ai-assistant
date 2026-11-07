import { compactText } from '../text/normalize.ts';
import type { AnswerContext } from './context.ts';
import type { AcademyClass } from '../types.ts';
import { explicitClassIds } from './info.ts';

function sectionLabel(klass: AcademyClass) {
  const match = /^(.*?)([a-z]|\d+)반$/i.exec(compactText(klass.name));
  return match && match[1]
    ? { group: match[1], section: match[2].toLowerCase() }
    : undefined;
}

/** A section suffix alone cannot identify a companion class. */
export function parallelClassSections(ctx: AnswerContext, classId: string) {
  const anchor = ctx.catalog.classes.find((entry) => entry.classId === classId);
  const label = anchor && sectionLabel(anchor);
  if (!anchor?.grade || !label) return [];
  return ctx.catalog.classes.flatMap((klass) => {
    const candidate = sectionLabel(klass);
    return candidate?.group === label.group &&
      klass.grade === anchor.grade &&
      klass.subject === anchor.subject &&
      !ctx.frame.negatedClassIds.includes(klass.classId)
      ? [{ klass, ...candidate }]
      : [];
  });
}

/** Carry a school/grade anchor across explicitly enumerated sibling classes. */
export function expandNumberedClasses(
  ctx: AnswerContext,
  ids: readonly string[],
): string[] | undefined {
  if (ids.length !== 1 || !ctx.frame.classIds.includes(ids[0]))
    return undefined;
  const anchor = ctx.catalog.classes.find((entry) => entry.classId === ids[0]);
  const series = anchor?.name.match(/^(.*?)([1-9]\d*)반$/);
  if (!series || !anchor?.grade) return undefined;

  const query = ctx.frame.normalized;
  if (/말고|제외|빼고|아니라|아닌/.test(query)) return undefined;
  const ordinals = [...query.matchAll(/(?<!\d)([1-9]\d*)\s*반/g)].map(
    ([, number]) => number,
  );
  if (
    ordinals.length !== 2 ||
    ordinals[0] === ordinals[1] ||
    !ordinals.includes(series[2]) ||
    !/이랑|랑|하고|및|,/.test(query)
  )
    return undefined;
  const grades = [...query.matchAll(/[초중고]\s*[1-6]|[1-6]\s*학년/g)];
  if (grades.length !== 1) return undefined;

  const classes = ordinals.map((number) =>
    ctx.catalog.classes.filter(
      (entry) =>
        entry.grade === anchor.grade &&
        !ctx.frame.negatedClassIds.includes(entry.classId) &&
        compactText(entry.name) === compactText(series[1] + number + '반'),
    ),
  );
  return classes.every((matches) => matches.length === 1)
    ? classes.map(([entry]) => entry.classId)
    : undefined;
}
export function resolveQualifiedClasses(
  ctx: AnswerContext,
  ids = explicitClassIds(ctx),
): string[] {
  const expanded = expandNumberedClasses(ctx, ids);
  if (expanded) return expanded;
  if (
    ids.length < 2 ||
    /(?:이랑|랑|하고|및|각각|둘\s*다|두\s*반)/.test(ctx.frame.normalized)
  )
    return ids;

  // A full catalog name is stronger than the shared grade matched in a
  // different school's alias. Keep all classes for explicit multi-class requests.
  const direct = ctx.catalog.classes.filter(
    (entry) =>
      ids.includes(entry.classId) &&
      ctx.frame.compact.includes(compactText(entry.name)),
  );
  if (
    ctx.frame.explicitDates.length === 1 &&
    direct.length === 1 &&
    !/비교|대신|말고|제외|[·,/]/.test(ctx.frame.normalized)
  )
    return [direct[0].classId];

  const grades = [
    ...ctx.frame.normalized.matchAll(
      /(?<!\d)([초중고])?([1-6](?:\s*[,·]\s*[1-6])*)\s*학년/g,
    ),
  ];
  if (grades.length !== 1) return ids;
  const [, school, gradeList] = grades[0];
  const requestedGrades = gradeList.match(/[1-6]/g) ?? [];
  const candidates = ctx.catalog.classes.filter((entry) => {
    if (!ids.includes(entry.classId) || !entry.grade) return false;
    const labels = [entry.name, ...entry.aliases].map((name) =>
      compactText(name).replace(/\([초중고][1-6].*?\)$/, ''),
    );
    const courseMention =
      labels.some(
        (label) => label.length >= 3 && ctx.frame.compact.includes(label),
      ) ||
      labels.some((label) => {
        const course = label.match(/([가-힣]{2,}반)$/)?.[1];
        return course && ctx.frame.compact.includes(course);
      });
    const catalogGrades = [...entry.grade.matchAll(/([초중고])([1-6])/g)];
    const gradeMatch = requestedGrades.every((grade) =>
      catalogGrades.some(
        ([, level, number]) =>
          (!school || school === level) && grade === number,
      ),
    );
    return courseMention && gradeMatch;
  });
  return candidates.length === 1 ? [candidates[0].classId] : ids;
}
