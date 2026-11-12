import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { OperationError } from './shared.ts';

const identifier = z.string().trim().min(1).max(128);
const agreement = z
  .object({
    same: z.number().int().nonnegative(),
    runs: z.number().int().positive().max(10000),
  })
  .refine((v) => v.same <= v.runs);
const tagSchema = z.object({
  tagId: identifier,
  status: z.enum(['adopted', 'reference', 'held']),
  evidenceKind: z.enum(['text', 'figure', 'text_and_figure']),
  agreement,
});
const schema = z.object({
  formatVersion: z.string().regex(/^1\.\d+$/),
  assignmentId: identifier,
  subject: z.enum(['M', 'E']),
  rubricVersion: z.literal('1.0'),
  classifiedAt: z.iso.datetime({ offset: true }),
  items: z
    .array(
      z.object({
        itemId: identifier,
        page: z.number().int().positive().max(100000),
        displayNumber: z.string().trim().min(1).max(80),
        itemStatus: z.enum([
          'classified',
          'no_adopted',
          'out_of_scope',
          'unreadable',
        ]),
        tags: z.array(tagSchema).max(25),
      }),
    )
    .min(1)
    .max(2000),
});
export type Classification = z.infer<typeof schema>;
export interface Tag {
  tagId: string;
  subject: 'M' | 'E';
  name: string;
  area: string;
  referenceOnly: boolean;
}
export const tagCatalog = JSON.parse(
  readFileSync(new URL('./tags.json', import.meta.url), 'utf8'),
) as { rubricVersion: string; tags: Tag[] };
export const tagById = new Map(tagCatalog.tags.map((tag) => [tag.tagId, tag]));

/** Unknown producer fields are stripped. Both documented empty tags and the held-tag example are accepted. */
export function parseClassification(input: unknown): Classification {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new OperationError(
      '분류 JSON 형식, 지원 버전(1.x / 기준서 1.0), 날짜 또는 문항 값을 확인해 주세요.',
      422,
    );
  const data = result.data;
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  for (const item of data.items) {
    const key = coordinate(item.page, item.displayNumber);
    if (ids.has(item.itemId) || coordinates.has(key))
      throw new OperationError(
        '문항 ID 또는 쪽수·번호 조합이 중복됩니다.',
        422,
      );
    ids.add(item.itemId);
    coordinates.add(key);
    const tags = new Set<string>();
    for (const tag of item.tags) {
      if (
        tagById.get(tag.tagId)?.subject !== data.subject ||
        tags.has(tag.tagId)
      )
        throw new OperationError(
          '과목에 맞지 않거나 중복된 태그가 있습니다.',
          422,
        );
      tags.add(tag.tagId);
    }
    if (
      (item.itemStatus === 'classified') !==
      item.tags.some((t) => t.status === 'adopted')
    )
      throw new OperationError(
        '분류 상태와 채택 태그가 일치하지 않습니다.',
        422,
      );
  }
  return data;
}

export function coordinate(page: number, number: string) {
  return JSON.stringify([page, number.trim()]);
}
export type Outcome = 'correct' | 'incorrect' | 'unknown';
export interface Counts {
  total: number;
  correct: number;
  incorrect: number;
}
export interface LearningSummary {
  algorithm: 'classification-v1';
  itemCount: number;
  assessed: number;
  correct: number;
  incorrect: number;
  unknown: number;
  unclassified: number;
  unclassifiedWrong: number;
  tags: (Tag & Counts)[];
  areas: ({ name: string } & Counts)[];
}
export function analyze(
  classification: Classification,
  outcomes: Record<string, Outcome>,
): LearningSummary {
  const counts = () => ({ total: 0, correct: 0, incorrect: 0 });
  const tags = new Map<string, Tag & Counts>();
  const areas = new Map<string, { name: string } & Counts>();
  const result: LearningSummary = {
    algorithm: 'classification-v1',
    itemCount: classification.items.length,
    assessed: 0,
    correct: 0,
    incorrect: 0,
    unknown: 0,
    unclassified: 0,
    unclassifiedWrong: 0,
    tags: [],
    areas: [],
  };
  for (const item of classification.items) {
    const outcome = Object.hasOwn(outcomes, item.itemId)
      ? outcomes[item.itemId]
      : 'unknown';
    if (outcome === 'unknown') result.unknown++;
    if (item.itemStatus !== 'classified') {
      result.unclassified++;
      if (outcome === 'incorrect') result.unclassifiedWrong++;
      continue;
    }
    if (outcome === 'unknown') continue;
    result.assessed++;
    result[outcome]++;
    const itemAreas = new Set<string>();
    for (const entry of item.tags.filter((t) => t.status === 'adopted')) {
      const tag = tagById.get(entry.tagId)!;
      const row = tags.get(tag.tagId) ?? { ...tag, ...counts() };
      row.total++;
      row[outcome]++;
      tags.set(tag.tagId, row);
      itemAreas.add(tag.area);
    }
    // Two adopted tags in the same area still describe one assessed question.
    for (const name of itemAreas) {
      const row = areas.get(name) ?? { name, ...counts() };
      row.total++;
      row[outcome]++;
      areas.set(name, row);
    }
  }
  result.tags = [...tags.values()].sort((a, b) =>
    a.tagId.localeCompare(b.tagId),
  );
  result.areas = [...areas.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return result;
}

export function outcomesFromWrongList(
  classification: Classification,
  value: string,
  complete: boolean,
): Record<string, Outcome> {
  const byPosition = new Map(
    classification.items.map((item) => [
      coordinate(item.page, item.displayNumber),
      item.itemId,
    ]),
  );
  const result: Record<string, Outcome> = Object.fromEntries(
    classification.items.map((item) => [
      item.itemId,
      complete ? 'correct' : 'unknown',
    ]),
  );
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/).filter((line) => line.trim())) {
    const match = /^\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line);
    const id = match && byPosition.get(coordinate(Number(match[1]), match[2]));
    if (!id || seen.has(id))
      throw new OperationError(
        '오답은 중복 없이 쪽수 | 번호 형식으로 입력해 주세요. 등록된 문항과 일치해야 합니다.',
        422,
      );
    seen.add(id);
    result[id] = 'incorrect';
  }
  return result;
}

/** Receiver contract for externally graded results; this function never grades answers. */
export function parseGradedResults(
  input: unknown,
  data: Classification,
  studentId: string,
  classificationRevision: number,
): Record<string, Outcome> {
  const envelope = z
    .object({
      formatVersion: z.literal('1.0'),
      assignmentId: identifier,
      studentId: identifier,
      classificationRevision: z.number().int().positive(),
      results: z
        .array(
          z.object({
            page: z.number().int().positive(),
            displayNumber: z.string().trim().min(1).max(80),
            outcome: z.enum(['correct', 'incorrect', 'unknown']),
          }),
        )
        .max(2000),
    })
    .safeParse(input);
  if (
    !envelope.success ||
    envelope.data.assignmentId !== data.assignmentId ||
    envelope.data.studentId !== studentId ||
    envelope.data.classificationRevision !== classificationRevision
  )
    throw new OperationError(
      '채점 결과의 형식·숙제·학생·분류 버전을 확인해 주세요.',
      422,
    );
  const byCoordinate = new Map(
    data.items.map((i) => [coordinate(i.page, i.displayNumber), i.itemId]),
  );
  const outcomes: Record<string, Outcome> = Object.fromEntries(
    data.items.map((i) => [i.itemId, 'unknown']),
  );
  const used = new Set<string>();
  for (const result of envelope.data.results) {
    const id = byCoordinate.get(coordinate(result.page, result.displayNumber));
    if (!id || used.has(id))
      throw new OperationError(
        '분류에 없거나 중복된 쪽수·문항 번호입니다.',
        422,
      );
    used.add(id);
    outcomes[id] = result.outcome;
  }
  return outcomes;
}
