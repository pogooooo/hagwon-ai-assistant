/**
 * 학습 방향 상담(원생별 분석 파일 기반).
 * 1) 리포트에 강사가 확인한 학습 방향(learning_guidance)이 있으면 그대로 인용한다 → 생성 0회.
 * 2) 없으면 확정 사실만 가명 처리해 생성 모델을 최대 1회 호출하고, 출력의 출처·숫자·대상·금지 표현을 검사한다.
 *    공급자 장애·미승인·검증 실패는 재시도 없이 담당자 연결.
 */
import { validateGeneratedOutput } from '../generation/validate-output.ts';
import type { GenerationInput } from '../ports.ts';
import { comparePeriods, formatPeriod } from '../text/time.ts';
import type { ApprovedFact } from '../types.ts';
import {
  abstain,
  handoff,
  markMultiSubjectStudents,
  matchesRequestedSubject,
  recordChunks,
  recordFacts,
  studentLabel,
  subjectTag,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { factText } from './format.ts';
import { allowedNumbersFor } from './verify.ts';

const HANDOFF_TEXT =
  '자세한 학습 상담은 지금 자동으로 안내해 드리기 어려워 담당자에게 연결해 드리겠습니다. 확정된 정답률 같은 수치는 바로 질문해 주시면 안내해 드릴 수 있습니다.';

function latestPeriodOf(facts: ApprovedFact[]): string | undefined {
  return [...new Set(facts.map((fact) => fact.period ?? '').filter(Boolean))]
    .sort(comparePeriods)
    .pop();
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

export async function answerAdvice(
  ctx: AnswerContext,
  targets: string[],
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
  const relevant = loaded.filter((fact) => matchesRequestedSubject(ctx, fact));

  // "10월 리포트"처럼 달을 말하면 그 달, 아니면 가장 최근 확정 기간
  const available = relevant.filter((fact) => fact.factType === 'accuracy');
  const askedPeriods = ctx.frame.months
    .map(
      (month) =>
        available.find((fact) => Number(fact.period?.split('-')[1]) === month)
          ?.period,
    )
    .filter((value): value is string => Boolean(value));
  const period =
    askedPeriods[askedPeriods.length - 1] ?? latestPeriodOf(available);
  if (!period) {
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
  const guidance = inPeriod.filter(
    (fact) => fact.factType === 'learning_guidance',
  );
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

  // 2) 승인된 학습 방향이 없으면 생성(최대 1회)
  const evidence = [...numbers, ...weakAreas];
  const now = ctx.clock.now();
  const availability = ctx.generation.availability(now);
  if (availability !== 'available') {
    return handoff(HANDOFF_TEXT, 'GENERATION_UNAVAILABLE', [
      'GENERATION_FAILED',
    ]);
  }
  if (ctx.generation.isExternal && !ctx.generation.personalDataApproved) {
    return handoff(HANDOFF_TEXT, 'PERSONAL_DATA_TRANSFER_NOT_APPROVED');
  }

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
      limit: 3,
      documentTypes: ['guidance'],
    })
  ).map((result) => result.chunk);
  recordChunks(ctx.trace, guidanceChunks);

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
    allowedNumbers: allowedNumbersFor({
      facts: evidence,
      instants: [ctx.asOf],
    }),
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
  const usedFacts = evidence.filter((fact) => cited.has(fact.sourceId));
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
      ...usedFacts.map((fact) => ({ kind: 'fact' as const, fact })),
      ...usedChunks.map((chunk) => ({ kind: 'chunk' as const, chunk })),
    ],
    usedFacts,
    generated: true,
    instants: [ctx.asOf],
    conversationUpdate: { selectedStudentId: target, selectedPeriod: period },
  };
}
