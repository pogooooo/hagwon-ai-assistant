/**
 * 원생 학습 분석 답변(정답률·문항 수·기간/단원/학생 비교).
 * - 점수·정답률은 3번 기능에서 확정된 사실만 사용하고 재계산·추정하지 않는다.
 * - 원인·태도·미래 예측은 관찰 자료로 판단할 수 없으므로 보류한다.
 * - 비교는 각 기간/학생의 근거가 모두 있을 때만 결론을 내고, 표본·난도 한계를 함께 안내한다.
 */
import {
  comparePeriods,
  formatPeriod,
  makePeriod,
  shiftPeriod,
  toKstDate,
} from '../text/time.ts';
import type { ApprovedFact } from '../types.ts';
import {
  abstain,
  recordFacts,
  studentLabel,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { accuracyPercent, formatAccuracy } from './format.ts';

type AccuracyFact = ApprovedFact & {
  value: { kind: 'accuracy'; correct: number; total: number; unit: string };
};

function isAccuracy(fact: ApprovedFact): fact is AccuracyFact {
  return fact.value.kind === 'accuracy' && fact.period !== null;
}

const CAVEAT =
  '과제 난도와 문항 구성이 기간마다 다를 수 있어 이 차이만으로 실력 변화를 단정할 수는 없습니다.';

function resolvePeriods(ctx: AnswerContext): string[] {
  const { frame, state, asOf } = ctx;
  const { year, month } = toKstDate(asOf);
  const explicit = frame.months.map((m) => makePeriod(year, m));
  if (frame.relativePeriod === 'last_month')
    explicit.push(shiftPeriod(makePeriod(year, month), -1));
  if (frame.relativePeriod === 'this_month')
    explicit.push(makePeriod(year, month));
  if (explicit.length > 0) return [...new Set(explicit)].sort(comparePeriods);
  if (frame.flags.elliptical || frame.anaphora) {
    if (frame.flags.elliptical && state?.previousFrame?.periods.length)
      return state.previousFrame.periods;
    if (state?.selectedPeriod) return [state.selectedPeriod];
  }
  return [];
}

function resolveUnits(ctx: AnswerContext): string[] {
  if (ctx.frame.units.length > 0) return ctx.frame.units;
  if (
    ctx.frame.flags.elliptical &&
    ctx.state?.previousFrame?.domain === 'analysis'
  ) {
    return ctx.state.previousFrame.units;
  }
  return [];
}

function line(ctx: AnswerContext, fact: AccuracyFact): string {
  const label = studentLabel(ctx.access, fact.subjectId);
  return `${label} 학생의 ${formatPeriod(fact.period ?? '')} ${fact.value.unit} 숙제 결과: ${formatAccuracy(fact.value)}.`;
}

function latestPerUnit(facts: AccuracyFact[]): AccuracyFact[] {
  const byKey = new Map<string, AccuracyFact>();
  for (const fact of facts) {
    const key = `${fact.subjectId}|${fact.value.unit}`;
    const existing = byKey.get(key);
    if (
      !existing ||
      comparePeriods(fact.period ?? '', existing.period ?? '') > 0
    )
      byKey.set(key, fact);
  }
  return [...byKey.values()];
}

function sortFacts(facts: AccuracyFact[]): AccuracyFact[] {
  return [...facts].sort(
    (a, b) =>
      a.subjectId.localeCompare(b.subjectId) ||
      comparePeriods(a.period ?? '', b.period ?? '') ||
      a.value.unit.localeCompare(b.value.unit),
  );
}

function notes(ctx: AnswerContext, facts: AccuracyFact[]): string[] {
  const result: string[] = [];
  for (const percent of ctx.frame.percents) {
    const matches = facts.some(
      (fact) =>
        accuracyPercent(fact.value.correct, fact.value.total) === percent,
    );
    if (!matches && facts.length > 0) {
      const latest = facts[facts.length - 1];
      result.push(
        `문의하신 ${percent}%는 현재 확정된 값과 다릅니다. 최신 확정값은 ${accuracyPercent(latest.value.correct, latest.value.total)}%입니다.`,
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
  used: AccuracyFact[],
  extras: {
    missing?: string[];
    derived?: number[];
    periods: string[];
    units: string[];
    targets: string[];
  },
): AnswerDraft {
  return {
    status,
    text: lines.join('\n'),
    citations: used.map((fact) => ({ kind: 'fact' as const, fact })),
    usedFacts: used,
    missingFields: status === 'partial' ? extras.missing : undefined,
    reasonCode: status === 'partial' ? 'PARTIAL_EVIDENCE' : undefined,
    derivedNumbers: extras.derived,
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
  const units = resolveUnits(ctx);
  const allFacts = (
    await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: targets,
      factTypes: ['accuracy'],
      asOf: ctx.asOf,
    })
  ).filter(isAccuracy);
  recordFacts(ctx.trace, allFacts);
  const facts = allFacts.filter(
    (fact) =>
      targets.includes(fact.subjectId) &&
      (units.length === 0 || units.includes(fact.value.unit)),
  );

  // 같은 학생·단원·기간에 동시에 유효한 승인 값이 서로 다르면 어느 쪽도 고르지 않는다.
  const groups = new Map<string, Set<string>>();
  for (const fact of facts) {
    const key = `${fact.subjectId}|${fact.value.unit}|${fact.period}`;
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

  const wantsComparison = frame.flags.compare || frame.flags.trend;
  if (wantsComparison && targets.length >= 2) {
    ctx.trace.intent = 'accuracy_compare_students';
    return compareStudents(ctx, targets, periods, units, facts);
  }
  if (wantsComparison && !(frame.flags.unitDimension && periods.length <= 1)) {
    ctx.trace.intent = 'accuracy_compare_periods';
    const comparePeriodsList =
      periods.length >= 2
        ? periods
        : periods.length === 1
          ? [shiftPeriod(periods[0], -1), periods[0]]
          : [...new Set(facts.map((fact) => fact.period ?? ''))]
              .sort(comparePeriods)
              .slice(-2);
    return comparePeriodsFor(ctx, targets[0], comparePeriodsList, units, facts);
  }

  ctx.trace.intent = 'accuracy_lookup';
  const selected =
    periods.length > 0
      ? facts.filter((fact) => periods.includes(fact.period ?? ''))
      : latestPerUnit(facts);
  const what = describeRequest(ctx, targets, periods, units);
  if (selected.length === 0) return missingAbstain(what);

  const sorted = sortFacts(selected);
  const lines = sorted.map((fact) => line(ctx, fact));
  const missing: string[] = [];
  for (const unit of units) {
    for (const target of targets) {
      if (
        !sorted.some(
          (fact) => fact.value.unit === unit && fact.subjectId === target,
        )
      ) {
        missing.push(`${studentLabel(ctx.access, target)} ${unit}`);
      }
    }
  }
  if (frame.flags.weakUnit && sorted.length >= 2 && targets.length === 1) {
    const lowest = [...sorted].sort(
      (a, b) =>
        a.value.correct / a.value.total - b.value.correct / b.value.total,
    )[0];
    lines.push(
      `확정 자료 중 정답률이 가장 낮은 단원은 ${lowest.value.unit}(${accuracyPercent(lowest.value.correct, lowest.value.total)}%)입니다. 숙제 결과 기준의 관찰값이며 원인을 뜻하지는 않습니다.`,
    );
  }
  if (frame.flags.unitDimension && wantsComparison && sorted.length >= 2) {
    const [a, b] = [...sorted].sort(
      (x, y) =>
        y.value.correct / y.value.total - x.value.correct / x.value.total,
    );
    const diff =
      Math.round(
        (accuracyPercent(a.value.correct, a.value.total) -
          accuracyPercent(b.value.correct, b.value.total)) *
          10,
      ) / 10;
    lines.push(
      diff === 0
        ? '두 단원의 정답률은 같습니다.'
        : `${a.value.unit} 정답률이 ${b.value.unit}보다 ${diff}%p 높습니다. 단원마다 문항 수와 난도가 달라 단순 비교에는 한계가 있습니다.`,
    );
    lines.push(...notes(ctx, sorted));
    return draft(ctx, missing.length ? 'partial' : 'answered', lines, sorted, {
      missing,
      derived: [diff],
      periods,
      units,
      targets,
    });
  }
  lines.push(...notes(ctx, sorted));
  return draft(ctx, missing.length ? 'partial' : 'answered', lines, sorted, {
    missing,
    periods: periods.length
      ? periods
      : [...new Set(sorted.map((fact) => fact.period ?? ''))],
    units,
    targets,
  });
}

function describeRequest(
  ctx: AnswerContext,
  targets: string[],
  periods: string[],
  units: string[],
): string {
  const who = targets.map((id) => studentLabel(ctx.access, id)).join(', ');
  const when = periods.map(formatPeriod).join(', ');
  return (
    [who && `${who} 학생`, when, units.join(', ')].filter(Boolean).join(' ') ||
    '요청하신 학습 결과'
  );
}

function comparePeriodsFor(
  ctx: AnswerContext,
  target: string,
  periods: string[],
  units: string[],
  facts: AccuracyFact[],
): AnswerDraft {
  const own = facts.filter((fact) => fact.subjectId === target);
  const byPeriod = periods.map((period) => ({
    period,
    facts: own.filter((fact) => fact.period === period),
  }));
  const available = byPeriod.filter((entry) => entry.facts.length > 0);
  const label = studentLabel(ctx.access, target);
  if (available.length === 0)
    return missingAbstain(describeRequest(ctx, [target], periods, units));

  if (available.length < byPeriod.length) {
    const used = sortFacts(available.flatMap((entry) => entry.facts));
    const missing = byPeriod
      .filter((entry) => entry.facts.length === 0)
      .map((entry) => `${formatPeriod(entry.period)} 분석 자료`);
    const lines = [
      ...used.map((fact) => line(ctx, fact)),
      `${missing.join(', ')}가 없어 기간 비교나 실력 변화 여부는 판단할 수 없습니다.`,
      ...notes(ctx, used),
    ];
    return draft(ctx, 'partial', lines, used, {
      missing,
      periods,
      units,
      targets: [target],
    });
  }

  const unitSets = byPeriod.map(
    (entry) => new Set(entry.facts.map((fact) => fact.value.unit)),
  );
  const commonUnits = [...unitSets[0]]
    .filter((unit) => unitSets.every((set) => set.has(unit)))
    .sort();
  if (commonUnits.length === 0) {
    const used = sortFacts(byPeriod.flatMap((entry) => entry.facts));
    return draft(
      ctx,
      'partial',
      [
        ...used.map((fact) => line(ctx, fact)),
        '기간별로 같은 단원 자료가 없어 직접 비교할 수 없습니다.',
      ],
      used,
      { missing: ['동일 단원 비교 자료'], periods, units, targets: [target] },
    );
  }

  const used: AccuracyFact[] = [];
  const derived: number[] = [];
  const lines: string[] = [];
  for (const unit of commonUnits) {
    const series = byPeriod.map(
      (entry) =>
        entry.facts.find((fact) => fact.value.unit === unit) as AccuracyFact,
    );
    used.push(...series);
    const parts = series.map(
      (fact) =>
        `${formatPeriod(fact.period ?? '')} ${fact.value.correct}/${fact.value.total}(${accuracyPercent(fact.value.correct, fact.value.total)}%)`,
    );
    const first = series[0];
    const last = series[series.length - 1];
    const diff =
      Math.round(
        (accuracyPercent(last.value.correct, last.value.total) -
          accuracyPercent(first.value.correct, first.value.total)) *
          10,
      ) / 10;
    derived.push(Math.abs(diff));
    const direction =
      diff === 0
        ? '변화가 없습니다'
        : `${Math.abs(diff)}%p ${diff > 0 ? '높습니다' : '낮습니다'}`;
    lines.push(
      `${label} 학생 ${unit}: ${parts.join(' → ')}. 이전 기간보다 정답률이 ${direction}.`,
    );
  }
  lines.push(CAVEAT, ...notes(ctx, used));
  return draft(ctx, 'answered', lines, sortFacts(used), {
    derived,
    periods,
    units: commonUnits,
    targets: [target],
  });
}

function compareStudents(
  ctx: AnswerContext,
  targets: string[],
  periods: string[],
  units: string[],
  facts: AccuracyFact[],
): AnswerDraft {
  const period =
    periods[periods.length - 1] ??
    [...new Set(facts.map((fact) => fact.period ?? ''))]
      .sort(comparePeriods)
      .slice(-1)[0];
  if (!period)
    return missingAbstain(describeRequest(ctx, targets, periods, units));
  const inPeriod = facts.filter((fact) => fact.period === period);
  const unitList =
    units.length > 0
      ? units
      : [...new Set(inPeriod.map((fact) => fact.value.unit))].sort();
  const used: AccuracyFact[] = [];
  const lines: string[] = [];
  const missing: string[] = [];
  for (const unit of unitList) {
    const rows = targets.map((target) => ({
      target,
      fact: inPeriod.find(
        (fact) => fact.subjectId === target && fact.value.unit === unit,
      ),
    }));
    for (const row of rows) {
      if (!row.fact)
        missing.push(
          `${studentLabel(ctx.access, row.target)} ${formatPeriod(period)} ${unit}`,
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
      const percents = present.map((fact) =>
        accuracyPercent(fact.value.correct, fact.value.total),
      );
      const same = percents.every((value) => value === percents[0]);
      const labels = present
        .map((fact) => studentLabel(ctx.access, fact.subjectId))
        .join(', ');
      lines.push(
        same
          ? `${labels} 학생의 ${formatPeriod(period)} ${unit} 정답률은 모두 ${percents[0]}%로 같습니다. 같은 값이라도 각 학생의 별도 확정 기록입니다.`
          : `${labels} 학생의 ${formatPeriod(period)} ${unit} 정답률은 서로 다릅니다.`,
      );
    }
  }
  if (used.length === 0)
    return missingAbstain(describeRequest(ctx, targets, [period], units));
  const status = missing.length > 0 ? 'partial' : 'answered';
  if (status === 'partial')
    lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  lines.push(...notes(ctx, used));
  return draft(ctx, status, lines, sortFacts(used), {
    missing,
    periods: [period],
    units: unitList,
    targets,
  });
}
