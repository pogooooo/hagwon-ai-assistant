/**
 * RAG 상담 도메인 서비스(오케스트레이션).
 *
 * 순서: 입력 검증 → (서버가 확정한) 권한 컨텍스트 → 규칙 기반 질의 해석 → 보안 차단 →
 *       대상 학생 확정 → 정형 조회/검색(권한 필터 선적용) → 근거 충분성 → 템플릿(0회) 또는 생성(최대 1회)
 *       → 인용·숫자·대상 사후 검사 → 답변/보류/확인/거부/담당자 연결
 */
import type { RagAnswer, RagCitation } from '../contract.ts';
import { collectEvidence, validateEvidence } from './answer/evidence-bundle.ts';
import { answerWeeklyRefund } from './answer/refund-evidence.ts';
import { answerWeeklyCurriculum } from './answer/curriculum-evidence.ts';
import { answerTeacherProfile } from './answer/teacher-profile.ts';
import { answerFromScheduleEvidence } from './answer/schedule-evidence.ts';
import { answerFromCostEvidence } from './answer/cost-evidence.ts';
import { composeRequests } from './answer/composer.ts';
import { isRosterRequest, planQuery, requiredCostSlots } from './query/plan.ts';
export { splitQuestion } from './query/plan.ts';
import { answerAdvice } from './answer/advice.ts';
import { answerAnalysis } from './answer/analysis.ts';
import {
  abstain,
  deny,
  studentLabel,
  type AnswerContext,
  type AnswerDraft,
} from './answer/context.ts';
import {
  answerFromDocuments,
  issuanceRequirement,
  documentTypesFor,
  expectedAnswerTypes,
  hasOnlyGenericTopics,
  keywordsOf,
  namedTeacher,
  planFromEvidence,
  TEACHER_WHO,
  retrieveEvidence,
  satisfiesAnswerTypes,
} from './answer/evidence.ts';
import { answerInfo, explicitClassIds } from './answer/info.ts';
import {
  allowedNumbersFor,
  extractNumbers,
  findForbiddenIdentifiers,
  findForbiddenNames,
  findUnsupportedNumbers,
  supportsExcerpt,
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
  engine?: 'legacy' | 'planned';
}

export type FrameRefinement = Pick<QueryFrame, 'classIds' | 'topics'>;

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
  // Server-side diagnostics only. Public request fields cannot override the parser.
  diagnostics?: {
    refineFrame?: (frame: Readonly<QueryFrame>) => FrameRefinement;
    observeLocations?: (citations: RagCitation[]) => void;
  },
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
    if (
      flags.bulkStudent ||
      (ctx.engine === 'planned' && isRosterRequest(frame))
    )
      return deny('BULK_STUDENT_REQUEST');
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

    // 등수·석차는 자기 자녀라도 학원이 제공하지 않는 정보다(성적 자료에 없음).
    if (flags.rankRequest) {
      trace.intent = 'rank_request';
      return abstain(
        '등수나 순위는 학원 자료로 안내해 드리지 않습니다. 정답률·단원별 결과 같은 학습 리포트 내용은 확인해 드릴 수 있습니다.',
        'UNSUPPORTED_REQUEST',
        ['등수·순위'],
      );
    }
    // 원생 권한이 없는 계정이 반 평균 같은 성적 통계를 물으면 공개 자료가 아니므로 보류한다.
    if (
      access.allowedStudentIds.length === 0 &&
      /평균\s*(점수|성적|정답률)?|전체\s*(점수|성적|정답률)|반\s*(성적|점수|정답률)/.test(
        frame.normalized,
      ) &&
      /점수|성적|정답률|평균/.test(frame.normalized) &&
      !/수강료|교재비|비용|요금|금액/.test(frame.normalized)
    ) {
      trace.intent = 'aggregate_stats';
      return abstain(
        '반 평균 같은 성적 통계는 공개 자료로 안내해 드리지 않습니다. 수업 일정·수강료 등 학원 안내는 확인해 드릴 수 있습니다.',
        'INSUFFICIENT_EVIDENCE',
        ['성적 통계'],
      );
    }

    const predictsOutcome =
      flags.prediction ||
      /\d+(?:\.\d+)?\s*점.{0,10}(?:넘|받|나오|되)겠/.test(frame.normalized) ||
      /(?:붙|합격|갈|들어갈|오를|받)\S{0,2}\s*수\s*있을\s*거\s*같/.test(
        frame.normalized,
      ); // An individual learning-risk question remains in the analysis domain
    // even when "class time" or "teacher" also matches an info topic.
    if (
      ctx.engine === 'planned' &&
      (frame.matchedStudentIds.length > 0 ||
        frame.selfReference ||
        frame.unresolvedRelationWords.length > 0 ||
        studentIdHint !== undefined) &&
      (flags.attitude ||
        predictsOutcome ||
        (flags.causal && frame.hasAnalysisTerms))
    ) {
      if (predictsOutcome && !flags.prediction)
        ctx.frame = { ...frame, flags: { ...flags, prediction: true } };
      return routeAnalysis(ctx, studentIdHint);
    }
    // 2) 학습 분석 vs 학원 정보
    // "선생님이 어떻게 지도해 주신대요?"처럼 원생을 가리키며 강사의 지도·연습을 묻는 말은 강사 정보가 아니라 학습 방향 질문이다.
    const recordedGuidance =
      ctx.engine === 'planned' &&
      (frame.matchedStudentIds.length > 0 ||
        frame.selfReference ||
        frame.unresolvedRelationWords.length > 0 ||
        (frame.flags.elliptical &&
          state?.previousFrame?.domain === 'analysis') ||
        (frame.hasAnalysisTerms && access.allowedStudentIds.length > 0)) &&
      /(?:지도|중점).{0,24}(?:신대|준대|해준|한다고)|(?:뭐|뭘|무엇)\s*(?:더\s*)?하라고/.test(
        frame.normalized,
      );
    if (recordedGuidance) {
      return routeAnalysis(ctx, studentIdHint, { recordedGuidance: true });
    }
    const teacherGuidance =
      frame.topics.length > 0 &&
      frame.topics.every((topic) => topic.id === 'teacher') &&
      (frame.matchedStudentIds.length > 0 ||
        frame.selfReference ||
        frame.unresolvedRelationWords.length > 0) &&
      /지도|연습|시키|하라고|하래|봐\s*주|챙겨|도와/.test(frame.normalized) &&
      !/누구|누가|담당|이름|성함|바뀌|교체|어떤\s*분/.test(frame.normalized);
    if (teacherGuidance) {
      ctx.frame = { ...frame, topics: [] };
      return routeAnalysis(ctx, studentIdHint, { forceAdvice: true });
    }
    carryOverFollowUp(ctx);
    const hasInfoTopics = ctx.frame.topics.length > 0;
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
    // 원생 권한이 없는 계정(비회원)이 학생을 가리키지 않고 "리포트·성적"을 물으면 학원 서비스 안내 질문으로 본다.
    // 단, 정답률·점수 같은 결과 값을 달라는 요청은 분석 경로로 보내 권한 판정(거부)을 받게 한다.
    const asksResultValues =
      /정답률|점수|성적|몇\s*(문제|개|점|문항)|맞았|맞혔|틀렸|틀린|등수|결과\s*(알려|좀)/.test(
        frame.normalized,
      ) &&
      !/보내\s*주|받을\s*수|받아\s*볼|주나요|주시나요|와요|오나요|나오나요|방식|어떻게\s*(받|확인|보)/.test(
        frame.normalized,
      );
    const canHaveAnalysis =
      access.allowedStudentIds.length > 0 ||
      hasStudentReference ||
      asksResultValues;
    const teacherIdentity =
      hasInfoTopics &&
      ctx.frame.topics.every((topic) => topic.id === 'teacher') &&
      /누구|누군지|누가|이름|성함/.test(frame.normalized) &&
      !asksResultValues;
    const isAnalysis =
      canHaveAnalysis &&
      !teacherIdentity &&
      (frame.hasAnalysisTerms ||
        flags.generationRequest ||
        periodOnlyQuestion ||
        (hasStudentReference && !hasInfoTopics) ||
        (flags.elliptical &&
          state?.previousFrame?.domain === 'analysis' &&
          !hasInfoTopics));

    if (!isAnalysis) {
      trace.domain = 'info';
      return routeInfo(ctx, studentIdHint);
    }

    // 학습 분석을 "애매한 단서"로만 정한 경우(분석 용어·학생 지칭·기간 없이 '보충·방향' 같은 말이나 '제/내'만 있음):
    // 원문으로 근거를 찾아 그 근거가 원생 리포트가 아니면 학원 정보로 답한다(계층적 라우팅).
    const weakAnalysis =
      !frame.hasAnalysisTerms &&
      !periodOnlyQuestion &&
      frame.matchedStudentIds.length === 0 &&
      frame.unresolvedRelationWords.length === 0 &&
      !frame.groupReference &&
      !frame.anaphora &&
      studentIdHint === undefined &&
      !(flags.elliptical && state?.previousFrame?.domain === 'analysis');
    if (weakAnalysis) {
      const evidence = await retrieveEvidence(ctx);
      const plan = planFromEvidence(ctx, evidence);
      if (plan.kind === 'facts' || plan.kind === 'document') {
        trace.domain = 'info';
        trace.intent = 'weak_analysis>info';
        return answerByPlan(ctx, evidence, plan, studentIdHint);
      }
    }
    return routeAnalysis(ctx, studentIdHint);
  }

  /**
   * 후속 질문(“그럼 B반은요?”·“둘째도 시간 바뀌어요?”): 직전 학원 정보 질문의 주제와 반을 이어 쓴다.
   * - 주제: 이번 질문에 주제·분석 용어가 없고, 새로 나온 내용어가 거의 없을 때만(새 내용이 있으면 근거 검색에 맡김)
   * - 반: 이번 질문이 반·학생을 따로 말하지 않았을 때
   */
  function carryOverFollowUp(ctx: AnswerContext) {
    const previous = ctx.state?.previousFrame;
    const frame = ctx.frame;
    if (previous?.domain === 'analysis') {
      // 직전이 취약 영역 답이고 "그거/같은 거야?"처럼 이어 묻으면 취약 영역을 기간 비교로 다시 본다.
      if (
        previous.weak &&
        frame.topics.length === 0 &&
        (frame.flags.elliptical || frame.anaphora) &&
        !frame.flags.weakUnit
      ) {
        const compare = /같|똑같|달라|다른|다르|비교|바뀌|변했/.test(
          frame.normalized,
        );
        ctx.frame = {
          ...frame,
          flags: {
            ...frame.flags,
            weakUnit: true,
            compare: frame.flags.compare || compare,
          },
        };
      }
      return;
    }
    if (previous?.domain !== 'info') return;
    const followUp =
      frame.flags.elliptical ||
      /(은|는)요\s*\??$|도요|그럼|그러면|그건|그거|거기/.test(
        frame.normalized,
      ) ||
      /[가-힣]도\s/.test(frame.normalized) ||
      keywordsOf(ctx.question).length <= 2;
    if (!followUp) return;
    const entityWords = [
      ...ctx.access.studentRefs.flatMap((ref) => [
        ref.displayLabel,
        ...ref.aliases,
      ]),
      ...ctx.catalog.classes.flatMap((klass) => [klass.name, ...klass.aliases]),
    ].map((word) => word.replace(/\s/g, ''));
    const previousWords = keywordsOf(previous.question ?? '');
    // 바뀌다·같다처럼 변화·비교를 묻는 동사는 새 주제가 아니다.
    const fresh = keywordsOf(ctx.question).filter(
      (word) =>
        !/^(바뀌|바꾸|바뀐|변경|달라|다르|다른|같|똑같|변했)/.test(word) &&
        !previousWords.some((p) => p.startsWith(word.slice(0, 2))) &&
        !entityWords.some(
          (entity) => entity.includes(word) || word.includes(entity),
        ),
    );
    let next = frame;
    if (
      frame.topics.length === 0 &&
      !frame.hasAnalysisTerms &&
      previous.topicIds?.length &&
      fresh.length === 0
    ) {
      next = {
        ...next,
        topics: ctx.config.topics.filter((topic) =>
          previous.topicIds?.includes(topic.id),
        ),
      };
    }
    const mentionsTarget =
      frame.classIds.length > 0 ||
      frame.matchedStudentIds.length > 0 ||
      frame.unresolvedRelationWords.length > 0 ||
      frame.groupReference;
    if (
      !mentionsTarget &&
      previous.classIds?.length &&
      ctx.studentClassIds.length === 0
    ) {
      next = { ...next, classIds: previous.classIds };
    }
    if (next !== frame) ctx.frame = next;
  }

  async function routeAnalysis(
    ctx: AnswerContext,
    studentIdHint: string | undefined,
    options: { forceAdvice?: boolean; recordedGuidance?: boolean } = {},
  ): Promise<AnswerDraft> {
    const { frame, access, state, trace } = ctx;
    const flags = frame.flags;
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
      /\d+(?:\.\d+)?\s*점.{0,10}(?:넘|받|나오|되)겠/.test(frame.normalized) ||
      flags.misattribution;
    if (options.recordedGuidance && !blocksGeneration)
      return answerAdvice(ctx, resolution.studentIds, { recordedOnly: true });
    if ((flags.generationRequest || options.forceAdvice) && !blocksGeneration) {
      return answerAdvice(ctx, resolution.studentIds);
    }
    return answerAnalysis(ctx, resolution.studentIds);
  }

  /** 검색 근거의 자리에 따라 답변 경로를 고른다(evidence.ts 의 planFromEvidence). */
  async function answerByPlan(
    ctx: AnswerContext,
    evidence: Awaited<ReturnType<typeof retrieveEvidence>>,
    plan: ReturnType<typeof planFromEvidence>,
    studentIdHint: string | undefined,
  ): Promise<AnswerDraft> {
    const types = expectedAnswerTypes(ctx.question);
    if (plan.kind === 'analysis') {
      return routeAnalysis(
        ctx,
        studentIdHint ??
          (plan.studentIds.length === 1 &&
          ctx.access.allowedStudentIds.length > 1
            ? undefined
            : undefined),
        {
          forceAdvice: plan.guidance,
        },
      );
    }
    if (plan.kind === 'facts') {
      // 대상 반: 질문·계정에서 정해진 반이 우선, 없으면 근거 행의 반
      const bound = explicitClassIds(ctx);
      const sub: AnswerContext = {
        ...ctx,
        frame: {
          ...ctx.frame,
          topics: plan.topics,
          classIds: bound.length > 0 ? ctx.frame.classIds : plan.classIds,
        },
      };
      ctx.trace.intent = `evidence>${plan.topics.map((t) => t.id).join('+')}`;
      const draft = await answerInfo(sub);
      if (
        (draft.status === 'answered' || draft.status === 'partial') &&
        satisfiesAnswerTypes(draft.text, types)
      )
        return draft;
    }
    if (plan.kind === 'none') {
      return {
        status: 'abstained',
        text: '질문하신 내용을 등록된 승인 자료에서 확인할 수 없어 답변드리기 어렵습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
        citations: [],
        usedFacts: [],
        reasonCode: 'INSUFFICIENT_EVIDENCE',
        internalErrors: ['INSUFFICIENT_EVIDENCE'],
      };
    }
    return answerFromDocuments(ctx, evidence);
  }

  /**
   * 학원 정보 경로(계층적 라우팅)
   * 1) 규칙이 뚜렷한 주제를 찾았으면 정형 조회·절 인용으로 답하고, 의문사가 요구하는 값이 없거나 자료 없음이면 2)로
   * 2) 주제가 없거나 일반어(얼마·언제)로만 잡혔으면 원문 검색 근거로 경로를 정한다.
   */
  const CLASS_FACT_TOPICS = [
    'fee',
    'material',
    'schedule',
    'teacher',
    'enrollment',
  ];

  async function routeInfo(
    ctx: AnswerContext,
    studentIdHint: string | undefined,
  ): Promise<AnswerDraft> {
    const { frame, access } = ctx;
    if (frame.unknownPrograms.length > 0) return answerInfo(ctx);
    // 자녀가 둘 이상인 보호자가 "우리 애"처럼 한 명을 가리키며 반마다 다른 정보를 물으면 누구인지 먼저 확인한다.
    const singleChild =
      /(우리|저희|제|내)\s*(아이|애|자녀|딸|아들)(?!들)|(^|\s)(애|아이)(가|는|이|도|의)?\s/.test(
        frame.normalized,
      ) && !frame.groupReference;
    const classSpecific =
      frame.topics.some((topic) =>
        [
          'fee',
          'material',
          'schedule',
          'teacher',
          'enrollment',
          'schedule_change',
        ].includes(topic.id),
      ) ||
      (frame.topics.length === 0 &&
        expectedAnswerTypes(ctx.question).length > 0);
    const childClasses = access.studentRefs
      .filter((ref) => access.allowedStudentIds.includes(ref.studentId))
      .map((ref) => (ref.classIds ?? []).slice().sort().join(','));
    if (
      access.role === 'guardian' &&
      access.allowedStudentIds.length >= 2 &&
      new Set(childClasses).size >= 2 &&
      singleChild &&
      classSpecific &&
      frame.matchedStudentIds.length === 0 &&
      frame.unresolvedRelationWords.length === 0 &&
      frame.classIds.length === 0 &&
      studentIdHint === undefined &&
      !ctx.state?.selectedStudentId
    ) {
      ctx.trace.intent = 'clarify_child';
      return {
        status: 'clarify',
        text: `어느 자녀에 대한 질문인지 알려 주세요: ${access.allowedStudentIds.map((id) => studentLabel(access, id)).join(', ')}`,
        citations: [],
        usedFacts: [],
        reasonCode: 'AMBIGUOUS_SUBJECT',
        clarifyOptionStudentIds: [...access.allowedStudentIds],
        conversationUpdate: {
          candidateStudentIds: [...access.allowedStudentIds],
        },
      };
    }
    if (
      ctx.engine === 'planned' &&
      frame.topics.some(({ id }) => id === 'enrollment') &&
      /대기|대기자|대기열/.test(frame.normalized) &&
      /(?:\d{1,2}\s*월|다음\s*달|언제쯤).{0,24}(?:들어갈|등록할|자리.{0,4}날)\s*수\s*있을|(?:\d{1,2}\s*월|다음\s*달|언제쯤).{0,16}자리.{0,6}날까요/.test(
        frame.normalized,
      )
    ) {
      return abstain(
        '대기 현황만으로 특정 시점에 입학할 수 있는지는 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
    }
    const season = /(?:여름|겨울)\s*방학/.exec(frame.normalized)?.[0];
    if (
      ctx.engine === 'planned' &&
      season &&
      frame.topics.some(({ id }) => id === 'shuttle') &&
      /운행\s*시간표|몇\s*시|언제\s*오/.test(frame.normalized)
    ) {
      const evidence = await retrieveEvidence(ctx, {
        documentTypes: ['schedule', 'academy_info', 'announcement'],
        searchTerms: [season, '차량 운행 정류장'],
        limit: 30,
      });
      const seasonal = evidence.filter(({ chunk }) => {
        const title = (
          chunk.title +
          ' ' +
          (chunk.location.section ?? '')
        ).replace(/\s+/g, '');
        return (
          title.includes(season.replace(/\s+/g, '')) &&
          /차량|셔틀|통학/.test(title)
        );
      });
      return answerFromDocuments(ctx, seasonal, (line) =>
        /\d{1,2}:\d{2}|\d{1,2}\s*시\s*\d{1,2}\s*분/.test(line),
      );
    }
    if (ctx.engine === 'planned') {
      if (frame.unboundProgram && classSpecific)
        return abstain(
          '문의하신 과정의 승인 자료를 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        );
      const cost = await answerFromCostEvidence(ctx);
      if (cost) return cost;
      const refund = await answerWeeklyRefund(ctx);
      if (refund) return refund;
      const curriculum = await answerWeeklyCurriculum(ctx);
      if (curriculum) return curriculum;
      const teacherProfile = await answerTeacherProfile(ctx);
      if (teacherProfile) return teacherProfile;
      const schedule = await answerFromScheduleEvidence(ctx);
      if (schedule) return schedule;
      // A monthly price request may precede an explicit textbook question.
      // Keep both topics when the legacy structured facts are the only source.
      if (
        frame.topics.length === 1 &&
        frame.topics[0].id === 'material' &&
        requiredCostSlots(frame).includes('fee')
      ) {
        const fee = ctx.config.topics.find(({ id }) => id === 'fee');
        if (fee)
          return answerInfo({
            ...ctx,
            frame: { ...frame, topics: [fee, ...frame.topics] },
          });
      }
    }
    const asksMinutes =
      /몇\s*분/.test(frame.normalized) &&
      /수업|한\s*번|1회/.test(frame.normalized);
    const asksHours =
      /몇\s*시간/.test(frame.normalized) &&
      /수업|한\s*달|월/.test(frame.normalized);
    if (asksMinutes || asksHours) {
      const evidence = await retrieveEvidence(ctx, {
        documentTypes: ['fee', 'academy_info', 'schedule'],
        limit: 18,
        searchTerms: [
          '수업 시간',
          '수업 횟수',
          ...(asksHours ? ['월 수업 시간'] : []),
        ],
      });
      return answerFromDocuments(ctx, evidence, (line) => {
        const durations = line.replace(/\d{1,2}\s*시\s*\d{1,2}\s*분/g, '');
        return (
          (!asksMinutes || /(?:^|[^\d:])\d+\s*분(?!의)/.test(durations)) &&
          (!asksHours || /\d+\s*시간/.test(durations))
        );
      });
    }
    const issuance = issuanceRequirement(ctx.question);
    if (issuance)
      return answerFromDocuments(ctx, await retrieveEvidence(ctx), issuance);
    const types = expectedAnswerTypes(ctx.question);
    if (types.includes('deadline') && /시간표/.test(frame.normalized)) {
      const evidence = await retrieveEvidence(ctx, {
        documentTypes: ['schedule', 'announcement'],
        searchTerms: ['적용 기간', '정규 시간표', '종료'],
        limit: 20,
      });
      const deadline = await answerFromDocuments(ctx, evidence, (line) =>
        satisfiesAnswerTypes(line, ['deadline']),
      );
      if (deadline.status === 'answered') return deadline;
    }
    const noTopic = frame.topics.length === 0;
    const weak = noTopic || hasOnlyGenericTopics(ctx);
    // (시험 후 제외) 자료에 없는 낱말을 묻는 질문을 보류하는 규칙(unknownConcepts)은 형태소 분석 없이
    // 기능어·활용형·구어 동의어까지 잡아 잘못된 보류가 48%로 늘어 기본 경로에서 뺐다. REPORT.md 참고.
    // 강사를 이름으로 부른 경우: 개인 연락처는 안내하지 않고, "누구·담당" 외 개인 속성(나이·학력 등)은 문서 근거가 있을 때만
    const teacherName = namedTeacher(frame.normalized);
    if (teacherName && frame.topics.some((topic) => topic.id === 'contact')) {
      ctx.trace.intent = 'teacher_personal_contact';
      return {
        status: 'abstained',
        text: '강사 개인 연락처는 안내해 드리지 않습니다. 학원 대표 연락처로 문의해 주시면 전달해 드립니다.',
        citations: [],
        usedFacts: [],
        reasonCode: 'INSUFFICIENT_EVIDENCE',
        missingFields: ['강사 개인 연락처'],
        internalErrors: ['INSUFFICIENT_EVIDENCE'],
      };
    }
    if (
      teacherName &&
      frame.topics.length > 0 &&
      frame.topics.every((topic) => topic.id === 'teacher') &&
      !TEACHER_WHO.test(frame.normalized)
    ) {
      const evidence = await retrieveEvidence(ctx);
      return answerFromDocuments(ctx, evidence);
    }
    // "중2 심화반은요?"처럼 반 이름만 말한 질문은 반 요약(수강료·시간표·강사)
    const classNames = ctx.catalog.classes
      .filter((klass) => frame.classIds.includes(klass.classId))
      .flatMap((klass) => [klass.name, ...klass.aliases]);
    const leftover = keywordsOf(ctx.question).filter(
      (word) =>
        !classNames.some(
          (name) =>
            name.replace(/\s/g, '').includes(word) ||
            word.includes(name.replace(/\s/g, '')),
        ),
    );
    if (noTopic && frame.classIds.length > 0 && leftover.length === 0)
      return answerInfo(ctx);

    const tryEvidence = async (topicIds: string[] = []) => {
      const evidence = await retrieveEvidence(ctx, {
        documentTypes: documentTypesFor(topicIds),
        searchTerms:
          types.includes('deadline') && /시간표|일정/.test(frame.normalized)
            ? ['적용 기간', '정규 시간표', '종료']
            : undefined,
      });
      return answerByPlan(
        ctx,
        evidence,
        planFromEvidence(ctx, evidence),
        studentIdHint,
      );
    };
    // 일반어 주제라도 반이 정해져 있으면(“영재원반 한 달에 얼마?”) 그 반의 정형 값을 먼저 본다.
    if (weak && explicitClassIds(ctx).length > 0 && !noTopic) {
      const ruled = await answerInfo(ctx);
      if (
        (ruled.status === 'answered' || ruled.status === 'partial') &&
        satisfiesAnswerTypes(ruled.text, types)
      )
        return ruled;
    }
    if (weak) {
      const viaEvidence = await tryEvidence();
      // 반도 정하지 않고 의문사(얼마·몇 명·언제)로만 주제가 잡혔는데 믿을 만한 근거가 없으면
      // 전체 반 목록을 내지 않고 보류한다.
      const unboundGeneric =
        explicitClassIds(ctx).length === 0 &&
        frame.topics.every((topic) => CLASS_FACT_TOPICS.includes(topic.id));
      if (
        viaEvidence.status === 'answered' ||
        viaEvidence.status === 'partial' ||
        noTopic ||
        unboundGeneric
      )
        return viaEvidence;
      return answerInfo(ctx);
    }
    // 반을 정하지 않은 반별 정형 질문은 전체 반 목록을 그대로 내기 전에 가장 믿을 만한 근거의 자리를 먼저 본다.
    // 근거가 그 정형 사실 자리가 아니라 다른 문서 내용이면(“상 받은 학생 몇 명?” → 소식지) 그 문서로 답한다.
    const unbound =
      explicitClassIds(ctx).length === 0 &&
      frame.topics.every((topic) => CLASS_FACT_TOPICS.includes(topic.id)) &&
      ctx.catalog.classes.length > 3;
    if (unbound) {
      const evidence = await retrieveEvidence(ctx);
      const plan = planFromEvidence(ctx, evidence);
      if (
        plan.kind === 'document' ||
        (plan.kind === 'facts' &&
          !plan.topics.some((topic) =>
            frame.topics.some((asked) => asked.id === topic.id),
          ))
      ) {
        const viaEvidence = await answerByPlan(
          ctx,
          evidence,
          plan,
          studentIdHint,
        );
        if (
          viaEvidence.status === 'answered' ||
          viaEvidence.status === 'partial'
        )
          return viaEvidence;
      }
    }
    const draft = await answerInfo(ctx);
    // 속성 주제(와이파이·연락처 등)가 자료에 "없다"는 판정은 그대로 따른다(다른 문서로 대신 답하지 않음).
    if (frame.topics.some((topic) => topic.kind === 'attribute')) return draft;
    const gave = draft.status === 'answered' || draft.status === 'partial';
    const insufficient =
      (draft.status === 'abstained' &&
        draft.reasonCode === 'INSUFFICIENT_EVIDENCE') ||
      (gave && !satisfiesAnswerTypes(draft.text, types));
    if (!insufficient) return draft;
    const alternative = await tryEvidence(
      frame.topics.map((topic) => topic.id),
    );
    if (alternative.status === 'answered' || alternative.status === 'partial')
      return alternative;
    return draft;
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
    if (
      draft.excerpts?.some(
        (excerpt) =>
          !supportsExcerpt(excerpt) ||
          !draft.citations.some(
            (citation) =>
              citation.kind === 'chunk' &&
              citation.chunk === excerpt.chunk &&
              citation.tableColumns === excerpt.tableColumns,
          ),
      )
    ) {
      return failClosed('CITATION_UNSUPPORTED');
    }

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
        effectiveAt: request.effectiveAt,
        includeHistory: isFact ? request.includeHistory : undefined,
        locate: isFact ? request.fact : undefined,
        locateClassNames:
          isFact && request.fact.subjectType === 'class'
            ? ctx.catalog.classes
                .filter((klass) => klass.classId === request.fact.subjectId)
                .flatMap((klass) => [klass.name, ...klass.aliases])
            : undefined,
      });

      if (!summary) return failClosed('CITATION_UNSUPPORTED');
      let location = isFact ? summary.location : request.chunk.location.label;
      if (!isFact) {
        const { chunk, tableColumns } = request;
        if (
          summary.documentId !== chunk.documentId ||
          summary.revision !== chunk.revision
        )
          return failClosed('CITATION_UNSUPPORTED');
        let quote = chunk.text;
        if (tableColumns) {
          const { header, cells, kind } = chunk.location;
          if (
            kind !== 'table_row' ||
            !header ||
            !cells ||
            tableColumns.length === 0 ||
            tableColumns.some(
              (index) =>
                !Number.isInteger(index) ||
                index < 0 ||
                index >= header.length ||
                index >= cells.length,
            )
          )
            return failClosed('CITATION_UNSUPPORTED');
          location =
            chunk.location.label +
            ' · 열 ' +
            tableColumns.map((index) => header[index]).join(', ');
          quote = [...new Set([0, ...tableColumns])]
            .map((index) => header[index] + ' ' + cells[index])
            .join(' ');
        }
        quotedNumbers.push(
          ...extractNumbers(
            [
              chunk.title,
              chunk.location.section,
              chunk.location.label,
              quote,
            ].join(' '),
          ),
        );
      }
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

    // 스캔(OCR) 청크의 수치: 판독이 불확실한 값(검수 필요 페이지는 모든 수치)을 답에 쓰면 보류한다.
    // 같은 값이 승인된 정형 사실로 확인되면 허용한다(외부 기능이 사람이 입력한 값).
    const answerNumbers = new Set(extractNumbers(draft.text));
    const factNumbers = new Set(
      allowedNumbersFor({ facts: draft.usedFacts, instants: [] }),
    );
    for (const request of draft.citations) {
      if (request.kind !== 'chunk' || !request.chunk.extraction) continue;
      const extraction = request.chunk.extraction;
      const risky = extraction.needsReview
        ? extractNumbers(request.chunk.text)
        : extractNumbers(extraction.uncertainTokens.join(' '));
      if (risky.some((n) => answerNumbers.has(n) && !factNumbers.has(n))) {
        return {
          ...abstain(
            '스캔된 문서에서 읽은 내용의 판독이 확실하지 않아 바로 안내해 드리기 어렵습니다. 담당자가 원본을 확인한 뒤 안내해 드릴 수 있도록 연결해 드리겠습니다.',
            'INSUFFICIENT_EVIDENCE',
            ['스캔 문서 판독 확인'],
            ['OCR_UNCERTAIN'],
          ),
          resolvedCitations: [] as RagCitation[],
        };
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
    diagnostics?.observeLocations?.(
      [...merged.values()].flatMap(({ locations, ...citation }) =>
        locations.size
          ? [...locations].map((location) => ({ ...citation, location }))
          : [citation],
      ),
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
            const refined = diagnostics?.refineFrame?.(frame);
            if (refined) {
              frame.classIds = refined.classIds.filter(
                (id) =>
                  !frame.negatedClassIds.includes(id) &&
                  catalog.classes.some((klass) => klass.classId === id),
              );
              frame.topics = config.topics.filter((topic) =>
                refined.topics.some((selected) => selected.id === topic.id),
              );
            }
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
              engine: deps.engine,
              asOf: started,
              state,
              config,
              facts: deps.facts,
              documents: deps.documents,
              generation: deps.generation,
              clock: deps.clock,
              trace,
            };
            const plan = planQuery(
              question,
              frame,
              input.access,
              catalog,
              config,
              deps.engine === 'planned',
            );
            let draft: AnswerDraft;
            if (plan.requests.length > 1) {
              const drafts: AnswerDraft[] = [];
              for (const [index, request] of plan.requests.entries()) {
                const { frame: partFrame, question: part } = request;
                let classes = studentClassIdsFor(
                  input.access,
                  partFrame,
                  input.studentIdHint,
                );
                if (
                  plan.analysisAndTeacher &&
                  index === 1 &&
                  partFrame.classIds.length === 0
                ) {
                  // Bind a follow-up to the authorized learner selected by the first clause.
                  const resolved = trace.targetStudentIds.filter((id) =>
                    input.access.allowedStudentIds.includes(id),
                  );
                  classes = studentClassIdsFor(
                    input.access,
                    { ...partFrame, matchedStudentIds: resolved },
                    input.studentIdHint,
                  ).filter(
                    (id) =>
                      partFrame.subjects.length === 0 ||
                      catalog.classes.some(
                        (klass) =>
                          klass.classId === id &&
                          klass.subject &&
                          partFrame.subjects.includes(klass.subject),
                      ),
                  );
                  if (resolved.length !== 1 || classes.length !== 1) {
                    drafts.push(
                      abstain(
                        '담당 강사를 확인할 반이나 과목을 지정해 주세요.',
                        'AMBIGUOUS_SUBJECT',
                      ),
                    );
                    continue;
                  }
                }
                const partContext = {
                  ...ctx,
                  frame: partFrame,
                  plannedRequest: request,
                  question: part,
                  studentClassIds:
                    deps.engine === 'planned'
                      ? classes
                      : studentClassIdsFor(
                          input.access,
                          partFrame,
                          input.studentIdHint,
                        ),
                };
                const proposal = await route(partContext, input.studentIdHint);
                const answer =
                  deps.engine === 'planned'
                    ? validateEvidence(
                        partContext,
                        collectEvidence(request, proposal),
                      ).draft
                    : proposal;
                // 연결된 절의 정형 요청을 다른 절의 근거로 대신 답하지 않는다.
                const asksAmount = request.requiredFields.includes('amount');
                drafts.push(
                  asksAmount &&
                    (answer.status === 'answered' ||
                      answer.status === 'partial') &&
                    !satisfiesAnswerTypes(answer.text, ['amount'])
                    ? abstain(
                        '요청한 비용을 승인 자료에서 확인할 수 없습니다.',
                        'INSUFFICIENT_EVIDENCE',
                      )
                    : answer,
                );
              }
              trace.intent = `multi(${plan.requests.length})`;
              draft = composeRequests(
                drafts,
                plan.requests.map((request) => request.question),
              );
            } else {
              ctx.plannedRequest = plan.requests[0];
              const proposal = await route(ctx, input.studentIdHint);
              draft =
                deps.engine === 'planned'
                  ? validateEvidence(
                      ctx,
                      collectEvidence(plan.requests[0], proposal),
                    ).draft
                  : proposal;
            }
            final = await finalize(ctx, draft);
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
        (final.status === 'answered' ||
          final.status === 'partial' ||
          final.status === 'clarify')
      ) {
        const next: ConversationState = { ...(state ?? {}) };
        for (const [key, value] of Object.entries(
          final.conversationUpdate ?? {},
        )) {
          if (value !== undefined)
            (next as Record<string, unknown>)[key] = value;
        }
        // 직전 질문 원문과 영역을 남긴다(후속 질문 해석용).
        if (final.status !== 'clarify') {
          next.previousFrame = {
            ...(final.conversationUpdate?.previousFrame ?? {
              domain: trace.domain === 'analysis' ? 'analysis' : 'info',
              units: [],
              periods: [],
            }),
            question: input.question,
          };
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
