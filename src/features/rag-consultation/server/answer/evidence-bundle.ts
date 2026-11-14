import type {
  AnswerContext,
  AnswerDraft,
  CitationRequest,
} from '../answer/context.ts';
import { abstain, deny, resolveEffectiveTime } from '../answer/context.ts';
import { satisfiesAnswerTypes } from '../answer/evidence.ts';
import { supportsExcerpt } from './verify.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { isValidAt, toKstDate } from '../text/time.ts';
import type { PlannedRequest } from '../query/plan.ts';

/** Domain adapters propose a draft. References keep the original facts and
 * rows, rather than rebuilding them from text or a search score. */
export interface EvidenceBundle {
  request: PlannedRequest;
  proposal: AnswerDraft;
  members: readonly CitationRequest[];
}

export function collectEvidence(
  request: PlannedRequest,
  proposal: AnswerDraft,
): EvidenceBundle {
  return { request, proposal, members: proposal.citations };
}

type EvidenceState =
  | 'sufficient'
  | 'partial'
  | 'missing'
  | 'conflict'
  | 'ambiguous'
  | 'forbidden'
  | 'untrusted'
  | 'handoff';

export interface EvidenceDecision {
  state: EvidenceState;
  draft: AnswerDraft;
}

export function validateEvidence(
  ctx: AnswerContext,
  bundle: EvidenceBundle,
): EvidenceDecision {
  const { proposal, members, request } = bundle;
  const decision = (
    state: EvidenceState,
    draft = proposal,
  ): EvidenceDecision => ({ state, draft });
  if (proposal.status === 'denied') return decision('forbidden');
  if (proposal.status === 'clarify') return decision('ambiguous');
  if (proposal.status === 'handoff') return decision('handoff');
  if (proposal.status === 'abstained')
    return decision(
      proposal.reasonCode === 'CONFLICTING_EVIDENCE' ? 'conflict' : 'missing',
    );

  if (
    request.weekday &&
    request.intentIds.includes('schedule') &&
    ctx.frame.explicitDates[0]?.operator === 'at'
  ) {
    const { explicitDay } = resolveEffectiveTime(ctx.frame, ctx.asOf);
    if (explicitDay !== null) {
      const { year, month, day } = toKstDate(explicitDay);
      const actual = '일월화수목금토'[
        new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      ];
      if (actual !== request.weekday)
        return decision(
          'ambiguous',
          abstain(
            '요청하신 날짜와 요일이 일치하지 않습니다.',
            'INSUFFICIENT_EVIDENCE',
          ),
        );
    }
  }
  const classes = ctx.frame.classIds.length
    ? ctx.frame.classIds
    : ctx.studentClassIds;
  const students = ctx.trace.targetStudentIds.length
    ? ctx.trace.targetStudentIds
    : ctx.frame.matchedStudentIds.length
      ? ctx.frame.matchedStudentIds
      : ctx.access.allowedStudentIds;
  const { frame } = ctx;
  const requestedAt = resolveEffectiveTime(frame, ctx.asOf).at;
  const explicitTime =
    frame.explicitDates.length > 0 ||
    frame.months.length > 0 ||
    frame.relativePeriod !== null;
  for (const member of members) {
    if (member.kind === 'fact') {
      const { fact } = member;
      if (
        fact.academyId !== ctx.access.academyId ||
        (fact.subjectType === 'student' &&
          (!students.includes(fact.subjectId) ||
            !ctx.access.allowedStudentIds.includes(fact.subjectId)))
      ) {
        return decision('forbidden', deny('ACCESS_DENIED'));
      }
      if (fact.approvalStatus !== 'approved') {
        return decision(
          'untrusted',
          abstain('승인된 근거를 확인할 수 없습니다.', 'INSUFFICIENT_EVIDENCE'),
        );
      }
    } else {
      const { chunk, tableColumns } = member;
      const citeAt = explicitTime
        ? requestedAt
        : (member.effectiveAt ?? requestedAt);
      if (!canReadRecord(ctx.access, chunk, students))
        return decision('forbidden', deny('ACCESS_DENIED'));
      if (
        chunk.documentType === 'schedule' &&
        request.intentIds.includes('schedule') &&
        !isValidAt(chunk.validFrom, chunk.validTo, citeAt)
      ) {
        return decision(
          'missing',
          abstain(
            '요청 시점에 적용되는 시간표 근거가 없습니다.',
            'INSUFFICIENT_EVIDENCE',
          ),
        );
      }
      const { cells, header, kind } = chunk.location;
      if (
        chunk.suspicious ||
        (tableColumns &&
          (kind !== 'table_row' ||
            !cells ||
            !header ||
            tableColumns.some(
              (index) =>
                !Number.isInteger(index) ||
                index < 0 ||
                index >= cells.length ||
                index >= header.length,
            )))
      ) {
        return decision(
          'untrusted',
          abstain(
            '원본 근거 위치를 확인할 수 없습니다.',
            'INSUFFICIENT_EVIDENCE',
          ),
        );
      }
    }
    const classId =
      member.kind === 'fact'
        ? member.fact.subjectType === 'class'
          ? member.fact.subjectId
          : member.fact.classId
        : member.chunk.classId;
    // A learner's dated private result remains their evidence after a class transfer.
    // Explicit class requests still constrain it; all source ACL checks remain in force.
    const personalEvidence =
      member.kind === 'fact'
        ? member.fact.subjectType === 'student'
        : member.chunk.visibility === 'student_private';
    const requestedClasses =
      personalEvidence && !ctx.frame.classIds.length ? [] : classes;
    if (
      classId &&
      (ctx.frame.negatedClassIds.includes(classId) ||
        (requestedClasses.length && !requestedClasses.includes(classId)))
    ) {
      return decision(
        'missing',
        abstain(
          '요청한 반의 근거를 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        ),
      );
    }
  }
  const verifiedPartial =
    proposal.status === 'partial' &&
    !!proposal.missingFields?.length &&
    !!proposal.excerpts?.length &&
    proposal.excerpts.every(supportsExcerpt);
  if (
    !members.length ||
    !request.requiredFields.every((field) => {
      if (verifiedPartial && proposal.unresolvedFields?.includes(field))
        return true;
      return field === 'startTime'
        ? /\d{1,2}:\d{2}|\d{1,2}\s*시(?:\s|[부터에]|$)/m.test(proposal.text)
        : satisfiesAnswerTypes(proposal.text, [field]);
    })
  ) {
    return decision(
      'missing',
      abstain(
        '요청한 항목을 승인 자료에서 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      ),
    );
  }
  return decision(proposal.status === 'partial' ? 'partial' : 'sufficient');
}
