/**
 * 학습 방향·서술형 상담처럼 생성 모델이 필요한 질문(질문당 최대 1회 호출).
 * 생성 전: 대상 확정·확정 사실 확보·공급자 가용성·개인정보 전송 승인 여부를 코드로 검사한다.
 * 생성 후: 출처·숫자·대상·금지 표현을 검사하고, 실패하면 재시도 없이 담당자 연결.
 */
import { validateGeneratedOutput } from '../generation/validate-output.ts';
import type { GenerationInput } from '../ports.ts';
import { comparePeriods, formatPeriod } from '../text/time.ts';
import type { ApprovedFact } from '../types.ts';
import {
  abstain,
  handoff,
  recordChunks,
  recordFacts,
  studentLabel,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { factText } from './format.ts';
import { allowedNumbersFor } from './verify.ts';

const HANDOFF_TEXT =
  '자세한 학습 상담은 지금 자동으로 안내해 드리기 어려워 담당자에게 연결해 드리겠습니다. 확정된 정답률 같은 수치는 바로 질문해 주시면 안내해 드릴 수 있습니다.';

function latestFacts(facts: ApprovedFact[]): ApprovedFact[] {
  const byUnit = new Map<string, ApprovedFact>();
  for (const fact of facts) {
    if (fact.value.kind !== 'accuracy' || !fact.period) continue;
    const existing = byUnit.get(fact.value.unit);
    if (!existing || comparePeriods(fact.period, existing.period ?? '') > 0)
      byUnit.set(fact.value.unit, fact);
  }
  return [...byUnit.values()];
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
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: targets,
    factTypes: ['accuracy'],
    asOf: ctx.asOf,
  });
  recordFacts(ctx.trace, facts);
  const evidence = latestFacts(
    facts.filter((fact) => fact.subjectId === target),
  );
  if (evidence.length === 0) {
    return abstain(
      '상담에 사용할 확정된 학습 분석 자료가 없어 답변드리기 어렵습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['학습 분석 자료'],
    );
  }

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

  const guidance = (
    await ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: targets,
      asOf: ctx.asOf,
      query: evidence
        .map((fact) => (fact.value.kind === 'accuracy' ? fact.value.unit : ''))
        .join(' '),
      limit: 3,
      documentTypes: ['guidance'],
    })
  ).map((result) => result.chunk);
  recordChunks(ctx.trace, guidance);

  // 외부 전송 시 실제 이름·ID 대신 가명 표기("학생")를 사용한다.
  const input: GenerationInput = {
    requestId: ctx.trace.requestId,
    question: ctx.question.replace(
      new RegExp(ctx.config.studentCodePattern.source, 'gi'),
      '학생',
    ),
    facts: evidence.map((fact) => ({
      factId: fact.factId,
      sourceId: fact.sourceId,
      subjectLabel: '학생',
      factType: fact.factType,
      period: fact.period,
      valueText:
        fact.value.kind === 'accuracy'
          ? `${fact.value.unit} ${factText(fact)}`
          : factText(fact),
    })),
    sources: guidance.map((chunk) => ({
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

  const allowedNumbers = allowedNumbersFor({
    facts: evidence,
    instants: [ctx.asOf],
  });
  const validation = validateGeneratedOutput(result.rawText, {
    allowedSourceIds: ctx.trace.generationInputSourceIds,
    allowedNumbers,
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
  const usedChunks = guidance.filter((chunk) => cited.has(chunk.sourceId));
  const label = studentLabel(ctx.access, target);
  const factLines = evidence.map((fact) =>
    fact.value.kind === 'accuracy'
      ? `· ${formatPeriod(fact.period ?? '')} ${fact.value.unit}: ${factText(fact)}`
      : `· ${factText(fact)}`,
  );
  return {
    status: 'answered',
    text: [
      `${label} 학생의 확정된 학습 기록:`,
      ...factLines,
      validation.output.answer,
    ].join('\n'),
    citations: [
      ...usedFacts.map((fact) => ({ kind: 'fact' as const, fact })),
      ...usedChunks.map((chunk) => ({ kind: 'chunk' as const, chunk })),
    ],
    usedFacts,
    generated: true,
    instants: [ctx.asOf],
    conversationUpdate: { selectedStudentId: target },
  };
}
