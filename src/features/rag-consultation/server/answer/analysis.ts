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
import type { AccuracyDimension, ApprovedFact } from '../types.ts';
import {
  abstain,
  markMultiSubjectStudents,
  matchesRequestedSubject,
  subjectOf,
  recordFacts,
  studentLabel,
  subjectTag,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { accuracyPercent, exactPercent } from './format.ts';

type AccuracyFact = ApprovedFact & {
  value: {
    kind: 'accuracy';
    correct: number;
    total: number;
    unit: string;
    dimension?: AccuracyDimension;
  };
};
type WeakAreaFact = ApprovedFact & {
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

function resolvePeriods(ctx: AnswerContext): string[] {
  const { frame, state, asOf } = ctx;
  const { year, month } = toKstDate(asOf);
  const explicit = frame.months.map((m) =>
    makePeriod(m > month + 1 ? year - 1 : year, m),
  );
  if (frame.relativePeriod === 'last_month')
    explicit.push(shiftPeriod(makePeriod(year, month), -1));
  if (frame.relativePeriod === 'this_month')
    explicit.push(makePeriod(year, month));
  // "9월보다 떨어졌어요?"처럼 비교 대상 한쪽만 말하면 직전 대화에서 본 기간과 비교한다.
  if (
    explicit.length === 1 &&
    (frame.flags.compare || frame.flags.trend) &&
    state?.selectedPeriod &&
    state.selectedPeriod !== explicit[0]
  )
    explicit.push(state.selectedPeriod);
  if (explicit.length > 0) return [...new Set(explicit)].sort(comparePeriods);
  if (frame.flags.elliptical || frame.anaphora) {
    if (frame.flags.elliptical && state?.previousFrame?.periods.length)
      return state.previousFrame.periods;
    if (state?.selectedPeriod) return [state.selectedPeriod];
  }
  return [];
}

function resolveLabels(ctx: AnswerContext): string[] {
  const requested = [...ctx.frame.units, ...ctx.frame.questionTypes];
  if (requested.length > 0) return requested;
  if (
    ctx.frame.flags.elliptical &&
    ctx.state?.previousFrame?.domain === 'analysis'
  ) {
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
    fact.revision > 1 ? ` (채점 수정 반영본 r${fact.revision})` : '';
  return `${name} 학생 ${formatPeriod(fact.period ?? '')} ${subjectTag(ctx, fact)}${labelOf(fact)}: ${fact.value.total}문항 중 ${fact.value.correct}문항 정답(정답률 ${percent(fact)}%)${revision}.`;
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
  },
): AnswerDraft {
  const assignmentCounts = [
    ...new Set(used.flatMap((fact) => fact.assignments.map((a) => a.title))),
  ].length;
  const periodNumbers = extras.periods.flatMap((period) =>
    period.split('-').map(Number),
  );
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
        extras.periods.length === 1 ? extras.periods[0] : undefined,
      previousFrame: {
        domain: 'analysis',
        units: extras.units,
        periods: extras.periods,
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

export async function answerAnalysis(
  ctx: AnswerContext,
  targets: string[],
): Promise<AnswerDraft> {
  const { frame } = ctx;
  if (frame.flags.causal || frame.flags.attitude) {
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

  const periods = resolvePeriods(ctx);
  const labels = resolveLabels(ctx);
  const loaded = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: targets,
    factTypes: ['accuracy', 'weak_area'],
    asOf: ctx.asOf,
  });
  recordFacts(ctx.trace, loaded);
  markMultiSubjectStudents(ctx, loaded);
  const allAccuracy = loaded
    .filter(isAccuracy)
    .filter((fact) => targets.includes(fact.subjectId))
    .filter((fact) => matchesRequestedSubject(ctx, fact));
  const weakAreas = loaded
    .filter(isWeakArea)
    .filter((fact) => targets.includes(fact.subjectId))
    .filter((fact) => matchesRequestedSubject(ctx, fact));

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

  const wantsComparison =
    frame.flags.compare || frame.flags.trend || frame.flags.cumulative;
  if (wantsComparison && targets.length >= 2) {
    ctx.trace.intent = 'accuracy_compare_students';
    return compareStudents(ctx, targets, periods, labels, allAccuracy);
  }
  const unitComparison =
    frame.flags.unitDimension && periods.length <= 1 && !frame.flags.cumulative;
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

  if (frame.flags.weakUnit && labels.length === 0) {
    ctx.trace.intent = 'weak_area';
    return weakAreaAnswer(
      ctx,
      targets,
      periods,
      candidates,
      weakAreas.filter(inScope),
      latestPeriod,
    );
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
  if (frame.flags.unitDimension && wantsComparison && unitFacts.length >= 2) {
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

function weakAreaAnswer(
  ctx: AnswerContext,
  targets: string[],
  periods: string[],
  accuracy: AccuracyFact[],
  weakAreas: WeakAreaFact[],
  latestPeriod: (facts: ApprovedFact[]) => string | undefined,
): AnswerDraft {
  const lines: string[] = [];
  const used: ApprovedFact[] = [];
  const missing: string[] = [];
  for (const target of targets) {
    const name = studentLabel(ctx.access, target);
    const ownWeak = weakAreas.filter((fact) => fact.subjectId === target);
    const period =
      periods.length > 0
        ? periods[periods.length - 1]
        : latestPeriod(
            ownWeak.length > 0
              ? ownWeak
              : accuracy.filter((fact) => fact.subjectId === target),
          );
    if (!period) {
      missing.push(`${name} 학생 분석 자료`);
      continue;
    }
    const reported = ownWeak.filter((fact) => fact.period === period);
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
  const coversAll = (facts: AccuracyFact[]) =>
    periods.every((period) => facts.some((fact) => fact.period === period));
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
