import { expectedAnswerTypes, keywordsOf } from '../answer/evidence.ts';
import type { RagConfig } from '../config.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';
import { parseQuery, type QueryFrame } from './parse-query.ts';

/** 질문을 물음표·마침표 경계로 나눈다(내용어가 있는 부분이 둘 이상일 때만). */
export function splitQuestion(question: string): string[] {
  const parts = question
    .split(/(?<=[?？])\s*|(?<=[다요]\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  // 질문 형태(물음표·의문사·의문 어미)인 부분만 따로 답한다. "~하고 싶다는데" 같은 사정 설명은 앞 질문에 붙인다.
  const isQuestion = (part: string) =>
    /[?？]$|얼마|언제|몇|어디|누구|무엇|뭐|뭘|어떻게|왜|어느|무슨|(나요|까요|가요|어요|아요|죠|니|냐|래요|되나|있나)\s*[.?？]?$/.test(
      part,
    );
  const merged: string[] = [];
  for (const part of parts) {
    if (
      merged.length > 0 &&
      (!isQuestion(part) || keywordsOf(part).length === 0)
    )
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`;
    else merged.push(part);
  }
  const meaningful = merged.filter((part) => keywordsOf(part).length > 0);
  return meaningful.length >= 2 && meaningful.length <= 4 ? meaningful : [];
}

/** 부분 질문이 대상(학생·반)·시점을 말하지 않으면 전체 문장의 것을 이어받는다. */
function inheritAnchors(part: QueryFrame, full: QueryFrame): QueryFrame {
  const out: QueryFrame = { ...part };
  const ownTarget =
    part.matchedStudentIds.length > 0 ||
    part.unresolvedRelationWords.length > 0 ||
    part.classIds.length > 0 ||
    part.selfReference ||
    part.groupReference;
  if (!ownTarget) {
    out.matchedStudentIds = full.matchedStudentIds;
    out.unresolvedRelationWords = full.unresolvedRelationWords;
    out.classIds = full.classIds;
    out.negatedClassIds = full.negatedClassIds;
    out.selfReference = full.selfReference;
    out.groupReference = full.groupReference;
    out.subjects = part.subjects.length ? part.subjects : full.subjects;
  }
  const ownTime =
    part.explicitDates.length > 0 ||
    part.months.length > 0 ||
    part.relativeDay !== null ||
    part.relativeWeek !== null ||
    part.relativePeriod !== null;
  if (!ownTime) {
    out.explicitDates = full.explicitDates;
    out.months = full.months;
    out.relativeDay = full.relativeDay;
    out.relativeWeek = full.relativeWeek;
    out.relativePeriod = full.relativePeriod;
  }
  if (part.units.length === 0) out.units = full.units;
  return out;
}

export type CostSlot = 'fee' | 'textbook' | 'supplies' | 'material';

export function requiredCostSlots(frame: QueryFrame): CostSlot[] {
  const fields: CostSlot[] = [];
  if (
    frame.topics.some(({ id }) => id === 'fee') ||
    (frame.classIds.length > 0 &&
      /한\s*달(?:에)?\s*얼마/.test(frame.normalized))
  )
    fields.push('fee');
  if (frame.topics.some(({ id }) => id === 'material')) {
    if (/교재|책값/.test(frame.normalized)) fields.push('textbook');
    if (/재료비/.test(frame.normalized)) fields.push('supplies');
    if (!fields.includes('textbook') && !fields.includes('supplies'))
      fields.push('material');
  }
  return fields;
}
export interface PlannedRequest {
  question: string;
  frame: QueryFrame;
  weekday?: string;
  intentIds: string[];
  costSlots: readonly CostSlot[];
  requiredFields: readonly (
    ReturnType<typeof expectedAnswerTypes>[number] | 'startTime'
  )[];
  expectedFields: readonly ReturnType<typeof expectedAnswerTypes>[number][];
  inheritsContext: boolean;
}
export interface QueryPlan {
  academyId: string;
  requests: PlannedRequest[];
  analysisAndTeacher: boolean;
}

export function isRosterRequest({ normalized }: QueryFrame): boolean {
  return (
    /(?:학생|원생|아이|애|친구)(?:들|의)?\s*(?:전체|전원)?\s*(?:성적\s*)?(?:명단|목록|리스트)/.test(
      normalized,
    ) ||
    /(?:학생|원생|아이|애|친구)들\s*(?:전체|전원)?\s*(?:이름|연락처|전화번호)/.test(
      normalized,
    ) ||
    /(?:명단|목록|리스트).{0,12}(?:학생|원생|아이|애들)/.test(normalized)
  );
}
export function planQuery(
  question: string,
  frame: QueryFrame,
  access: RagAccessScope,
  catalog: AcademyCatalog,
  config: RagConfig,
  planned: boolean,
): QueryPlan {
  const sentences = splitQuestion(question);
  const clauses =
    sentences.length === 0
      ? question
          .split(/(?:이랑|랑|하고)\s+|\s+(?:및|그리고)\s+/)
          .map((clause) => clause.trim())
      : [];
  const parsePart = (part: string) =>
    parseQuery(part, { access: access, catalog, config });
  const clauseFrames =
    clauses.length === 2 && clauses.every(Boolean)
      ? clauses.map(parsePart)
      : [];
  const analysisAndTeacher =
    clauseFrames.length === 2 &&
    clauseFrames[0].hasAnalysisTerms &&
    clauseFrames[1].topics.some((topic) => topic.id === 'teacher') &&
    /누구|누군지|누가|이름|성함/.test(clauseFrames[1].normalized);
  const hasIndependentSchedule =
    clauseFrames.length === 2 &&
    clauseFrames[1].topics.some((topic) => topic.id === 'schedule') &&
    clauseFrames[0].topics.some((topic) =>
      ['fee', 'teacher', 'material'].includes(topic.id),
    );
  const inline =
    clauseFrames.length === 2 &&
    (analysisAndTeacher ||
      (planned && hasIndependentSchedule) ||
      /(?:[월화수목금토일]요일|\d{1,2}월\s*\d{1,2}일)/.test(clauses[1]));
  const parts = inline ? clauses : sentences;
  // 문장 전체에 적용되는 보안·정책 판단(다른 학원·전체 명단·원인/예측·미승인 프로그램)이 있으면 나누지 않는다.
  const blocked =
    frame.flags.crossTenant ||
    frame.flags.bulkStudent ||
    (planned && (frame.unboundProgram || isRosterRequest(frame))) ||
    frame.flags.shareOrPermission ||
    frame.flags.sessionChange ||
    frame.flags.citationForgery ||
    frame.flags.causal ||
    frame.flags.attitude ||
    frame.flags.prediction ||
    frame.flags.misattribution ||
    frame.flags.rankRequest ||
    frame.unknownPrograms.length > 0 ||
    frame.unauthorizedStudentRefs.length > 0;
  const parsedParts = inline ? clauseFrames : parts.map(parsePart);
  const shared = inline ? parsedParts[0] : frame;
  const partFrames = parsedParts.map((part) => inheritAnchors(part, shared));
  const distinctInlineTopics =
    !inline ||
    analysisAndTeacher ||
    (parsedParts.every((part) => part.topics.length > 0) &&
      !parsedParts[0].topics.some((topic) =>
        parsedParts[1].topics.some((other) => other.id === topic.id),
      ));
  // 부분마다 스스로 해석 가능한 주제(일반어가 아닌 주제어)나 분석 용어가 있을 때만 나눈다
  // ("셔틀 몇 시에 와요? 이용료도 알려주세요"의 뒤 문장처럼 앞 문장에 기대는 경우는 통째로 처리).
  const selfContained = (part: QueryFrame) =>
    part.hasAnalysisTerms ||
    part.topics.some((topic) => {
      const matched = topic.terms.filter((term) =>
        part.compact.includes(term.replace(/\s/g, '')),
      );
      return matched.some((term) => !topic.genericTerms?.includes(term));
    });

  const separate =
    parts.length >= 2 &&
    !blocked &&
    distinctInlineTopics &&
    partFrames.every(selfContained);
  const request = (
    text: string,
    parsed: QueryFrame,
    inheritsContext: boolean,
  ): PlannedRequest => {
    const intentIds = parsed.topics.map((topic) => topic.id);
    const weekday = /([월화수목금토일])요일/.exec(parsed.normalized)?.[1];
    const requiredFields: PlannedRequest['requiredFields'][number][] = [];
    if (
      separate &&
      inline &&
      intentIds.some((id) => id === 'fee' || id === 'material')
    )
      requiredFields.push('amount');
    if (
      planned &&
      intentIds.includes('schedule') &&
      /몇\s*시(?!간)|시작\s*시간/.test(parsed.normalized)
    )
      requiredFields.push('startTime');
    return {
      question: text,
      frame: parsed,
      weekday,
      intentIds,
      costSlots: planned ? requiredCostSlots(parsed) : [],
      requiredFields,
      expectedFields: expectedAnswerTypes(text),
      inheritsContext,
    };
  };
  return {
    academyId: access.academyId,
    analysisAndTeacher: separate && analysisAndTeacher,
    requests: separate
      ? parts.map((part, index) => request(part, partFrames[index], index > 0))
      : [request(question, frame, false)],
  };
}
