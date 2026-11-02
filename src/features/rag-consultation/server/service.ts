/**
 * RAG 상담 도메인 서비스(오케스트레이션).
 *
 * 순서: 입력 검증 → (서버가 확정한) 권한 컨텍스트 → 규칙 기반 질의 해석 → 보안 차단 →
 *       대상 학생 확정 → 정형 조회/검색(권한 필터 선적용) → 근거 충분성 → 템플릿(0회) 또는 생성(최대 1회)
 *       → 인용·숫자·대상 사후 검사 → 답변/보류/확인/거부/담당자 연결
 */
import type { RagAnswer, RagCitation } from '../contract.ts';
import { answerAdvice } from './answer/advice.ts';
import { answerAnalysis } from './answer/analysis.ts';
import {
  abstain,
  deny,
  studentLabel,
  type AnswerContext,
  type AnswerDraft,
} from './answer/context.ts';
import { answerInfo } from './answer/info.ts';
import {
  allowedNumbersFor,
  extractNumbers,
  findForbiddenIdentifiers,
  findForbiddenNames,
  findUnsupportedNumbers,
} from './answer/verify.ts';
import { DEFAULT_RAG_CONFIG, type RagConfig } from './config.ts';
import type {
  ApprovedFactsPort,
  CatalogPort,
  Clock,
  ConversationStatePort,
  GenerationPort,
  HandoffPort,
  RagDocumentsPort,
  RagLogger,
} from './ports.ts';
import { parseQuery, type QueryFrame } from './query/parse-query.ts';
import { resolveSubjects } from './query/resolve-subjects.ts';
import type { ConversationState, RagAccessScope, RagTrace } from './types.ts';

export interface RagConsultationDeps {
  facts: ApprovedFactsPort;
  documents: RagDocumentsPort;
  catalog: CatalogPort;
  generation: GenerationPort;
  handoff: HandoffPort;
  conversations: ConversationStatePort;
  clock: Clock;
  logger?: RagLogger;
  config?: Partial<RagConfig>;
  createRequestId?: () => string;
}

export interface RagQueryInput {
  /** 반드시 서버 세션에서 계산한 값 */
  access: RagAccessScope;
  question: string;
  studentIdHint?: string;
  conversationId?: string;
}

export interface RagQueryOutput {
  answer: RagAnswer;
  /** 내부 진단용(ID만 포함). 클라이언트 응답에 넣지 않는다. */
  trace: RagTrace;
}

export interface RagConsultationService {
  query(input: RagQueryInput): Promise<RagQueryOutput>;
}

const MAX_QUESTION_LENGTH = 500;

/**
 * "첫째 반 수강료", "도윤이 반 시간표"처럼 학생으로 반을 가리키면 서버가 아는 그 학생의 반을 쓴다.
 * 학생 본인의 "우리 반/내 반", 보호자의 "우리 애 반"도 같은 방식으로 해석한다.
 */
function studentClassIdsFor(
  access: RagAccessScope,
  frame: QueryFrame,
  hint: string | undefined,
): string[] {
  let studentIds = [...frame.matchedStudentIds];
  if (
    studentIds.length === 0 &&
    hint &&
    access.allowedStudentIds.includes(hint)
  )
    studentIds = [hint];
  const ownClassWords =
    /(우리|내|제)\s*반|(우리|내|제)\s*(아이|애|자녀|딸|아들)/.test(
      frame.normalized,
    );
  if (
    studentIds.length === 0 &&
    ownClassWords &&
    (access.role === 'student' || access.role === 'guardian')
  ) {
    studentIds = [...access.allowedStudentIds];
  }
  // 원생 본인 계정은 반을 말하지 않아도 자기 반 정보를 묻는 것으로 본다.
  if (studentIds.length === 0 && access.role === 'student')
    studentIds = [...access.allowedStudentIds];
  const classIds = access.studentRefs
    .filter((ref) => studentIds.includes(ref.studentId))
    .flatMap((ref) => ref.classIds ?? []);
  return [...new Set(classIds)];
}

export function createRagConsultationService(
  deps: RagConsultationDeps,
): RagConsultationService {
  const config: RagConfig = { ...DEFAULT_RAG_CONFIG, ...deps.config };
  const createRequestId =
    deps.createRequestId ?? (() => globalThis.crypto.randomUUID());

  async function route(
    ctx: AnswerContext,
    studentIdHint: string | undefined,
  ): Promise<AnswerDraft> {
    const { frame, access, state, trace } = ctx;
    const flags = frame.flags;

    // 1) 보안 차단(문서 존재 여부를 드러내지 않는 동일한 거부 응답)
    trace.domain = 'security';
    if (flags.crossTenant) return deny('CROSS_TENANT_REFERENCE');
    if (flags.bulkStudent) return deny('BULK_STUDENT_REQUEST');
    if (flags.shareOrPermission || flags.sessionChange)
      return deny('SHARE_OR_PERMISSION_CHANGE');
    if (
      frame.unauthorizedStudentRefs.length > 0 ||
      (studentIdHint !== undefined &&
        !access.allowedStudentIds.includes(studentIdHint))
    ) {
      return deny('ACCESS_DENIED');
    }
    if (flags.citationForgery) {
      trace.intent = 'citation_forgery';
      return abstain(
        '근거 자료 없이 답변하거나 질문에 적힌 출처를 근거로 사용할 수는 없습니다. 궁금하신 내용을 다시 질문해 주세요.',
        'UNSUPPORTED_REQUEST',
        undefined,
        ['CITATION_FORGERY'],
      );
    }
    if (flags.injectionDirective || flags.documentIdReference) {
      trace.internalErrors.push('PROMPT_INJECTION_DIRECTIVE');
    }

    // 2) 학습 분석 vs 학원 정보
    const hasInfoTopics = frame.topics.length > 0;
    const hasStudentReference =
      frame.matchedStudentIds.length > 0 ||
      frame.unresolvedRelationWords.length > 0 ||
      frame.groupReference ||
      frame.anaphora ||
      frame.selfReference ||
      studentIdHint !== undefined;
    // 주제어 없이 기간만 있는 질문("10월과 11월 비교해줘")은 학생 범위가 있는 계정에서 학습 분석으로 본다.
    const periodOnlyQuestion =
      !hasInfoTopics &&
      frame.classIds.length === 0 &&
      (frame.months.length > 0 || frame.relativePeriod !== null) &&
      (state?.selectedStudentId !== undefined ||
        access.allowedStudentIds.length > 0);
    const isAnalysis =
      frame.hasAnalysisTerms ||
      flags.generationRequest ||
      periodOnlyQuestion ||
      (hasStudentReference && !hasInfoTopics) ||
      (flags.elliptical &&
        state?.previousFrame?.domain === 'analysis' &&
        !hasInfoTopics);

    if (!isAnalysis) {
      trace.domain = 'info';
      return answerInfo(ctx);
    }

    trace.domain = 'analysis';
    const resolution = resolveSubjects({ access, frame, state, studentIdHint });
    if (resolution.kind === 'denied') return deny('ACCESS_DENIED');
    if (resolution.kind === 'clarify') {
      trace.intent = 'clarify_subject';
      const labels = resolution.optionStudentIds.map((id) =>
        studentLabel(access, id),
      );
      return {
        status: 'clarify',
        text: `어느 학생에 대한 질문인지 알려 주세요: ${labels.join(', ')}`,
        citations: [],
        usedFacts: [],
        reasonCode: 'AMBIGUOUS_SUBJECT',
        clarifyOptionStudentIds: resolution.optionStudentIds,
        conversationUpdate: {
          candidateStudentIds: resolution.optionStudentIds,
        },
      };
    }
    trace.targetStudentIds = resolution.studentIds;
    const blocksGeneration =
      flags.causal ||
      flags.attitude ||
      flags.prediction ||
      flags.misattribution;
    if (flags.generationRequest && !blocksGeneration) {
      return answerAdvice(ctx, resolution.studentIds);
    }
    return answerAnalysis(ctx, resolution.studentIds);
  }

  async function finalize(
    ctx: AnswerContext,
    draft: AnswerDraft,
  ): Promise<AnswerDraft & { resolvedCitations: RagCitation[] }> {
    if (draft.status !== 'answered' && draft.status !== 'partial') {
      return { ...draft, resolvedCitations: [] };
    }
    const failClosed = (
      error: 'CITATION_UNSUPPORTED' | 'NUMBER_UNSUPPORTED' | 'WRONG_ENTITY',
    ) => ({
      ...abstain(
        '확인된 근거와 답변을 대조하는 과정에서 문제가 있어 안내를 보류합니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
        'INSUFFICIENT_EVIDENCE',
        undefined,
        [error],
      ),
      resolvedCitations: [] as RagCitation[],
    });

    if (draft.citations.length === 0) return failClosed('CITATION_UNSUPPORTED');

    // 인용 재검증: 이 요청의 권한·승인·유효 버전으로 다시 조회되는 출처만 표시
    const merged = new Map<string, RagCitation & { locations: Set<string> }>();
    const quotedNumbers: number[] = [];
    for (const request of draft.citations) {
      const isFact = request.kind === 'fact';
      const studentId = isFact
        ? request.fact.subjectType === 'student'
          ? request.fact.subjectId
          : null
        : request.chunk.studentId;
      const summary = await ctx.documents.getCitableSource({
        access: ctx.access,
        studentIds: studentId ? [studentId] : [],
        sourceId: isFact ? request.fact.sourceId : request.chunk.sourceId,
        asOf: ctx.asOf,
        effectiveAt: isFact ? request.effectiveAt : undefined,
        includeHistory: isFact ? request.includeHistory : undefined,
        locate: isFact ? request.fact : undefined,
      });
      if (!summary) return failClosed('CITATION_UNSUPPORTED');
      if (!isFact) {
        quotedNumbers.push(
          ...extractNumbers(
            `${request.chunk.title} ${request.chunk.location.section ?? ''} ${request.chunk.location.label} ${request.chunk.text}`,
          ),
        );
      }
      const location = isFact ? summary.location : request.chunk.location.label;
      const existing = merged.get(summary.sourceId);
      if (existing) {
        if (location) existing.locations.add(location);
      } else {
        merged.set(summary.sourceId, {
          sourceId: summary.sourceId,
          documentId: summary.documentId,
          title: summary.title,
          revision: summary.revision,
          locations: new Set(location ? [location] : []),
        });
      }
    }

    const allowed = allowedNumbersFor({
      facts: draft.usedFacts,
      instants: draft.instants ?? [ctx.asOf],
      derived: [...(draft.derivedNumbers ?? []), ...quotedNumbers],
      questionNumbers: draft.generated ? [] : extractNumbers(ctx.question),
    });
    if (findUnsupportedNumbers(draft.text, allowed).length > 0)
      return failClosed('NUMBER_UNSUPPORTED');

    const allowedCodes = ctx.access.studentRefs
      .filter((ref) => ctx.trace.targetStudentIds.includes(ref.studentId))
      .flatMap((ref) => [...ref.aliases, ref.displayLabel])
      .map((alias) => alias.replace(/^ST_/i, ''));
    if (
      findForbiddenIdentifiers(draft.text, {
        studentCodePattern: ctx.config.studentCodePattern,
        allowedCodes,
      }).length > 0
    ) {
      return failClosed('WRONG_ENTITY');
    }
    if (
      findForbiddenNames(
        draft.text,
        ctx.catalog.studentDirectory ?? [],
        ctx.trace.targetStudentIds,
      ).length > 0
    ) {
      return failClosed('WRONG_ENTITY');
    }

    const resolvedCitations = [...merged.values()].map(
      ({ locations, ...citation }) => ({
        ...citation,
        location: locations.size > 0 ? [...locations].join(', ') : undefined,
      }),
    );
    return { ...draft, resolvedCitations };
  }

  return {
    async query(input) {
      const started = deps.clock.now();
      const requestId = createRequestId();
      const trace: RagTrace = {
        requestId,
        domain: 'none',
        intent: 'unknown',
        retrievedChunkIds: [],
        retrievedFactIds: [],
        usedFactIds: [],
        generationCalls: 0,
        generationInputFactIds: [],
        generationInputSourceIds: [],
        internalErrors: [],
        targetStudentIds: [],
      };

      let final: AnswerDraft & { resolvedCitations: RagCitation[] };
      let state: ConversationState | null = null;
      try {
        const question = input.question.trim();
        if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
          final = {
            ...abstain('질문을 다시 입력해 주세요.', 'UNSUPPORTED_REQUEST'),
            resolvedCitations: [],
          };
        } else {
          const catalog = await deps.catalog.getAcademyCatalog(
            input.access.academyId,
          );
          state = input.conversationId
            ? await deps.conversations.load(
                input.access.actorId,
                input.conversationId,
              )
            : null;
          if (!catalog) {
            final = {
              ...abstain(
                '지금은 학원 정보를 확인할 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
                'INSUFFICIENT_EVIDENCE',
              ),
              resolvedCitations: [],
            };
          } else {
            const frame = parseQuery(question, {
              access: input.access,
              catalog,
              config,
            });
            const ctx: AnswerContext = {
              access: input.access,
              catalog,
              frame,
              studentClassIds: studentClassIdsFor(
                input.access,
                frame,
                input.studentIdHint,
              ),
              question,
              asOf: started,
              state,
              config,
              facts: deps.facts,
              documents: deps.documents,
              generation: deps.generation,
              clock: deps.clock,
              trace,
            };
            final = await finalize(ctx, await route(ctx, input.studentIdHint));
          }
        }
      } catch {
        trace.internalErrors.push('UNEXPECTED_ERROR');
        final = {
          ...abstain(
            '일시적인 문제로 답변을 확인하지 못했습니다. 잠시 후 다시 시도하시거나 담당자 상담을 요청해 주세요.',
            'INSUFFICIENT_EVIDENCE',
          ),
          resolvedCitations: [],
        };
      }

      trace.reasonCode = final.reasonCode;
      trace.internalErrors.push(...(final.internalErrors ?? []));
      trace.usedFactIds =
        final.status === 'answered' || final.status === 'partial'
          ? final.usedFacts.map((fact) => fact.factId)
          : [];

      const answer: RagAnswer = {
        status: final.status,
        answer: final.text,
        citations: final.resolvedCitations,
        requestId,
      };
      if (final.missingFields?.length)
        answer.missingFields = final.missingFields;
      if (final.status === 'clarify' && final.clarifyOptionStudentIds) {
        answer.clarifyOptions = final.clarifyOptionStudentIds.map((id) =>
          studentLabel(input.access, id),
        );
      }
      if (final.status === 'abstained' || final.status === 'handoff') {
        answer.handoff = {
          needed: true,
          reasonCode: final.reasonCode ?? 'INSUFFICIENT_EVIDENCE',
        };
      }
      if (final.status === 'handoff') {
        try {
          await deps.handoff.createRequestOrDraft({
            requestId,
            academyId: input.access.academyId,
            actorId: input.access.actorId,
            reasonCode: final.reasonCode ?? 'INSUFFICIENT_EVIDENCE',
            studentIds: trace.targetStudentIds,
            question: input.question,
          });
        } catch {
          trace.internalErrors.push('HANDOFF_DRAFT_FAILED');
        }
      }

      if (
        input.conversationId &&
        final.conversationUpdate &&
        (final.status === 'answered' ||
          final.status === 'partial' ||
          final.status === 'clarify')
      ) {
        const next: ConversationState = { ...(state ?? {}) };
        for (const [key, value] of Object.entries(final.conversationUpdate)) {
          if (value !== undefined)
            (next as Record<string, unknown>)[key] = value;
        }
        await deps.conversations.save(
          input.access.actorId,
          input.conversationId,
          next,
        );
      }

      deps.logger?.log({
        event: 'rag.query',
        requestId,
        status: answer.status,
        reasonCode: final.reasonCode,
        intent: trace.intent,
        latencyMs: deps.clock.now() - started,
        sourceIds: answer.citations.map((citation) => citation.sourceId),
        generationCalls: trace.generationCalls,
        errorType: trace.internalErrors.join(',') || undefined,
      });

      return { answer, trace };
    },
  };
}
