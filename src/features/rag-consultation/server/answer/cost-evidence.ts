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

import { requiredCostSlots, type CostSlot } from '../query/plan.ts';
const COST_KEYS = {
  fee: /^(?:(?:월|매월|1개월|\d+주)\s*)?(?:수강료|교습비|학원비)(?:\s*\((?:월|\d+주|\d+개월)\))?$/,
  material: /^(?:(?:실험|실습)\s*)?(?:교재비|재료비)(?:\s*\((?:월|학기)\))?$/,
  textbook: /^교재비(?:\s*\((?:월|학기)\))?$/,
  supplies: /^(?:(?:실험|실습)\s*)?재료비(?:\s*\((?:월|학기)\))?$/,
};
const AMOUNT =
  /^(?:(?:월|매월|학기당|\d+\s*(?:주|개월)(?:당|\s*기준)?)\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원(?:\s*\((?:월|\d+\s*(?:주|개월))(?:당|\s*기준)?\))?$/;

/** Compare billing units independently of how the original amount is printed. */
function billingPeriods(text: string): string[] {
  return [...text.matchAll(/(\d+)\s*(개월|주)|매월|월|학기(?:당)?/g)].map(
    (match) => (match[1] ? `${Number(match[1])}${match[2]}` : '1개월'),
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
    if (!match) return [];
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
  };
}
/** Payment instruments, installment availability, and deadlines are independent claims. */
async function answerPaymentTerms(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, explicitDates, months, relativePeriod } = ctx.frame;
  const installment =
    /할부/.test(normalized) && /수강료|교습비|카드|납부|결제/.test(normalized);
  const deadline =
    /납부|결제/.test(normalized) &&
    /언제\s*까지|기한|마감|며칠\s*까지/.test(normalized);
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
    const supported = hits.flatMap(({ chunk }) => {
      if (
        chunk.classId !== null ||
        chunk.location.kind !== 'paragraph' ||
        chunk.suspicious ||
        chunk.extraction?.needsReview ||
        !canReadRecord(ctx.access, chunk, [])
      )
        return [];
      const line = /납부\s*기한\s*[:：]?\s*매월\s*\d{1,2}\s*일까지/.exec(
        chunk.text,
      )?.[0];
      return line && supportsExcerpt({ chunk, line }) ? [{ chunk, line }] : [];
    });
    if (new Set(supported.map(({ line }) => /\d+/.exec(line)?.[0])).size > 1)
      return abstain(
        '승인 자료의 납부 기한이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    if (supported[0]) excerpts.push(supported[0]);
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
    citations: excerpts.map(({ chunk }) => ({ kind: 'chunk', chunk })),
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
export async function answerFromCostEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
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
  const { frame } = ctx;
  const asksEquality =
    frame.flags.compare &&
    /같나요|같은가|같은지|다른가|다른지|똑같/.test(frame.normalized);
  const ids =
    asksEquality && frame.matchedStudentIds.length === 1
      ? [...new Set([...explicitClassIds(ctx), ...ctx.studentClassIds])]
      : explicitClassIds(ctx);
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
  if (distinctMaterials && /포함|들어\s*있/.test(frame.normalized))
    return abstain(
      '교재비와 재료비의 포함 관계를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (
    !classIds.length ||
    !fields.length ||
    !frame.topics.every(({ id }) => id === 'fee' || id === 'material') ||
    (frame.flags.compare &&
      !(asksEquality && classIds.length === 2 && fields.length === 1)) ||
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
  const comparablePeriods = selected.map(
    ({ label, value }) => billingPeriods(label + ' ' + value)[0],
  );
  const comparison =
    asksEquality &&
    selected.length === 2 &&
    missing.length === 0 &&
    comparablePeriods[0] &&
    comparablePeriods[0] === comparablePeriods[1]
      ? selected[0].amount === selected[1].amount
        ? '두 항목의 금액은 같습니다.'
        : '두 항목의 금액은 서로 다릅니다.'
      : undefined;
  if (asksEquality && !comparison && missing.length === 0)
    missing.push('같은 청구 기준의 비용 비교');
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
      ...(comparison ? [comparison] : []),
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
