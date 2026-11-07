import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { formatKstDate, isValidAt } from '../text/time.ts';
import {
  abstain,
  className,
  recordChunks,
  recordFacts,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import { cohortNumbers } from './offering-evidence.ts';
import {
  expandNumberedClasses,
  parallelClassSections,
} from './class-targets.ts';
import { isCleanPublicEvidence } from './public-evidence.ts';
import type { ApprovedFact } from '../types.ts';
import { supportsExcerpt } from './verify.ts';

const MID_TERM =
  /중도\s*(?:등록|입학)|(?:월\s*)?중간(?:에|에도)?.{0,10}(?:등록|입학|들어가|들어오)|개강\s*후.{0,20}(?:등록|입학)/;
const TRIAL = /체험\s*수업|시범\s*수업/;
const DAY_VARIANT = /(?:평일|주말|[월화수목금토일]요)반$/;

function siblingClass(
  ctx: AnswerContext,
  ids: readonly string[],
): string | undefined {
  if (ids.length !== 1) return;
  const fallback =
    /(?:없으면|마감이면|대신)\s*(평일반|주말반|[월화수목금토일]요반)/.exec(
      ctx.frame.normalized,
    );
  if (!fallback) return;
  const first = ctx.catalog.classes.find(({ classId }) => classId === ids[0]);
  if (
    !first ||
    !DAY_VARIANT.test(first.name) ||
    first.name.endsWith(fallback[1])
  )
    return;
  const name = first.name.replace(DAY_VARIANT, fallback[1]);
  const candidates = ctx.catalog.classes.filter(
    (entry) =>
      entry.classId !== first.classId &&
      !ctx.frame.negatedClassIds.includes(entry.classId) &&
      entry.grade === first.grade &&
      compactText(entry.name) === compactText(name),
  );
  return candidates.length === 1 ? candidates[0].classId : undefined;
}

async function readEnrollmentRules(
  ctx: AnswerContext,
  classIds: readonly string[],
  cohort: number | undefined,
  midTerm: boolean,
  trial: boolean,
) {
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [ctx.question, '중도 등록 개강 월 중간 일할 체험 수업 가능'].join(
      ' ',
    ),
    documentTypes: ['policy', 'academy_info', 'fee', 'announcement'],
    limit: 50,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const claims: Array<EvidenceExcerpt & { board: boolean; cutoff?: number }> =
    [];
  const trials: EvidenceExcerpt[] = [];
  for (const { chunk } of found) {
    if (
      chunk.visibility !== 'academy_public' ||
      !canReadRecord(ctx.access, chunk, []) ||
      (chunk.classId &&
        (classIds.length !== 1 || !classIds.includes(chunk.classId))) ||
      chunk.location.kind !== 'paragraph' ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf)
    )
      continue;
    const declared = cohortNumbers(
      chunk.title + ' ' + (chunk.location.section ?? ''),
    );
    if (declared.size && (cohort === undefined || !declared.has(cohort)))
      continue;
    const board = /게시판|질문\s*답변|문의\s*모음/.test(chunk.title);
    // A board reply can reveal a conflicting policy. A parent's question or a
    // standalone board reply cannot establish the published rule.
    const body = board
      ? (/^\s*\[학원\s*답변\]\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*\|\s*[^.\n|]{0,30}?(?:데스크|운영팀|담당자|관리자)\s+([\s\S]*)$/.exec(
          chunk.text,
        )?.[1] ?? '')
      : chunk.text;
    for (const line of splitSentences(body)) {
      const cohorts = cohortNumbers(line);
      if (cohorts.size && (cohort === undefined || !cohorts.has(cohort)))
        continue;
      const mentioned = ctx.catalog.classes.filter(({ name }) =>
        compactText(line).includes(compactText(name)),
      );
      if (mentioned.some(({ classId }) => !classIds.includes(classId)))
        continue;
      const excerpt = { chunk, line };
      if (!supportsExcerpt(excerpt)) continue;
      if (
        midTerm &&
        MID_TERM.test(line) &&
        /등록|입학/.test(line) &&
        /가능|없습니다|불가|등록할\s*수|받고|받습니다|일할\s*계산|남은\s*수업/.test(
          line,
        )
      ) {
        const limit = /개강\s*후\s*(\d+)\s*주(?:\s*차)?\s*까지/.exec(line)?.[1];
        claims.push({
          ...excerpt,
          board,
          cutoff: limit ? Number(limit) : undefined,
        });
      }
      if (
        trial &&
        !board &&
        TRIAL.test(line) &&
        /가능|불가|없습니다|진행하지|신청|운영|예약/.test(line)
      )
        trials.push(excerpt);
    }
  }
  const cutoffs = new Set(
    claims.flatMap(({ cutoff }) => (cutoff === undefined ? [] : [cutoff])),
  );
  const trusted = claims.filter(({ board }) => !board);
  const directions = new Set(
    trusted.map(({ line }) =>
      /불가|등록(?:을|은)?\s*(?:받지\s*않|할\s*수\s*없)|입학할\s*수\s*없/.test(
        line,
      )
        ? 'closed'
        : 'open',
    ),
  );
  return {
    mid: trusted[0],
    trial: trials[0],
    midConflict: cutoffs.size > 1 || directions.size > 1,
    trialConflict:
      new Set(trials.map(({ line }) => compactText(line))).size > 1,
  };
}

async function readClosedWaitlist(
  ctx: AnswerContext,
  primary: ApprovedFact,
  facts: ApprovedFact[],
) {
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: '마감 반 대기 접수 불가 같은 학년 다른 반 진도 등록',
    documentTypes: ['announcement', 'policy', 'academy_info'],
    limit: 44,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const rules = hits.flatMap(({ chunk }) => {
    if (
      chunk.sourceId !== primary.sourceId ||
      chunk.location.kind !== 'paragraph' ||
      (chunk.classId && chunk.classId !== primary.subjectId) ||
      !isCleanPublicEvidence(chunk, ctx.asOf)
    )
      return [];
    return splitSentences(chunk.text)
      .map((line) => ({ chunk, line }))
      .filter(supportsExcerpt);
  });
  const refusals = rules.filter(({ line }) => {
    const text = compactText(line);
    return /(?:마감된반|모집마감반|마감된강좌).{0,12}대기(?:자)?(?:접수|신청)(?:를|은|이|가)?(?:받지않|불가|할수없)/.test(
      text,
    );
  });
  const permitsWait = rules.some(({ line }) => {
    const text = compactText(line);
    return /(?:마감된반|모집마감반|마감된강좌).{0,12}대기(?:자)?(?:접수|신청)(?:를|은|이|가)?(?:받습니다|가능|할수있)/.test(
      text,
    );
  });
  const refusal =
    !permitsWait &&
    new Set(refusals.map(({ line }) => compactText(line))).size === 1
      ? refusals[0]
      : undefined;
  const group = parallelClassSections(ctx, primary.subjectId);
  const alternateRules = rules.filter(({ line }) => {
    const text = compactText(line);
    const listed = [...text.matchAll(/([a-z]|\d+)반/g)].map(
      ([, section]) => section,
    );
    if (
      listed.length &&
      !group.every(({ section }) => listed.includes(section))
    )
      return false;
    return (
      /같은(?:학년|과정).{0,14}다른반/.test(text) &&
      /같은진도|동일한진도|진도가같/.test(text) &&
      /자리.{0,20}등록(?:할수있|가능)/.test(text)
    );
  });
  const companion =
    refusal && alternateRules.length === 1 && group.length === 2
      ? group.find(({ klass }) => klass.classId !== primary.subjectId)
      : undefined;
  const alternative = companion
    ? facts.flatMap((fact) => {
        if (
          fact.sourceId !== primary.sourceId ||
          fact.subjectType !== 'class' ||
          fact.subjectId !== companion.klass.classId ||
          fact.value.kind !== 'enrollment' ||
          fact.value.status !== 'open' ||
          fact.value.remaining === null ||
          fact.value.remaining <= 0 ||
          isAssistantDirective(fact.value.text)
        )
          return [];
        return [{ fact, text: fact.value.text }];
      })
    : [];
  return {
    refusal,
    alternative: alternative.length === 1 ? alternative[0] : undefined,
    alternativeRule: alternateRules[0],
  };
}

/** Seat availability, eligibility to enroll mid-term, and trial lessons are separate slots. */
export async function answerEnrollmentEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const text = frame.normalized;
  const midTerm = MID_TERM.test(text);
  const trial = TRIAL.test(text);
  const seats = /자리|잔여|마감|대기\s*(?:인원|몇\s*명)|모집\s*현황/.test(text);
  if (
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    frame.flags.previousRevision ||
    frame.flags.prediction ||
    !frame.topics.some(({ id }) => id === 'enrollment') ||
    /수강료|교재비|환불|할인|납부|결제|자리.{0,8}언제|언제쯤|예약\s*(?:변경|취소)/.test(
      text,
    )
  )
    return;
  const cohorts = cohortNumbers(text);
  if (cohorts.size > 1) return;
  const [cohort] = cohorts;
  const ids = explicitClassIds(ctx);
  const alternative = seats ? siblingClass(ctx, ids) : undefined;
  const expanded = seats ? expandNumberedClasses(ctx, ids) : undefined;
  const waitsIfFull =
    seats &&
    ids.length === 1 &&
    /대기.{0,10}(?:접수|신청|걸|넣|가능|받|할\s*수)/.test(text) &&
    /자리|마감|없으면/.test(text);
  if (
    !midTerm &&
    !(
      seats &&
      (alternative || expanded || waitsIfFull || (trial && ids.length))
    )
  )
    return;
  const classIds = expanded ?? (alternative ? [...ids, alternative] : ids);
  const missing: string[] = [];
  const lines: string[] = [];
  const citations: AnswerDraft['citations'] = [];
  const usedFacts: AnswerDraft['usedFacts'] = [];
  const excerpts: EvidenceExcerpt[] = [];

  if (seats) {
    const found = classIds.length
      ? await ctx.facts.queryApprovedFacts({
          access: ctx.access,
          studentIds: [],
          asOf: ctx.asOf,
          factTypes: ['enrollment_status'],
        })
      : [];
    recordFacts(ctx.trace, found);
    let open = false;
    for (const id of classIds) {
      if (alternative === id && open) break;
      const eligible = [];
      for (const fact of found) {
        if (
          fact.subjectType !== 'class' ||
          fact.subjectId !== id ||
          fact.value.kind !== 'enrollment' ||
          fact.approvalStatus !== 'approved' ||
          fact.academyId !== ctx.access.academyId ||
          isAssistantDirective(fact.value.text)
        )
          continue;
        if (cohort !== undefined) {
          const source = await ctx.documents.getCitableSource({
            access: ctx.access,
            studentIds: [],
            sourceId: fact.sourceId,
            asOf: ctx.asOf,
          });
          if (!source || !cohortNumbers(source.title).has(cohort)) continue;
        }
        eligible.push({ fact, value: fact.value });
      }
      const label = className(ctx.catalog, id) + ' 모집 현황';
      if (
        new Set(
          eligible.map(({ value }) =>
            [value.status, value.remaining, compactText(value.text)].join('|'),
          ),
        ).size > 1
      )
        return abstain(
          '같은 반의 승인 모집 현황이 서로 다릅니다.',
          'CONFLICTING_EVIDENCE',
        );
      const selected = eligible[0];
      if (!selected) {
        missing.push(label);
        continue;
      }
      open ||=
        selected.value.status === 'open' && selected.value.remaining !== 0;
      lines.push(
        label +
          ': ' +
          selected.value.text +
          ' (' +
          formatKstDate(selected.fact.validFrom) +
          ' 공지 기준)',
      );
      citations.push({ kind: 'fact', fact: selected.fact });
      usedFacts.push(selected.fact);
      if (waitsIfFull && id === ids[0] && selected.value.status === 'closed') {
        const waiting = await readClosedWaitlist(ctx, selected.fact, found);
        if (!waiting.refusal) {
          missing.push('마감 반의 대기 접수 가능 여부');
          continue;
        }
        lines.push(waiting.refusal.line);
        excerpts.push(waiting.refusal);
        citations.push({ kind: 'chunk', chunk: waiting.refusal.chunk });
        if (waiting.alternative && waiting.alternativeRule) {
          const { fact, text } = waiting.alternative;
          lines.push(
            waiting.alternativeRule.line,
            className(ctx.catalog, fact.subjectId) + ' 모집 현황: ' + text,
          );
          excerpts.push(waiting.alternativeRule);
          citations.push(
            { kind: 'chunk', chunk: waiting.alternativeRule.chunk },
            { kind: 'fact', fact },
          );
          usedFacts.push(fact);
        }
      }
    }
    if (!classIds.length) missing.push('대상 반 모집 현황');
  }
  if (midTerm || trial) {
    const rules = await readEnrollmentRules(
      ctx,
      classIds,
      cohort,
      midTerm,
      trial,
    );
    if (midTerm && rules.midConflict && !citations.length)
      return abstain(
        '승인 자료에 기재된 중도 등록 기준이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    for (const [asked, label, proof, conflict] of [
      [midTerm, '중도 등록 기준', rules.mid, rules.midConflict],
      [trial, '체험 수업', rules.trial, rules.trialConflict],
    ] as const) {
      if (!asked) continue;
      if (!proof || conflict) {
        missing.push(label);
        continue;
      }
      lines.push(proof.line);
      excerpts.push(proof);
      citations.push({ kind: 'chunk', chunk: proof.chunk });
    }
  }
  if (!citations.length)
    return abstain(
      '요청하신 모집 또는 등록 조건을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      missing,
    );
  const confirmedClasses = [
    ...new Set([...classIds, ...usedFacts.map(({ subjectId }) => subjectId)]),
  ];
  ctx.frame = { ...frame, classIds: confirmedClasses };
  ctx.trace.intent = 'enrollment_fields';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      ...lines,
      ...(missing.length ? ['확인되지 않은 항목: ' + missing.join(', ')] : []),
    ].join('\n'),
    citations,
    usedFacts,
    excerpts,
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        classIds: confirmedClasses,
        topicIds: ['enrollment'],
        units: [],
        periods: [],
      },
    },
  };
}
