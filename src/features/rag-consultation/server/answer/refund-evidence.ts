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

function coversWeek(value: string, week: number): boolean {
  const text = compactText(value);
  const bounded = /^(\d+)주차종료후[~～–-](\d+)주차종료전$/.exec(text);
  if (bounded) return Number(bounded[1]) < week && week <= Number(bounded[2]);
  const after = /^(\d+)주차종료후$/.exec(text);
  if (after) return Number(after[1]) < week;
  const exact = /^(\d+)주차$/.exec(text);
  return exact !== null && Number(exact[1]) === week;
}

export async function answerWeeklyRefund(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  if (
    ctx.frame.topics
      .filter(({ id }) => id !== 'parking')
      .some(({ id }) => id !== 'refund') ||
    !ctx.frame.topics.some(({ id }) => id === 'refund')
  )
    return;
  if (explicitClassIds(ctx).length > 0) return;
  const weeks = [
    ...ctx.frame.normalized.matchAll(/(?<!\d)(\d{1,2})\s*주\s*차/g),
  ];
  if (
    weeks.length !== 1 ||
    /종료|이전|이후|전날|마지막|정확히|경과|며칠/.test(ctx.frame.normalized)
  )
    return;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['policy', 'fee'],
    query: '환불 반환 사유 발생 시점 반환 금액 ' + weeks[0][0],
    limit: 50,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const rows = hits.flatMap(({ chunk }) => {
    const { kind, header, cells } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      chunk.classId ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      return [];
    const time = header.findIndex((label) =>
      /^(?:환불|반환)(?:사유발생)?시점$/.test(compactText(label)),
    );
    const amount = header.findIndex((label) =>
      /^(?:환불|반환)(?:금액|비율)$/.test(compactText(label)),
    );
    if (
      time < 0 ||
      amount < 0 ||
      !coversWeek(cells[time], Number(weeks[0][1])) ||
      !cells[amount].trim()
    )
      return [];
    const tableColumns = [time, amount];
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt)
      ? [{ excerpt, value: compactText(cells[amount]) }]
      : [];
  });
  if (!rows.length) return;
  if (new Set(rows.map(({ value }) => value)).size > 1)
    return abstain(
      '같은 주차의 승인된 환불 규정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const { excerpt } = rows[0];
  ctx.trace.intent = 'weekly_refund';
  return {
    status: 'answered',
    text: excerpt.line,
    excerpts: [excerpt],
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
      },
    ],
    usedFacts: [],
  };
}
