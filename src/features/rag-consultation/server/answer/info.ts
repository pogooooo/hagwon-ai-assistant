/**
 * 학원 정보(수강료·시간표·강사·휴강·보강·시설) 답변.
 * 정형 사실을 먼저 코드로 조회하고 템플릿으로 답한다(생성 API 0회).
 * 시설 같은 속성 질문은 승인 문서에 그 속성이 "실제로 있다"는 문장/값이 있을 때만 답한다.
 */
import type { TopicDefinition } from '../config.ts';
import {
  compactText,
  containsAny,
  isDataAbsenceStatement,
  normalizeText,
  splitSentences,
} from '../text/normalize.ts';
import {
  formatIsoDate,
  formatKstDate,
  formatValidity,
  isValidAt,
  toIsoDate,
  toKstDate,
} from '../text/time.ts';
import type { ApprovedFact, FactType, RagChunk } from '../types.ts';
import {
  abstain,
  className,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type CitationRequest,
  type EffectiveTime,
} from './context.ts';
import { formatKrw, josa } from './format.ts';

interface Part {
  outcome: 'ok' | 'partial' | 'missing' | 'conflict';
  lines: string[];
  citations: CitationRequest[];
  usedFacts: ApprovedFact[];
  missing: string[];
  derived: number[];
}

const emptyPart = (outcome: Part['outcome'], missing: string[] = []): Part => ({
  outcome,
  lines: [],
  citations: [],
  usedFacts: [],
  missing,
  derived: [],
});

async function loadFacts(
  ctx: AnswerContext,
  factTypes: FactType[],
  effective: EffectiveTime,
  includeHistory = false,
): Promise<ApprovedFact[]> {
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes,
    asOf: ctx.asOf,
    effectiveAt: effective.at,
    includeHistory,
  });
  recordFacts(ctx.trace, facts);
  return facts;
}

function targetClassIds(ctx: AnswerContext): string[] {
  if (ctx.frame.classIds.length > 0) return ctx.frame.classIds;
  return ctx.catalog.classes
    .map((klass) => klass.classId)
    .filter((id) => !ctx.frame.negatedClassIds.includes(id));
}

function currentFor(
  facts: ApprovedFact[],
  subjectId: string,
  at: number,
): ApprovedFact[] {
  return facts.filter(
    (fact) =>
      fact.subjectId === subjectId &&
      isValidAt(fact.validFrom, fact.validTo, at),
  );
}

function hasConflict(facts: ApprovedFact[]): boolean {
  const values = new Set(facts.map((fact) => JSON.stringify(fact.value)));
  return values.size > 1;
}

function datePrefix(effective: EffectiveTime): string {
  return `${formatKstDate(effective.at)} 기준 `;
}

async function answerFee(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const wantsPrevious =
    ctx.frame.flags.previousRevision && ctx.access.canViewPublicHistory;
  const facts = (
    await loadFacts(ctx, ['monthly_fee'], effective, wantsPrevious)
  ).filter((fact) => fact.value.kind === 'money');
  const explicitClasses = ctx.frame.classIds.length > 0;
  const part = emptyPart('ok');

  const rows: Array<{
    classId: string;
    current: ApprovedFact;
    previous?: ApprovedFact;
  }> = [];
  for (const classId of targetClassIds(ctx)) {
    const current = currentFor(facts, classId, effective.at);
    if (current.length === 0) {
      if (explicitClasses)
        part.missing.push(`${className(ctx.catalog, classId)} 수강료`);
      continue;
    }
    if (hasConflict(current))
      return emptyPart('conflict', [
        `${className(ctx.catalog, classId)} 수강료`,
      ]);
    const previous = wantsPrevious
      ? facts
          .filter(
            (fact) =>
              fact.subjectId === classId &&
              fact.validTo !== null &&
              fact.validTo <= current[0].validFrom,
          )
          .sort((a, b) => b.validFrom - a.validFrom)[0]
      : undefined;
    rows.push({ classId, current: current[0], previous });
  }

  const amountOf = (fact: ApprovedFact) =>
    fact.value.kind === 'money' ? fact.value.amount : 0;

  if (wantsPrevious) {
    const withHistory = rows.filter((row) => row.previous);
    const selected = explicitClasses ? rows : withHistory;
    if (withHistory.length === 0) part.missing.push('개정 전 수강료');
    for (const row of selected) {
      const name = className(ctx.catalog, row.classId);
      const now = amountOf(row.current);
      if (!row.previous) {
        part.lines.push(
          `${name}의 현재 월 수강료는 ${formatKrw(now)}입니다(${formatValidity(row.current.validFrom, row.current.validTo)}). 이전 수강료 기록은 확인되지 않습니다.`,
        );
        part.citations.push({
          kind: 'fact',
          fact: row.current,
          effectiveAt: effective.at,
        });
        part.usedFacts.push(row.current);
        continue;
      }
      const before = amountOf(row.previous);
      const diff = Math.abs(now - before);
      part.derived.push(diff);
      part.lines.push(
        `${name} 월 수강료는 개정 전 ${formatKrw(before)}(${formatValidity(row.previous.validFrom, row.previous.validTo)})에서 ${datePrefix(effective)}${formatKrw(now)}(${formatValidity(row.current.validFrom, row.current.validTo)})입니다. 차이는 ${formatKrw(diff)}입니다.`,
      );
      part.citations.push(
        {
          kind: 'fact',
          fact: row.previous,
          effectiveAt: effective.at,
          includeHistory: true,
        },
        { kind: 'fact', fact: row.current, effectiveAt: effective.at },
      );
      part.usedFacts.push(row.previous, row.current);
    }
  } else {
    for (const row of rows) {
      const name = className(ctx.catalog, row.classId);
      part.lines.push(
        `${datePrefix(effective)}${name} 월 수강료는 ${formatKrw(amountOf(row.current))}입니다(${formatValidity(row.current.validFrom, row.current.validTo)}).`,
      );
      part.citations.push({
        kind: 'fact',
        fact: row.current,
        effectiveAt: effective.at,
      });
      part.usedFacts.push(row.current);
    }
    if (ctx.frame.flags.compare && rows.length >= 2) {
      const sorted = [...rows].sort(
        (a, b) => amountOf(b.current) - amountOf(a.current),
      );
      const diff =
        amountOf(sorted[0].current) -
        amountOf(sorted[sorted.length - 1].current);
      part.derived.push(diff);
      if (diff === 0) {
        part.lines.push('비교한 반들의 월 수강료는 같습니다.');
      } else {
        const top = className(ctx.catalog, sorted[0].classId);
        const bottom = className(
          ctx.catalog,
          sorted[sorted.length - 1].classId,
        );
        part.lines.push(
          `${top}${josa(top, '이', '가')} ${bottom}보다 ${formatKrw(diff)} 더 비쌉니다.`,
        );
      }
    }
  }

  for (const amount of ctx.frame.amountsKrw) {
    part.derived.push(amount);
    const match = rows.find((row) => amountOf(row.current) === amount);
    part.lines.push(
      match
        ? `문의하신 금액(${formatKrw(amount)})은 ${className(ctx.catalog, match.classId)}의 승인된 수강료와 같습니다.`
        : `문의하신 금액(${formatKrw(amount)})은 승인된 현재 수강료 자료에서 확인되지 않습니다.`,
    );
  }

  if (part.usedFacts.length === 0)
    return emptyPart(
      'missing',
      part.missing.length ? part.missing : ['수강료'],
    );
  if (part.missing.length > 0) part.outcome = 'partial';
  return part;
}

async function answerSchedule(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const facts = await loadFacts(ctx, ['schedule'], effective);
  const part = emptyPart('ok');
  const explicitClasses = ctx.frame.classIds.length > 0;
  for (const classId of targetClassIds(ctx)) {
    const current = currentFor(facts, classId, effective.at);
    const name = className(ctx.catalog, classId);
    if (current.length === 0) {
      if (explicitClasses) part.missing.push(`${name} 수업 시간표`);
      continue;
    }
    if (hasConflict(current))
      return emptyPart('conflict', [`${name} 수업 시간표`]);
    const fact = current[0];
    const text =
      fact.value.kind === 'schedule' || fact.value.kind === 'text'
        ? fact.value.text
        : '';
    part.lines.push(
      `${datePrefix(effective)}${name} 수업은 ${text}입니다(${formatValidity(fact.validFrom, fact.validTo)}).`,
    );
    part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
    part.usedFacts.push(fact);
  }
  if (part.usedFacts.length === 0)
    return emptyPart(
      'missing',
      part.missing.length ? part.missing : ['수업 시간표'],
    );
  if (part.missing.length > 0) part.outcome = 'partial';
  return part;
}

async function answerTeacher(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const facts = await loadFacts(ctx, ['teacher'], effective);
  const part = emptyPart('ok');
  const explicitClasses = ctx.frame.classIds.length > 0;
  for (const classId of targetClassIds(ctx)) {
    const current = currentFor(facts, classId, effective.at);
    const name = className(ctx.catalog, classId);
    if (current.length === 0) {
      if (explicitClasses) part.missing.push(`${name} 담당 강사`);
      continue;
    }
    if (hasConflict(current))
      return emptyPart('conflict', [`${name} 담당 강사`]);
    const fact = current[0];
    const text = fact.value.kind === 'text' ? fact.value.text : '';
    part.lines.push(`${name} 담당 강사는 ${text}입니다.`);
    part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
    part.usedFacts.push(fact);
  }
  if (part.usedFacts.length === 0)
    return emptyPart(
      'missing',
      part.missing.length ? part.missing : ['담당 강사'],
    );
  if (part.missing.length > 0) part.outcome = 'partial';
  return part;
}

async function answerHoliday(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const facts = (
    await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      factTypes: ['holiday'],
      asOf: ctx.asOf,
    })
  ).filter((fact) => fact.value.kind === 'holiday');
  recordFacts(ctx.trace, facts);
  const part = emptyPart('ok');
  const targetDay = effective.explicitDay;
  const matches =
    targetDay === null
      ? facts.filter(
          (fact) =>
            fact.value.kind === 'holiday' &&
            fact.value.date >= toIsoDate(toKstDate(ctx.asOf)),
        )
      : facts.filter(
          (fact) =>
            fact.value.kind === 'holiday' &&
            fact.value.date === toIsoDate(toKstDate(targetDay)),
        );
  if (matches.length === 0) {
    const label =
      targetDay === null
        ? '휴강 일정'
        : `${formatKstDate(targetDay)} 휴강 공지`;
    return emptyPart('missing', [label]);
  }
  for (const fact of matches) {
    if (fact.value.kind !== 'holiday') continue;
    const description =
      fact.value.text.replace(fact.value.date, '').trim() || '휴강';
    const day = formatIsoDate(fact.value.date);
    part.lines.push(
      `${day}${josa(day, '은', '는')} ${description}입니다(학원 공지).`,
    );
    part.citations.push({ kind: 'fact', fact });
    part.usedFacts.push(fact);
  }
  return part;
}

async function answerMakeup(
  ctx: AnswerContext,
  effective: EffectiveTime,
): Promise<Part> {
  const facts = await loadFacts(ctx, ['makeup_policy'], effective);
  if (facts.length === 0) return emptyPart('missing', ['보강 규정']);
  if (hasConflict(facts)) return emptyPart('conflict', ['보강 규정']);
  const fact = facts[0];
  const text = fact.value.kind === 'text' ? fact.value.text : '';
  const part = emptyPart('ok');
  part.lines.push(`등록된 운영 규정에 따른 보강 기준: ${text}.`);
  part.citations.push({ kind: 'fact', fact, effectiveAt: effective.at });
  part.usedFacts.push(fact);
  if (ctx.frame.flags.unconditional) {
    part.lines.push(
      '규정에 무조건(자동) 승인한다는 내용은 없으므로, 구체적인 가능 여부는 담당자에게 확인해 주세요.',
    );
  }
  if (ctx.frame.flags.countLimit) {
    const evidence = await findSentence(
      ctx,
      ['보강', '횟수', '회', '번'],
      (sentence) => /횟수|\d+\s*(회|번)/.test(sentence),
    );
    if (evidence) {
      part.lines.push(`관련 규정: "${evidence.sentence}"`);
      part.citations.push({ kind: 'chunk', chunk: evidence.chunk });
    } else {
      part.outcome = 'partial';
      part.missing.push('보강 횟수 기준');
      part.lines.push('보강 가능 횟수는 등록된 규정에서 확인되지 않습니다.');
    }
  }
  return part;
}

/** 승인 문서에서 조건을 만족하는 "자료 없음"이 아닌 문장을 찾는다. */
async function findSentence(
  ctx: AnswerContext,
  queryTerms: readonly string[],
  predicate: (sentence: string) => boolean,
): Promise<{ chunk: RagChunk; sentence: string } | null> {
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: queryTerms.join(' '),
    limit: ctx.config.searchLimit,
  });
  recordChunks(
    ctx.trace,
    results.map((result) => result.chunk),
  );
  for (const { chunk } of results) {
    for (const sentence of splitSentences(chunk.text)) {
      if (!isDataAbsenceStatement(sentence) && predicate(sentence))
        return { chunk, sentence };
    }
  }
  return null;
}

async function answerAttribute(
  ctx: AnswerContext,
  topic: TopicDefinition,
  effective: EffectiveTime,
): Promise<Part> {
  const evidenceTerms = topic.evidenceTerms ?? topic.terms;
  const facts = await loadFacts(ctx, [...topic.factTypes], effective);
  const matchingFact = facts.find((fact) => {
    const text = fact.value.kind === 'text' ? fact.value.text : '';
    return containsAny(text, evidenceTerms) && !isDataAbsenceStatement(text);
  });
  const part = emptyPart('ok');
  if (matchingFact && matchingFact.value.kind === 'text') {
    part.lines.push(`등록된 안내 자료에 따르면: ${matchingFact.value.text}.`);
    part.citations.push({
      kind: 'fact',
      fact: matchingFact,
      effectiveAt: effective.at,
    });
    part.usedFacts.push(matchingFact);
    return part;
  }
  const evidence = await findSentence(
    ctx,
    [...evidenceTerms, ...topic.terms],
    (sentence) => containsAny(sentence, evidenceTerms),
  );
  if (!evidence) return emptyPart('missing', [topic.label]);
  part.lines.push(`등록된 안내 자료에 따르면: "${evidence.sentence}"`);
  part.citations.push({ kind: 'chunk', chunk: evidence.chunk });
  part.usedFacts.push(
    ...facts.filter((fact) => fact.sourceId === evidence.chunk.sourceId),
  );
  return part;
}

const STOPWORDS = new Set([
  '알려줘',
  '알려주세요',
  '알려',
  '주세요',
  '있나요',
  '있어요',
  '있습니까',
  '뭐예요',
  '무엇',
  '무엇인가요',
  '어떻게',
  '어디',
  '인가요',
  '되나요',
  '해주세요',
  '궁금해요',
  '궁금합니다',
  '문의',
  '혹시',
  '정보',
  '학원',
  '관련',
  '대해',
  '대한',
  '좀',
  '그',
  '이',
  '저',
]);

function contentWords(question: string): string[] {
  const words = normalizeText(question)
    .split(/[^0-9a-z가-힣]+/)
    .map((word) =>
      word.replace(
        /(에서는|에서|으로|에게|까지|부터|이나|이랑|하고|은|는|이|가|을|를|의|에|도|만|요)$/,
        '',
      ),
    )
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

async function answerGeneric(ctx: AnswerContext): Promise<AnswerDraft> {
  const words = contentWords(ctx.question);
  if (words.length === 0) {
    return abstain(
      '질문하신 내용을 등록된 자료에서 확인할 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  }
  const evidence = await findSentence(ctx, words, (sentence) => {
    const compact = compactText(sentence);
    return words.every((word) => compact.includes(compactText(word)));
  });
  if (!evidence) {
    return abstain(
      '질문하신 내용을 등록된 승인 자료에서 확인할 수 없어 답변드리기 어렵습니다. 담당자 상담으로 연결해 드릴 수 있습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  }
  return {
    status: 'answered',
    text: `등록된 자료에 따르면: "${evidence.sentence}"`,
    citations: [{ kind: 'chunk', chunk: evidence.chunk }],
    usedFacts: [],
  };
}

export async function answerInfo(ctx: AnswerContext): Promise<AnswerDraft> {
  const effective = resolveEffectiveTime(ctx.frame, ctx.asOf);
  const topics = ctx.frame.topics;
  ctx.trace.intent =
    topics.length > 0
      ? topics.map((topic) => topic.id).join('+')
      : 'general_info';

  let selectedTopics: TopicDefinition[] = [...topics];
  if (selectedTopics.length === 0) {
    if (ctx.frame.classIds.length === 0) return answerGeneric(ctx);
    // 반만 언급된 경우 해당 반의 수강료·시간표·강사를 함께 안내한다.
    selectedTopics = ctx.config.topics.filter((topic) =>
      ['fee', 'schedule', 'teacher'].includes(topic.id),
    );
  }

  // 1) 속성 주제(시설·연락처 등)가 하나라도 확인되지 않으면 전체 보류(그 속성이 실제 질문 대상이므로)
  const parts: Part[] = [];
  const missingAttributes: string[] = [];
  for (const topic of selectedTopics.filter((t) => t.kind === 'attribute')) {
    const part = await answerAttribute(ctx, topic, effective);
    if (part.outcome === 'missing') missingAttributes.push(topic.label);
    else parts.push(part);
  }
  if (missingAttributes.length > 0) {
    return abstain(
      `${missingAttributes.join(', ')} 관련 내용은 등록된 승인 자료에서 확인되지 않아 안내해 드릴 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.`,
      'INSUFFICIENT_EVIDENCE',
      missingAttributes,
      ['INSUFFICIENT_EVIDENCE'],
    );
  }

  // 2) 정형 주제
  for (const topic of selectedTopics.filter((t) => t.kind === 'structured')) {
    switch (topic.id) {
      case 'fee':
        parts.push(await answerFee(ctx, effective));
        break;
      case 'schedule':
        parts.push(await answerSchedule(ctx, effective));
        break;
      case 'teacher':
        parts.push(await answerTeacher(ctx, effective));
        break;
      case 'holiday':
        parts.push(await answerHoliday(ctx, effective));
        break;
      case 'makeup':
        parts.push(await answerMakeup(ctx, effective));
        break;
      default:
        parts.push(emptyPart('missing', [topic.label]));
    }
  }

  if (parts.some((part) => part.outcome === 'conflict')) {
    return {
      ...abstain(
        '승인된 자료끼리 내용이 서로 달라 정확한 안내가 어렵습니다. 담당자에게 확인 후 안내해 드리겠습니다.',
        'CONFLICTING_EVIDENCE',
        parts.flatMap((part) =>
          part.outcome === 'conflict' ? part.missing : [],
        ),
        ['CONTRADICTION'],
      ),
    };
  }

  const answered = parts.filter(
    (part) => part.outcome === 'ok' || part.outcome === 'partial',
  );
  const missing = parts.flatMap((part) => part.missing);
  if (answered.length === 0) {
    const label =
      missing.length > 0
        ? `요청하신 내용(${missing.join(', ')})`
        : '요청하신 내용';
    return abstain(
      `${label}은 등록된 승인 자료에서 확인되지 않아 안내해 드릴 수 없습니다. 담당자 상담으로 연결해 드릴 수 있습니다.`,
      'INSUFFICIENT_EVIDENCE',
      missing,
      ['INSUFFICIENT_EVIDENCE'],
    );
  }

  const isPartial =
    missing.length > 0 || answered.some((part) => part.outcome === 'partial');
  const lines = answered.flatMap((part) => part.lines);
  if (isPartial) lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  return {
    status: isPartial ? 'partial' : 'answered',
    text: lines.join('\n'),
    citations: answered.flatMap((part) => part.citations),
    usedFacts: answered.flatMap((part) => part.usedFacts),
    missingFields: isPartial ? missing : undefined,
    reasonCode: isPartial ? 'PARTIAL_EVIDENCE' : undefined,
    derivedNumbers: answered.flatMap((part) => part.derived),
    instants: [effective.at, effective.explicitDay, ctx.asOf].filter(
      (v): v is number => v !== null,
    ),
    conversationUpdate: {
      previousFrame: { domain: 'info', units: [], periods: [] },
    },
  };
}
