/**
 * 원생 학습 분석 답변(단원·유형·전체 정답률, 취약 영역, 기간/학생/단원 비교, 누적 추이).
 * - 점수·정답률·취약 영역은 3번 기능에서 확정된 사실만 사용하고 재계산·추정하지 않는다.
 * - 과거 성적은 분석 기간과 근거 숙제를 함께 제시한다(프로젝트 기준 4장).
 * - 원인·태도·미래 예측은 관찰 자료로 판단할 수 없으므로 보류한다.
 * - 비교는 각 기간/학생의 근거가 모두 있을 때만 결론을 내고, 난도·표본 한계를 함께 안내한다.
 */
import {
  comparePeriods,
  formatPeriod,
  makePeriod,
  shiftPeriod,
  toKstDate,
} from '../text/time.ts';
import { compactText } from '../text/normalize.ts';
import { isAssistantDirective } from '../ingest/validation.ts';
import { refersToPriorUnit } from '../query/follow-up.ts';
import type { AccuracyDimension, ApprovedFact, RagChunk } from '../types.ts';
import {
  abstain,
  markMultiSubjectStudents,
  matchesRequestedSubject,
  subjectOf,
  recordFacts,
  recordChunks,
  studentLabel,
  subjectTag,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { accuracyPercent, exactPercent } from './format.ts';
import { supportsExcerpt } from './verify.ts';
import { composeRequests } from './composer.ts';
import { readEvidenceRow } from './public-evidence.ts';

type AccuracyFact = ApprovedFact & {
  value: {
    kind: 'accuracy';
    correct: number;
    total: number;
    unit: string;
    dimension?: AccuracyDimension;
    referenceOnly?: boolean;
    basis?: 'classified_assessed';
  };
};
type WeakAreaFact = ApprovedFact & {
  period: string;
  value: { kind: 'weak_area'; unit: string; text: string };
};

function isAccuracy(fact: ApprovedFact): fact is AccuracyFact {
  return fact.value.kind === 'accuracy' && fact.period !== null;
}
function isWeakArea(fact: ApprovedFact): fact is WeakAreaFact {
  return fact.value.kind === 'weak_area' && fact.period !== null;
}
function dimensionOf(fact: AccuracyFact): AccuracyDimension {
  return fact.value.dimension ?? 'unit';
}
function percent(fact: AccuracyFact): number {
  return accuracyPercent(fact.value.correct, fact.value.total);
}
function exact(fact: AccuracyFact): number {
  return exactPercent(fact.value.correct, fact.value.total);
}

const CAVEAT =
  '과제 난도와 문항 구성이 기간마다 다를 수 있어 이 차이만으로 실력 변화를 단정할 수는 없습니다.';

function resolvePeriods(ctx: AnswerContext, compareUnits = false): string[] {
  const { frame, state, asOf } = ctx;
  const { year, month } = toKstDate(asOf);
  const explicit = frame.months.map((m) =>
    makePeriod(m > month + 1 ? year - 1 : year, m),
  );
  if (frame.relativePeriod === 'last_month')
    explicit.push(shiftPeriod(makePeriod(year, month), -1));
  if (frame.relativePeriod === 'this_month')
    explicit.push(makePeriod(year, month));
  const previous = state?.previousFrame;
  const reference =
    ctx.engine === 'planned' && previous
      ? previous.domain === 'analysis' && previous.periods.length === 1
        ? previous.periods[0]
        : undefined
      : state?.selectedPeriod;
  // "9월보다 떨어졌어요?"처럼 비교 대상 한쪽만 말하면 직전 대화에서 본 기간과 비교한다.
  if (
    explicit.length === 1 &&
    !compareUnits &&
    (frame.flags.compare || frame.flags.trend) &&
    reference &&
    reference !== explicit[0] &&
    (ctx.engine !== 'planned' ||
      !frame.matchedStudentIds.length ||
      (state?.selectedStudentId !== undefined &&
        frame.matchedStudentIds.includes(state.selectedStudentId)))
  )
    explicit.push(reference);
  if (explicit.length > 0) return [...new Set(explicit)].sort(comparePeriods);
  if (frame.flags.elliptical || frame.anaphora) {
    if (frame.flags.elliptical && state?.previousFrame?.periods.length)
      return state.previousFrame.periods;
    if (reference) return [reference];
  }
  return [];
}

const LABEL_SUFFIX = /^(?:이랑|랑|하고|은|는|이|가|을|를|도|의|와|과|에서)?$/;

function mentionsReportLabel(text: string, label: string): boolean {
  return text
    .split(/[^가-힣a-z0-9]+/)
    .some(
      (word) =>
        word.startsWith(label) && LABEL_SUFFIX.test(word.slice(label.length)),
    );
}

function resolveLabels(ctx: AnswerContext): string[] {
  const { frame } = ctx;
  const requested = [...frame.units, ...frame.questionTypes];
  if (
    ctx.engine === 'planned' &&
    frame.flags.compare &&
    !frame.flags.trend &&
    !frame.flags.cumulative &&
    !frame.flags.typeDimension &&
    frame.months.length <= 1 &&
    /이랑|랑\s|하고\s|각각|둘\s*다/.test(frame.normalized) &&
    !/말고|빼고|제외|아니라/.test(frame.normalized)
  ) {
    const units = ctx.catalog.units.map((unit) => ({
      unit,
      terms: unit.split(/[^가-힣a-z0-9]+/).filter((term) => term.length >= 2),
    }));
    const resolved = units
      .filter(
        ({ unit, terms }) =>
          requested.includes(unit) ||
          terms.some(
            (term) =>
              units.filter((entry) => entry.terms.includes(term)).length ===
                1 && mentionsReportLabel(frame.normalized, term),
          ),
      )
      .map(({ unit }) => unit);
    if (resolved.length === 2) return resolved;
  }
  if (requested.length > 0) return requested;
  if (
    ctx.frame.flags.elliptical &&
    ctx.state?.previousFrame?.domain === 'analysis'
  ) {
    if (
      ctx.engine === 'planned' &&
      (frame.matchedStudentIds.some(
        (id) => id !== ctx.state?.selectedStudentId,
      ) ||
        frame.subjects.some(
          (subject) => !ctx.state?.previousFrame?.subjects?.includes(subject),
        ))
    )
      return [];
    return ctx.state.previousFrame.units;
  }
  return [];
}

function labelOf(fact: AccuracyFact): string {
  const dimension = dimensionOf(fact);
  if (dimension === 'overall') return '전체';
  if (dimension === 'question_type') return `${fact.value.unit} 유형`;
  return fact.value.unit;
}

function line(ctx: AnswerContext, fact: AccuracyFact): string {
  const name = studentLabel(ctx.access, fact.subjectId);
  const revision =
    fact.revision > 1
      ? ` (${fact.value.basis === 'classified_assessed' ? '분석 갱신본' : '채점 수정 반영본'} r${fact.revision})`
      : '';
  return `${name} 학생 ${formatPeriod(fact.period ?? '')} ${subjectTag(ctx, fact)}${labelOf(fact)}${fact.value.referenceOnly ? ' (참고용)' : ''}: ${fact.value.total}문항 중 ${fact.value.correct}문항 정답(정답률 ${percent(fact)}%)${revision}.`;
}

/** 분석 기간과 근거 숙제를 함께 제시한다. */
function assignmentLines(facts: readonly ApprovedFact[]): string[] {
  const byPeriod = new Map<string, string[]>();
  for (const fact of facts) {
    if (!fact.period) continue;
    const titles = byPeriod.get(fact.period) ?? [];
    for (const assignment of fact.assignments) {
      if (!titles.includes(assignment.title)) titles.push(assignment.title);
    }
    byPeriod.set(fact.period, titles);
  }
  return [...byPeriod.entries()]
    .filter(([, titles]) => titles.length > 0)
    .sort(([a], [b]) => comparePeriods(a, b))
    .map(([period, titles]) => {
      const shown = titles.slice(0, 3).join(', ');
      const rest = titles.length > 3 ? ` 외 ${titles.length - 3}건` : '';
      return `근거 숙제(${formatPeriod(period)}): ${shown}${rest}`;
    });
}

function sortFacts<T extends ApprovedFact>(facts: T[]): T[] {
  const rank = (fact: ApprovedFact) =>
    fact.value.kind === 'accuracy'
      ? ({ overall: 0, unit: 1, question_type: 2 } as const)[
          fact.value.dimension ?? 'unit'
        ]
      : 3;
  return [...facts].sort(
    (a, b) =>
      a.subjectId.localeCompare(b.subjectId) ||
      comparePeriods(a.period ?? '', b.period ?? '') ||
      rank(a) - rank(b) ||
      a.factId.localeCompare(b.factId),
  );
}

function notes(ctx: AnswerContext, facts: AccuracyFact[]): string[] {
  const result: string[] = [];
  if (facts.some((fact) => fact.value.basis === 'classified_assessed'))
    result.push(
      '분류 가능한 문항 중 결과가 확인된 문항 기준입니다. 미분류·결과 미확인 문항은 제외했습니다.',
    );
  for (const asked of ctx.frame.percents) {
    if (facts.length > 0 && !facts.some((fact) => percent(fact) === asked)) {
      const latest = facts[facts.length - 1];
      result.push(
        `문의하신 ${asked}%는 현재 확정된 값과 다릅니다. 최신 확정값은 ${percent(latest)}%입니다.`,
      );
    }
  }
  if (
    facts.some((fact) => fact.value.total < ctx.config.smallSampleThreshold)
  ) {
    result.push(
      '문항 수가 적은 결과는 변동이 클 수 있어 해석에 주의가 필요합니다.',
    );
  }
  return result;
}

function draft(
  ctx: AnswerContext,
  status: 'answered' | 'partial',
  lines: string[],
  used: ApprovedFact[],
  extras: {
    missing?: string[];
    derived?: number[];
    periods: string[];
    units: string[];
    targets: string[];
    weak?: boolean;
  },
): AnswerDraft {
  const assignmentCounts = [
    ...new Set(used.flatMap((fact) => fact.assignments.map((a) => a.title))),
  ].length;
  const periodNumbers = extras.periods.flatMap((period) =>
    period.split('-').map(Number),
  );
  const observedPeriods =
    ctx.engine === 'planned'
      ? [
          ...new Set(used.flatMap(({ period }) => (period ? [period] : []))),
        ].sort(comparePeriods)
      : extras.periods;
  return {
    status,
    text: [...lines, ...assignmentLines(used)].join('\n'),
    citations: used.map((fact) => ({ kind: 'fact' as const, fact })),
    usedFacts: used,
    missingFields: status === 'partial' ? extras.missing : undefined,
    reasonCode: status === 'partial' ? 'PARTIAL_EVIDENCE' : undefined,
    // 기간 표기(연·월)와 "외 N건" 같은 개수도 코드가 만든 수치로 허용한다.
    derivedNumbers: [
      ...(extras.derived ?? []),
      ...periodNumbers,
      ...Array.from({ length: assignmentCounts + 1 }, (_, n) => n),
    ],
    instants: [ctx.asOf],
    conversationUpdate: {
      selectedStudentId:
        extras.targets.length === 1 ? extras.targets[0] : undefined,
      candidateStudentIds:
        extras.targets.length > 1 ? extras.targets : undefined,
      selectedPeriod:
        observedPeriods.length === 1 ? observedPeriods[0] : undefined,
      previousFrame: {
        domain: 'analysis',
        units: extras.units,
        periods: observedPeriods,
        subjects: ctx.frame.subjects,
        ...(extras.weak ? { weak: true } : {}),
      },
    },
  };
}

function missingAbstain(what: string): AnswerDraft {
  return abstain(
    `${what}에 대한 확정된 학습 분석 자료가 아직 없어 답변드릴 수 없습니다. 자료가 확정되면 다시 확인해 주시거나 담당자 상담을 요청해 주세요.`,
    'INSUFFICIENT_EVIDENCE',
    [what],
    ['INSUFFICIENT_EVIDENCE'],
  );
}

function describeRequest(
  ctx: AnswerContext,
  targets: string[],
  periods: string[],
  labels: string[],
): string {
  const who = targets.map((id) => studentLabel(ctx.access, id)).join(', ');
  const when = periods.map(formatPeriod).join(', ');
  return (
    [who && `${who} 학생`, when, labels.join(', ')].filter(Boolean).join(' ') ||
    '요청하신 학습 결과'
  );
}

/** 비교·추이에 쓸 기준: 요청한 단원/유형 → 전체 합계 → 단원별 순. */
function seriesFacts(
  facts: AccuracyFact[],
  labels: string[],
  requireAllPeriods: (fs: AccuracyFact[]) => boolean,
): AccuracyFact[] {
  if (labels.length > 0)
    return facts.filter((fact) => labels.includes(fact.value.unit));
  const overall = facts.filter((fact) => dimensionOf(fact) === 'overall');
  if (overall.length > 0 && requireAllPeriods(overall)) return overall;
  return facts.filter((fact) => dimensionOf(fact) === 'unit');
}

/** Combined reports may contain subject rows even when their class metadata
 * describes only the homeroom. Use the approved report revision, then bind
 * the subject and requested metric to the same row. */
async function subjectReportRows(
  ctx: AnswerContext,
  targets: readonly string[],
  periods: readonly string[],
  labels: readonly string[],
  facts: readonly AccuracyFact[],
): Promise<AnswerDraft | undefined> {
  const [subject] = ctx.frame.subjects;
  const [studentId] = targets;
  const followUp =
    ctx.frame.flags.elliptical &&
    ctx.state?.previousFrame?.domain === 'analysis';
  const namesUnit = followUp && refersToPriorUnit(ctx.frame.normalized);
  if (
    ctx.engine !== 'planned' ||
    !subject ||
    ctx.frame.subjects.length !== 1 ||
    targets.length !== 1 ||
    labels.length > 1 ||
    ctx.frame.flags.weakUnit ||
    ctx.frame.flags.cumulative ||
    ctx.frame.flags.trend ||
    (!followUp &&
      !/정답률|몇\s*(?:개|문항|프로|퍼)|맞았|맞혔/.test(ctx.frame.normalized))
  )
    return;
  const own = facts.filter((fact) => fact.subjectId === studentId);
  const latest = own
    .map((fact) => fact.period ?? '')
    .sort(comparePeriods)
    .at(-1);
  const requested = periods.length ? periods : latest ? [latest] : [];
  if (!requested.length) return;
  const evidence = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [studentId],
    asOf: ctx.asOf,
    query: [
      subject,
      ...labels,
      labels.length || namesUnit ? '과목 유형 단원' : '소계',
      '정답 문항 전체 문항 정답률',
    ].join(' '),
    limit: 80,
    documentTypes: ['student_analysis'],
  });
  recordChunks(
    ctx.trace,
    evidence.map(({ chunk }) => chunk),
  );
  const matches = [];
  for (const period of requested) {
    const sources = new Set(
      own.filter((fact) => fact.period === period).map((fact) => fact.sourceId),
    );
    const rows = evidence.flatMap(({ chunk }) => {
      const { header, cells, kind } = chunk.location;
      if (
        chunk.studentId !== studentId ||
        !sources.has(chunk.sourceId) ||
        chunk.suspicious ||
        chunk.extraction?.needsReview ||
        chunk.extraction?.uncertainTokens.length ||
        kind !== 'table_row' ||
        !header ||
        !cells ||
        header.length !== cells.length
      )
        return [];
      const subjectColumn = header.findIndex((name) =>
        /^(과목|구분)$/.test(compactText(name)),
      );
      const correct = header.findIndex((name) =>
        /^정답(?:문항|수|문항수)$/.test(compactText(name)),
      );
      const total = header.findIndex((name) =>
        /^전체(?:문항|문항수)$/.test(compactText(name)),
      );
      const rate = header.findIndex((name) => compactText(name) === '정답률');
      if ([subjectColumn, correct, total, rate].some((index) => index < 0))
        return [];
      const rowSubject = compactText(cells[subjectColumn]);
      const labelColumn =
        labels.length || namesUnit
          ? header.findIndex((name) =>
              ctx.frame.flags.typeDimension
                ? /^(유형|문항유형)$/.test(compactText(name))
                : /^(단원|단원명|영역)$/.test(compactText(name)),
            )
          : -1;
      if (
        labels.length || namesUnit
          ? rowSubject !== compactText(subject) ||
            labelColumn < 0 ||
            !cells[labelColumn].trim() ||
            (labels.length > 0 &&
              compactText(cells[labelColumn]) !== compactText(labels[0]))
          : rowSubject !== compactText(subject + ' 소계')
      )
        return [];
      if (
        !/^\d+\s*문항$/.test(cells[correct]) ||
        !/^\d+\s*문항$/.test(cells[total]) ||
        !/^\d+(?:\.\d+)?\s*%$/.test(cells[rate])
      )
        return [];
      const columns = [
        ...new Set(
          [subjectColumn, labelColumn, correct, total, rate].filter(
            (index) => index >= 0,
          ),
        ),
      ];
      return [
        {
          chunk,
          columns,
          values: [
            cells[labelColumn] ?? '',
            cells[correct],
            cells[total],
            cells[rate],
          ],
          line: columns
            .map((index) => header[index] + ': ' + cells[index])
            .join(' / '),
        },
      ];
    });
    const verified = rows.filter(({ chunk, columns, line }) =>
      supportsExcerpt({ chunk, tableColumns: columns, line }),
    );
    if (!verified.length)
      return namesUnit
        ? abstain(
            '이전 리포트에서 과목에 해당하는 단원을 확인할 수 없습니다.',
            'INSUFFICIENT_EVIDENCE',
          )
        : undefined;
    if (new Set(verified.map((row) => row.values.join('|'))).size > 1)
      return abstain(
        '같은 과목과 기간의 승인 표가 서로 달라 확인이 필요합니다.',
        'CONFLICTING_EVIDENCE',
      );
    matches.push({ period, ...verified[0] });
  }
  ctx.trace.intent = 'subject_report_rows';
  return {
    status: 'answered',
    text: matches
      .map(({ period, line }) => formatPeriod(period) + ' ' + line)
      .join('\n'),
    citations: matches.map(({ chunk, columns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns: columns,
    })),
    usedFacts: [],
    excerpts: matches.map(({ chunk, columns, line }) => ({
      chunk,
      tableColumns: columns,
      line,
    })),
    instants: [
      ctx.asOf,
      ...matches.map(({ period }) => Date.parse(period + '-01T00:00:00+09:00')),
    ],
    conversationUpdate: {
      selectedStudentId: studentId,
      selectedPeriod: matches.at(-1)?.period,
      previousFrame: {
        domain: 'analysis',
        periods: matches.map(({ period }) => period),
        units: labels.length
          ? [...labels]
          : namesUnit
            ? [matches[0].values[0]]
            : [],
        subjects: [subject],
      },
    },
  };
}
const MONTH_END_ASSESSMENT = /월말\s*(?:평가|시험|고사)/;
const WORD_ASSESSMENT = /(?:단어|어휘)\s*(?:시험|평가|테스트)/;
const WORD_ASSESSMENT_TITLE = new RegExp(WORD_ASSESSMENT.source + '$');

export function reportAssessmentRequest(text: string) {
  const monthly = MONTH_END_ASSESSMENT.test(text);
  const words = WORD_ASSESSMENT.test(text);
  if (!monthly && !words) return;
  const points = /몇\s*점|점수|성적/.test(text);
  const rate = /정답률|몇\s*(?:%|퍼|프로)/.test(text);
  if (
    (!points && !rate) ||
    /커트라인|합격|통과|기준|넘어야|(?:어떻게|어디서|언제)\s*(?:확인|보|받)/.test(
      text,
    )
  )
    return;
  if (
    (monthly && words) ||
    (points && rate) ||
    /재\s*(?:시험|응시)|말고|제외|빼고|아니라/.test(text) ||
    /(?:학교|외부)(?:에서\s*(?:본|치른))?\s*(?:월말|단어\s*시험|어휘\s*시험)/.test(
      text,
    )
  )
    return 'unsupported';
  if (monthly && points) return 'monthly_points';
  if (words && rate) return 'word_test_rate';
  return 'unsupported';
}

/** Link a named assessment to one approved student, reporting period and metric. */
async function answerReportAssessment(
  ctx: AnswerContext,
  request: NonNullable<ReturnType<typeof reportAssessmentRequest>>,
  targets: readonly string[],
  periods: readonly string[],
  facts: readonly AccuracyFact[],
): Promise<AnswerDraft> {
  const { frame } = ctx;
  ctx.trace.intent = 'report_assessment';
  const label =
    request === 'monthly_points'
      ? '월말 평가 점수'
      : request === 'word_test_rate'
        ? '단어 시험 정답률'
        : '요청하신 시험 결과';
  const missing = () => missingAbstain(label);
  const [studentId] = targets;
  const years = [
    ...new Set(
      [...frame.normalized.matchAll(/(?<!\d)(\d{4})\s*년/g)].map(
        ([, year]) => year,
      ),
    ),
  ];
  if (
    request === 'unsupported' ||
    targets.length !== 1 ||
    frame.subjects.length > 1 ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.flags.compare ||
    frame.flags.trend ||
    frame.flags.cumulative ||
    frame.explicitDates.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    periods.length > 1 ||
    years.length > 1 ||
    (years.length && frame.months.length !== 1)
  )
    return missing();
  const owned = facts.filter(
    (fact) =>
      fact.subjectType === 'student' &&
      fact.subjectId === studentId &&
      (!frame.classIds.length ||
        (fact.classId !== null && frame.classIds.includes(fact.classId))) &&
      (!frame.subjects.length ||
        subjectOf(ctx.catalog, fact.classId) === frame.subjects[0]),
  );
  const period = years.length
    ? makePeriod(Number(years[0]), frame.months[0])
    : (periods[0] ??
      owned
        .map(({ period }) => period ?? '')
        .sort(comparePeriods)
        .at(-1));
  if (!period) return missing();
  const scoped = owned.filter((fact) => fact.period === period);

  if (request === 'word_test_rate') {
    const weekNumber = /(?<!\d)(\d{1,2})\s*주(?:차)?/g;
    const weeks = [...frame.normalized.matchAll(weekNumber)].map(([, n]) =>
      Number(n),
    );
    if (
      weeks.length > 1 ||
      /\d+\s*회차|유형/.test(frame.normalized) ||
      frame.questionTypes.some((type) => compactText(type) !== '어휘')
    )
      return missing();
    const results = scoped.filter((fact) => {
      const [assignment] = fact.assignments;
      if (
        dimensionOf(fact) !== 'unit' ||
        fact.assignments.length !== 1 ||
        !WORD_ASSESSMENT_TITLE.test(assignment.title.trim()) ||
        (frame.units.length && !frame.units.includes(fact.value.unit))
      )
        return false;
      const assignmentWeeks = [...assignment.title.matchAll(weekNumber)];
      return (
        !weeks.length ||
        (assignmentWeeks.length === 1 &&
          Number(assignmentWeeks[0][1]) === weeks[0])
      );
    });
    const keys = new Set(
      results.map(
        (fact) => fact.assignments[0].assignmentId + '|' + fact.value.unit,
      ),
    );
    if (!keys.size) return missing();
    if (keys.size > 1)
      return {
        status: 'clarify',
        reasonCode: 'AMBIGUOUS_SUBJECT',
        text: '같은 기간에 시험 기록이 여러 건 있습니다. 시험명이나 주차를 포함해 다시 질문해 주세요.',
        citations: [],
        usedFacts: [],
      };
    if (
      new Set(results.map(({ value }) => value.correct + '/' + value.total))
        .size > 1
    )
      return abstain(
        '같은 시험의 승인 정답 수가 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    const [fact] = results;
    return draft(ctx, 'answered', [line(ctx, fact)], [fact], {
      periods: [period],
      units: [fact.value.unit],
      targets: [studentId],
    });
  }

  const sources = new Set(scoped.map(({ sourceId }) => sourceId));
  if (!sources.size) return missing();
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [studentId],
    asOf: ctx.asOf,
    query: [ctx.question, formatPeriod(period), '월말 평가 시험 점수'].join(
      ' ',
    ),
    documentTypes: ['student_analysis'],
    limit: 65,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const [year, month] = period.split('-').map(Number);
  const candidates = hits.flatMap(({ chunk }) => {
    if (
      chunk.visibility !== 'student_private' ||
      chunk.studentId !== studentId ||
      !sources.has(chunk.sourceId) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      return [];
    const row = readEvidenceRow(chunk);
    const { header } = chunk.location;
    if (!row || !header) return [];
    const singleColumn = (pattern: RegExp) =>
      header.filter((cell) => pattern.test(compactText(cell))).length === 1
        ? row.column(pattern)
        : -1;
    const name = singleColumn(/^(?:평가|평가명|시험|시험명|항목|구분)$/);
    const score = singleColumn(/^(?:점수|평가점수|시험점수|획득점수)$/);
    const assessment =
      /^(?:(\d{4})년)?(?:(\d{1,2})월)?월말(?:평가|시험|고사)$/.exec(
        compactText(row.cells[name] ?? ''),
      );
    const points = /^(\d+(?:\.\d+)?)\s*점$/.exec(row.cells[score] ?? '');
    if (
      !assessment ||
      (assessment[1] && Number(assessment[1]) !== year) ||
      (assessment[2] && Number(assessment[2]) !== month) ||
      !points
    )
      return [];
    const subjectColumn = singleColumn(/^과목$/);
    if (subjectColumn < 0 && row.column(/^과목$/) >= 0) return [];
    const subject = compactText(
      subjectColumn >= 0
        ? row.cells[subjectColumn]
        : (subjectOf(ctx.catalog, chunk.classId) ?? ''),
    );
    if (frame.subjects.length && subject !== compactText(frame.subjects[0]))
      return [];
    const excerpt = row.project(
      name,
      ...(subjectColumn >= 0 ? [subjectColumn] : []),
      score,
    );
    return excerpt ? [{ excerpt, score: Number(points[1]), subject }] : [];
  });
  if (
    new Set(candidates.map(({ subject }) => subject).filter(Boolean)).size > 1
  )
    return {
      status: 'clarify',
      reasonCode: 'AMBIGUOUS_SUBJECT',
      text: '과목별 월말 평가가 있습니다. 어느 과목의 점수를 확인할까요?',
      citations: [],
      usedFacts: [],
    };
  if (new Set(candidates.map(({ score }) => score)).size > 1)
    return abstain(
      '같은 기간의 승인 평가 점수가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  if (!candidates.length) return missing();
  const [{ excerpt }] = candidates;
  return {
    status: 'answered',
    text: formatPeriod(period) + ' ' + excerpt.line,
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
      },
    ],
    excerpts: [excerpt],
    usedFacts: [],
    instants: [ctx.asOf, Date.parse(period + '-01T00:00:00+09:00')],
    conversationUpdate: {
      selectedStudentId: studentId,
      selectedPeriod: period,
      previousFrame: {
        domain: 'analysis',
        periods: [period],
        units: [],
        subjects: frame.subjects,
      },
    },
  };
}

const EXTERNAL_REPORT_FIELDS = [
  {
    label: '반·학년 평균',
    pattern: /(?:반|학년)(?:의)?\s*평균(?:\s*(?:점수|정답률|성적))?/,
  },
  {
    label: '학교 시험 점수',
    pattern:
      /학교(?:에서\s*(?:본|치른))?\s*(?:(?:단원|형성|수행)\s*평가|(?:중간|기말)\s*(?:고사|시험)|시험)(?:의)?\s*(?:점수|성적)/,
  },
];

/** A combined-class weakness belongs to a named subject only if the same report binds its unit. */
async function subjectBoundWeakness(
  ctx: AnswerContext,
  studentId: string,
  subject: string,
  candidates: WeakAreaFact[],
): Promise<WeakAreaFact[]> {
  if (!candidates.length) return [];
  const units = [...new Set(candidates.map((fact) => fact.value.unit))];
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [studentId],
    asOf: ctx.asOf,
    query: [subject, '과목 단원 단원별 결과', ...units].join(' '),
    limit: 80,
    documentTypes: ['student_analysis'],
  });
  recordChunks(
    ctx.trace,
    results.map(({ chunk }) => chunk),
  );
  const scope = new Map<string, Set<string>>();
  const keyOf = (entry: {
    sourceId: string;
    documentId: string;
    revision: number;
  }) => [entry.sourceId, entry.documentId, entry.revision].join('|');
  const sources = new Set(candidates.map(keyOf));
  for (const { chunk } of results) {
    const { kind, header, cells } = chunk.location;
    if (
      chunk.studentId !== studentId ||
      !sources.has(keyOf(chunk)) ||
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      continue;
    const unitIndex = header.findIndex((value) =>
      /^(?:단원|단원명|영역)$/.test(compactText(value)),
    );
    const subjectIndex = header.findIndex(
      (value) => compactText(value) === '과목',
    );
    if (unitIndex < 0 || subjectIndex < 0 || !cells[subjectIndex].trim())
      continue;
    const key = keyOf(chunk) + '|' + compactText(cells[unitIndex]);
    const subjects = scope.get(key) ?? new Set<string>();
    subjects.add(compactText(cells[subjectIndex]));
    scope.set(key, subjects);
  }
  return candidates.filter((fact) => {
    const subjects = scope.get(
      keyOf(fact) + '|' + compactText(fact.value.unit),
    );
    return subjects?.size === 1 && subjects.has(compactText(subject));
  });
}

export async function answerAnalysis(
  ctx: AnswerContext,
  targets: string[],
): Promise<AnswerDraft> {
  const { frame } = ctx;
  const external =
    ctx.engine === 'planned'
      ? EXTERNAL_REPORT_FIELDS.filter(({ pattern }) =>
          pattern.test(frame.normalized),
        )
      : [];
  if (!external.length) return answerLearningReport(ctx, targets);
  const missing = external.map(({ label }) => label);
  const outside = abstain(
    '학원 학습 분석 리포트의 범위에서 해당 비교 자료를 확인할 수 없습니다.',
    'INSUFFICIENT_EVIDENCE',
    missing,
  );
  const personal = external.reduce(
    (question, { pattern }) => question.replace(pattern, ''),
    frame.normalized,
  );
  if (
    !/정답률|정답\s*(?:개수|문항)|몇\s*(?:개|문항).{0,8}(?:맞|틀)/.test(
      personal,
    )
  )
    return outside;

  // Comparing with a cohort is a separate request from comparing periods.
  // Keep an explicit trend or multi-month comparison in the personal report.
  const comparePeriods =
    frame.flags.compare &&
    (!external.includes(EXTERNAL_REPORT_FIELDS[0]) ||
      frame.months.length >= 2 ||
      /지난\s*달|저번\s*달|전월/.test(personal));
  const local = await answerLearningReport(
    {
      ...ctx,
      frame: { ...frame, flags: { ...frame.flags, compare: comparePeriods } },
    },
    targets,
  );
  return composeRequests([local, outside], [personal, missing.join(', ')]);
}

export function recordedDeductionRequest(
  frame: AnswerContext['frame'],
): boolean {
  const q = frame.normalized;
  return (
    /감점|깎(?:였|인|이)|점수\s*(?:가|를)?\s*잃/.test(q) &&
    /왜|이유|사유|때문|어떤\s*(?:항목|조건|부분)/.test(q) &&
    (frame.months.length > 0 ||
      frame.relativePeriod !== null ||
      /리포트|보고서|채점\s*기록/.test(q)) &&
    !/학교(?:에서|\s*시험)|시험장에서|탓|태도|실력|성격|집중|노력/.test(q)
  );
}

async function answerRecordedDeduction(
  ctx: AnswerContext,
  targets: string[],
): Promise<AnswerDraft> {
  ctx.trace.intent = 'recorded_deduction';
  const { frame } = ctx;
  const year = /(?<!\d)(20\d{2})년\s*\d{1,2}월/.exec(frame.normalized)?.[1];
  const periods = year
    ? frame.months.map((month) => makePeriod(Number(year), month))
    : resolvePeriods(ctx);
  const labels = resolveLabels(ctx);
  const missing = () =>
    missingAbstain(
      describeRequest(ctx, targets, periods, ['기록된 감점 사유']),
    );
  if (
    targets.length !== 1 ||
    periods.length > 1 ||
    frame.explicitDates.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.flags.compare
  )
    return missing();
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: targets,
    factTypes: ['weak_area'],
    asOf: ctx.asOf,
  });
  recordFacts(ctx.trace, facts);
  const [student] = targets;
  const eligible = facts
    .filter(isWeakArea)
    .filter(
      (fact) =>
        fact.subjectType === 'student' &&
        fact.subjectId === student &&
        matchesRequestedSubject(ctx, fact),
    );
  const period =
    periods[0] ??
    eligible
      .map((fact) => fact.period)
      .sort(comparePeriods)
      .at(-1);
  if (!period) return missing();
  const candidates = eligible.filter(
    (fact) =>
      fact.period === period &&
      /감점|깎였/.test(fact.value.text) &&
      /누락|오류|오답|잘못|미충족|틀림|위반|때문|(?:이유|사유)\s*[:：]/.test(
        fact.value.text,
      ) &&
      !isAssistantDirective(fact.value.text) &&
      labels.every(
        (label) =>
          compactText(fact.value.unit) === compactText(label) ||
          mentionsReportLabel(fact.value.unit, label),
      ),
  );
  if (!candidates.length) return missing();
  if (
    new Set(
      candidates.map(({ value }) => compactText(value.unit + ' ' + value.text)),
    ).size !== 1
  )
    return abstain(
      '같은 기간의 승인 리포트에 서로 다른 감점 기록이 있습니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [fact] = candidates;
  return draft(
    ctx,
    'answered',
    [
      `${studentLabel(ctx.access, student)} 학생 ${formatPeriod(period)} ${fact.value.unit} 채점 기록에 따르면 ${fact.value.text}`,
    ],
    [fact],
    { periods: [period], units: [fact.value.unit], targets },
  );
}

async function answerLearningReport(
  ctx: AnswerContext,
  targets: string[],
): Promise<AnswerDraft> {
  // A combined class's catalog label is not evidence that the report covers
  // every subject. Bind a named component to an exact fact or report row.
  const inferredSubjects =
    ctx.engine === 'planned' && ctx.frame.subjects.length === 0
      ? [
          ...new Set(
            ctx.catalog.classes.flatMap(({ subject }) =>
              subject && /[·,/]/.test(subject)
                ? subject.split(/[·,/]/).map((name) => name.trim())
                : [],
            ),
          ),
        ].filter(
          (name) =>
            /^[가-힣]{2,}$/.test(name) &&
            !ctx.catalog.classes.some(({ subject }) => subject === name) &&
            mentionsReportLabel(ctx.frame.normalized, name),
        )
      : [];
  if (inferredSubjects.length === 1)
    ctx = { ...ctx, frame: { ...ctx.frame, subjects: inferredSubjects } };
  if (ctx.engine === 'planned' && ctx.frame.subjects.length) {
    const classIds = ctx.frame.classIds.filter((classId) => {
      const klass = ctx.catalog.classes.find(
        (entry) => entry.classId === classId,
      );
      if (!klass?.subject || !ctx.frame.subjects.includes(klass.subject))
        return true;
      // A subject token can match the short name of a separate class. Keep
      // the class constraint only when the learner actually mentioned it.
      return [klass.name, ...klass.aliases].some((label) => {
        const key = compactText(label);
        return (
          key !== compactText(klass.subject ?? '') &&
          ctx.frame.compact.includes(key)
        );
      });
    });
    if (classIds.length !== ctx.frame.classIds.length)
      ctx.frame = { ...ctx.frame, classIds };
  }
  const { frame } = ctx;
  if (
    ctx.engine === 'planned' &&
    !frame.flags.attitude &&
    !frame.flags.prediction &&
    !frame.flags.misattribution &&
    recordedDeductionRequest(frame)
  )
    return answerRecordedDeduction(ctx, targets);
  const recordedErrors =
    ctx.engine === 'planned' &&
    /취약|약하다고/.test(frame.normalized) &&
    /리포트|보고서|나온|기록/.test(frame.normalized) &&
    /왜\s*틀렸/.test(frame.normalized) &&
    !/원인|태도|집중|성격|의지|노력|실력/.test(frame.normalized);
  if ((frame.flags.causal && !recordedErrors) || frame.flags.attitude) {
    ctx.trace.intent = 'causal_or_attitude';
    return abstain(
      '숙제 정답·오답 기록만으로는 원인이나 학습 태도를 판단할 수 없어 답변드리기 어렵습니다. 담당 강사와 상담해 보시길 권해 드립니다.',
      'CAUSAL_CLAIM_NOT_SUPPORTED',
    );
  }
  if (frame.flags.prediction) {
    ctx.trace.intent = 'prediction';
    return abstain(
      '아직 확정되지 않은 미래 결과는 예측해 드릴 수 없습니다. 지금까지 확정된 학습 결과는 안내해 드릴 수 있습니다.',
      'PREDICTION_NOT_SUPPORTED',
    );
  }
  if (frame.flags.misattribution) {
    ctx.trace.intent = 'misattribution';
    return abstain(
      '한 학생의 성적을 다른 학생의 성적으로 안내할 수는 없습니다. 각 학생의 확정 자료는 따로 확인해 주세요.',
      'MISATTRIBUTION_REQUEST',
      undefined,
      ['WRONG_ENTITY'],
    );
  }

  if (
    ctx.engine === 'planned' &&
    /미\s*제출|(?:안|못)\s*(?:냈|낸|내|제출)|제출\s*(?:안|못|하지\s*않)/.test(
      frame.normalized,
    ) &&
    /몇\s*(?:번|회|개|건)|횟수|건수|개수/.test(frame.normalized)
  ) {
    ctx.trace.intent = 'unsubmitted_assignment_count';
    return abstain(
      '학습 리포트의 분석 대상 과제 목록만으로는 미제출 과제 수를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['미제출 과제 기록'],
    );
  }
  const labels = resolveLabels(ctx);
  const compareUnits =
    ctx.engine === 'planned' &&
    labels.length === 2 &&
    frame.flags.compare &&
    !frame.flags.trend &&
    !frame.flags.cumulative &&
    frame.months.length <= 1;
  const periods = resolvePeriods(ctx, compareUnits);
  const assessment =
    ctx.engine === 'planned' && reportAssessmentRequest(frame.normalized);
  const loaded = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: targets,
    factTypes: assessment ? ['accuracy'] : ['accuracy', 'weak_area'],
    asOf: ctx.asOf,
  });
  recordFacts(ctx.trace, loaded);
  markMultiSubjectStudents(ctx, loaded);
  const matchesSubject = (fact: ApprovedFact) =>
    inferredSubjects.length === 1
      ? subjectOf(ctx.catalog, fact.classId) === inferredSubjects[0]
      : matchesRequestedSubject(ctx, fact);
  const allAccuracy = loaded
    .filter(isAccuracy)
    .filter((fact) => targets.includes(fact.subjectId))
    .filter(matchesSubject);
  if (assessment)
    return answerReportAssessment(
      ctx,
      assessment,
      targets,
      periods,
      loaded.filter(isAccuracy),
    );
  const wantsReportedWeakness =
    ctx.engine === 'planned' &&
    /취약\s*(?:영역|단원)|약하다고|단원.{0,12}약했/.test(frame.normalized);
  const allWeak = loaded
    .filter(isWeakArea)
    .filter((fact) => targets.includes(fact.subjectId));
  let weakAreas = allWeak.filter(matchesSubject);
  if (
    ctx.engine === 'planned' &&
    targets.length === 1 &&
    frame.subjects.length === 1 &&
    (frame.flags.weakUnit || wantsReportedWeakness)
  ) {
    const [subject] = frame.subjects;
    const possible = allWeak.filter(
      (fact) =>
        !matchesSubject(fact) &&
        (!periods.length || periods.includes(fact.period ?? '')),
    );
    weakAreas = [
      ...weakAreas,
      ...(await subjectBoundWeakness(ctx, targets[0], subject, possible)),
    ];
  }

  // 같은 학생·지표·기간에 동시에 유효한 승인 값이 서로 다르면 어느 쪽도 고르지 않는다.
  const groups = new Map<string, Set<string>>();
  for (const fact of allAccuracy) {
    const key = `${fact.subjectId}|${subjectOf(ctx.catalog, fact.classId) ?? ''}|${dimensionOf(fact)}|${fact.value.unit}|${fact.period}`;
    const values = groups.get(key) ?? new Set<string>();
    values.add(`${fact.value.correct}/${fact.value.total}`);
    groups.set(key, values);
  }
  if ([...groups.values()].some((values) => values.size > 1)) {
    ctx.trace.intent = 'accuracy_conflict';
    return abstain(
      '같은 기간·단원에 대해 승인된 기록이 서로 달라 정확한 안내가 어렵습니다. 담당자 확인 후 안내해 드리겠습니다.',
      'CONFLICTING_EVIDENCE',
      undefined,
      ['CONTRADICTION'],
    );
  }

  const rows = await subjectReportRows(
    ctx,
    targets,
    periods,
    labels,
    loaded.filter(isAccuracy),
  );
  if (rows) return rows;
  if (
    ctx.engine === 'planned' &&
    refersToPriorUnit(frame.normalized) &&
    labels.length !== 1
  )
    return abstain(
      '어느 단원이나 영역을 말씀하시는지 확인할 수 없습니다.',
      'AMBIGUOUS_SUBJECT',
    );

  const wantsComparison =
    frame.flags.compare || frame.flags.trend || frame.flags.cumulative;
  if (wantsComparison && targets.length >= 2) {
    ctx.trace.intent = 'accuracy_compare_students';
    return compareStudents(ctx, targets, periods, labels, allAccuracy);
  }
  const unitComparison =
    (frame.flags.unitDimension || compareUnits) &&
    periods.length <= 1 &&
    !frame.flags.cumulative;
  if ((frame.flags.weakUnit || wantsReportedWeakness) && periods.length >= 2) {
    ctx.trace.intent = 'weak_area_compare';
    return weakAreaAnswer(
      ctx,
      targets,
      periods,
      allAccuracy.filter((fact) => periods.includes(fact.period ?? '')),
      weakAreas.filter((fact) => periods.includes(fact.period ?? '')),
      () => undefined,
      recordedErrors,
    );
  }
  if (wantsComparison && !unitComparison) {
    ctx.trace.intent = frame.flags.cumulative
      ? 'accuracy_cumulative'
      : 'accuracy_compare_periods';
    const available = [
      ...new Set(allAccuracy.map((fact) => fact.period ?? '')),
    ].sort(comparePeriods);
    const comparePeriodsList =
      periods.length >= 2
        ? periods
        : frame.flags.cumulative
          ? available.filter(
              (period) =>
                periods.length === 0 || comparePeriods(period, periods[0]) <= 0,
            )
          : periods.length === 1
            ? [shiftPeriod(periods[0], -1), periods[0]]
            : available.slice(-2);
    return comparePeriodsFor(
      ctx,
      targets[0],
      comparePeriodsList,
      labels,
      allAccuracy,
    );
  }

  // 단일 조회
  const inScope = (fact: ApprovedFact) =>
    periods.length > 0 ? periods.includes(fact.period ?? '') : true;
  const candidates = allAccuracy.filter(inScope);
  const latestPeriod = (facts: ApprovedFact[]) =>
    [...new Set(facts.map((fact) => fact.period ?? ''))]
      .sort(comparePeriods)
      .pop();

  if ((frame.flags.weakUnit && labels.length === 0) || wantsReportedWeakness) {
    ctx.trace.intent = 'weak_area';
    return weakAreaAnswer(
      ctx,
      targets,
      periods,
      candidates,
      weakAreas.filter(inScope),
      latestPeriod,
      recordedErrors,
    );
  }

  if (targets.length === 1) {
    const detail = await reportDetail(
      ctx,
      targets[0],
      periods,
      allAccuracy.filter((fact) => fact.subjectId === targets[0]),
    );
    if (detail) return detail;
  }

  ctx.trace.intent = 'accuracy_lookup';
  let selected: AccuracyFact[];
  if (labels.length > 0) {
    selected = candidates.filter((fact) => labels.includes(fact.value.unit));
  } else if (frame.flags.typeDimension) {
    selected = candidates.filter(
      (fact) => dimensionOf(fact) === 'question_type',
    );
  } else {
    selected = candidates.filter(
      (fact) => dimensionOf(fact) !== 'question_type',
    );
  }
  if (periods.length === 0) {
    // 기간을 말하지 않으면 학생별 가장 최근 확정 기간을 쓴다.
    selected = targets.flatMap((target) => {
      const own = selected.filter((fact) => fact.subjectId === target);
      const latest = latestPeriod(own);
      return own.filter((fact) => fact.period === latest);
    });
  }
  const what = describeRequest(ctx, targets, periods, labels);
  if (selected.length === 0) return missingAbstain(what);

  const sorted = sortFacts(selected);
  const lines = sorted.map((fact) => line(ctx, fact));
  const missing: string[] = [];
  for (const label of labels) {
    for (const target of targets) {
      if (
        !sorted.some(
          (fact) => fact.value.unit === label && fact.subjectId === target,
        )
      ) {
        missing.push(`${studentLabel(ctx.access, target)} ${label}`);
      }
    }
  }
  const derived: number[] = [];
  const unitFacts = sorted.filter((fact) => dimensionOf(fact) !== 'overall');
  if (unitComparison && wantsComparison && unitFacts.length >= 2) {
    const [a, b] = [...unitFacts].sort((x, y) => percent(y) - percent(x));
    const diff = Math.round(exact(a) - exact(b));
    derived.push(diff);
    lines.push(
      diff === 0
        ? '두 항목의 정답률은 같습니다.'
        : `${labelOf(a)} 정답률이 ${labelOf(b)}보다 ${diff}%p 높습니다. 항목마다 문항 수와 난도가 달라 단순 비교에는 한계가 있습니다.`,
    );
  }
  if (missing.length > 0)
    lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  lines.push(...notes(ctx, sorted));
  return draft(ctx, missing.length ? 'partial' : 'answered', lines, sorted, {
    missing,
    derived,
    periods: periods.length
      ? periods
      : [...new Set(sorted.map((fact) => fact.period ?? ''))],
    units: labels,
    targets,
  });
}

const SUBMISSION_COUNT =
  /몇\s*(번|회|개|건)\s*(냈|제출|했|풀었|썼)|제출\s*(횟수|한\s*거|몇)|(과제|활동지|숙제|기록지|보고서)\s*(을|를)?\s*(몇\s*(번|회|개|건)|횟수)/;
const REVISION_REASON =
  /(왜|이유|무슨|뭐가|어디가).{0,12}(수정|정정|바뀌|바뀐|바꿨|변경)|(수정|정정|변경)\s*(된|한|됐)?\s*(이유|내용|사유|문제|문항)|몇\s*번\s*문제/;

const MOST_ERRORS =
  /(?:숙제|과제).{0,18}(?:중에|중에서|에서)?.{0,14}(?:가장|제일)\s*많이\s*틀|(?:오답|틀린\s*(?:문항|문제)).{0,12}(?:가장|제일)\s*많.{0,12}(?:숙제|과제)/;

async function mostMissedAssignment(
  ctx: AnswerContext,
  studentId: string,
  overall: AccuracyFact[],
): Promise<AnswerDraft> {
  const [report] = overall;
  const missingEvidence = () =>
    abstain(
      '해당 리포트의 과제별 문항 수를 모두 확인할 수 없어 오답이 가장 많은 과제를 특정할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (overall.length !== 1 || !report.period || !report.assignments.length)
    return missingEvidence();
  const listed = new Map(
    report.assignments.map((assignment) => [
      compactText(assignment.title),
      assignment,
    ]),
  );
  if (listed.size !== report.assignments.length) return missingEvidence();
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [studentId],
    asOf: ctx.asOf,
    query: [
      '분석 대상 숙제 과제 제목 문항 수 정답',
      ...report.assignments.map(({ title }) => title),
    ].join(' '),
    limit: 90,
    documentTypes: ['student_analysis'],
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const rows = new Map<
    string,
    {
      excerpt: { chunk: RagChunk; line: string; tableColumns: number[] };
      correct: number;
      total: number;
    }
  >();
  for (const { chunk } of found) {
    const { kind, cells, header } = chunk.location;
    if (
      chunk.studentId !== studentId ||
      chunk.sourceId !== report.sourceId ||
      chunk.revision !== report.revision ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      kind !== 'table_row' ||
      !cells ||
      !header ||
      cells.length !== header.length
    )
      continue;
    const labels = header.map(compactText);
    const titleIndex = labels.findIndex((label) =>
      /^(?:숙제제목|숙제명|과제제목|과제명|과제)$/.test(label),
    );
    const idIndex = labels.findIndex((label) =>
      /^(?:숙제번호|과제번호|숙제코드|과제코드)$/.test(label),
    );
    const totalIndex = labels.findIndex((label) =>
      /^(?:전체문항수?|문항수)$/.test(label),
    );
    const correctIndex = labels.findIndex((label) =>
      /^(?:정답|정답문항수?|정답수)$/.test(label),
    );
    if (titleIndex < 0 || totalIndex < 0 || correctIndex < 0) continue;
    const title = compactText(cells[titleIndex]);
    const assignment = listed.get(title);
    if (
      !assignment ||
      (idIndex >= 0 && cells[idIndex] !== assignment.assignmentId)
    )
      continue;
    const total = Number(/^(\d+)\s*(?:문항)?$/.exec(cells[totalIndex])?.[1]);
    const correct = Number(
      /^(\d+)\s*(?:문항)?$/.exec(cells[correctIndex])?.[1],
    );
    if (
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(correct) ||
      !total ||
      correct > total
    )
      return missingEvidence();
    const tableColumns = [titleIndex, totalIndex, correctIndex];
    const line = tableColumns
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, line, tableColumns };
    if (!supportsExcerpt(excerpt)) continue;
    const previous = rows.get(title);
    if (previous && (previous.correct !== correct || previous.total !== total))
      return abstain(
        '리포트에 같은 과제의 채점 결과가 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    rows.set(title, { excerpt, total, correct });
  }
  const compared = [...rows.values()];
  if (
    compared.length !== listed.size ||
    compared.reduce((total, row) => total + row.total, 0) !==
      report.value.total ||
    compared.reduce((total, row) => total + row.correct, 0) !==
      report.value.correct
  )
    return missingEvidence();
  const max = Math.max(
    ...compared.map(({ total, correct }) => total - correct),
  );
  const winners = compared.filter(
    ({ total, correct }) => total - correct === max,
  );
  const send = /보내|재발송|파일\s*(?:줘|주|첨부)/.test(ctx.frame.normalized);
  const missing = send ? ['과제 자료 재전송 가능 여부'] : [];
  const excerpts = compared.map(({ excerpt }) => excerpt);
  ctx.trace.intent = 'report_assignment_errors';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      formatPeriod(report.period) +
        ' 리포트에서 오답이 가장 많은 과제는 다음과 같습니다.',
      ...winners.map(
        ({ excerpt }) => excerpt.line + ' / 오답: ' + max + '문항',
      ),
      ...(send ? ['확인되지 않은 항목: 과제 자료 재전송 가능 여부'] : []),
    ].join('\n'),
    citations: excerpts.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    excerpts,
    usedFacts: [report],
    derivedNumbers: [max, ...report.period.split('-').map(Number)],
    conversationUpdate: {
      selectedStudentId: studentId,
      selectedPeriod: report.period,
    },
  };
}

/**
 * 리포트 원문에만 있는 세부 내용: 과제 이름을 말한 질문(그 과제 행), 제출 횟수(분석 대상 과제 수),
 * 채점 수정 이유(리포트의 수정 이력 절). 학생 본인 리포트 청크만 근거로 쓴다.
 */
async function reportDetail(
  ctx: AnswerContext,
  target: string,
  periods: string[],
  own: AccuracyFact[],
): Promise<AnswerDraft | null> {
  if (own.length === 0) return null;
  const latest = [...new Set(own.map((fact) => fact.period ?? ''))]
    .sort(comparePeriods)
    .pop();
  const scoped = own.filter((fact) =>
    periods.length > 0
      ? periods.includes(fact.period ?? '')
      : fact.period === latest,
  );
  if (
    ctx.engine === 'planned' &&
    MOST_ERRORS.test(ctx.frame.normalized) &&
    !/오답률|비율|퍼센트|미제출|안\s*낸/.test(ctx.frame.normalized)
  )
    return mostMissedAssignment(
      ctx,
      target,
      scoped.filter((fact) => dimensionOf(fact) === 'overall'),
    );
  const label = studentLabel(ctx.access, target);
  const search = async (query: string) =>
    (
      await ctx.documents.searchApprovedChunks({
        access: ctx.access,
        studentIds: [target],
        asOf: ctx.asOf,
        query,
        limit: 30,
        documentTypes: ['student_analysis'],
      })
    )
      .map((result) => result.chunk)
      .filter((chunk) => chunk.studentId === target);
  // 내부 관리 번호처럼 보이는 칸(예: HK_HW_M2B_0908)은 답변에 싣지 않는다.
  const rowText = (chunk: RagChunk) =>
    (chunk.location.header ?? [])
      .map((name, i) => [name, chunk.location.cells?.[i] ?? ''])
      .filter(([, cell]) => !/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(cell.trim()))
      .map(([name, cell]) => `${name}: ${cell}`)
      .join(' / ');
  const chunkDraft = (text: string, chunks: RagChunk[]): AnswerDraft => ({
    status: 'answered',
    text,
    citations: chunks.map((chunk) => ({ kind: 'chunk' as const, chunk })),
    usedFacts: [],
    instants: [ctx.asOf],
    conversationUpdate: { selectedStudentId: target },
  });

  // 1) 과제 이름을 그대로 말한 질문 → 그 과제 행(같은 이름의 다른 학생 과제와 섞이지 않게 본인 리포트에서만)
  const question = ctx.frame.compact;
  const titles = [
    ...new Set(own.flatMap((fact) => fact.assignments.map((a) => a.title))),
  ].filter((title) => question.includes(compactText(title)));
  if (titles.length === 1) {
    const rows = (await search(titles[0])).filter(
      (chunk) =>
        chunk.location.kind === 'table_row' &&
        (chunk.location.cells ?? []).some(
          (cell) => compactText(cell) === compactText(titles[0]),
        ),
    );
    if (rows.length > 0) {
      ctx.trace.intent = 'report_assignment';
      return chunkDraft(
        `${rows[0].title} 기준 과제 기록입니다.\n${rowText(rows[0])}`,
        [rows[0]],
      );
    }
  }

  // 2) 제출 횟수 → 그 기간 분석 대상 과제 수와 전체 문항 수
  if (SUBMISSION_COUNT.test(ctx.frame.normalized) && scoped.length > 0) {
    const period = scoped[0].period ?? '';
    const sameSubject = scoped.filter((fact) => fact.period === period);
    const assignments = [
      ...new Set(
        sameSubject.flatMap((fact) => fact.assignments.map((a) => a.title)),
      ),
    ];
    const overall = sameSubject.find((fact) => dimensionOf(fact) === 'overall');
    if (assignments.length > 0) {
      ctx.trace.intent = 'report_submissions';
      const lines = [
        `${label} 학생 ${formatPeriod(period)} 분석 대상 과제는 ${assignments.length}회${overall ? `(총 ${overall.value.total}문항)` : ''}입니다.`,
      ];
      return draft(ctx, 'answered', lines, overall ? [overall] : sameSubject, {
        periods: [period],
        units: [],
        targets: [target],
      });
    }
  }

  // 3) 채점 수정 이유 → 리포트의 수정 이력 절
  if (REVISION_REASON.test(ctx.frame.normalized)) {
    const notes = (await search(`${ctx.question} 수정 정정 변경 이력`)).filter(
      (chunk) =>
        chunk.revision > 1 &&
        /수정|정정|변경/.test(chunk.location.section ?? '') &&
        (periods.length === 0 ||
          scoped.some((fact) => fact.documentId === chunk.documentId)),
    );
    if (notes.length > 0) {
      ctx.trace.intent = 'report_revision';
      const chunks = notes
        .filter((chunk) => chunk.documentId === notes[0].documentId)
        .sort(
          (a, b) =>
            Number(a.chunkId.split('#').pop()) -
            Number(b.chunkId.split('#').pop()),
        );
      return chunkDraft(
        `${chunks[0].title}(${chunks[0].revision}차 수정본) 수정 이력입니다.\n${chunks
          .map((chunk) =>
            chunk.location.kind === 'table_row' ? rowText(chunk) : chunk.text,
          )
          .join('\n')}`,
        chunks,
      );
    }
  }
  return null;
}

function weakAreaAnswer(
  ctx: AnswerContext,
  targets: string[],
  periods: string[],
  accuracy: AccuracyFact[],
  weakAreas: WeakAreaFact[],
  latestPeriod: (facts: ApprovedFact[]) => string | undefined,
  onlyReported = false,
): AnswerDraft {
  const lines: string[] = [];
  const used: ApprovedFact[] = [];
  const missing: string[] = [];
  for (const target of targets) {
    const name = studentLabel(ctx.access, target);
    const ownWeak = weakAreas.filter((fact) => fact.subjectId === target);
    const single =
      periods.length > 0
        ? periods[periods.length - 1]
        : latestPeriod(
            ownWeak.length > 0
              ? ownWeak
              : accuracy.filter((fact) => fact.subjectId === target),
          );
    if (!single) {
      missing.push(`${name} 학생 분석 자료`);
      continue;
    }
    // 두 기간을 함께 물으면(“그거 9월이랑 같은 거야?”) 기간마다 취약 영역을 보여 준다.
    for (const period of periods.length >= 2 ? periods : [single]) {
      const reported = ownWeak.filter((fact) => fact.period === period);
      if (onlyReported && !reported.length) {
        missing.push(
          `${name} 학생 ${formatPeriod(period)} 리포트에 기록된 취약 영역`,
        );
        continue;
      }
      // 그 달 전체 정답률이 있으면 함께 보여 준다("성적이랑 약한 단원" 질문).
      const overall = accuracy.find(
        (fact) =>
          fact.subjectId === target &&
          fact.period === period &&
          dimensionOf(fact) === 'overall',
      );
      if (overall) {
        lines.push(line(ctx, overall));
        used.push(overall);
      }
      if (reported.length > 0) {
        // 3번 기능이 판정한 취약 영역을 그대로 전달하고, 해당 단원의 확정 수치를 함께 보여 준다.
        for (const weak of reported) {
          lines.push(
            `${name} 학생 ${formatPeriod(period)} 리포트의 취약 영역: ${weak.value.unit} — ${weak.value.text}`,
          );
          used.push(weak);
          const numbers = accuracy.find(
            (fact) =>
              fact.subjectId === target &&
              fact.period === period &&
              (ctx.engine !== 'planned' || fact.sourceId === weak.sourceId) &&
              fact.value.unit === weak.value.unit,
          );
          if (numbers) {
            lines.push(line(ctx, numbers));
            used.push(numbers);
          }
        }
        continue;
      }
      // 리포트에 취약 영역 판정이 없으면 확정 단원 정답률 중 가장 낮은 값을 관찰값으로만 안내한다.
      const units = accuracy.filter(
        (fact) =>
          fact.subjectId === target &&
          fact.period === period &&
          dimensionOf(fact) === 'unit',
      );
      if (units.length === 0) {
        missing.push(`${name} 학생 ${formatPeriod(period)} 분석 자료`);
        continue;
      }
      const sortedUnits = [...units].sort((a, b) => percent(a) - percent(b));
      lines.push(...sortFacts(units).map((fact) => line(ctx, fact)));
      if (sortedUnits.length >= 2) {
        const lowest = sortedUnits[0];
        lines.push(
          `확정 자료 중 정답률이 가장 낮은 단원은 ${lowest.value.unit}(${percent(lowest)}%)입니다. 숙제 결과 기준의 관찰값이며 원인을 뜻하지는 않습니다.`,
        );
      }
      used.push(...units);
    }
  }
  if (used.length === 0)
    return missingAbstain(
      describeRequest(ctx, targets, periods, ['취약 영역']),
    );
  if (missing.length > 0)
    lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  return draft(
    ctx,
    missing.length ? 'partial' : 'answered',
    lines,
    sortFacts(used),
    {
      missing,
      periods: [...new Set(used.map((fact) => fact.period ?? ''))],
      units: [],
      targets,
      weak: true,
    },
  );
}

function comparePeriodsFor(
  ctx: AnswerContext,
  target: string,
  periods: string[],
  labels: string[],
  allFacts: AccuracyFact[],
): AnswerDraft {
  const own = allFacts.filter((fact) => fact.subjectId === target);
  const name = studentLabel(ctx.access, target);
  if (periods.length < 2) {
    const used = sortFacts(
      seriesFacts(
        own.filter((fact) => periods.includes(fact.period ?? '')),
        labels,
        () => true,
      ),
    );
    if (used.length === 0)
      return missingAbstain(describeRequest(ctx, [target], periods, labels));
    return draft(
      ctx,
      'partial',
      [
        ...used.map((fact) => line(ctx, fact)),
        '비교할 다른 기간의 확정 자료가 없어 변화 여부는 판단할 수 없습니다.',
        ...notes(ctx, used),
      ],
      used,
      {
        missing: ['비교 기간 분석 자료'],
        periods,
        units: labels,
        targets: [target],
      },
    );
  }
  const inPeriods = own.filter((fact) => periods.includes(fact.period ?? ''));
  const observedPeriods = new Set(inPeriods.map(({ period }) => period));
  const comparisonPeriods =
    ctx.engine === 'planned' && observedPeriods.size === 1
      ? periods.filter((period) => observedPeriods.has(period))
      : periods;
  const coversAll = (facts: AccuracyFact[]) =>
    comparisonPeriods.every((period) =>
      facts.some((fact) => fact.period === period),
    );
  const series = seriesFacts(inPeriods, labels, coversAll);
  const byPeriod = periods.map((period) => ({
    period,
    facts: series.filter((fact) => fact.period === period),
  }));
  const available = byPeriod.filter((entry) => entry.facts.length > 0);
  if (available.length === 0)
    return missingAbstain(describeRequest(ctx, [target], periods, labels));

  if (available.length < byPeriod.length) {
    const used = sortFacts(available.flatMap((entry) => entry.facts));
    const missing = byPeriod
      .filter((entry) => entry.facts.length === 0)
      .map((entry) => `${formatPeriod(entry.period)} 분석 자료`);
    return draft(
      ctx,
      'partial',
      [
        ...used.map((fact) => line(ctx, fact)),
        `${missing.join(', ')}가 없어 기간 비교나 실력 변화 여부는 판단할 수 없습니다.`,
        ...notes(ctx, used),
      ],
      used,
      { missing, periods, units: labels, targets: [target] },
    );
  }

  const keyOf = (fact: AccuracyFact) =>
    `${subjectOf(ctx.catalog, fact.classId) ?? ''}|${dimensionOf(fact)}|${fact.value.unit}`;
  const keySets = byPeriod.map((entry) => new Set(entry.facts.map(keyOf)));
  const commonKeys = [...keySets[0]]
    .filter((key) => keySets.every((set) => set.has(key)))
    .sort();
  if (commonKeys.length === 0) {
    const used = sortFacts(byPeriod.flatMap((entry) => entry.facts));
    return draft(
      ctx,
      'partial',
      [
        ...used.map((fact) => line(ctx, fact)),
        '기간별로 같은 항목 자료가 없어 직접 비교할 수 없습니다.',
      ],
      used,
      {
        missing: ['동일 항목 비교 자료'],
        periods,
        units: labels,
        targets: [target],
      },
    );
  }

  const used: AccuracyFact[] = [];
  const derived: number[] = [];
  const lines: string[] = [];
  for (const key of commonKeys) {
    const points = byPeriod.map(
      (entry) =>
        entry.facts.find((fact) => keyOf(fact) === key) as AccuracyFact,
    );
    used.push(...points);
    const parts = points.map(
      (fact) =>
        `${formatPeriod(fact.period ?? '')} ${fact.value.total}문항 중 ${fact.value.correct}문항(${percent(fact)}%)`,
    );
    const diff = Math.round(
      exact(points[points.length - 1]) - exact(points[0]),
    );
    derived.push(Math.abs(diff));
    const direction =
      diff === 0
        ? '변화가 없습니다'
        : `${Math.abs(diff)}%p ${diff > 0 ? '높습니다' : '낮습니다'}`;
    const span = points.length > 2 ? '첫 기간보다' : '이전 기간보다';
    lines.push(
      `${name} 학생 ${subjectTag(ctx, points[0])}${labelOf(points[0])}: ${parts.join(' → ')}. ${span} 정답률이 ${direction}.`,
    );
  }
  lines.push(CAVEAT, ...notes(ctx, used));
  return draft(ctx, 'answered', lines, sortFacts(used), {
    derived,
    periods,
    units: labels,
    targets: [target],
  });
}

function compareStudents(
  ctx: AnswerContext,
  targets: string[],
  periods: string[],
  labels: string[],
  allFacts: AccuracyFact[],
): AnswerDraft {
  const period =
    periods[periods.length - 1] ??
    [...new Set(allFacts.map((fact) => fact.period ?? ''))]
      .sort(comparePeriods)
      .slice(-1)[0];
  if (!period)
    return missingAbstain(describeRequest(ctx, targets, periods, labels));
  const inPeriod = allFacts.filter((fact) => fact.period === period);
  const coversAll = (facts: AccuracyFact[]) =>
    targets.every((target) => facts.some((fact) => fact.subjectId === target));
  const series = seriesFacts(inPeriod, labels, coversAll);
  const keys = [
    ...new Set(
      series.map(
        (fact) =>
          `${subjectOf(ctx.catalog, fact.classId) ?? ''}|${dimensionOf(fact)}|${fact.value.unit}`,
      ),
    ),
  ].sort();
  const used: AccuracyFact[] = [];
  const lines: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const rows = targets.map((target) => ({
      target,
      fact: series.find(
        (fact) =>
          fact.subjectId === target &&
          `${subjectOf(ctx.catalog, fact.classId) ?? ''}|${dimensionOf(fact)}|${fact.value.unit}` ===
            key,
      ),
    }));
    for (const row of rows) {
      if (!row.fact)
        missing.push(
          `${studentLabel(ctx.access, row.target)} ${formatPeriod(period)} ${key.split('|')[2]}`,
        );
      else {
        used.push(row.fact);
        lines.push(line(ctx, row.fact));
      }
    }
    const present = rows
      .filter((row) => row.fact)
      .map((row) => row.fact as AccuracyFact);
    if (present.length === rows.length && present.length >= 2) {
      const percents = present.map(percent);
      const same = percents.every((value) => value === percents[0]);
      const names = present
        .map((fact) => studentLabel(ctx.access, fact.subjectId))
        .join(', ');
      lines.push(
        same
          ? `${names} 학생의 ${formatPeriod(period)} ${labelOf(present[0])} 정답률은 모두 ${percents[0]}%로 같습니다. 같은 값이라도 각 학생의 별도 확정 기록입니다.`
          : `${names} 학생의 ${formatPeriod(period)} ${labelOf(present[0])} 정답률은 서로 다릅니다.`,
      );
    }
  }
  if (used.length === 0)
    return missingAbstain(describeRequest(ctx, targets, [period], labels));
  const status = missing.length > 0 ? 'partial' : 'answered';
  if (status === 'partial')
    lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  lines.push(...notes(ctx, used));
  return draft(ctx, status, lines, sortFacts(used), {
    missing,
    periods: [period],
    units: labels,
    targets,
  });
}
