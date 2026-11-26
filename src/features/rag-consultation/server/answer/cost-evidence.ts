import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
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
import { answerSessionPrice } from './session-price.ts';
import { answerTuitionPolicy } from './tuition-policy.ts';
import { isCleanPublicEvidence, readEvidenceRow } from './public-evidence.ts';
import { resolveQualifiedClasses } from './class-targets.ts';

import {
  prepaidTuitionMonth,
  requiredCostSlots,
  type CostSlot,
} from '../query/plan.ts';
const COST_KEYS = {
  fee: /^(?:(?:월|매월|1개월|\d+주)\s*)?(?:수강료|교습비|학원비)(?:\s*\((?:월|\d+주|\d+개월)\))?$/,
  material: /^(?:(?:실험|실습)\s*)?(?:교재비|재료비)(?:\s*\((?:월|학기)\))?$/,
  textbook: /^교재비(?:\s*\((?:월|학기)\))?$/,
  supplies: /^(?:(?:실험|실습)\s*)?재료비(?:\s*\((?:월|학기)\))?$/,
  kit: /^(?:(?:교구|실습|실험|재료)\s*)?키트\s*(?:비용|비|구입비|구매비|가격)$/,
};
const AMOUNT =
  /^(?:(?:월|매월|학기당|\d+\s*(?:주|개월)(?:당|\s*기준)?)\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원(?:\s*\((?:월|\d+\s*(?:주|개월))(?:당|\s*기준)?\))?$/;

/** Compare billing units independently of how the original amount is printed. */
function billingPeriods(text: string): string[] {
  return [...text.matchAll(/(\d+)\s*(개월|주)|매월|월|학기(?:당)?/g)].map(
    (match) => (match[1] ? `${Number(match[1])}${match[2]}` : '1개월'),
  );
}
type MaterialField = CostSlot | 'kit';

interface CostEvidence<
  Field extends MaterialField = CostSlot,
> extends EvidenceExcerpt {
  classId: string;
  field: Field;
  amount: number;
  value: string;
  label: string;
  tableColumns: number[];
}

function selectCosts<Field extends MaterialField>(
  ctx: AnswerContext,
  chunk: RagChunk,
  classIds: readonly string[],
  fields: readonly Field[],
  at: number,
): CostEvidence<Field>[] {
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
  const gradeColumn = header.findIndex((label) =>
    /^(대상|(?:대상|수강)?학년)$/.test(compactText(label)),
  );
  const classLabel = cells[classColumn];
  const grade = cells[gradeColumn]?.trim();
  const qualified =
    classLabel && grade ? compactText(classLabel + '(' + grade + ')') : '';
  const hasQualifiedClass =
    qualified &&
    ctx.catalog.classes.some((entry) =>
      [entry.name, ...entry.aliases].some(
        (name) => compactText(name) === qualified,
      ),
    );
  const matches = ctx.catalog.classes.filter(
    (entry) =>
      (!chunk.classId || chunk.classId === entry.classId) &&
      (classColumn >= 0
        ? [entry.name, ...entry.aliases].some(
            (name) =>
              compactText(name) ===
              (hasQualifiedClass ? qualified : compactText(classLabel)),
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
    const tenThousands = /^(\d+(?:\.\d+)?)\s*만\s*원$/.exec(value);
    const amount = match
      ? Number(match[1].replace(/,/g, ''))
      : tenThousands
        ? Math.round(Number(tenThousands[1]) * 10_000)
        : NaN;
    if (!Number.isSafeInteger(amount)) return [];
    const tableColumns = [
      ...new Set(
        [
          classColumn,
          hasQualifiedClass ? gradeColumn : -1,
          column === amountColumn ? key : -1,
          column,
        ].filter((index) => index >= 0),
      ),
    ].sort((a, b) => a - b);
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    return [
      {
        classId: klass.classId,
        field,
        amount,
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
/** A pass can name a service listed in a fee table rather than a catalog class. */
async function answerPassPrice(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, relativePeriod, months, explicitDates } = ctx.frame;
  const pass = /(\d+)\s*회권/.exec(normalized);
  if (
    !pass ||
    !/얼마|가격|요금|금액|비용/.test(normalized) ||
    /포함|유효|환불|취소|기한|사용|할인|묶음|합계|비교|내년|작년|말고|제외/.test(
      normalized,
    ) ||
    relativePeriod ||
    months.length ||
    explicitDates.length
  )
    return undefined;

  const requested = compactText(normalized);
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question,
    limit: 40,
    documentTypes: ['fee'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const candidates = hits.flatMap(({ chunk }) => {
    const { kind, cells, header } = chunk.location;
    if (
      kind !== 'table_row' ||
      !cells ||
      !header ||
      (chunk.classId !== null &&
        !explicitClassIds(ctx).includes(chunk.classId)) ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      !canReadRecord(ctx.access, chunk, []) ||
      !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
    )
      return [];
    const service = header.findIndex((label) =>
      /^(구분|과정|과정명|강좌|강좌명|항목|서비스|프로그램)$/.test(
        compactText(label),
      ),
    );
    const price = header.findIndex(
      (label) => compactText(label) === pass[1] + '회권',
    );
    if (service < 0 || price < 0 || !cells[service] || !cells[price]) return [];
    const label = compactText(cells[service]);
    const value = cells[price].trim();
    const amount = AMOUNT.exec(value);
    if (label.length < 3 || !requested.includes(label) || !amount) return [];
    const tableColumns = [service, price].sort((a, b) => a - b);
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt)
      ? [
          {
            label,
            excerpt,
            amount: Number(amount[1].replace(/,/g, '')),
            name: cells[service],
            value,
          },
        ]
      : [];
  });
  const selected = candidates[0];
  if (!selected) return undefined;
  if (
    candidates.some(
      (option) =>
        option.label !== selected.label || option.amount !== selected.amount,
    )
  )
    return abstain(
      '승인 자료에서 이용권의 단일 가격을 확인할 수 없습니다.',
      'CONFLICTING_EVIDENCE',
    );
  const { chunk, tableColumns } = selected.excerpt;
  ctx.trace.intent = 'pass_price_evidence';
  return {
    status: 'answered',
    text: selected.name + ' ' + pass[1] + '회권: ' + selected.value,
    citations: [{ kind: 'chunk', chunk, tableColumns }],
    excerpts: [selected.excerpt],
    usedFacts: [],
  };
}
/** An enrolled learner's equipment charge needs a row with an explicit class condition. */
export async function answerClassRentalPrice(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const equipment = /(노트북|태블릿|기기)\s*대여료/.exec(frame.normalized)?.[1];
  if (
    !equipment ||
    frame.matchedStudentIds.length !== 1 ||
    ctx.studentClassIds.length !== 1 ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    !/내야|얼마|무료|있어요|있나요|받나요|내나요/.test(frame.normalized) ||
    /환불|신청|반납|분실|파손|포함|할인|개정|예전|내년|수강료|교재비|재료비|차량비|방학|수업\s*시간|시간표|시간(?:이랑|과)|\d\s*기/.test(
      frame.normalized,
    ) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod
  )
    return;
  const [classId] = ctx.studentClassIds;
  if (
    frame.negatedClassIds.includes(classId) ||
    (frame.classIds.length > 0 && !frame.classIds.includes(classId))
  )
    return;
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return;
  const level = /^([a-z]+\d+)(?!\d)/i.exec(klass.name)?.[1]?.toLowerCase();
  const uniqueLevel =
    level &&
    ctx.catalog.classes.filter(
      ({ name }) =>
        /^([a-z]+\d+)(?!\d)/i.exec(name)?.[1]?.toLowerCase() === level,
    ).length === 1
      ? level
      : undefined;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['fee'],
    query: [klass.name, equipment, '대여료 금액 대상 안내 없음'].join(' '),
    limit: 32,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const hits = found.flatMap(({ chunk }) => {
    const { kind, header, cells } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      !canReadRecord(ctx.access, chunk, []) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      (chunk.classId && chunk.classId !== classId)
    )
      return [];
    const fields = header.map(compactText);
    const key = fields.findIndex((label) =>
      /^(?:항목|서비스|구분)$/.test(label),
    );
    const price = fields.findIndex((label) =>
      /^(?:금액|대여료|요금|비용)$/.test(label),
    );
    const note = fields.findIndex((label) =>
      /^(?:안내|대상|대상·비고|조건|비고)$/.test(label),
    );
    if (
      key < 0 ||
      price < 0 ||
      note < 0 ||
      ![cells[key], cells[note]].some((cell) =>
        compactText(cell).includes(equipment + '대여료'),
      )
    )
      return [];
    const condition = cells[note].split(/[.!?]/)[0];
    const scope = condition.split(/(?:반|과정)(?:은|는|이|가)\s+/)[0];
    const levels = [
      ...scope.matchAll(/(?<![a-z0-9])([a-z]+\d+)(?![a-z0-9])/gi),
    ].map(([, value]) => value.toLowerCase());
    const matches =
      chunk.classId === classId ||
      compactText(condition).includes(compactText(klass.name)) ||
      (uniqueLevel &&
        levels.includes(uniqueLevel) &&
        /반(?:은|는|이|가)|과정(?:은|는|이|가)/.test(condition) &&
        !/이상|이하|미만|초과|만\s*제외|일부|별도/.test(scope));
    if (
      !matches ||
      /제외|아닌|해당하지\s*않|미정|해당\s*없음|개별\s*문의/.test(condition)
    )
      return [];
    const value = cells[price].trim();
    if (
      !/^(?:없음|무료|(?:(?:\d+\s*(?:주|개월)|월)\s*)?\d[\d,]*\s*원)$/.test(
        value,
      )
    )
      return [];
    const tableColumns = [key, price, note];
    const line = tableColumns
      .map((i) => header[i] + ': ' + cells[i])
      .join(' / ');
    const excerpt = { chunk, line, tableColumns };
    return supportsExcerpt(excerpt) ? [{ excerpt, value }] : [];
  });
  if (!hits.length)
    return abstain(
      '등록 반에 적용되는 기기 대여료를 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (new Set(hits.map(({ excerpt }) => compactText(excerpt.line))).size > 1)
    return abstain(
      '같은 반의 승인 대여료 기준이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const { excerpt } = hits[0];
  ctx.trace.intent = 'class_rental_price';
  return {
    status: 'answered',
    text: excerpt.line,
    excerpts: [excerpt],
    usedFacts: [],
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
      },
    ],
  };
}

/** Bind ancillary charges to the named service and, for transport, the trip type. */
async function answerAncillaryPrice(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, relativePeriod, months, explicitDates } = ctx.frame;
  if (
    !/얼마|요금|가격|비용/.test(normalized) ||
    /환불|취소|할인|무료|포함|제외|말고|내년|작년/.test(normalized) ||
    relativePeriod ||
    months.length ||
    explicitDates.length
  )
    return undefined;
  const rental = /([가-힣a-z0-9]+?)(?:을|를)?\s*(?:빌리|빌려|대여)/.exec(
    normalized,
  )?.[1];
  const transport =
    /차량\s*(?:비|이용료)|셔틀\s*(?:비|요금|이용료)|통학\s*(?:비|요금)/.test(
      normalized,
    );
  if (!rental && !transport) return undefined;
  const oneWay = /편도|(?:등원|하원)\s*만/.test(normalized);
  const roundTrip = /왕복|(?:등원|하원).{0,8}(?:둘\s*다|모두)/.test(normalized);
  const compare = /같[나은]|똑같|차이|비교/.test(normalized);
  const slots = transport
    ? oneWay && !roundTrip && !compare
      ? ['편도']
      : roundTrip && !oneWay && !compare
        ? ['왕복']
        : ['왕복', '편도']
    : ['대여'];
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      ctx.question,
      rental ? rental + ' 대여료' : '차량 이용료 편도 왕복',
    ].join(' '),
    limit: 30,
    documentTypes: ['fee'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const scopedClasses = explicitClassIds(ctx);
  const selected: Array<EvidenceExcerpt & { text: string }> = [];
  for (const slot of slots) {
    const options = hits.flatMap(({ chunk }) => {
      const { kind, cells, header } = chunk.location;
      if (
        kind !== 'table_row' ||
        !cells ||
        !header ||
        chunk.suspicious ||
        chunk.extraction?.needsReview ||
        chunk.extraction?.uncertainTokens.length ||
        (chunk.classId !== null && !scopedClasses.includes(chunk.classId)) ||
        !canReadRecord(ctx.access, chunk, []) ||
        !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
      )
        return [];
      const key = header.findIndex((label) =>
        /^(항목|서비스|구분)$/.test(compactText(label)),
      );
      const price = header.findIndex((label) =>
        /^(?:금액|비용|요금)(?:\(월\))?$/.test(compactText(label)),
      );
      const label = cells[key];
      const value = cells[price]?.trim();
      if (!label || !value || !AMOUNT.test(value)) return [];
      const identifier = compactText(label);
      const matches = transport
        ? /^(차량이용료|셔틀이용료|통학차량비|차량비)\((왕복|편도)\)$/.exec(
            identifier,
          )?.[2] === slot
        : identifier === compactText(rental + '대여료');
      if (!matches) return [];
      const note = header.findIndex((name) =>
        /^(?:대상·비고|비고|조건|안내)$/.test(compactText(name)),
      );
      const tableColumns = [key, price, ...(cells[note] ? [note] : [])].sort(
        (a, b) => a - b,
      );
      const line = [...new Set([0, ...tableColumns])]
        .map((index) => header[index] + ': ' + cells[index])
        .join(' / ');
      const excerpt = { chunk, line, tableColumns };
      const period = compactText(header[price]).endsWith('(월)')
        ? ' (월 기준)'
        : '';
      return supportsExcerpt(excerpt)
        ? [
            {
              ...excerpt,
              text:
                label +
                ': ' +
                value +
                period +
                (cells[note] ? ' · ' + cells[note] : ''),
              value: compactText(value.replace(/,/g, '')) + period,
            },
          ]
        : [];
    });
    if (!options.length) return undefined;
    if (new Set(options.map(({ value }) => value)).size > 1)
      return abstain(
        '승인 자료에서 서비스 비용이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    selected.push(options[0]);
  }
  ctx.trace.intent = 'ancillary_price_evidence';
  return {
    status: 'answered',
    text: selected.map(({ text }) => text).join('\n'),
    citations: selected.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    excerpts: selected,
    usedFacts: [],
    conversationUpdate:
      !transport && rental
        ? {
            previousFrame: {
              domain: 'info',
              units: [],
              periods: [],
              loanItem: rental,
            },
          }
        : undefined,
  };
}
/** Payment instruments, installment availability, and deadlines are independent claims. */
async function answerPaymentTerms(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, explicitDates, months, relativePeriod } = ctx.frame;
  const installment =
    /할부/.test(normalized) && /수강료|교습비|카드|납부|결제/.test(normalized);
  const paymentQuestion =
    /납부|결제/.test(normalized) ||
    (/수강료|교습비|학원비/.test(normalized) &&
      /내야|내면|내는|낼|내나요/.test(normalized));
  const deadline =
    paymentQuestion &&
    /언제\s*까지|기한|마감|며칠\s*까지|몇\s*일\s*까지/.test(normalized) &&
    !/신규|첫\s*수업|교재비|재료비|차량비|특강비/.test(normalized);
  if (
    (!installment && !deadline) ||
    /\d+\s*기(?!간|준)|할인|환불|연체|내년|작년/.test(normalized) ||
    explicitDates.length ||
    months.length ||
    relativePeriod
  )
    return undefined;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question + ' 카드 할부 납부 기한',
    limit: 20,
    documentTypes: ['fee', 'policy', 'announcement'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const excerpts: EvidenceExcerpt[] = [];
  const missing: string[] = [];
  if (installment) {
    const supported = hits.flatMap(({ chunk }) =>
      chunk.classId === null &&
      chunk.location.kind === 'paragraph' &&
      !chunk.suspicious &&
      !chunk.extraction?.needsReview &&
      canReadRecord(ctx.access, chunk, [])
        ? splitSentences(chunk.text).flatMap((line) => {
            const direct =
              /할부.{0,14}(불가|안\s*됩|제공하지\s*않|지원하지\s*않|가능|지원)/.exec(
                line,
              );
            return direct && supportsExcerpt({ chunk, line })
              ? [{ chunk, line, allowed: /^(가능|지원)$/.test(direct[1]) }]
              : [];
          })
        : [],
    );
    if (new Set(supported.map(({ allowed }) => allowed)).size > 1)
      return abstain(
        '승인 자료의 할부 안내가 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    if (supported[0]) excerpts.push(supported[0]);
    else missing.push('할부 가능 여부');
  }
  if (deadline) {
    const monthly = /^매월\s*(0?[1-9]|[12]\d|3[01])\s*일\s*까지/;
    const supported = hits.flatMap<
      EvidenceExcerpt & { day: number; condition?: string }
    >(({ chunk }) => {
      if (
        chunk.classId !== null ||
        !isCleanPublicEvidence(chunk, ctx.asOf) ||
        !canReadRecord(ctx.access, chunk, [])
      )
        return [];
      const row = readEvidenceRow(chunk);
      if (row) {
        const key = row.column(/^(?:항목|항목명|구분)$/);
        const value = row.column(/^(?:내용|세부내용|안내|기준)$/);
        if (compactText(row.cells[key] ?? '') !== '납부기한') return [];
        const text = row.cells[value] ?? '';
        const when = monthly.exec(text);
        const excerpt = when && row.project(key, value);
        return when && excerpt
          ? [
              {
                ...excerpt,
                day: Number(when[1]),
                condition: compactText(text.slice(when[0].length)),
              },
            ]
          : [];
      }
      if (chunk.location.kind !== 'paragraph') return [];
      const label = /납부\s*기한\s*[:：]?\s*/.exec(chunk.text);
      if (!label) return [];
      const when = monthly.exec(
        chunk.text.slice(label.index + label[0].length),
      );
      if (!when) return [];
      const line = label[0] + when[0];
      return supportsExcerpt({ chunk, line })
        ? [{ chunk, line, day: Number(when[1]) }]
        : [];
    });
    if (
      new Set(supported.map(({ day }) => day)).size > 1 ||
      new Set(supported.map(({ condition }) => condition).filter(Boolean))
        .size > 1
    )
      return abstain(
        '승인 자료의 납부 기한이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    const preferred =
      supported.find(({ condition }) => condition) ?? supported[0];
    if (preferred) excerpts.push(preferred);
    else missing.push('납부 기한');
  }
  if (!excerpts.length)
    return installment
      ? abstain(
          '승인 자료에서 요청하신 납부 조건을 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
          missing,
        )
      : undefined;
  ctx.trace.intent = 'payment_terms_evidence';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      ...excerpts.map(({ line }) => line),
      ...(missing.length ? ['확인되지 않은 항목: ' + missing.join(', ')] : []),
    ].join('\n'),
    citations: excerpts.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    excerpts,
    usedFacts: [],
  };
}
/** Approval and the effective window are independent for scheduled payment notices. */
async function answerPaymentWindow(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, flags } = ctx.frame;
  const cohortPattern = /(?<!\d)\d+\s*기(?!간|준)/g;
  const cohorts = new Set(
    [...normalized.matchAll(cohortPattern)].map(([value]) =>
      compactText(value),
    ),
  );
  if (
    cohorts.size !== 1 ||
    flags.compare ||
    !/납부|수강료|교습비/.test(normalized) ||
    !/언제|며칠|기한|마감/.test(normalized) ||
    /환불|할부|연체|할인/.test(normalized)
  )
    return undefined;
  const [cohort] = cohorts;
  const upcomingUntil = ctx.asOf + 93 * 86_400_000;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil,
    query: ctx.question + ' 납부 기간 기한',
    limit: 30,
    documentTypes: ['fee', 'announcement', 'policy'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const options = hits.flatMap(({ chunk }) => {
    const { kind, header, cells } = chunk.location;
    const upcoming = chunk.validFrom > ctx.asOf;
    const effectiveAt = upcoming ? chunk.validFrom : ctx.asOf;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      (chunk.classId !== null &&
        !explicitClassIds(ctx).includes(chunk.classId)) ||
      !canReadRecord(ctx.access, chunk, []) ||
      !isValidAt(chunk.validFrom, chunk.validTo, effectiveAt) ||
      (upcoming &&
        (chunk.visibility !== 'academy_public' || effectiveAt > upcomingUntil))
    )
      return [];
    const key = header.findIndex((label) =>
      /^(구분|항목|일정)$/.test(compactText(label)),
    );
    const date = header.findIndex((label) =>
      /^(기간|기한|납부기간|납부기한|일정)$/.test(compactText(label)),
    );
    const label = cells[key];
    const value = cells[date];
    if (
      key === date ||
      !label ||
      !value ||
      ![...label.matchAll(cohortPattern)].some(
        ([match]) => compactText(match) === cohort,
      ) ||
      !/납부|수납/.test(label) ||
      (/수강료|교습비/.test(normalized) && !/수강료|교습비/.test(label)) ||
      !/\d+\s*월\s*\d+\s*일/.test(value) ||
      (/언제\s*부터/.test(normalized) && !/[~～]|부터/.test(value)) ||
      (/언제\s*까지|기한|마감/.test(normalized) && !/[~～]|까지/.test(value))
    )
      return [];
    const tableColumns = [key, date].sort((a, b) => a - b);
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, line, tableColumns };
    return supportsExcerpt(excerpt)
      ? [{ ...excerpt, label, value, effectiveAt }]
      : [];
  });
  if (!options.length) return undefined;
  if (new Set(options.map(({ value }) => compactText(value))).size > 1)
    return abstain(
      '승인 자료의 납부 일정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const selected = options[0];
  const { chunk, tableColumns, effectiveAt } = selected;
  ctx.trace.intent = 'payment_window_evidence';
  return {
    status: 'answered',
    text: selected.label + ': ' + selected.value,
    citations: [{ kind: 'chunk', chunk, tableColumns, effectiveAt }],
    excerpts: [selected],
    usedFacts: [],
  };
}
/** Combine separately verified tuition and posted snack rates without claiming a bill total. */
async function answerTuitionAndSnacks(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const classIds = explicitClassIds(ctx);
  if (
    classIds.length !== 1 ||
    !/수강료|교습비/.test(frame.normalized) ||
    !/간식비/.test(frame.normalized) ||
    /합계|합쳐|할인|포함|환불|내년|작년/.test(frame.normalized) ||
    frame.explicitDates.length ||
    frame.months.length ||
    (frame.relativePeriod && frame.relativePeriod !== 'this_month')
  )
    return undefined;
  const classId = classIds[0];
  const [facts, hits] = await Promise.all([
    ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      factTypes: ['monthly_fee'],
    }),
    ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      query: ctx.question + ' 간식비',
      limit: 30,
      documentTypes: ['fee'],
    }),
  ]);
  recordFacts(ctx.trace, facts);
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const fees = facts.filter(
    (fact) =>
      fact.academyId === ctx.access.academyId &&
      fact.subjectType === 'class' &&
      fact.subjectId === classId &&
      fact.factType === 'monthly_fee' &&
      fact.approvalStatus === 'approved' &&
      fact.value.kind === 'money' &&
      isValidAt(fact.validFrom, fact.validTo, ctx.asOf),
  );
  const firstFee = fees[0];
  if (!firstFee || firstFee.value.kind !== 'money') return undefined;
  const fee = firstFee.value.amount;
  if (fees.some(({ value }) => value.kind === 'money' && value.amount !== fee))
    return abstain(
      '승인 자료의 수강료가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const snacks = hits.flatMap(({ chunk }) => {
    const { kind, header, cells } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      (chunk.classId !== null && chunk.classId !== classId) ||
      !canReadRecord(ctx.access, chunk, []) ||
      !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
    )
      return [];
    const key = header.findIndex((label) =>
      /^(항목|구분)$/.test(compactText(label)),
    );
    if (!/^(?:간식비)(?:\(월\))?$/.test(compactText(cells[key] ?? '')))
      return [];
    const direct = header.findIndex((label) =>
      /^(금액|요금)(?:\(월\))?$/.test(compactText(label)),
    );
    const revision = header.findIndex((label) => compactText(label) === '개정');
    const prior = header.some((label) => compactText(label) === '현행');
    const price =
      direct >= 0
        ? direct
        : prior &&
            chunk.sourceId === firstFee.sourceId &&
            chunk.validFrom === firstFee.validFrom
          ? revision
          : -1;
    const value = cells[price]?.trim();
    const amount = value && AMOUNT.exec(value);
    if (!value || !amount) return [];
    const note = header.findIndex((label) =>
      /^(안내|비고|조건|대상·비고)$/.test(compactText(label)),
    );
    const tableColumns = [key, price, ...(cells[note] ? [note] : [])].sort(
      (a, b) => a - b,
    );
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, line, tableColumns };
    return supportsExcerpt(excerpt)
      ? [
          {
            ...excerpt,
            value,
            label: cells[key],
            note: cells[note],
            amount: Number(amount[1].replace(/,/g, '')),
          },
        ]
      : [];
  });
  if (!snacks.length) return undefined;
  if (new Set(snacks.map(({ amount }) => amount)).size > 1)
    return abstain(
      '승인 자료의 간식비가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const snack = snacks[0];
  ctx.trace.intent = 'tuition_and_snacks';
  return {
    status: 'answered',
    text:
      '요청하신 반의 월 수강료: ' +
      formatKrw(fee) +
      '\n' +
      '안내표 ' +
      snack.label +
      ': ' +
      snack.value +
      (snack.note ? ' · ' + snack.note : ''),
    citations: [
      { kind: 'fact', fact: firstFee, effectiveAt: ctx.asOf },
      { kind: 'chunk', chunk: snack.chunk, tableColumns: snack.tableColumns },
    ],
    excerpts: [snack],
    usedFacts: [firstFee],
  };
}
/** A published calculation is an example for an exact combination, not an invoice. */
async function answerCombinedTuitionExample(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const {
    normalized,
    matchedStudentIds,
    explicitDates,
    months,
    relativePeriod,
  } = ctx.frame;
  if (
    !/수강료|교습비/.test(normalized) ||
    !/합치|합계|합산|총액/.test(normalized) ||
    /교재비|간식비|재료비|차량비|형제|자매|환불|내년|작년/.test(normalized) ||
    matchedStudentIds.length !== 1 ||
    ctx.studentClassIds.length !== 2 ||
    explicitDates.length ||
    months.length ||
    (relativePeriod && relativePeriod !== 'this_month')
  )
    return undefined;
  if (
    (ctx.frame.classIds.length > 0 &&
      ctx.studentClassIds.some((id) => !ctx.frame.classIds.includes(id))) ||
    ctx.catalog.classes.some(
      ({ classId, name }) =>
        !ctx.studentClassIds.includes(classId) &&
        ctx.frame.compact.includes(compactText(name)),
    )
  )
    return undefined;
  const classes = ctx.studentClassIds.map((id) =>
    ctx.catalog.classes.find(({ classId }) => classId === id),
  );
  if (classes.some((entry) => !entry)) return undefined;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      ctx.question,
      ...classes.map((entry) => entry?.name),
      '할인 계산 예시 월 수강료',
    ].join(' '),
    limit: 30,
    documentTypes: ['fee', 'policy'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const examples = hits.flatMap(({ chunk }) => {
    const { kind, header, cells, section } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      !section ||
      !/할인.*(?:계산|예시)/.test(section) ||
      chunk.classId !== null ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      !canReadRecord(ctx.access, chunk, []) ||
      !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
    )
      return [];
    const key = header.findIndex((label) =>
      /^(예시|조합|대상)$/.test(compactText(label)),
    );
    const calculation = header.findIndex((label) =>
      /^(계산|산식)$/.test(compactText(label)),
    );
    const total = header.findIndex((label) =>
      /^할인후월수강료$/.test(compactText(label)),
    );
    if (!cells[key] || !cells[calculation] || !cells[total]) return [];
    const names = cells[key].split('+').map(compactText);
    if (
      names.length !== 2 ||
      new Set(names).size !== 2 ||
      !classes.every(
        (entry) =>
          entry &&
          [entry.name, ...entry.aliases].some((name) =>
            names.includes(compactText(name)),
          ),
      )
    )
      return [];
    const amount = AMOUNT.exec(cells[total].trim());
    if (!amount) return [];
    const formula =
      /^\s*(\d[\d,]*)\s*원\s*\+\s*\(\s*(\d[\d,]*)\s*원\s*[-−]\s*(\d[\d,]*)\s*원\s*\)\s*$/.exec(
        cells[calculation],
      );
    if (!formula) return [];
    const [first, second, discount, due] = [...formula.slice(1), amount[1]].map(
      (value) => Number(value.replace(/,/g, '')),
    );
    if (discount <= 0 || discount > second || first + second - discount !== due)
      return [];
    const tableColumns = [key, calculation, total].sort((a, b) => a - b);
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, line, tableColumns };
    return supportsExcerpt(excerpt)
      ? [
          {
            ...excerpt,
            label: cells[key],
            formula: cells[calculation],
            total: cells[total],
            due,
            discount,
          },
        ]
      : [];
  });
  if (!examples.length) return undefined;
  if (
    new Set(examples.map(({ due, discount }) => due + ':' + discount)).size > 1
  )
    return abstain(
      '승인 자료의 할인 계산 예시가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [example] = examples;
  ctx.trace.intent = 'combined_tuition_example';
  return {
    status: 'answered',
    text:
      '승인 안내의 할인 계산 예시 (' +
      example.label +
      '): ' +
      example.formula +
      ' = ' +
      example.total,
    citations: [
      {
        kind: 'chunk',
        chunk: example.chunk,
        tableColumns: example.tableColumns,
      },
    ],
    excerpts: [example],
    usedFacts: [],
  };
}
/** Returns undefined for requests whose semantics still use the legacy adapter. */
export async function answerNumberedFeeFollowUp(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const previous = ctx.state?.previousFrame;
  const target = /^(?:그럼|그러면)\s*([1-9]\d*)\s*반/.exec(frame.normalized);
  if (
    !target ||
    previous?.domain !== 'info' ||
    previous.classIds?.length !== 1 ||
    previous.topicIds?.length !== 1 ||
    previous.topicIds[0] !== 'fee' ||
    !/더\s*싸|비싸|수강료|얼마|가격|차이/.test(frame.normalized) ||
    frame.classIds.length ||
    frame.matchedStudentIds.length ||
    frame.unresolvedRelationWords.length ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.relativeDay !== null ||
    /교재비|할인|내년|작년|합계|환불/.test(frame.normalized)
  )
    return;
  const previousClass = ctx.catalog.classes.find(
    ({ classId }) => classId === previous.classIds?.[0],
  );
  const label = /^(.+?)(\d+)\s*반$/.exec(previousClass?.name ?? '');
  if (
    !previousClass ||
    !label ||
    !previousClass.grade ||
    label[2] === target[1]
  )
    return;
  const alternatives = ctx.catalog.classes.filter(
    ({ name, grade }) =>
      grade === previousClass.grade &&
      compactText(name) === compactText(label[1] + target[1] + '반'),
  );
  if (alternatives.length !== 1) return;
  const requested = alternatives[0];
  const classIds = [requested.classId, previousClass.classId];
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: requested.name + ' ' + previousClass.name + ' 월 수강료',
    documentTypes: ['fee'],
    limit: 45,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const options = hits.flatMap(({ chunk }) =>
    isAssistantDirective(chunk.text)
      ? []
      : selectCosts(ctx, chunk, classIds, ['fee'], ctx.asOf).filter(
          supportsExcerpt,
        ),
  );
  const amounts = classIds.map((classId) =>
    options.filter(
      (option) =>
        option.classId === classId &&
        billingPeriods(option.label + ' ' + option.value).includes('1개월'),
    ),
  );
  if (
    amounts.some(
      (values) =>
        !values.length ||
        new Set(values.map(({ amount }) => amount)).size !== 1,
    )
  )
    return abstain(
      '같은 청구 기준의 두 반 수강료를 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const [current, prior] = amounts.map(([choice]) => choice);
  const comparison =
    current.amount < prior.amount
      ? '이전 반보다 낮습니다.'
      : current.amount > prior.amount
        ? '이전 반보다 높습니다.'
        : '이전 반과 같습니다.';
  ctx.frame = { ...frame, classIds };
  ctx.trace.intent = 'numbered_fee_followup';
  return {
    status: 'answered',
    text: [
      requested.name + ' ' + current.label + ' ' + current.value,
      previousClass.name + ' ' + prior.label + ' ' + prior.value,
      '월 수강료를 비교하면 ' + comparison,
    ].join('\n'),
    citations: [current, prior].map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    excerpts: [current, prior],
    usedFacts: [],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        classIds: [requested.classId],
        topicIds: ['fee'],
        units: [],
        periods: [],
      },
    },
  };
}

/** Equipment purchases and a future cohort's textbook price have separate cost slots. */
async function answerScopedMaterialCost(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    !/얼마|몇\s*원|금액|비용|가격/.test(frame.normalized) ||
    /환불|할인|비교|합계|수강료|말고|제외/.test(frame.normalized)
  )
    return;
  const kit =
    /키트/.test(frame.normalized) &&
    /별도|따로|구매|구입|사야|키트\s*(?:비용|비|가격)/.test(frame.normalized);
  const promotion =
    /교재비/.test(frame.normalized) &&
    /올라가|진급|승급/.test(frame.normalized) &&
    frame.months.length === 1 &&
    !frame.explicitDates.length &&
    !frame.relativePeriod;
  if (!kit && !promotion) return;
  const missing = kit
    ? '해당 과정의 키트 구매 비용'
    : '진급 시점에 적용되는 교재비';
  const unavailable = () =>
    abstain(
      missing + '을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const classIds = explicitClassIds(ctx);
  if (
    classIds.length !== 1 ||
    frame.flags.compare ||
    frame.negatedClassIds.length ||
    (kit &&
      (frame.explicitDates.length > 1 ||
        frame.relativeWeek ||
        frame.relativeDay !== null))
  )
    return unavailable();
  if (promotion && frame.months[0] === toKstDate(ctx.asOf).month)
    return unavailable();
  const { at } = resolveEffectiveTime(
    promotion ? { ...frame, futureCue: true } : frame,
    ctx.asOf,
  );
  const effectiveFacts = promotion
    ? await ctx.facts.queryApprovedFacts({
        access: ctx.access,
        studentIds: [],
        asOf: ctx.asOf,
        effectiveAt: at,
        factTypes: ['material_fee'],
      })
    : [];
  recordFacts(ctx.trace, effectiveFacts);
  const scopedFacts = effectiveFacts.filter(
    (fact) =>
      fact.subjectType === 'class' &&
      fact.subjectId === classIds[0] &&
      fact.value.kind === 'money',
  );
  if (promotion && !scopedFacts.length) return unavailable();
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: at > ctx.asOf ? at : undefined,
    query:
      ctx.question +
      ' ' +
      className(ctx.catalog, classIds[0]) +
      ' ' +
      (kit ? '키트 구매비' : '교재비'),
    documentTypes: kit
      ? ['fee', 'curriculum', 'announcement', 'academy_info']
      : ['fee'],
    limit: 45,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const asksPurchase =
    kit && /따로|별도|사야|구매해야|구입해야/.test(frame.normalized);
  const options = hits.flatMap(({ chunk }) =>
    isAssistantDirective(chunk.text)
      ? []
      : selectCosts(
          ctx,
          chunk,
          classIds,
          [kit ? 'kit' : 'textbook'],
          at,
        ).filter(
          (option) =>
            supportsExcerpt(option) &&
            (!promotion ||
              scopedFacts.some(
                (fact) =>
                  fact.sourceId === chunk.sourceId &&
                  fact.value.kind === 'money' &&
                  fact.value.amount === option.amount,
              )),
        ),
  );
  if (!options.length) return unavailable();
  if (
    new Set(
      options.map(
        ({ amount, label, value }) =>
          amount + '|' + billingPeriods(label + ' ' + value).join(','),
      ),
    ).size !== 1
  )
    return abstain(
      '해당 과정과 시점의 승인 비용이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = options;
  ctx.trace.intent = 'scoped_material_cost';
  return {
    status: asksPurchase ? 'partial' : 'answered',
    reasonCode: asksPurchase ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: asksPurchase ? ['별도 구매 필요 여부'] : undefined,
    text: [
      className(ctx.catalog, classIds[0]) +
        ' ' +
        selected.label +
        ' ' +
        selected.value,
      ...(asksPurchase ? ['별도 구매 필요 여부는 확인되지 않습니다.'] : []),
    ].join('\n'),
    citations: [
      {
        kind: 'chunk',
        chunk: selected.chunk,
        tableColumns: selected.tableColumns,
        effectiveAt: at,
      },
    ],
    excerpts: [selected],
    usedFacts: [],
  };
}

/** Match an unconditional policy statement to the requested class and rate. */
function publishedDiscountDecision(
  chunk: RagChunk,
  classId: string,
  rate: number,
  at: number,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
) {
  if (
    chunk.location.kind !== 'paragraph' ||
    (chunk.classId && chunk.classId !== classId) ||
    !isCleanPublicEvidence(chunk, at) ||
    /게시판|게시글|질문답변|문의모음|댓글|커뮤니티/.test(
      compactText(chunk.title + ' ' + (chunk.location.section ?? '')),
    )
  )
    return [];
  return splitSentences(chunk.text).flatMap((line) => {
    const text = compactText(line).replace(/^[-•]/, '');
    const named = [...owners.keys()]
      .filter((name) => text.startsWith(name))
      .sort((a, b) => b.length - a.length)[0];
    if (
      named &&
      (owners.get(named)?.size !== 1 || !owners.get(named)?.has(classId))
    )
      return [];
    const scope =
      named ?? /^(?:전과정|모든(?:반|과정)|학원전체)/.exec(text)?.[0];
    if (!scope && chunk.classId !== classId) return [];
    const clause = scope
      ? text.slice(scope.length).replace(/^(?:에서는|에서|에|은|는|의)/, '')
      : text;
    const rule =
      /^(?:정규)?(월)?(?:수강료|교습비|학원비)(?:의|에서|에|는|은|를)?(\d{1,3}(?:\.\d{1,2})?)%할인(?:은|을|이)?((?:별도)?조건없이)?(적용하지않습니다|시행하지않습니다|하지않습니다|미적용입니다|적용합니다|시행합니다|적용됩니다)[.!。]?$/.exec(
        clause,
      );
    if (!rule || Number(rule[2]) !== rate) return [];
    const applies = /^(?:적용합니다|시행합니다|적용됩니다)$/.test(rule[4]);
    const definitive = applies ? Boolean(rule[3]) : !rule[3];
    return [
      {
        chunk,
        line,
        monthly: Boolean(rule[1]),
        applies: definitive ? applies : null,
      },
    ];
  });
}

/** Verify a reported discount separately from the published base charge. */
async function answerPublishedTuitionOnDiscountClaim(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const text = frame.normalized;
  const claims = [
    ...text.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,2})?)\s*%\s*할인/g),
  ];
  const rates = new Set(claims.map((claim) => Number(claim[1])));
  const [rate] = rates;
  if (
    rates.size !== 1 ||
    rate <= 0 ||
    rate > 100 ||
    !/게시판|게시글|글.{0,6}(?:봤|봐서|있)|안내한다고/.test(text) ||
    !/얼마|금액|가격|할인가/.test(text) ||
    /중복|합산|형제|환불|작년|내년|특강|차량비|교재비/.test(text) ||
    frame.explicitDates.length > 1 ||
    frame.months.length > 1 ||
    frame.relativePeriod ||
    frame.relativeWeek ||
    frame.relativeDay !== null
  )
    return;
  const ids = explicitClassIds(ctx);
  if (ids.length !== 1) return;
  const [classId] = ids;
  const month = frame.months[0];
  const requestedYear = /(?<!\d)(20\d{2})\s*년\s*(?=\d{1,2}\s*월)/.exec(
    text,
  )?.[1];
  const currentMonth = toKstDate(ctx.asOf).month;
  if (
    month &&
    month < currentMonth &&
    !frame.explicitDates.length &&
    !requestedYear
  )
    return;
  const at =
    requestedYear && month && !frame.explicitDates.length
      ? kstStartOfDay({ year: Number(requestedYear), month, day: 1 })
      : resolveEffectiveTime(
          month && month > currentMonth ? { ...frame, futureCue: true } : frame,
          ctx.asOf,
        ).at;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: at > ctx.asOf ? at : undefined,
    documentTypes: ['fee', 'policy', 'announcement'],
    query: [
      ctx.question,
      className(ctx.catalog, classId),
      '정규 수강료 공식 할인 기간',
    ].join(' '),
    limit: 55,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const options = found.flatMap(({ chunk }) =>
    chunk.documentType === 'fee' && isCleanPublicEvidence(chunk, at)
      ? selectCosts(ctx, chunk, ids, ['fee'], at).filter(supportsExcerpt)
      : [],
  );
  if (!options.length) return;
  const comparable = options.filter(
    ({ label, value }) => billingPeriods(label + ' ' + value).length,
  );
  const prices = comparable.length ? comparable : options;
  if (
    new Set(
      prices.map(
        ({ amount, label, value }) =>
          amount + '|' + billingPeriods(label + ' ' + value).join(','),
      ),
    ).size !== 1
  )
    return abstain(
      '동일 반의 승인 수강료가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = prices;
  const owners = new Map<string, Set<string>>();
  for (const klass of ctx.catalog.classes) {
    for (const name of [klass.name, ...klass.aliases]
      .map(compactText)
      .filter(Boolean)) {
      const ids = owners.get(name) ?? new Set();
      ids.add(klass.classId);
      owners.set(name, ids);
    }
  }
  const billing = billingPeriods(selected.label + ' ' + selected.value);
  const rules = found
    .flatMap(({ chunk }) =>
      publishedDiscountDecision(chunk, classId, rate, at, owners),
    )
    .filter(({ monthly }) => !monthly || billing.includes('1개월'));
  const conflict = new Set(rules.map(({ applies }) => applies)).size > 1;
  const rule = conflict
    ? undefined
    : rules.find(({ applies }) => applies !== null);
  const numerator = selected.amount * (10_000 - Math.round(rate * 100));
  const discounted = Number.isSafeInteger(numerator) ? numerator / 10_000 : NaN;
  const canCalculate =
    rule?.applies && billing.length > 0 && Number.isSafeInteger(discounted);
  const complete = Boolean(rule && (!rule.applies || canCalculate));
  ctx.trace.intent = rule
    ? 'published_tuition_verified_discount'
    : 'published_tuition_unverified_discount';
  return {
    status: complete ? 'answered' : 'partial',
    reasonCode: complete ? undefined : 'PARTIAL_EVIDENCE',
    missingFields: complete
      ? undefined
      : [rule ? '할인 후 수강료' : '게시글 할인율 적용 여부'],
    text: [
      formatKstDate(at) +
        ' 적용 ' +
        className(ctx.catalog, classId) +
        ' ' +
        selected.label +
        ' ' +
        selected.value,
      rule?.line ??
        (conflict
          ? '해당 할인율의 승인 자료가 서로 달라 적용 여부를 확인할 수 없습니다.'
          : '게시글에서 언급한 할인율의 승인 근거는 확인되지 않습니다.'),
      ...(canCalculate
        ? ['할인 후 ' + selected.label + ' ' + formatKrw(discounted)]
        : []),
    ].join('\n'),
    citations: [
      {
        kind: 'chunk',
        chunk: selected.chunk,
        tableColumns: selected.tableColumns,
        effectiveAt: at,
      },
      ...(rule
        ? [{ kind: 'chunk' as const, chunk: rule.chunk, effectiveAt: at }]
        : []),
    ],
    excerpts: rule ? [selected, rule] : [selected],
    usedFacts: [],
    instants: [at],
    derivedNumbers: canCalculate ? [discounted] : undefined,
  };
}

/** Quote the approved charge for the service month and verify any prepayment rule separately. */
export async function answerPrepaidTuition(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const target = prepaidTuitionMonth(frame.normalized);
  if (!target || frame.unknownPrograms.length || frame.unboundProgram) return;
  const { month } = target;
  const now = toKstDate(ctx.asOf);
  const year = target.year ?? now.year + Number(month < now.month);
  const at =
    month === now.month && year === now.year
      ? ctx.asOf
      : kstStartOfDay({ year, month, day: 1 });
  const ids = resolveQualifiedClasses(ctx);
  const matching =
    frame.matchedStudentIds.length && ctx.studentClassIds.length
      ? ids.filter((id) => ctx.studentClassIds.includes(id))
      : ids;
  const missing = () =>
    abstain(
      '해당 반의 수강월 기준 승인 수강료를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['수강월 적용 수강료'],
    );
  if (matching.length !== 1 || at < ctx.asOf) return missing();
  const [classId] = matching;
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    effectiveAt: at,
    factTypes: ['monthly_fee'],
  });
  recordFacts(ctx.trace, facts);
  const prices = facts.flatMap((fact) =>
    fact.subjectType === 'class' &&
    fact.subjectId === classId &&
    fact.value.kind === 'money' &&
    fact.value.currency === 'KRW' &&
    isValidAt(fact.validFrom, fact.validTo, at)
      ? [{ fact, amount: fact.value.amount }]
      : [],
  );
  if (!prices.length) return missing();
  if (new Set(prices.map(({ amount }) => amount)).size > 1)
    return abstain(
      '같은 반의 수강월별 승인 수강료가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );

  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: at > ctx.asOf ? at : undefined,
    documentTypes: ['fee'],
    query: [
      className(ctx.catalog, classId),
      month + '월 수강분',
      '납부일 관계없이 미리 선납 개정 금액 적용',
    ].join(' '),
    limit: 55,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const sources = new Set(prices.map(({ fact }) => fact.sourceId));
  const policy = hits.flatMap(({ chunk }) => {
    if (
      !sources.has(chunk.sourceId) ||
      (chunk.classId && chunk.classId !== classId) ||
      chunk.location.kind !== 'paragraph' ||
      !isCleanPublicEvidence(chunk, at)
    )
      return [];
    return splitSentences(chunk.text).flatMap((line) => {
      const text = compactText(line);
      if (
        !/(?:납부|결제)(?:한)?(?:날짜|일자|시점|일)(?:과|와|에)?(?:관계없이|무관하게)/.test(
          text,
        ) ||
        !/수강분|수강월|수강하는달/.test(text) ||
        !/금액|수강료|교습비/.test(text) ||
        !/적용(?:됩니다|합니다|해요)/.test(text) ||
        /제외|다만|예외|경우에만/.test(text)
      )
        return [];
      const periods = [
        ...text.matchAll(/(?<!\d)(?:(20\d{2})년)?(1[0-2]|[1-9])월수강분부터/g),
      ];
      if (
        periods.length &&
        !periods.every(([, startYear, startMonth]) =>
          startYear
            ? Number(startYear) * 12 + Number(startMonth) <= year * 12 + month
            : Number(startMonth) === month,
        )
      )
        return [];
      const excerpt = { chunk, line };
      return supportsExcerpt(excerpt) ? [excerpt] : [];
    });
  });
  if (new Set(policy.map(({ line }) => compactText(line))).size > 1)
    return abstain(
      '수강료의 납부일 적용 규정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const rule = policy[0];
  const { fact, amount } =
    prices.find((price) => price.fact.sourceId === rule?.chunk.sourceId) ??
    prices[0];
  ctx.trace.intent = 'tuition_service_month';
  return {
    status: rule ? 'answered' : 'partial',
    reasonCode: rule ? undefined : 'PARTIAL_EVIDENCE',
    missingFields: rule ? undefined : ['선납 시 적용 기준'],
    text: [
      year +
        '년 ' +
        month +
        '월 수강분 ' +
        className(ctx.catalog, classId) +
        ' 월 수강료 ' +
        formatKrw(amount),
      rule?.line ??
        '선납할 때 적용하는 기준은 승인 자료에서 확인되지 않습니다.',
    ].join('\n'),
    citations: [
      { kind: 'fact', fact, effectiveAt: at },
      ...(rule
        ? [{ kind: 'chunk' as const, chunk: rule.chunk, effectiveAt: at }]
        : []),
    ],
    excerpts: rule ? [rule] : [],
    usedFacts: [fact],
    instants: [at],
  };
}

export async function answerFromCostEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const scopedMaterial = await answerScopedMaterialCost(ctx);
  if (scopedMaterial) return scopedMaterial;
  const sessionPrice = await answerSessionPrice(ctx);
  if (sessionPrice) return sessionPrice;
  const passPrice = await answerPassPrice(ctx);
  if (passPrice) return passPrice;
  const ancillaryPrice = await answerAncillaryPrice(ctx);
  if (ancillaryPrice) return ancillaryPrice;
  const paymentWindow = await answerPaymentWindow(ctx);
  if (paymentWindow) return paymentWindow;
  const paymentTerms = await answerPaymentTerms(ctx);
  if (paymentTerms) return paymentTerms;
  const tuitionAndSnacks = await answerTuitionAndSnacks(ctx);
  if (tuitionAndSnacks) return tuitionAndSnacks;
  const combinedTuition = await answerCombinedTuitionExample(ctx);
  if (combinedTuition) return combinedTuition;
  const tuitionPolicy = await answerTuitionPolicy(ctx);
  if (tuitionPolicy) return tuitionPolicy;
  const publishedTuition = await answerPublishedTuitionOnDiscountClaim(ctx);
  if (publishedTuition) return publishedTuition;
  const { frame } = ctx;
  const asksEquality =
    frame.flags.compare &&
    /같아요|같나요|같은가|같은지|다른가|다른지|똑같/.test(frame.normalized);
  const gradePair =
    /(?<![가-힣])([초중고][1-6])\s*(?:이랑|랑|하고|와|과|및|[·,])\s*([초중고][1-6])(?!\d|[가-힣])/.exec(
      frame.normalized,
    );
  const exactGrades =
    gradePair &&
    asksEquality &&
    frame.classIds.length === 0 &&
    frame.matchedStudentIds.length === 0 &&
    ctx.studentClassIds.length === 0 &&
    /수강료|교습비|교재비|재료비/.test(frame.normalized) &&
    !frame.unknownPrograms.length &&
    !frame.unboundProgram
      ? gradePair
          .slice(1)
          .map((grade) =>
            ctx.catalog.classes.filter((klass) => klass.grade === grade),
          )
      : [];
  const ids =
    asksEquality && frame.matchedStudentIds.length === 1
      ? [...new Set([...explicitClassIds(ctx), ...ctx.studentClassIds])]
      : exactGrades.length === 2 &&
          exactGrades.every((matches) => matches.length === 1)
        ? [...new Set(exactGrades.map(([klass]) => klass.classId))]
        : resolveQualifiedClasses(ctx);
  const exact = ctx.catalog.classes.filter(
    ({ classId, name }) =>
      ids.includes(classId) && frame.compact.includes(compactText(name)),
  );
  const classIds =
    exact.length === 1 && !/와|과|랑|및|그리고|각각|비교/.test(frame.normalized)
      ? [exact[0].classId]
      : ids;
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
  const { at } = resolveEffectiveTime(frame, ctx.asOf);
  const datedFee =
    ctx.engine === 'planned' &&
    at > ctx.asOf &&
    classIds.length === 1 &&
    fields.length === 1 &&
    fields[0] === 'fee' &&
    frame.months.length <= 1 &&
    frame.explicitDates.length <= 1 &&
    !frame.flags.compare;
  if (distinctMaterials && /포함|들어\s*있/.test(frame.normalized))
    return abstain(
      '교재비와 재료비의 포함 관계를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (
    !classIds.length ||
    !fields.length ||
    !frame.topics.every(({ id }) => id === 'fee' || id === 'material') ||
    (frame.flags.compare && !(asksEquality && classIds.length === 2)) ||
    frame.flags.previousRevision ||
    (!datedFee &&
      ((frame.relativePeriod !== null &&
        !(frame.relativePeriod === 'this_month' && distinctMaterials)) ||
        frame.months.length > 0 ||
        frame.explicitDates.length > 0)) ||
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

  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    ...(datedFee ? { effectiveAt: at } : {}),
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
  if (!candidates.length && !datedFee)
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
      // Keep the structured answer path for a verified fact at the requested date.
      if (datedFee && scopedFacts.length) return undefined;
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
  if (!selected.length) {
    return datedFee
      ? abstain(
          '문의한 시점의 수강료를 확인할 수 있는 승인 자료가 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        )
      : undefined;
  }
  const comparisons: string[] = [];
  if (asksEquality) {
    for (const field of fields) {
      const values = selected.filter((entry) => entry.field === field);
      if (values.length !== 2) continue;
      const periods = values.map(
        ({ label, value }) => billingPeriods(label + ' ' + value)[0],
      );
      if (!periods[0] || periods[0] !== periods[1]) {
        missing.push(values[0].label + ' 청구 기준 비교');
        continue;
      }
      const same = values[0].amount === values[1].amount;
      comparisons.push(
        fields.length === 1
          ? same
            ? '두 항목의 금액은 같습니다.'
            : '두 항목의 금액은 서로 다릅니다.'
          : values[0].label +
              (same ? ' 금액은 같습니다.' : ' 금액은 서로 다릅니다.'),
      );
    }
  }
  ctx.frame = { ...frame, classIds };
  ctx.trace.intent = 'cost_evidence';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      ...(datedFee ? [formatKstDate(at) + ' 기준'] : []),
      ...selected.map(
        ({ classId, label, value }) =>
          className(ctx.catalog, classId) + ' ' + label + ': ' + value,
      ),
      ...comparisons,
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
      ...(datedFee ? { effectiveAt: at } : {}),
    })),
    usedFacts,
    ...(datedFee ? { instants: [at] } : {}),
  };
}
