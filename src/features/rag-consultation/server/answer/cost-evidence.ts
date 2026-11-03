import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText } from '../text/normalize.ts';
import { isValidAt } from '../text/time.ts';
import type { ApprovedFact, RagChunk } from '../types.ts';
import {
  abstain,
  className,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

type CostField = 'fee' | 'material';
const COST_KEYS = {
  fee: /^(?:(?:월|매월|1개월|\d+주)\s*)?(?:수강료|교습비|학원비)(?:\s*\((?:월|\d+주|\d+개월)\))?$/,
  material: /^(?:(?:실험|실습)\s*)?(?:교재비|재료비)$/,
};
const AMOUNT =
  /^(?:(?:월|매월|\d+\s*(?:주|개월)(?:당|\s*기준)?)\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원(?:\s*\((?:월|\d+\s*(?:주|개월))(?:당|\s*기준)?\))?$/;

interface CostEvidence extends EvidenceExcerpt {
  classId: string;
  field: CostField;
  amount: number;
  value: string;
  label: string;
  tableColumns: number[];
}

function selectCosts(
  ctx: AnswerContext,
  chunk: RagChunk,
  classIds: readonly string[],
  fields: readonly CostField[],
  at: number,
): CostEvidence[] {
  const { cells, header, kind } = chunk.location;
  if (
    kind !== 'table_row' ||
    !cells ||
    !header ||
    header.length !== cells.length ||
    chunk.suspicious ||
    chunk.extraction?.needsReview ||
    chunk.extraction?.uncertainTokens.length ||
    !canReadRecord(ctx.access, chunk, []) ||
    !isValidAt(chunk.validFrom, chunk.validTo, at)
  )
    return [];

  const classColumn = header.findIndex((label) =>
    /^(반|반이름|과정|과정명|강좌|강좌명|수업명|클래스)$/.test(
      compactText(label),
    ),
  );
  const matches = ctx.catalog.classes.filter(
    (entry) =>
      (!chunk.classId || chunk.classId === entry.classId) &&
      (classColumn >= 0
        ? [entry.name, ...entry.aliases].some(
            (name) => compactText(name) === compactText(cells[classColumn]),
          )
        : chunk.classId === entry.classId),
  );
  if (matches.length !== 1 || !classIds.includes(matches[0].classId)) return [];
  const [klass] = matches;

  const key = header.findIndex((label) =>
    /^(항목|구분|비용항목)$/.test(compactText(label)),
  );
  const amountColumn = header.findIndex((label) =>
    /^(금액|비용)$/.test(compactText(label)),
  );
  return fields.flatMap((field) => {
    const column =
      key >= 0 && amountColumn >= 0 && COST_KEYS[field].test(cells[key].trim())
        ? amountColumn
        : header.findIndex((label) => COST_KEYS[field].test(label.trim()));
    if (column < 0) return [];
    const label =
      column === amountColumn ? cells[key].trim() : header[column].trim();
    if (
      field === 'material' &&
      ((/교재비|책값/.test(ctx.frame.normalized) &&
        !/재료비/.test(ctx.frame.normalized) &&
        !label.includes('교재비')) ||
        (/재료비/.test(ctx.frame.normalized) &&
          !/교재비|책값/.test(ctx.frame.normalized) &&
          !label.includes('재료비')))
    )
      return [];
    const value = cells[column].trim();
    const match = AMOUNT.exec(value);
    if (!match) return [];
    const tableColumns = [
      ...new Set(
        [classColumn, column === amountColumn ? key : -1, column].filter(
          (index) => index >= 0,
        ),
      ),
    ].sort((a, b) => a - b);
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    return [
      {
        classId: klass.classId,
        field,
        amount: Number(match[1].replace(/,/g, '')),
        label,
        value,
        chunk,
        line,
        tableColumns,
      },
    ];
  });
}

/** Returns undefined for requests whose semantics still use the legacy adapter. */
export async function answerFromCostEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const classIds = explicitClassIds(ctx);
  const fields = frame.topics.map(({ id }) => id);
  if (
    !classIds.length ||
    !fields.length ||
    !fields.every((id): id is CostField => id === 'fee' || id === 'material') ||
    frame.flags.compare ||
    frame.flags.previousRevision ||
    frame.relativePeriod !== null ||
    frame.months.length > 0 ||
    frame.explicitDates.length > 0 ||
    frame.amountsKrw.length ||
    /납부|결제|포함|무료|할인|언제|기한|환불|말고|제외|합쳐|합계|오르|인상|개정|별도\s*신청/.test(
      frame.normalized,
    ) ||
    (fields.includes('fee') &&
      !/수강료|교습비|학원비|원비|한\s*달|매달|월\s*얼마/.test(
        frame.normalized,
      ))
  )
    return undefined;

  const { at } = resolveEffectiveTime(frame, ctx.asOf);
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      ctx.question,
      ...classIds.map((id) => className(ctx.catalog, id)),
      '수강료 교습비 교재비 재료비 금액',
    ].join(' '),
    limit: 40,
    documentTypes: ['fee'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const candidates = hits.flatMap(({ chunk }) =>
    selectCosts(ctx, chunk, classIds, fields, at),
  );
  if (!candidates.length) return undefined;

  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    effectiveAt: at,
    factTypes: ['monthly_fee', 'material_fee'],
  });
  recordFacts(ctx.trace, facts);
  const selected: CostEvidence[] = [];
  const usedFacts: ApprovedFact[] = [];
  const missing: string[] = [];
  for (const classId of classIds) {
    for (const field of fields) {
      const options = candidates.filter(
        (entry) =>
          entry.classId === classId &&
          entry.field === field &&
          supportsExcerpt(entry),
      );
      const scopedFacts = facts.filter(
        (fact) =>
          fact.academyId === ctx.access.academyId &&
          fact.subjectType === 'class' &&
          fact.subjectId === classId &&
          fact.approvalStatus === 'approved' &&
          isValidAt(fact.validFrom, fact.validTo, at) &&
          fact.factType ===
            (field === 'fee' ? 'monthly_fee' : 'material_fee') &&
          fact.value.kind === 'money',
      );
      // A slot available only through the structured adapter keeps its original path.
      if (!options.length && scopedFacts.length) return undefined;
      const amounts = new Set([
        ...options.map(({ amount }) => amount),
        ...scopedFacts.flatMap(({ value }) =>
          value.kind === 'money' ? [value.amount] : [],
        ),
      ]);
      if (
        amounts.size > 1 ||
        new Set(options.map(({ label, value }) => compactText(label + value)))
          .size > 1
      ) {
        return abstain(
          '같은 시점의 승인 자료에서 비용이 서로 다릅니다. 담당자에게 확인해 주세요.',
          'CONFLICTING_EVIDENCE',
        );
      }
      const choice =
        options.find((option) =>
          scopedFacts.some((fact) => fact.sourceId === option.chunk.sourceId),
        ) ?? options[0];
      if (choice) {
        selected.push(choice);
        usedFacts.push(
          ...scopedFacts.filter(
            (fact) =>
              fact.sourceId === choice.chunk.sourceId &&
              fact.documentId === choice.chunk.documentId &&
              fact.revision === choice.chunk.revision,
          ),
        );
      } else
        missing.push(
          className(ctx.catalog, classId) +
            (field === 'fee' ? ' 수강료' : ' 교재·재료비'),
        );
    }
  }
  if (!selected.length) return undefined;
  ctx.trace.intent = 'cost_evidence';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      ...selected.map(
        ({ classId, label, value }) =>
          className(ctx.catalog, classId) + ' ' + label + ': ' + value,
      ),
      ...(missing.length ? ['확인되지 않은 항목: ' + missing.join(', ')] : []),
    ].join('\n'),
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        units: [],
        periods: [],
        topicIds: fields,
        classIds,
      },
    },
    excerpts: selected,
    citations: selected.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    usedFacts,
  };
}
