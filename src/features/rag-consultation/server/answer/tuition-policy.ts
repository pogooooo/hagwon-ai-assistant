import { gradeBand } from '../query/grade-band.ts';
import { asksSiblingTextbookDiscount } from '../query/plan.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { formatKstDate, kstStartOfDay, toKstDate } from '../text/time.ts';
import type { AcademyClass, ApprovedFact } from '../types.ts';
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
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

const amount = (value: string) => Number(value.replace(/,/g, ''));
const won = (value: number) => Number.isSafeInteger(value) && value >= 0;
const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);
const courseName = (label: string) =>
  compactText(label.replace(/\s*\([초중고].*?\)\s*$/, ''));
const isComprehensive = ({ name }: AcademyClass) =>
  /종합(?:\d+)?반/.test(compactText(name));

function namesCourse(query: string, klass: AcademyClass): boolean {
  const name = courseName(klass.name);
  const family = /[가-힣]{2,}반$/.exec(
    klass.name.replace(/\s*\([초중고].*?\)\s*$/, '').trim(),
  )?.[0];
  return (
    query.includes(name) ||
    Boolean(family && query.includes(family)) ||
    (isComprehensive(klass) && query.includes('종합반'))
  );
}

function gradeTargets(ctx: AnswerContext, classes: AcademyClass[]) {
  const band = /(?<!\d)([초중고])?([1-6](?:\s*[,·]\s*[1-6])+)\s*학년/.exec(
    ctx.frame.normalized,
  );
  if (!band) return classes;
  const levels = new Set(
    ctx.catalog.classes.flatMap(({ grade }) =>
      gradeBand(grade ?? '').map((value) =>
        value <= 6 ? '초' : value <= 9 ? '중' : '고',
      ),
    ),
  );
  const level = band[1] ?? (levels.size === 1 ? [...levels][0] : undefined);
  if (!level) return [];
  const targets = gradeBand(level + band[2]);
  return classes.filter(({ grade }) =>
    targets.every((value) => gradeBand(grade ?? '').includes(value)),
  );
}

interface BillGroup {
  label?: string;
  classes: AcademyClass[];
}

interface TuitionScope {
  kind: 'siblings' | 'mixed' | 'singles';
  groups: BillGroup[];
  studentIds: string[];
}

function tuitionScope(ctx: AnswerContext): TuitionScope | undefined {
  const { frame, access } = ctx;
  const siblings =
    /형제\s*할인|자매\s*할인|남매\s*할인/.test(frame.normalized) &&
    /누구|어느\s*(?:애|아이|자녀)|각각|얼마/.test(frame.normalized);
  const mixed =
    frame.compact.includes('종합반') &&
    /같이|함께|\+/.test(frame.normalized) &&
    !/종합반.{0,12}(?:안\s*다녀|제외|없이)/.test(frame.normalized);
  const singles =
    /종합반.{0,12}(?:안\s*다녀|제외|없이)|단과반\s*만/.test(frame.normalized) &&
    /둘\s*다|두\s*과목|이랑|하고|\+/.test(frame.normalized);
  if (!siblings && !mixed && !singles) return;
  const classes = ctx.catalog.classes;
  if (siblings) {
    const members = access.studentRefs.filter(
      ({ studentId }) =>
        access.allowedStudentIds.includes(studentId) &&
        frame.matchedStudentIds.includes(studentId),
    );
    if (members.length !== 2 || access.studentRefs.length !== 2) return;
    const groups = members.map((member) => ({
      label: member.displayLabel,
      classes: classes.filter(({ classId }) =>
        member.classIds?.includes(classId),
      ),
    }));
    if (
      groups.some(
        ({ classes }, index) =>
          classes.length !== members[index].classIds?.length ||
          classes.length < 1 ||
          classes.length > 2 ||
          classes.filter(isComprehensive).length > 1,
      )
    )
      return;
    return {
      kind: 'siblings' as const,
      groups,
      studentIds: members.map(({ studentId }) => studentId),
    };
  }
  const explicit = classes.filter(
    (klass) =>
      !frame.negatedClassIds.includes(klass.classId) &&
      frame.classIds.includes(klass.classId) &&
      namesCourse(frame.compact, klass),
  );
  if (mixed && frame.matchedStudentIds.length === 1) {
    const pair = classes.filter(({ classId }) =>
      ctx.studentClassIds.includes(classId),
    );
    if (
      pair.length === 2 &&
      pair.every((klass) => namesCourse(frame.compact, klass)) &&
      !explicit.some(
        (klass) =>
          !pair.includes(klass) &&
          frame.compact.includes(courseName(klass.name)),
      ) &&
      pair.filter(isComprehensive).length === 1
    )
      return {
        kind: 'mixed' as const,
        groups: [{ classes: pair }],
        studentIds: [],
      };
  }
  if (singles) {
    const pair = gradeTargets(
      ctx,
      explicit.filter((klass) => !isComprehensive(klass)),
    );
    if (
      pair.length === 2 &&
      new Set(pair.map((klass) => courseName(klass.name))).size === 2
    )
      return {
        kind: 'singles' as const,
        groups: [{ classes: pair }],
        studentIds: [],
      };
  }
}

type RuleType = 'bundle' | 'singles' | 'siblings' | 'nonStacking';
interface TuitionRule {
  value: number;
  excerpt: EvidenceExcerpt;
}

function parseRules(excerpt: EvidenceExcerpt, at: number) {
  const text = compactText(excerpt.line);
  const date = /(\d{4})년(\d{1,2})월부터/.exec(text);
  const { year, month } = toKstDate(at);
  if (
    date &&
    (Number(date[1]) * 12 + Number(date[2]) > year * 12 + month ||
      Number(date[2]) < 1 ||
      Number(date[2]) > 12)
  )
    return [];
  const rules: Array<[RuleType, TuitionRule]> = [];
  const add = (kind: RuleType, value: number) => {
    if (
      won(value) &&
      value > 0 &&
      ((kind !== 'singles' && kind !== 'siblings') || value <= 100)
    )
      rules.push([kind, { value, excerpt }]);
  };
  const perCourse = /(?:한|1)과목당(\d[\d,]*)원(?:을)?할인/.exec(text);
  if (perCourse && /종합반(?:과|및|\+)단과반/.test(text))
    add('bundle', amount(perCourse[1]));
  const pair = /단과반만2과목.{0,40}?합계(?:의)?(\d{1,2})%/.exec(text);
  if (pair) add('singles', Number(pair[1]));
  const siblings = /수강료합계가더적은원생.{0,24}?(\d{1,2})%/.exec(text);
  if (siblings && /형제|자매|남매/.test(text))
    add('siblings', Number(siblings[1]));
  if (
    /중복할인없음|중복(?:으로)?적용하지않/.test(text) &&
    /더큰(?:할인|쪽)|할인금액이더큰/.test(text)
  )
    add('nonStacking', 1);
  return rules;
}

const FAMILY =
  /형제|자매|남매|동생|누나|언니|오빠|형(?:이랑|하고)|첫째.{0,10}둘째/;
const JOINT_ENROLLMENT = /같이|함께|동시(?:에)?|둘\s*다/;
const SIBLING_DISCOUNT =
  /(?:형제(?:[·ㆍ/]자매)?|자매|남매|가족)(?:동시수강|동시등록)?할인/;

function textbookDiscountScope(line: string, siblingSection: boolean) {
  const text = compactText(line);
  const cost = text.indexOf('교재비');
  if (
    cost < 0 ||
    !(
      siblingSection ||
      SIBLING_DISCOUNT.test(text) ||
      /^(?:[-•>]\s*)?(?:모든)?할인은/.test(text)
    )
  )
    return;
  const clause = text
    .slice(cost)
    .replace(
      /^교재비(?:(?:[·ㆍ/,]|및|와|과)(?:재료비|간식비|차량이용료|차량비|교구비))*(?:에도|에는|는|은|도|에|를)?/,
      '',
    );
  if (
    /^(?:할인하지않|할인되지않|할인대상이아니|할인대상이아닙|(?:(?:할인|감면)(?:대상)?에서)?제외)/.test(
      clause,
    )
  )
    return 'excluded';
  if (
    /^(?:(?:같은|동일한)?할인(?:을)?적용(?:됩니다|합니다)|할인대상입니다)/.test(
      clause,
    )
  )
    return 'included';
}

export async function answerSiblingDiscountPolicy(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const textbook = asksSiblingTextbookDiscount(frame);
  if (
    !FAMILY.test(q) ||
    (!textbook &&
      (!JOINT_ENROLLMENT.test(q) ||
        /교재비/.test(q) ||
        frame.topics.some(({ id }) => id !== 'fee' && id !== 'discount'))) ||
    !/깎(?:아|이|여)|할인/.test(q) ||
    /특강|환불|쿠폰|얼마.{0,5}(?:내|납부)|각각|중복|형제\s*할인\s*(?:적용됐|받았)/.test(
      q,
    ) ||
    frame.classIds.length ||
    frame.explicitDates.length > 1 ||
    frame.months.length > 1
  )
    return;
  const { at } = resolveEffectiveTime(frame, ctx.asOf);
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: at > ctx.asOf ? at : undefined,
    documentTypes: ['fee', 'policy'],
    query:
      '형제 자매 남매 가족 동시 수강 수강료 할인 대상 제외' +
      (textbook ? ' 교재비' : ''),
    limit: 48,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const groups = new Map<string, EvidenceExcerpt[]>();
  for (const { chunk } of hits) {
    if (chunk.classId !== null || !isCleanPublicEvidence(chunk, at)) continue;
    const heading = compactText(chunk.location.section ?? chunk.title);
    const section = SIBLING_DISCOUNT.test(heading);
    const row = readEvidenceRow(chunk);
    const lines: EvidenceExcerpt[] = [];
    if (row) {
      const key = row.column(/^(?:항목|구분|할인종류|할인항목)$/);
      const value = row.column(/^(?:내용|조건|적용기준|할인율|할인내용)$/);
      const label = compactText(row.cells[key] ?? '');
      if (
        SIBLING_DISCOUNT.test(label) ||
        (section &&
          /^(?:대상|할인|할인율|조건|적용조건|제외|중복적용)$/.test(label))
      ) {
        const excerpt = row.project(key, value);
        if (excerpt) lines.push(excerpt);
      }
    } else if (chunk.location.kind === 'paragraph') {
      for (const line of splitSentences(chunk.text)) {
        if (
          !/^\s*(?:[-•>]\s*)?(?:예시?|예를\s*들면|가령)[) :]/.test(line) &&
          /할인|재원|수강|등록/.test(line) &&
          (SIBLING_DISCOUNT.test(compactText(line)) ||
            (section && /형제|자매|남매|할인/.test(line)) ||
            (textbook && textbookDiscountScope(line, section)))
        )
          lines.push({ chunk, line });
      }
    }
    if (!lines.length) continue;
    const key = chunk.sourceId + '|' + heading;
    groups.set(key, [...(groups.get(key) ?? []), ...lines]);
  }
  const choices = [...groups.values()].filter((excerpts) =>
    excerpts.some(({ line }) =>
      textbook
        ? /\d+(?:\.\d+)?\s*%/.test(line)
        : /(?:\d+(?:\.\d+)?\s*%|할인.{0,12}(?:없|적용하지\s*않))/.test(line),
    ),
  );
  if (!choices.length)
    return abstain(
      '가족 동시 수강 할인 조건을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['가족 동시 수강 할인'],
    );
  const signature = (excerpts: EvidenceExcerpt[]) =>
    [...new Set(excerpts.map(({ line }) => compactText(line)))]
      .sort()
      .join('|');
  if (new Set(choices.map(signature)).size !== 1)
    return abstain(
      '같은 시점의 승인 할인 조건이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'sibling_discount_policy';
  const selected = choices[0];
  if (!textbook) return fromPublicExcerpts(selected);
  const coverageOf = ({ chunk, line }: EvidenceExcerpt) => {
    const section = SIBLING_DISCOUNT.test(
      compactText(chunk.location.section ?? chunk.title),
    );
    const scope = textbookDiscountScope(line, section);
    if (scope) return [scope];
    const row = readEvidenceRow(chunk);
    const key = row?.column(/^(?:항목|구분|할인종류|할인항목)$/) ?? -1;
    return section && row?.cells[key]?.trim() === '제외' && /교재비/.test(line)
      ? ['excluded']
      : [];
  };
  const coverage = new Set(selected.flatMap(coverageOf));
  if (coverage.size > 1)
    return abstain(
      '교재비의 승인 할인 조건이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  return fromPublicExcerpts(
    selected.filter(
      (excerpt) =>
        /\d+(?:\.\d+)?\s*%/.test(excerpt.line) || coverageOf(excerpt).length,
    ),
    coverage.size ? [] : ['교재비 할인 적용 여부'],
  );
}

/** Compute discounts only from a single approved version that supplies both rates and conditions. */
export async function answerTuitionPolicy(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    !/할인/.test(frame.normalized) ||
    /수강권|환불|쿠폰|상품권|교재비|차량비|간식비|재료비|할부|작년|지난|특강/.test(
      frame.normalized,
    ) ||
    frame.explicitDates.length > 1 ||
    frame.months.length > 1 ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod === 'last_month'
  )
    return;
  const scope = tuitionScope(ctx);
  if (!scope) return;
  const { kind, groups, studentIds } = scope;
  const ids = [
    ...new Set(
      groups.flatMap((group) => group.classes.map(({ classId }) => classId)),
    ),
  ];
  const explicit = resolveEffectiveTime(frame, ctx.asOf);
  const now = toKstDate(ctx.asOf);
  const at =
    /내년/.test(frame.normalized) &&
    frame.months.length === 1 &&
    !frame.explicitDates.length
      ? kstStartOfDay({ year: now.year + 1, month: frame.months[0], day: 1 })
      : explicit.at;
  if (/내년/.test(frame.normalized) && at <= ctx.asOf) return;
  const [facts, found] = await Promise.all([
    ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      effectiveAt: at,
      factTypes: ['monthly_fee'],
    }),
    ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      upcomingUntil: at > ctx.asOf ? at : undefined,
      documentTypes: ['fee', 'policy'],
      query: '할인 규정 형제 다과목 종합반 단과반 수강료',
      limit: 70,
    }),
  ]);
  recordFacts(ctx.trace, facts);
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const allClasses = groups.flatMap(({ classes }) => classes);
  const ruleSources = new Map<string, Map<RuleType, TuitionRule[]>>();
  for (const { chunk } of found) {
    if (
      chunk.classId !== null ||
      !isCleanPublicEvidence(chunk, at) ||
      chunk.location.kind !== 'paragraph' ||
      !/할인\s*(?:규정|기준|정책)/.test(chunk.location.section ?? chunk.title)
    )
      continue;
    for (const line of splitSentences(chunk.text)) {
      for (const [kind, rule] of parseRules({ chunk, line }, at)) {
        const rules = ruleSources.get(chunk.sourceId) ?? new Map();
        rules.set(kind, [...(rules.get(kind) ?? []), rule]);
        ruleSources.set(chunk.sourceId, rules);
      }
    }
  }
  const choices = [...ruleSources].flatMap(([source, policy]) => {
    const rule = (kind: RuleType) => {
      const rules = policy.get(kind) ?? [];
      return new Set(rules.map(({ value }) => value)).size === 1
        ? rules[0]
        : undefined;
    };
    const fees = new Map<string, { fact: ApprovedFact; price: number }>();
    for (const id of ids) {
      const prices = facts.flatMap((fact) =>
        fact.subjectType === 'class' &&
        fact.subjectId === id &&
        fact.value.kind === 'money' &&
        fact.value.currency === 'KRW' &&
        won(fact.value.amount)
          ? [{ fact, price: fact.value.amount }]
          : [],
      );
      const same = prices.find(({ fact }) => fact.sourceId === source);
      if (!same || new Set(prices.map(({ price }) => price)).size !== 1)
        return [];
      fees.set(id, same);
    }
    const classification: EvidenceExcerpt[] = [];
    for (const klass of allClasses.filter((entry) => !isComprehensive(entry))) {
      if (/돌봄|자습/.test(klass.name)) return [];
      const monthly = fees.get(klass.classId);
      const verified = found.flatMap(({ chunk }) => {
        if (
          chunk.sourceId !== source ||
          chunk.classId !== null ||
          !/단과반/.test(chunk.location.section ?? '') ||
          !isCleanPublicEvidence(chunk, at)
        )
          return [];
        const row = readEvidenceRow(chunk);
        if (!row) return [];
        const key = row.column(/^(?:과정|강좌|반|과정명|강좌명)$/);
        const target = row.column(/^(?:대상|대상학년)$/);
        const label = row.cells[key] ?? '';
        const price = row.column(/^(?:월수강료|수강료\(월\)|개정)$/);
        const priceCell = /^(\d[\d,]*)\s*원(?:\s*\(동결\))?$/.exec(
          row.cells[price] ?? '',
        );
        if (!priceCell || amount(priceCell[1]) !== monthly?.price) return [];
        const band = gradeBand(klass.grade ?? '');
        const sameBand =
          target >= 0 &&
          band.length > 0 &&
          gradeBand(row.cells[target] ?? '').join(',') === band.join(',');
        if (
          compactText(label) !== compactText(klass.name) &&
          !(sameBand && courseName(label) === courseName(klass.name))
        )
          return [];
        const proof = row.project(key, ...(target >= 0 ? [target] : []), price);
        return proof ? [proof] : [];
      });
      if (verified.length !== 1) return [];
      classification.push(verified[0]);
    }
    const used = new Set<TuitionRule>();
    const subtotal = (group: BillGroup) =>
      sum(group.classes.map(({ classId }) => fees.get(classId)!.price));
    const bundle = rule('bundle');
    const rate = rule('singles');
    const sibling = rule('siblings');
    const nonStacking = rule('nonStacking');
    const prices = groups.map(subtotal);
    const smaller =
      prices[0] === prices[1] ? -1 : prices[0] < prices[1] ? 0 : 1;
    if (kind === 'siblings' && (!sibling || smaller < 0)) return [];
    const discounts = groups.map((group, index) => {
      const [single] = group.classes.filter((klass) => !isComprehensive(klass));
      const bundleApplies =
        group.classes.length === 2 &&
        group.classes.filter(isComprehensive).length === 1;
      if (
        bundleApplies &&
        (!bundle || !single || fees.get(single.classId)!.price < bundle.value)
      )
        return NaN;
      if (bundleApplies && bundle) used.add(bundle);
      const pairApplies =
        group.classes.length === 2 &&
        group.classes.every((entry) => !isComprehensive(entry));
      if (pairApplies && !rate) return NaN;
      if (pairApplies && rate) used.add(rate);
      const combined = bundleApplies
        ? bundle!.value
        : pairApplies
          ? (prices[index] * rate!.value) / 100
          : 0;
      if (kind !== 'siblings' || index !== smaller) return combined;
      if (combined && !nonStacking) return NaN;
      if (nonStacking && combined) used.add(nonStacking);
      used.add(sibling!);
      return Math.max(combined, (prices[index] * sibling!.value) / 100);
    });
    if (
      !discounts.every(won) ||
      !used.size ||
      groups.some(
        (group, i) =>
          group.classes.some((klass) => /돌봄|자습/.test(klass.name)) ||
          discounts[i] > prices[i],
      )
    )
      return [];
    return [
      {
        fees,
        prices,
        discounts,
        excerpts: [...used].map(({ excerpt }) => excerpt),
        classification,
        siblingRate: sibling?.value,
      },
    ];
  });
  if (!choices.length) return;
  if (
    new Set(
      choices.map(({ prices, discounts, siblingRate }) =>
        JSON.stringify([prices, discounts, siblingRate]),
      ),
    ).size > 1
  )
    return abstain(
      '같은 반과 적용 시점의 할인 규정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = choices;
  const lines = groups.map((group, index) => {
    const { fees, discounts, prices } = selected;
    const details = group.classes.map(
      ({ classId }) =>
        className(ctx.catalog, classId) +
        ' ' +
        formatKrw(fees.get(classId)!.price),
    );
    return [
      group.label ? group.label + ' 학생 월 수강료' : '월 수강료',
      details.join(' + '),
      '할인 전 ' + formatKrw(prices[index]),
      '할인 ' + formatKrw(discounts[index]),
      '할인 후 ' + formatKrw(prices[index] - discounts[index]),
    ].join(' / ');
  });
  const usedFacts = [...selected.fees.values()].map(({ fact }) => fact);
  const proofs = [...selected.excerpts, ...selected.classification];
  if (studentIds.length) ctx.trace.targetStudentIds = studentIds;
  ctx.frame = { ...frame, classIds: ids };
  ctx.trace.intent = 'effective_tuition_discount';
  return {
    status: 'answered',
    text: [
      formatKstDate(at) +
        ' 적용 월 수강료 기준' +
        (studentIds.length ? ' · 등록 반 기준' : ''),
      ...lines,
      ...selected.excerpts.map(({ line }) => line),
    ].join('\n'),
    citations: [
      ...usedFacts.map((fact) => ({
        kind: 'fact' as const,
        fact,
        effectiveAt: at,
      })),
      ...proofs.map(({ chunk, tableColumns }) => ({
        kind: 'chunk' as const,
        chunk,
        tableColumns,
        effectiveAt: at,
      })),
    ],
    excerpts: proofs,
    usedFacts,
    instants: [at],
    derivedNumbers: [
      ...selected.prices,
      ...selected.discounts,
      ...selected.prices.map(
        (price, index) => price - selected.discounts[index],
      ),
    ],
  };
}
