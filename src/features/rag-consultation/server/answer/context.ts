import type { RagAnswerStatus, RagPublicReasonCode } from '../../contract.ts';
import type { RagConfig } from '../config.ts';
import type {
  ApprovedFactsPort,
  Clock,
  GenerationPort,
  RagDocumentsPort,
} from '../ports.ts';
import type { PlannedRequest } from '../query/plan.ts';
import type { QueryFrame } from '../query/parse-query.ts';
import { isSameKstDay, kstStartOfDay, toKstDate } from '../text/time.ts';
import type {
  AcademyCatalog,
  ApprovedFact,
  ConversationState,
  RagAccessScope,
  RagChunk,
  RagInternalErrorType,
  RagTrace,
} from '../types.ts';

export interface AnswerContext {
  access: RagAccessScope;
  catalog: AcademyCatalog;
  frame: QueryFrame;
  plannedRequest?: PlannedRequest;
  question: string;
  engine?: 'legacy' | 'planned';
  asOf: number;
  state: ConversationState | null;
  config: RagConfig;
  facts: ApprovedFactsPort;
  documents: RagDocumentsPort;
  generation: GenerationPort;
  clock: Clock;
  trace: RagTrace;
  /** 질문이 반 대신 학생으로 반을 가리킬 때(“첫째 반”, “도윤이 반”) 서버가 아는 그 학생들의 반 */
  studentClassIds: string[];
  /** 과목이 둘 이상인 학생(답변에 과목 표시가 필요한 경우) — 분석 단계에서 채운다 */
  multiSubjectStudents?: Set<string>;
}

export type CitationRequest =
  | {
      kind: 'fact';
      fact: ApprovedFact;
      effectiveAt?: number;
      includeHistory?: boolean;
    }
  | { kind: 'chunk'; chunk: RagChunk; tableColumns?: readonly number[] };

export interface EvidenceExcerpt {
  line: string;
  chunk: RagChunk;
  tableColumns?: readonly number[];
}

export interface AnswerDraft {
  excerpts?: EvidenceExcerpt[];
  status: RagAnswerStatus;
  text: string;
  citations: CitationRequest[];
  usedFacts: ApprovedFact[];
  missingFields?: string[];
  reasonCode?: RagPublicReasonCode;
  clarifyOptionStudentIds?: string[];
  /** 코드에서 계산한 파생 수치(차이 등) — 사후 숫자 검사 허용 목록 */
  derivedNumbers?: number[];
  /** 답변이 언급하는 기준 시각들(사후 숫자 검사 허용 목록) */
  instants?: number[];
  /** 생성 모델 출력이 포함되었는지(질문 숫자 재인용 허용 여부 판단) */
  generated?: boolean;
  internalErrors?: RagInternalErrorType[];
  conversationUpdate?: Partial<ConversationState>;
}

export function abstain(
  text: string,
  reasonCode: RagPublicReasonCode,
  missingFields?: string[],
  internalErrors?: RagInternalErrorType[],
): AnswerDraft {
  return {
    status: 'abstained',
    text,
    citations: [],
    usedFacts: [],
    reasonCode,
    missingFields,
    internalErrors,
  };
}

export function deny(internalError: RagInternalErrorType): AnswerDraft {
  return {
    status: 'denied',
    text: '요청하신 정보는 현재 계정으로 조회할 수 있는 범위가 아니어서 안내해 드릴 수 없습니다. 필요하시면 학원 담당자에게 문의해 주세요.',
    citations: [],
    usedFacts: [],
    reasonCode: 'OUT_OF_SCOPE',
    internalErrors: [internalError],
  };
}

export function handoff(
  text: string,
  reasonCode: RagPublicReasonCode,
  internalErrors?: RagInternalErrorType[],
): AnswerDraft {
  return {
    status: 'handoff',
    text,
    citations: [],
    usedFacts: [],
    reasonCode,
    internalErrors,
  };
}

export interface EffectiveTime {
  /** 정형 정보를 조회할 시점 */
  at: number;
  /** 질문에 명시된 날짜가 있으면 그 날짜의 KST 0시 */
  explicitDay: number | null;
}

/** 질문의 "11월 4일 기준/이후" 를 조회 시점으로 바꾼다(연도 미기재 시 기준 시각의 연도). */
export function resolveEffectiveTime(
  frame: QueryFrame,
  asOf: number,
): EffectiveTime {
  const date = frame.explicitDates[0];
  if (!date) {
    // 날짜는 없지만 미래 시점을 묻는 경우: "1월부터 얼마"·"다음 달 수강료" → 그 달 1일 기준 값
    const now = toKstDate(asOf);
    const month =
      frame.relativePeriod === 'next_month'
        ? (now.month % 12) + 1
        : frame.futureCue && frame.months.length === 1
          ? frame.months[0]
          : null;
    if (month !== null && month !== now.month) {
      const year = month < now.month ? now.year + 1 : now.year;
      const start = kstStartOfDay({ year, month, day: 1 });
      return { at: start, explicitDay: null };
    }
    return { at: asOf, explicitDay: null };
  }
  const now = toKstDate(asOf);
  let year = Number.isNaN(date.year) ? now.year : date.year;
  let month = date.month;
  if (month === 0) {
    // 날만 말한 날짜: 이번 달 그날이 지났으면 다음 달
    month = date.day >= now.day ? now.month : (now.month % 12) + 1;
    if (month < now.month) year += 1;
  }
  const start = kstStartOfDay({ year, month, day: date.day });
  if (date.operator === 'before') return { at: start - 1, explicitDay: start };
  if (date.operator === 'at' && isSameKstDay(start, asOf))
    return { at: asOf, explicitDay: start };
  return { at: start, explicitDay: start };
}

export function studentLabel(
  access: RagAccessScope,
  studentId: string,
): string {
  return (
    access.studentRefs.find((ref) => ref.studentId === studentId)
      ?.displayLabel ?? '대상'
  );
}

export function className(catalog: AcademyCatalog, classId: string): string {
  return (
    catalog.classes.find((klass) => klass.classId === classId)?.name ??
    '해당 반'
  );
}

export function recordFacts(trace: RagTrace, facts: readonly ApprovedFact[]) {
  for (const fact of facts) {
    if (!trace.retrievedFactIds.includes(fact.factId))
      trace.retrievedFactIds.push(fact.factId);
  }
}

export function recordChunks(trace: RagTrace, chunks: readonly RagChunk[]) {
  for (const chunk of chunks) {
    if (!trace.retrievedChunkIds.includes(chunk.chunkId))
      trace.retrievedChunkIds.push(chunk.chunkId);
  }
}

export function subjectOf(
  catalog: AcademyCatalog,
  classId: string | null,
): string | null {
  if (!classId) return null;
  return (
    catalog.classes.find((klass) => klass.classId === classId)?.subject ?? null
  );
}

/** 질문에 과목이 있으면 그 과목 문서의 사실만 남긴다(과목을 알 수 없는 사실은 유지). */
export function matchesRequestedSubject(
  ctx: AnswerContext,
  fact: ApprovedFact,
): boolean {
  if (ctx.frame.subjects.length === 0) return true;
  const subject = subjectOf(ctx.catalog, fact.classId);
  return subject === null || ctx.frame.subjects.includes(subject);
}

/** 학생별로 사실이 걸친 과목이 둘 이상인지 기록한다. */
export function markMultiSubjectStudents(
  ctx: AnswerContext,
  facts: readonly ApprovedFact[],
) {
  const subjects = new Map<string, Set<string>>();
  for (const fact of facts) {
    const subject = subjectOf(ctx.catalog, fact.classId);
    if (!subject) continue;
    const set = subjects.get(fact.subjectId) ?? new Set<string>();
    set.add(subject);
    subjects.set(fact.subjectId, set);
  }
  ctx.multiSubjectStudents = new Set(
    [...subjects].filter(([, set]) => set.size > 1).map(([id]) => id),
  );
}

export function subjectTag(ctx: AnswerContext, fact: ApprovedFact): string {
  if (!ctx.multiSubjectStudents?.has(fact.subjectId)) return '';
  const subject = subjectOf(ctx.catalog, fact.classId);
  return subject ? `[${subject}] ` : '';
}
