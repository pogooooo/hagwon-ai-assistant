import { isAssistantDirective } from '../ingest/validation.ts';
import { compactText } from '../text/normalize.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

export async function answerWeeklyCurriculum(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized } = ctx.frame;
  const weeks = [...normalized.matchAll(/(?<!\d)(\d{1,2})\s*주\s*차/g)];
  if (
    weeks.length !== 1 ||
    !/배워|배우|학습\s*(?:주제|내용)|커리큘럼|실습|결과물|뭐\s*만들/.test(
      normalized,
    )
  )
    return;

  const classIds = explicitClassIds(ctx);
  if (classIds.length !== 1) return;
  const klass = ctx.catalog.classes.find(
    ({ classId }) => classId === classIds[0],
  );
  if (!klass) return;
  const names = [klass.name, ...klass.aliases].map(compactText);
  const week = Number(weeks[0][1]);
  const asksResult = /결과물|뭐\s*만들/.test(normalized);
  const asksTopic = /배워|배우|학습\s*(?:주제|내용)/.test(normalized);
  const result = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [klass.name, week + '주 차', '주차 학습 주제 실습 결과물'].join(' '),
    documentTypes: ['schedule', 'academy_info', 'announcement'],
    limit: 80,
  });
  recordChunks(
    ctx.trace,
    result.map(({ chunk }) => chunk),
  );
  const rows = result.flatMap(({ chunk }) => {
    const { kind, header, cells } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      (chunk.classId && chunk.classId !== klass.classId)
    )
      return [];
    const namesColumn = header.findIndex((value) =>
      /^(과정|과정명|강좌|강좌명|반|반이름)$/.test(compactText(value)),
    );
    const weekColumn = header.findIndex(
      (value) => compactText(value) === '주차',
    );
    const requestedColumns = header.flatMap((value, index) =>
      /^(학습주제|학습내용|수업내용|실습결과물|결과물|실습)$/.test(
        compactText(value),
      ) && cells[index].trim()
        ? [index]
        : [],
    );
    if (
      namesColumn < 0 ||
      weekColumn < 0 ||
      !requestedColumns.length ||
      !names.includes(compactText(cells[namesColumn])) ||
      Number(/^(\d{1,2})주차$/.exec(compactText(cells[weekColumn]))?.[1]) !==
        week
    )
      return [];
    if (
      asksResult &&
      !requestedColumns.some((index) => /결과물|실습/.test(header[index]))
    )
      return [];
    if (
      asksTopic &&
      !requestedColumns.some((index) => /학습|수업/.test(header[index]))
    )
      return [];
    const tableColumns = [namesColumn, weekColumn, ...requestedColumns];
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt)
      ? [
          {
            excerpt,
            signature: requestedColumns
              .map((index) => compactText(header[index] + cells[index]))
              .join('|'),
          },
        ]
      : [];
  });
  if (!rows.length)
    return abstain(
      '요청한 반과 주차의 승인 커리큘럼을 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (new Set(rows.map(({ signature }) => signature)).size > 1)
    return abstain(
      '같은 반과 주차의 승인 커리큘럼이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );

  const { excerpt } = rows[0];
  ctx.trace.intent = 'weekly_curriculum';
  return {
    status: 'answered',
    text: excerpt.line,
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
      },
    ],
    excerpts: [excerpt],
    usedFacts: [],
  };
}
