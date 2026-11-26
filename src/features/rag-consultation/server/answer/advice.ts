/**
 * 학습 방향 상담(원생별 분석 파일 기반).
 * 1) 리포트에 강사가 확인한 학습 방향(learning_guidance)이 있으면 그대로 인용한다 → 생성 0회.
 * 2) 없으면 승인된 사실을 범위에 맞춰 가명 처리하고 최대 1회 생성한다. 과목·단원 조언은 진단 또는 지도 근거가 필요하다.
 *    공급자 미선정·전송 미승인 시 승인 리포트의 취약 영역으로 복습 제안을 구성한다.
 *    공급자 장애·검증 실패와 근거 부족은 담당자 연결.
 */
import { validateGeneratedOutput } from '../generation/validate-output.ts';
import { isAssistantDirective } from '../ingest/validation.ts';
import {
  compactText,
  isDataAbsenceStatement,
  splitSentences,
} from '../text/normalize.ts';
import type { GenerationInput } from '../ports.ts';
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
  handoff,
  markMultiSubjectStudents,
  matchesRequestedSubject,
  recordChunks,
  recordFacts,
  studentLabel,
  subjectOf,
  subjectTag,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { factText } from './format.ts';
import { extractNumbers } from './verify.ts';
import { readEvidenceRow } from './public-evidence.ts';

const HANDOFF_TEXT =
  '자세한 학습 상담은 지금 자동으로 안내해 드리기 어려워 담당자에게 연결해 드리겠습니다. 확정된 정답률 같은 수치는 바로 질문해 주시면 안내해 드릴 수 있습니다.';

function latestPeriodOf(facts: ApprovedFact[]): string | undefined {
  return [...new Set(facts.map((fact) => fact.period ?? '').filter(Boolean))]
    .sort(comparePeriods)
    .pop();
}

const REPORT_PERIOD_MENTION =
  /(?:\d{1,2}\s*월|지난\s*달|저번\s*달|전월|이번\s*달|이달|금월|다음\s*달|담달|내달)\s*(?:리포트|보고서|분석|기록)/;

function requestedAdvicePeriods(
  ctx: AnswerContext,
  studentId: string,
): string[] {
  const { frame, state, asOf } = ctx;
  const { year, month } = toKstDate(asOf);
  const datedMonths = [
    ...frame.normalized.matchAll(
      /(?<!\d)(\d{4})\s*년\s*(1[0-2]|0?[1-9])\s*월/g,
    ),
  ].filter((match) => frame.months.includes(Number(match[2])));
  const monthsWithYear = new Set(datedMonths.map((match) => Number(match[2])));
  const periods = [
    ...datedMonths.map((match) =>
      makePeriod(Number(match[1]), Number(match[2])),
    ),
    ...frame.months
      .filter((value) => !monthsWithYear.has(value))
      .map((value) => makePeriod(value > month + 1 ? year - 1 : year, value)),
  ];
  const relativeReport =
    /(?:이번\s*달|이달|금월|다음\s*달|담달|내달)\s*(?:리포트|보고서|분석|기록|기준)/.test(
      frame.normalized,
    );
  if (
    frame.relativePeriod === 'last_month' ||
    (frame.relativePeriod && relativeReport)
  ) {
    const offset =
      frame.relativePeriod === 'last_month'
        ? -1
        : frame.relativePeriod === 'next_month'
          ? 1
          : 0;
    periods.push(shiftPeriod(makePeriod(year, month), offset));
  }
  if (periods.length) return [...new Set(periods)].sort(comparePeriods);
  if (
    (frame.anaphora || frame.flags.elliptical) &&
    state?.selectedStudentId === studentId
  ) {
    if (state.previousFrame) {
      return state.previousFrame.domain === 'analysis'
        ? state.previousFrame.periods
        : [];
    }
    if (state.selectedPeriod) return [state.selectedPeriod];
  }
  return [];
}

function valueLine(fact: ApprovedFact): string {
  switch (fact.value.kind) {
    case 'accuracy': {
      const dimension = fact.value.dimension ?? 'unit';
      const label =
        dimension === 'overall'
          ? '전체'
          : dimension === 'question_type'
            ? `${fact.value.unit} 유형`
            : fact.value.unit;
      return `${label}: ${factText(fact)}`;
    }
    case 'weak_area':
      return `취약 영역 ${fact.value.unit}: ${fact.value.text}`;
    case 'text':
      return fact.value.text;
    default:
      return factText(fact);
  }
}

function matchesGuidanceMonth(fact: ApprovedFact, period: string) {
  const reportPeriod = fact.period;
  if (fact.value.kind !== 'text' || !reportPeriod) return false;
  return [
    ...fact.value.text.matchAll(
      /(?<!\d)(?:(\d{4})\s*년\s*)?(1[0-2]|0?[1-9])\s*월(?:\s*(?:에|엔|부터)|[ \t]+(?!(?:보다|이전|이후|말고|제외))[가-힣])/g,
    ),
  ].some(([, year, value]) => {
    const month = Number(value);
    if (year) return makePeriod(Number(year), month) === period;
    // A report can announce guidance for its own month or the following month.
    return (
      Number(period.split('-')[1]) === month &&
      (period === reportPeriod || period === shiftPeriod(reportPeriod, 1))
    );
  });
}

function recordedAdvice(
  selected: ApprovedFact[],
  target: string,
  period: string | undefined,
): AnswerDraft {
  return {
    status: 'answered',
    text: selected
      .map((fact) => '담당 강사가 확인한 학습 방향: ' + valueLine(fact))
      .join('\n'),
    citations: selected.map((fact) => ({ kind: 'fact', fact })),
    usedFacts: selected,
    conversationUpdate: { selectedStudentId: target, selectedPeriod: period },
  };
}

async function scopeAdviceFacts(
  ctx: AnswerContext,
  target: string,
  facts: ApprovedFact[],
) {
  const { subjects } = ctx.frame;
  if (ctx.engine !== 'planned' || !subjects.length)
    return facts.filter((fact) => matchesRequestedSubject(ctx, fact));
  const direct = facts.filter((fact) =>
    subjects.includes(subjectOf(ctx.catalog, fact.classId) ?? ''),
  );
  if (subjects.length !== 1 || direct.length === facts.length) return direct;
  const [subject] = subjects;
  const explicitlyLabeled = facts.filter(
    (fact) =>
      fact.factType === 'learning_guidance' &&
      fact.value.kind === 'text' &&
      !isAssistantDirective(fact.value.text) &&
      fact.value.text.includes(subject) &&
      !ctx.catalog.classes.some(
        ({ subject: label }) =>
          label &&
          label !== subject &&
          fact.value.kind === 'text' &&
          fact.value.text.includes(label),
      ),
  );
  const units = [
    ...new Set(
      facts.flatMap(({ value }) =>
        value.kind === 'weak_area' ||
        (value.kind === 'accuracy' && (value.dimension ?? 'unit') === 'unit')
          ? [value.unit]
          : [],
      ),
    ),
  ];
  if (!units.length) return [...new Set([...direct, ...explicitlyLabeled])];
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [target],
    asOf: ctx.asOf,
    documentTypes: ['student_analysis'],
    query: [subject, ...units, '단원 과목 정답'].join(' '),
    limit: 90,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const unitSubjects = new Map<string, Set<string>>();
  for (const { chunk } of hits) {
    if (
      chunk.studentId !== target ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      isAssistantDirective(chunk.text)
    )
      continue;
    const row = readEvidenceRow(chunk);
    if (!row) continue;
    const owner = row.cells[row.column(/^과목$/)];
    const unit = row.cells[row.column(/^(?:단원|단원명|영역)$/)];
    if (!owner || !unit) continue;
    const key = chunk.sourceId + '|' + compactText(unit);
    const values = unitSubjects.get(key) ?? new Set<string>();
    values.add(compactText(owner));
    unitSubjects.set(key, values);
  }
  const linked = facts.filter(({ value, sourceId, classId }) => {
    const owner = subjectOf(ctx.catalog, classId);
    if (
      owner &&
      !owner
        .split(/[·,/|]/)
        .some((part) => compactText(part) === compactText(subject))
    )
      return false;
    if (
      value.kind !== 'weak_area' &&
      (value.kind !== 'accuracy' || (value.dimension ?? 'unit') !== 'unit')
    )
      return false;
    const owners = unitSubjects.get(sourceId + '|' + compactText(value.unit));
    return owners?.size === 1 && owners.has(compactText(subject));
  });
  return [...new Set([...direct, ...explicitlyLabeled, ...linked])];
}

export function asksForRecordedLearningDirection(question: string): boolean {
  return (
    /(?:리포트|보고서).{0,32}학습\s*방향/.test(question) &&
    /있었|있어|적혀|적어\s*(?:둔|놓은)|기재|기록(?:된|되어)|없으면/.test(
      question,
    )
  );
}

async function answerRecordedAbsence(
  ctx: AnswerContext,
  target: string,
  reports: ApprovedFact[],
  period: string | undefined,
) {
  if (
    !asksForRecordedLearningDirection(ctx.frame.normalized) ||
    ctx.frame.months.length !== 1 ||
    ctx.frame.subjects.length
  )
    return;
  const month = ctx.frame.months[0];
  if (!period) return;
  const sources = new Set(
    reports
      .filter((fact) => fact.period === period)
      .map((fact) => fact.sourceId),
  );
  if (sources.size !== 1) return;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [target],
    asOf: ctx.asOf,
    documentTypes: ['student_analysis'],
    query: '강사 확인 학습 방향 리포트 없습니다 ' + month + '월',
    limit: 65,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const matches = hits.flatMap(({ chunk }) => {
    if (
      chunk.studentId !== target ||
      !sources.has(chunk.sourceId) ||
      chunk.location.kind !== 'paragraph' ||
      !/학습\s*방향/.test(chunk.location.section ?? '') ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      isAssistantDirective(chunk.text)
    )
      return [];
    return splitSentences(chunk.text)
      .filter((line) =>
        /학습\s*방향(?:은|이)?\s*(?:없습니다|미기재입니다|기재되지\s*않았습니다)[.!]?$/.test(
          line,
        ),
      )
      .map((line) => ({ chunk, line }));
  });
  if (
    !matches.length ||
    new Set(matches.map(({ line }) => compactText(line))).size !== 1
  )
    return;
  const [excerpt] = matches;
  return {
    status: 'answered' as const,
    text: excerpt.line,
    excerpts: [excerpt],
    citations: [{ kind: 'chunk' as const, chunk: excerpt.chunk }],
    usedFacts: [],
    conversationUpdate: { selectedStudentId: target, selectedPeriod: period },
  };
}

function usableDiagnosis(fact: ApprovedFact): boolean {
  const { value } = fact;
  return (
    value.kind === 'weak_area' &&
    Boolean(value.unit.trim() && value.text.trim()) &&
    !/^(?:없음|미정|미판정|해당없음)$/.test(compactText(value.unit)) &&
    !isDataAbsenceStatement(value.text) &&
    !isAssistantDirective(value.unit + ' ' + value.text)
  );
}

async function hasDiagnosisLocation(
  ctx: AnswerContext,
  target: string,
  fact: ApprovedFact,
) {
  const citation = await ctx.documents.getCitableSource({
    access: ctx.access,
    studentIds: [target],
    sourceId: fact.sourceId,
    asOf: ctx.asOf,
    locate: fact,
  });
  return Boolean(citation?.location);
}

/** Build a bounded review suggestion from a verified report diagnosis. */
async function reviewFromApprovedWeakAreas(
  ctx: AnswerContext,
  target: string,
  period: string,
  weakAreas: ApprovedFact[],
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    frame.subjects.length > 1 ||
    frame.explicitDates.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    (frame.flags.typeDimension && frame.questionTypes.length) ||
    /말고|빼고|제외|아닌/.test(frame.normalized)
  )
    return;

  const units = new Set(frame.units.map(compactText));
  const selected = new Map<string, ApprovedFact>();
  for (const fact of weakAreas) {
    const { value, classId } = fact;
    if (
      fact.approvalStatus !== 'approved' ||
      fact.academyId !== ctx.access.academyId ||
      fact.subjectType !== 'student' ||
      value.kind !== 'weak_area' ||
      !usableDiagnosis(fact) ||
      (frame.subjects.length && !subjectOf(ctx.catalog, classId)) ||
      (frame.classIds.length && (!classId || !frame.classIds.includes(classId)))
    )
      continue;
    const unit = compactText(value.unit);
    if (units.size && !units.has(unit)) continue;
    const existing = selected.get(unit);
    if (
      existing &&
      (existing.sourceId !== fact.sourceId ||
        valueLine(existing) !== valueLine(fact))
    )
      return;
    selected.set(unit, fact);
  }
  const facts = [...selected.values()];
  if (
    !facts.length ||
    new Set(facts.map(({ sourceId }) => sourceId)).size !== 1
  )
    return;
  if (units.size && [...units].some((unit) => !selected.has(unit))) return;

  for (const fact of facts) {
    if (!(await hasDiagnosisLocation(ctx, target, fact))) return;
  }
  const missing = [];
  if (
    /(?:선생님|강사)(?:의)?\s*(?:의견|조언|추천|지도\s*방향)/.test(
      frame.normalized,
    )
  )
    missing.push('담당 강사가 확인한 학습 방향');
  if (
    /(?:공부|학습|복습)\s*계획|루틴|몇\s*분|(?:문제집|교재)\s*추천/.test(
      frame.normalized,
    )
  )
    missing.push('구체적인 학습 계획');

  return {
    status: missing.length ? 'partial' : 'answered',
    text: [
      formatPeriod(period) + ' 승인 리포트에 기록된 취약 영역입니다.',
      ...facts.map((fact) => '· ' + subjectTag(ctx, fact) + valueLine(fact)),
      '복습 제안으로, 위에 기록된 단원에서 틀린 문제와 놓친 개념을 먼저 확인해 보세요.',
      ...(missing.length ? ['확인되지 않은 항목 ' + missing.join(', ')] : []),
    ].join('\n'),
    citations: facts.map((fact) => ({ kind: 'fact', fact })),
    usedFacts: facts,
    missingFields: missing.length ? missing : undefined,
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    conversationUpdate: { selectedStudentId: target, selectedPeriod: period },
  };
}

export async function answerAdvice(
  ctx: AnswerContext,
  targets: string[],
  options: { recordedOnly?: boolean } = {},
): Promise<AnswerDraft> {
  ctx.trace.intent = 'learning_advice';
  if (targets.length !== 1) {
    return {
      status: 'clarify',
      text: '어느 학생에 대한 상담인지 먼저 알려 주세요.',
      citations: [],
      usedFacts: [],
      reasonCode: 'AMBIGUOUS_SUBJECT',
      clarifyOptionStudentIds: targets,
    };
  }
  const [target] = targets;
  const loaded = (
    await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: targets,
      factTypes: ['accuracy', 'weak_area', 'learning_guidance'],
      asOf: ctx.asOf,
    })
  ).filter((fact) => fact.subjectId === target && fact.period);
  recordFacts(ctx.trace, loaded);
  markMultiSubjectStudents(ctx, loaded);
  const relevant = await scopeAdviceFacts(ctx, target, loaded);
  const approvedGuidance = relevant.filter(
    (fact) =>
      fact.factType === 'learning_guidance' &&
      fact.value.kind === 'text' &&
      !isAssistantDirective(fact.value.text),
  );
  const reportMonth = REPORT_PERIOD_MENTION.test(ctx.frame.normalized);
  const requestedPeriods = requestedAdvicePeriods(ctx, target);
  const exactGuidance = approvedGuidance.filter((fact) =>
    requestedPeriods.includes(fact.period ?? ''),
  );
  const actionMonth =
    !reportMonth &&
    ctx.frame.months.length > 0 &&
    (!exactGuidance.length ||
      /(?<!\d)\d{1,2}\s*월\s*(?:에|엔|부터)/.test(ctx.frame.normalized));
  const scopedGuidance = actionMonth
    ? approvedGuidance.filter((fact) =>
        requestedPeriods.some((period) => matchesGuidanceMonth(fact, period)),
      )
    : exactGuidance;

  if (options.recordedOnly) {
    const candidates = requestedPeriods.length
      ? scopedGuidance
      : approvedGuidance;
    const period = latestPeriodOf(candidates);
    const selected = candidates.filter((fact) => fact.period === period);
    if (!selected.length) {
      const absence =
        ctx.engine === 'planned'
          ? await answerRecordedAbsence(
              ctx,
              target,
              loaded,
              reportMonth && requestedPeriods.length === 1
                ? requestedPeriods[0]
                : undefined,
            )
          : undefined;
      if (absence) return absence;
      return abstain(
        '승인된 리포트에서 요청하신 학습 지도를 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
    }
    return recordedAdvice(selected, target, period);
  }
  if (requestedPeriods.length > 1) {
    return {
      status: 'clarify',
      text: '어느 기간의 학습 기록을 기준으로 상담할까요?',
      citations: [],
      usedFacts: [],
    };
  }
  const available = relevant.filter(
    (fact) => fact.factType === 'accuracy' || fact.factType === 'weak_area',
  );
  const [requested] = requestedPeriods;
  if (actionMonth) {
    const period = latestPeriodOf(scopedGuidance);
    if (period)
      return recordedAdvice(
        scopedGuidance.filter((fact) => fact.period === period),
        target,
        period,
      );
  }
  if (
    requested &&
    !available.some((fact) => fact.period === requested) &&
    !approvedGuidance.some((fact) => fact.period === requested)
  ) {
    return abstain(
      `${formatPeriod(requested)}에 해당하는 확정 학습 기록을 확인할 수 없습니다.`,
      'INSUFFICIENT_EVIDENCE',
      ['요청 기간의 학습 기록'],
    );
  }
  const period = requested ?? latestPeriodOf(available);
  if (!period) {
    if (
      ctx.engine === 'planned' &&
      loaded.some((fact) => fact.factType === 'accuracy') &&
      ctx.frame.subjects.length > 0
    )
      return handoff(HANDOFF_TEXT, 'INSUFFICIENT_EVIDENCE');
    return abstain(
      '상담에 사용할 확정된 학습 분석 자료가 없어 답변드리기 어렵습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['학습 분석 자료'],
    );
  }
  const inPeriod = relevant.filter((fact) => fact.period === period);
  const numbers = inPeriod.filter(
    (fact) =>
      fact.value.kind === 'accuracy' &&
      (fact.value.dimension ?? 'unit') !== 'question_type',
  );
  const weakAreas = inPeriod.filter((fact) => fact.factType === 'weak_area');
  const guidance = approvedGuidance.filter((fact) => fact.period === period);
  const name = studentLabel(ctx.access, target);

  // 1) 강사가 확인한 학습 방향이 있으면 인용(생성 0회)
  if (guidance.length > 0) {
    const weakUnits = new Set(
      weakAreas.map((fact) =>
        fact.value.kind === 'weak_area' ? fact.value.unit : '',
      ),
    );
    // 질문이 단원·유형을 지정하면 그 수치를, 아니면 전체와 취약 단원 수치를 함께 보여 준다.
    const labels = [...ctx.frame.units, ...ctx.frame.questionTypes];
    const preferType = ctx.frame.flags.typeDimension;
    const requested = inPeriod.filter(
      (fact) =>
        fact.value.kind === 'accuracy' &&
        labels.includes(fact.value.unit) &&
        (!preferType ||
          !ctx.frame.questionTypes.includes(fact.value.unit) ||
          (fact.value.dimension ?? 'unit') === 'question_type'),
    );
    const shownNumbers = [
      ...numbers.filter(
        (fact) =>
          fact.value.kind === 'accuracy' &&
          ((fact.value.dimension ?? 'unit') === 'overall' ||
            (labels.length === 0 && weakUnits.has(fact.value.unit))),
      ),
      ...requested,
    ];
    const used = [...guidance, ...weakAreas, ...shownNumbers];
    const lines = [
      `${name} 학생 ${formatPeriod(period)} 분석 리포트 기준입니다.`,
      ...shownNumbers.map(
        (fact) => `· ${subjectTag(ctx, fact)}${valueLine(fact)}`,
      ),
      ...weakAreas.map(
        (fact) => `· ${subjectTag(ctx, fact)}${valueLine(fact)}`,
      ),
      ...guidance.map(
        (fact) =>
          `담당 강사가 확인한 학습 방향: ${subjectTag(ctx, fact)}${valueLine(fact)}`,
      ),
    ];
    return {
      status: 'answered',
      text: lines.join('\n'),
      citations: used.map((fact) => ({ kind: 'fact' as const, fact })),
      usedFacts: used,
      instants: [ctx.asOf],
      conversationUpdate: { selectedStudentId: target, selectedPeriod: period },
    };
  }

  // 2) 생성에는 요청과 연결된 범위의 승인 기록만 전달한다.
  const scoped = ctx.engine === 'planned';
  const { subjects, negatedClassIds, classIds } = ctx.frame;
  const units = new Set(ctx.frame.units.map(compactText));
  const classes = classIds.length ? classIds : ctx.studentClassIds;
  const matchesClass = (id: string | null) =>
    !id ||
    (!negatedClassIds.includes(id) &&
      (!classes.length || classes.includes(id)));
  const matchingFacts = [...numbers, ...weakAreas].filter((fact) => {
    if (!scoped) return true;
    const { value, classId } = fact;
    if (!matchesClass(classId)) return false;
    if (value.kind !== 'weak_area' && value.kind !== 'accuracy') return false;
    if (value.kind === 'weak_area' && !usableDiagnosis(fact)) return false;
    return !units.size || units.has(compactText(value.unit));
  });
  if (!matchingFacts.length)
    return handoff(HANDOFF_TEXT, 'INSUFFICIENT_EVIDENCE');
  const now = ctx.clock.now();
  const availability = ctx.generation.availability(now);
  const transferBlocked =
    ctx.generation.isExternal && !ctx.generation.personalDataApproved;
  if (
    availability === 'disabled' ||
    (availability === 'available' && transferBlocked)
  ) {
    const review = await reviewFromApprovedWeakAreas(
      ctx,
      target,
      period,
      matchingFacts.filter(({ value }) => value.kind === 'weak_area'),
    );
    if (review) return review;
  }
  if (availability !== 'available') {
    return handoff(HANDOFF_TEXT, 'GENERATION_UNAVAILABLE', [
      'GENERATION_FAILED',
    ]);
  }
  if (transferBlocked) {
    return handoff(HANDOFF_TEXT, 'PERSONAL_DATA_TRANSFER_NOT_APPROVED');
  }

  const located = await Promise.all(
    matchingFacts.map(
      (fact) =>
        !scoped ||
        fact.value.kind !== 'weak_area' ||
        hasDiagnosisLocation(ctx, target, fact),
    ),
  );
  const evidence = matchingFacts.filter((_, index) => located[index]);
  if (!evidence.length) return handoff(HANDOFF_TEXT, 'INSUFFICIENT_EVIDENCE');

  const guidanceChunks = (
    await ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: targets,
      asOf: ctx.asOf,
      query: evidence
        .map((fact) =>
          fact.value.kind === 'accuracy' || fact.value.kind === 'weak_area'
            ? fact.value.unit
            : '',
        )
        .join(' '),
      limit: scoped ? 15 : 3,
      documentTypes: ['guidance'],
    })
  )
    .map((result) => result.chunk)
    .filter((chunk) => {
      if (
        chunk.suspicious ||
        chunk.extraction?.needsReview ||
        chunk.extraction?.uncertainTokens.length ||
        isAssistantDirective(chunk.text)
      )
        return false;
      if (!scoped) return true;
      if (
        !matchesClass(chunk.classId) ||
        (subjects.length &&
          !subjects.includes(subjectOf(ctx.catalog, chunk.classId) ?? ''))
      )
        return false;
      const content = compactText(
        [chunk.title, chunk.location.section, chunk.text].join(' '),
      );
      return !units.size || [...units].some((unit) => content.includes(unit));
    })
    .slice(0, 3);
  recordChunks(ctx.trace, guidanceChunks);
  const actionableSources =
    scoped && (subjects.length || units.size || classIds.length)
      ? new Set([
          ...evidence.filter(usableDiagnosis).map(({ sourceId }) => sourceId),
          ...guidanceChunks.map(({ sourceId }) => sourceId),
        ])
      : undefined;
  if (actionableSources?.size === 0)
    return handoff(HANDOFF_TEXT, 'INSUFFICIENT_EVIDENCE');

  // 외부 전송 시 실제 이름·ID 대신 가명 표기("학생")를 사용한다.
  const directoryNames = (ctx.catalog.studentDirectory ?? []).flatMap(
    (entry) => entry.names,
  );
  let question = ctx.question.replace(
    new RegExp(ctx.config.studentCodePattern.source, 'gi'),
    '학생',
  );
  for (const alias of [
    ...ctx.access.studentRefs.flatMap((ref) => [
      ref.displayLabel,
      ...ref.aliases,
    ]),
    ...directoryNames,
  ]) {
    if (/[가-힣]/.test(alias) && alias.length >= 2)
      question = question.split(alias).join('학생');
  }
  const input: GenerationInput = {
    requestId: ctx.trace.requestId,
    question,
    facts: evidence.map((fact) => ({
      factId: fact.factId,
      sourceId: fact.sourceId,
      subjectLabel: '학생',
      factType: fact.factType,
      period: fact.period,
      valueText: valueLine(fact),
    })),
    sources: guidanceChunks.map((chunk) => ({
      sourceId: chunk.sourceId,
      title: chunk.title,
      location: chunk.location.label,
      text: chunk.text,
    })),
    containsPersonalData: true,
  };
  ctx.trace.generationCalls += 1;
  ctx.trace.generationInputFactIds = input.facts.map((fact) => fact.factId);
  ctx.trace.generationInputSourceIds = [
    ...new Set([
      ...input.facts.map((fact) => fact.sourceId),
      ...input.sources.map((source) => source.sourceId),
    ]),
  ];

  const result = await ctx.generation.generateGroundedAnswer(input, {
    timeoutMs: ctx.config.generationTimeoutMs,
    now,
  });
  if (!result.ok)
    return handoff(HANDOFF_TEXT, 'GENERATION_UNAVAILABLE', [
      'GENERATION_FAILED',
    ]);

  const validation = validateGeneratedOutput(result.rawText, {
    allowedSourceIds: ctx.trace.generationInputSourceIds,
    allowedNumbers: (citedSourceIds) =>
      new Set(
        input.facts
          .filter(({ sourceId }) => citedSourceIds.includes(sourceId))
          .flatMap(({ period, valueText }) =>
            extractNumbers(`${period ?? ''} ${valueText}`),
          ),
      ),
    studentCodePattern: ctx.config.studentCodePattern,
    allowedStudentCodes: [],
  });
  if (!validation.ok) {
    const internal =
      validation.problem === 'CITATION_UNSUPPORTED'
        ? 'CITATION_UNSUPPORTED'
        : validation.problem === 'NUMBER_UNSUPPORTED'
          ? 'NUMBER_UNSUPPORTED'
          : validation.problem === 'FORBIDDEN_IDENTIFIER'
            ? 'WRONG_ENTITY'
            : 'GENERATION_FAILED';
    return handoff(HANDOFF_TEXT, 'GENERATION_REJECTED', [internal]);
  }

  const cited = new Set(validation.output.cited_source_ids);
  if (actionableSources && ![...cited].some((id) => actionableSources.has(id)))
    return handoff(HANDOFF_TEXT, 'GENERATION_REJECTED', [
      'CITATION_UNSUPPORTED',
    ]);
  const usedChunks = guidanceChunks.filter((chunk) =>
    cited.has(chunk.sourceId),
  );
  return {
    status: 'answered',
    text: [
      `${name} 학생의 확정된 학습 기록(${formatPeriod(period)}):`,
      ...evidence.map((fact) => `· ${valueLine(fact)}`),
      `참고 의견(자동 생성, 담당 강사 확인 전): ${validation.output.answer}`,
    ].join('\n'),
    citations: [
      ...evidence.map((fact) => ({ kind: 'fact' as const, fact })),
      ...usedChunks.map((chunk) => ({ kind: 'chunk' as const, chunk })),
    ],
    usedFacts: evidence,
    generated: true,
    instants: [ctx.asOf],
    conversationUpdate: { selectedStudentId: target, selectedPeriod: period },
  };
}
