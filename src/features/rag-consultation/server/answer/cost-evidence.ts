import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText } from '../text/normalize.ts';
import {
  formatKstDate,
  isValidAt,
  kstStartOfDay,
  toKstDate,
} from '../text/time.ts';
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
import { formatKrw } from './format.ts';
import { explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

import { requiredCostSlots, type CostSlot } from '../query/plan.ts';
const COST_KEYS = {
  fee: /^(?:(?:월|매월|1개월|\d+주)\s*)?(?:수강료|교습비|학원비)(?:\s*\((?:월|\d+주|\d+개월)\))?$/,
  material: /^(?:(?:실험|실습)\s*)?(?:교재비|재료비)$/,
  textbook: /^교재비$/,
  supplies: /^(?:(?:실험|실습)\s*)?재료비$/,
};
const AMOUNT =
  /^(?:(?:월|매월|\d+\s*(?:주|개월)(?:당|\s*기준)?)\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원(?:\s*\((?:월|\d+\s*(?:주|개월))(?:당|\s*기준)?\))?$/;

/** Compare billing units independently of how the original amount is printed. */
function billingPeriods(text: string): string[] {
  return [...text.matchAll(/(\d+)\s*(개월|주)|매월|월/g)].map((match) =>
    match[1] ? `${Number(match[1])}${match[2]}` : '1개월',
  );
}
interface CostEvidence extends EvidenceExcerpt {
  classId: string;
  field: CostSlot;
  amount: number;
  value: string;
  label: string;
  tableColumns: number[];
}

function selectCosts(
  ctx: AnswerContext,
  chunk: RagChunk,
  classIds: readonly string[],
  fields: readonly CostSlot[],
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

async function answerUpcomingFee(
  ctx: AnswerContext,
  classId: string,
): Promise<AnswerDraft> {
  const year = toKstDate(ctx.asOf).year + 1;
  const from = kstStartOfDay({ year, month: 1, day: 1 });
  const until = kstStartOfDay({ year: year + 1, month: 1, day: 1 });
  const scope = {
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['monthly_fee'] as const,
  };
  const eligible = (fact: ApprovedFact) =>
    fact.academyId === ctx.access.academyId &&
    fact.subjectType === 'class' &&
    fact.subjectId === classId &&
    fact.factType === 'monthly_fee' &&
    fact.approvalStatus === 'approved';
  const facts = await ctx.facts.queryApprovedFacts({
    ...scope,
    startsIn: { from, until },
  });
  recordFacts(ctx.trace, facts);
  const first = facts
    .filter(
      (fact) =>
        eligible(fact) && fact.validFrom >= from && fact.validFrom < until,
    )
    .sort((a, b) => a.validFrom - b.validFrom)[0];
  if (!first || first.value.kind !== 'money')
    return abstain(
      '승인된 내년 수강료 개정 자료를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );

  const at = first.validFrom;
  const amount = first.value.amount;
  const effective = await ctx.facts.queryApprovedFacts({
    ...scope,
    effectiveAt: at,
  });
  recordFacts(ctx.trace, effective);
  if (
    effective.some(
      (fact) =>
        eligible(fact) &&
        isValidAt(fact.validFrom, fact.validTo, at) &&
        (fact.value.kind !== 'money' || fact.value.amount !== amount),
    )
  )
    return abstain(
      '같은 시점의 승인 자료에서 비용이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'upcoming_fee';
  return {
    status: 'answered',
    text:
      className(ctx.catalog, classId) +
      ' 수강료는 ' +
      formatKstDate(at) +
      '부터 ' +
      formatKrw(amount) +
      '입니다.',
    citations: [{ kind: 'fact', fact: first, effectiveAt: at }],
    usedFacts: [first],
    instants: [at],
  };
}
/** Returns undefined for requests whose semantics still use the legacy adapter. */
export async function answerFromCostEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const classIds = explicitClassIds(ctx);
  const fields =
    ctx.plannedRequest?.frame === frame
      ? ctx.plannedRequest.costSlots
      : requiredCostSlots(frame);
  if (
    classIds.length === 1 &&
    fields.length === 1 &&
    fields[0] === 'fee' &&
    frame.topics.every(({ id }) => id === 'fee') &&
    /내년|다음\s*해/.test(frame.normalized) &&
    /개정|인상|오르|올라|바뀌/.test(frame.normalized) &&
    frame.months.length === 0 &&
    frame.explicitDates.length === 0 &&
    !frame.flags.compare
  )
    return answerUpcomingFee(ctx, classIds[0]);
  const distinctMaterials =
    fields.includes('textbook') && fields.includes('supplies');
  if (distinctMaterials && /포함|들어\s*있/.test(frame.normalized))
    return abstain(
      '교재비와 재료비의 포함 관계를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (
    !classIds.length ||
    !fields.length ||
    !frame.topics.every(({ id }) => id === 'fee' || id === 'material') ||
    frame.flags.compare ||
    frame.flags.previousRevision ||
    (frame.relativePeriod !== null &&
      !(frame.relativePeriod === 'this_month' && distinctMaterials)) ||
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
  if (!candidates.length)
    return distinctMaterials
      ? abstain(
          '교재비와 재료비를 구분할 수 있는 승인 자료가 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        )
      : undefined;

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
          (field === 'fee' || !distinctMaterials) &&
          fact.value.kind === 'money',
      );
      // A slot available only through the structured adapter keeps its original path.
      if (!options.length && scopedFacts.length && !distinctMaterials)
        return undefined;
      const amounts = new Set([
        ...options.map(({ amount }) => amount),
        ...scopedFacts.flatMap(({ value }) =>
          value.kind === 'money' ? [value.amount] : [],
        ),
      ]);
      const explicitPeriodOptions = options.filter(
        ({ label, value }) => billingPeriods(label + ' ' + value).length > 0,
      );
      if (
        amounts.size > 1 ||
        (field === 'material' &&
          new Set(options.map(({ label }) => label.includes('교재비'))).size >
            1) ||
        new Set(
          options.flatMap(({ label, value }) =>
            billingPeriods(label + ' ' + value),
          ),
        ).size > 1
      ) {
        return abstain(
          '같은 시점의 승인 자료에서 비용이 서로 다릅니다. 담당자에게 확인해 주세요.',
          'CONFLICTING_EVIDENCE',
        );
      }
      const comparable = explicitPeriodOptions.length
        ? explicitPeriodOptions
        : options;
      const choice =
        comparable.find((option) =>
          scopedFacts.some((fact) => fact.sourceId === option.chunk.sourceId),
        ) ?? comparable[0];
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
            {
              fee: ' 수강료',
              textbook: ' 교재비',
              supplies: ' 재료비',
              material: ' 교재·재료비',
            }[field],
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
        topicIds: [
          ...new Set(
            fields.map((field) => (field === 'fee' ? 'fee' : 'material')),
          ),
        ],
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
