import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText } from '../text/normalize.ts';
import {
  formatKstDate,
  isValidAt,
  kstStartOfDay,
  toKstDate,
} from '../text/time.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import { tableDateAt } from './table-dates.ts';
import { supportsExcerpt } from './verify.ts';

const amountPattern = /^(\d{1,3}(?:,\d{3})+|\d+)\s*원$/;
const readAmount = (value: string | undefined) => {
  const match = amountPattern.exec(value?.trim() ?? '');
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
};

export async function answerSessionPrice(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const previous = ctx.state?.previousFrame?.sessionPrice;
  const revision =
    previous &&
    /^내년(?:에|에는|에도|은|도)?\s*(?:같은|똑같은|변경된)\s*(?:가격|요금|금액|비용)/.test(
      frame.normalized,
    );
  const current =
    /(?<!\d)1\s*회\s*(?:요금|가격|금액|비용)|회당\s*(?:요금|가격|금액|비용)/.test(
      frame.normalized,
    ) &&
    /얼마|몇\s*원/.test(frame.normalized) &&
    !/내년|작년|회권/.test(frame.normalized);
  if (
    (!current && !revision) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    /제외|환불|할인|수강료|교재비|비교|합계/.test(frame.normalized)
  )
    return;
  const classIds = explicitClassIds(ctx);
  const year = toKstDate(ctx.asOf).year + 1;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: revision
      ? kstStartOfDay({ year, month: 1, day: 1 })
      : undefined,
    query: revision
      ? previous.label + ' ' + year + ' 개정 1회 요금'
      : ctx.question,
    documentTypes: revision ? ['fee', 'announcement'] : ['fee', 'academy_info'],
    limit: 50,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const options = hits.flatMap(({ chunk }) => {
    const { kind, cells, header, section } = chunk.location;
    if (
      kind !== 'table_row' ||
      !cells ||
      !header ||
      header.length !== cells.length ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      isAssistantDirective(chunk.text) ||
      !canReadRecord(ctx.access, chunk, []) ||
      (chunk.classId !== null &&
        (revision
          ? chunk.classId !== previous.classId
          : !classIds.includes(chunk.classId) &&
            !ctx.access.allowedClassIds.includes(chunk.classId)))
    )
      return [];
    const service = header.findIndex((label) =>
      /^(?:구분|과정|과정명|강좌|강좌명|항목|서비스|프로그램)$/.test(
        compactText(label),
      ),
    );
    if (service < 0) return [];
    const name = cells[service];
    const label = compactText(name.replace(/\s*\([^()]+\)\s*$/, ''));
    if (
      label.length < 3 ||
      (revision ? label !== previous.label : !frame.compact.includes(label))
    )
      return [];
    let at = ctx.asOf;
    const tableColumns = [service];
    const date = /(\d{4}년\s*\d{1,2}월\s*\d{1,2}일)\s*부터/.exec(
      section ?? '',
    )?.[1];
    if (revision) {
      const effective = date && tableDateAt(date, year);
      if (!effective || toKstDate(effective).year !== year) return [];
      at = effective;
      const old = header.findIndex((value) =>
        /^현재1회(?:요금|가격|금액)$/.test(compactText(value)),
      );
      if (readAmount(cells[old]) !== previous.amount) return [];
      tableColumns.push(old);
    } else if (date) {
      const effective = tableDateAt(date, toKstDate(at).year);
      if (effective === undefined || effective > at) return [];
    }
    const price = header.findIndex((value) =>
      revision
        ? /^(?:개정|변경후)1회(?:요금|가격|금액)$/.test(compactText(value))
        : /^(?:1회|회당)(?:요금|가격|금액|비용)$/.test(compactText(value)),
    );
    const amount = readAmount(cells[price]);
    if (amount === undefined || !isValidAt(chunk.validFrom, chunk.validTo, at))
      return [];
    tableColumns.push(price);
    const line = [...new Set([0, ...tableColumns])]
      .map((i) => header[i] + ': ' + cells[i])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt)
      ? [{ excerpt, at, amount, label, name, value: cells[price].trim() }]
      : [];
  });
  const selected = options[0];
  if (!selected)
    return revision
      ? abstain(
          '직전 문의 항목의 내년 요금을 승인 자료에서 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        )
      : undefined;
  if (
    options.some(
      ({ at, amount, label }) =>
        at !== selected.at ||
        amount !== selected.amount ||
        label !== selected.label,
    )
  )
    return abstain(
      '같은 항목의 승인 요금이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const { excerpt, at, value, name, label, amount } = selected;
  ctx.trace.intent = revision
    ? 'revised_session_price'
    : 'session_price_evidence';
  return {
    status: 'answered',
    text:
      (revision ? formatKstDate(at) + '부터 ' : '') +
      name +
      ' 1회 요금은 ' +
      value +
      '입니다.',
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
        effectiveAt: at,
      },
    ],
    excerpts: [excerpt],
    usedFacts: [],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        units: [],
        periods: [],
        sessionPrice:
          previous && revision
            ? previous
            : { label, classId: excerpt.chunk.classId, amount },
      },
    },
  };
}
