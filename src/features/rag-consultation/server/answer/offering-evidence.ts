import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { formatKstDate, isValidAt } from '../text/time.ts';
import type { ApprovedFact, FactType, RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  recordFacts,
  type AnswerContext,
  type AnswerDraft,
  type CitationRequest,
  type EvidenceExcerpt,
} from './context.ts';
import { formatKrw } from './format.ts';
import { explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

export const cohortNumbers = (text: string) =>
  new Set(
    [
      ...text.matchAll(
        /(?<![가-힣a-z\d])(\d{1,3})\s*기(?=$|[^가-힣a-z\d]|(?:부터|까지|도|는|가|에|엔|랑|와|를|의)(?![가-힣a-z\d]))/gi,
      ),
    ].map(([, value]) => Number(value)),
  );

const TIME_RANGE = /\d{1,2}:[0-5]\d\s*[~～–-]\s*\d{1,2}:[0-5]\d/;
const CLASS_HEADER = /^(?:반|반명|과정|과정명|강좌|강좌명)$/;
const TIME_HEADER = /^(?:수업시간|시간|요일·시간|수업요일·시간)$/;

function tableProof(
  chunk: RagChunk,
  classColumn: number,
  fieldColumn: number,
): EvidenceExcerpt | undefined {
  const { header, cells } = chunk.location;
  if (!header || !cells || fieldColumn < 0) return;
  const tableColumns = [classColumn, fieldColumn];
  const line = [...new Set([0, ...tableColumns])]
    .map((index) => header[index] + ': ' + cells[index])
    .join(' / ');
  const excerpt = { chunk, line, tableColumns };
  return supportsExcerpt(excerpt) ? excerpt : undefined;
}

function feeColumn(label: string, type: FactType, cohort: number | undefined) {
  const cohorts = cohortNumbers(label);
  if (
    cohorts.size &&
    (!cohort || !cohorts.has(cohort) || /까지|이전/.test(label))
  )
    return false;
  const field = compactText(label)
    .replace(/^(?:개정|변경)/, '')
    .replace(/\(\d{1,3}기(?:부터)?\)$/, '');
  return type === 'monthly_fee'
    ? /^(?:(?:월|매월|\d+주))?(?:수강료|교습비|학원비)(?:\((?:월|\d+주)\))?$/.test(
        field,
      )
    : /^교재비(?:\((?:월|학기)\))?$/.test(field);
}

function approvedOfferingChunk(ctx: AnswerContext, chunk: RagChunk) {
  return (
    chunk.visibility === 'academy_public' &&
    canReadRecord(ctx.access, chunk, []) &&
    !chunk.suspicious &&
    !isAssistantDirective(chunk.text) &&
    !chunk.extraction?.needsReview &&
    !chunk.extraction?.uncertainTokens.length
  );
}

const DATE = '(?:\\d{4}\\s*년\\s*)?\\d{1,2}\\s*월\\s*\\d{1,2}\\s*일';

/** A term's end date and the following term's opening date have separate sources. */
export async function answerCohortBoundaries(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized } = ctx.frame;
  const cohorts = cohortNumbers(normalized);
  const [cohort] = cohorts;
  if (
    cohorts.size !== 1 ||
    !/다음\s*기수/.test(normalized) ||
    !/종강|끝나|끝날/.test(normalized) ||
    !/개강|시작/.test(normalized) ||
    /수강료|신청|등록|납부|환불|특강|휴강|보강/.test(normalized)
  )
    return;
  const next = cohort + 1;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: ctx.asOf + 93 * 86_400_000,
    query: `${cohort}기 ${next}기 수업 기간 종강 개강`,
    limit: 40,
    documentTypes: ['schedule', 'announcement'],
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const slots = [
    { number: cohort, end: true, label: `${cohort}기 종강일` },
    { number: next, end: false, label: `${next}기 개강일` },
  ];
  const lines: string[] = [];
  const citations: CitationRequest[] = [];
  const excerpts: EvidenceExcerpt[] = [];
  const missing: string[] = [];
  for (const { number, end, label } of slots) {
    const anchor = `(?<![가-힣a-z0-9])${number}\\s*기(?:는|가|의)?\\s*`;
    const range = new RegExp(
      `(?:(?<![가-힣a-z0-9])(\\d{1,3})\\s*기(?:는|가|의)?\\s*)?수업\\s*기간\\s*[:：]\\s*(${DATE})(?:\\([월화수목금토일]\\))?\\s*[~～–-]\\s*(${DATE})`,
    );
    const exact = new RegExp(
      `${anchor}(${DATE})(?:\\([월화수목금토일]\\))?(?:에|부터)?\\s*${end ? '종강' : '개강'}`,
    );
    const matches = found.flatMap(({ chunk }) => {
      if (
        !approvedOfferingChunk(ctx, chunk) ||
        chunk.classId ||
        chunk.location.kind !== 'paragraph'
      )
        return [];
      return splitSentences(chunk.text).flatMap((sentence) => {
        const hit = exact.exec(sentence);
        const interval = range.exec(sentence);
        const title = cohortNumbers(chunk.title);
        const scoped =
          interval &&
          (interval[1]
            ? Number(interval[1]) === number
            : title.size === 1 && title.has(number));
        const date = hit?.[1] ?? (scoped ? interval[end ? 3 : 2] : undefined);
        const line = hit?.[0] ?? interval?.[0];
        if (!date || !line || !supportsExcerpt({ chunk, line })) return [];
        return [
          {
            chunk,
            line,
            date,
            // Prefer a direct announcement of the boundary, then the calendar
            // itself, over a recap in admissions or curriculum material.
            priority:
              (hit ? 4 : 0) +
              (chunk.documentType === 'schedule' &&
              /시간표|수업\s*일정/.test(chunk.title)
                ? 2
                : 0) +
              (/\d{4}\s*년/.test(date) ? 1 : 0),
          },
        ];
      });
    });
    const dates = new Set(
      matches.map(({ date }) => compactText(date).replace(/^\d{4}년/, '')),
    );
    const years = new Set(
      matches.flatMap(
        ({ date }) => /\d{4}\s*년/.exec(date)?.[0].replace(/\s/g, '') ?? [],
      ),
    );
    if (dates.size !== 1 || years.size > 1) {
      missing.push(label);
      continue;
    }
    const selected = matches.reduce((best, match) =>
      match.priority > best.priority ? match : best,
    );
    lines.push(label + ': ' + selected.date);
    excerpts.push(selected);
    citations.push({
      kind: 'chunk',
      chunk: selected.chunk,
      effectiveAt: Math.max(ctx.asOf, selected.chunk.validFrom),
    });
  }
  if (!lines.length)
    return abstain(
      '요청한 기수의 종강과 개강 일정을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      missing,
    );
  if (missing.length)
    lines.push('확인되지 않은 항목: ' + missing.join(', ') + '.');
  ctx.trace.intent = 'cohort_boundaries';
  return {
    status: missing.length ? 'partial' : 'answered',
    text: lines.join('\n'),
    citations,
    excerpts,
    usedFacts: [],
    missingFields: missing.length ? missing : undefined,
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
  };
}

/** Bind one class and effective time before independently checking each requested field. */
export async function answerOfferingEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame, asOf } = ctx;
  const question = frame.normalized;
  const cohorts = cohortNumbers(question);
  const [cohort] = cohorts;
  const season = /(?:여름|겨울)\s*방학/.exec(question)?.[0];
  const scoped = Boolean(cohort || season);
  const tuition = /수강료|교습비|학원비/.test(question);
  const textbook = /교재비|책값/.test(question);
  const rental = /([가-힣a-z0-9]{2,})\s*대여료/.exec(question)?.[1];
  const schedule =
    /시간표|수업\s*시간|(?:^|\s)시간(?:이랑|랑|도|은|이|을|과|\s|$)|몇\s*시/.test(
      question,
    ) && !/몇\s*시간|운영\s*시간|납부\s*시간/.test(question);
  if (
    cohorts.size > 1 ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    frame.flags.previousRevision ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.topics.some(
      ({ id }) => !['fee', 'material', 'schedule', 'hours'].includes(id),
    ) ||
    /정원|자리|신청|납부|할부|결제|환불|할인|포함|특강|보강|휴강|등원|하원|셔틀|주차|공휴일|요일|[초중고]\d\s*학년\s*대상/.test(
      question,
    ) ||
    (!scoped &&
      !(tuition && schedule && /(?:이랑|랑|하고|및)\s/.test(question))) ||
    !(tuition || textbook || rental || schedule)
  )
    return;
  const ids = explicitClassIds(ctx);
  const previous = ctx.state?.previousFrame;
  const inherited =
    scoped &&
    schedule &&
    ids.length === 0 &&
    frame.matchedStudentIds.length === 0 &&
    frame.unresolvedRelationWords.length === 0 &&
    previous?.domain === 'info' &&
    previous.topicIds?.includes('schedule') &&
    /같|바뀌|변경/.test(question)
      ? (previous.classIds ?? [])
      : [];
  const classIds = ids.length ? ids : inherited;
  if (classIds.length !== 1) return;
  const classId = classIds[0];
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return;
  const name = klass.name;
  const names = new Set([name, ...klass.aliases].map(compactText));
  for (const other of ctx.catalog.classes) {
    if (other.classId === classId) continue;
    for (const alias of [other.name, ...other.aliases])
      names.delete(compactText(alias));
  }
  const upcomingUntil = asOf + 93 * 86_400_000;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf,
    upcomingUntil: scoped ? upcomingUntil : undefined,
    query: [
      name,
      season,
      cohort ? cohort + '기' : '',
      '수업 시간표 수강료 교재비',
    ]
      .filter(Boolean)
      .join(' '),
    limit: 70,
    documentTypes: ['schedule', 'fee'],
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const rows = hits.flatMap(({ chunk }) => {
    const { header, cells, kind } = chunk.location;
    if (
      !approvedOfferingChunk(ctx, chunk) ||
      (chunk.classId && chunk.classId !== classId) ||
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length
    )
      return [];
    const key = header.findIndex((label) =>
      CLASS_HEADER.test(compactText(label)),
    );
    return names.has(compactText(cells[key] ?? ''))
      ? [{ chunk, header, cells, key }]
      : [];
  });
  const scheduleRows = rows.flatMap(({ chunk, header, cells, key }) => {
    if (
      chunk.documentType !== 'schedule' ||
      (cohort && !cohortNumbers(chunk.title).has(cohort)) ||
      (season && !compactText(chunk.title).includes(compactText(season)))
    )
      return [];
    const time = header.findIndex((label) =>
      TIME_HEADER.test(compactText(label)),
    );
    const value = cells[time] ?? '';
    if (!TIME_RANGE.test(value)) return [];
    const excerpt = tableProof(chunk, key, time);
    return excerpt ? [{ excerpt, value }] : [];
  });
  let at = asOf;
  let startsAt: number | undefined;
  if (scoped) {
    const times = new Set(
      scheduleRows.map(({ excerpt }) => excerpt.chunk.validFrom),
    );
    if (times.size !== 1)
      return abstain(
        '요청한 기수·방학의 적용 시점을 승인 시간표에서 확인할 수 없습니다.',
        times.size > 1 ? 'CONFLICTING_EVIDENCE' : 'INSUFFICIENT_EVIDENCE',
      );
    [startsAt] = times;
    at = Math.max(asOf, startsAt);
  }
  const scheduleSources = new Set(
    scheduleRows.map(({ excerpt }) => excerpt.chunk.sourceId),
  );
  const relatedCohorts = new Set(
    scheduleRows.flatMap(({ excerpt }) => [
      ...cohortNumbers(excerpt.chunk.title),
    ]),
  );
  const appliedCohort =
    cohort ?? (relatedCohorts.size === 1 ? [...relatedCohorts][0] : undefined);

  const requests: Array<{ label: string; type: FactType }> = [];
  if (tuition) requests.push({ label: '수강료', type: 'monthly_fee' });
  if (textbook) requests.push({ label: '교재비', type: 'material_fee' });
  if (rental) requests.push({ label: rental + ' 대여료', type: 'notice' });
  if (schedule) requests.push({ label: '수업 시간', type: 'schedule' });
  const found = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf,
    effectiveAt: at,
    factTypes: requests.map(({ type }) => type),
  });
  recordFacts(ctx.trace, found);
  const lines: string[] = [];
  const usedFacts: ApprovedFact[] = [];
  const excerpts: EvidenceExcerpt[] = [];
  const citations: CitationRequest[] = [];
  const missing: string[] = [];
  for (const { label, type } of requests) {
    const options = found.flatMap((fact) => {
      if (
        fact.factType !== type ||
        !isValidAt(fact.validFrom, fact.validTo, at) ||
        (type === 'notice'
          ? fact.subjectType !== 'academy' ||
            fact.subjectId !== ctx.access.academyId
          : fact.subjectType !== 'class' || fact.subjectId !== classId)
      )
        return [];
      const { value } = fact;
      if (type === 'notice') {
        if (
          value.kind !== 'text' ||
          !compactText(value.text).includes(compactText(label)) ||
          [...value.text.matchAll(/\d[\d,]*\s*원/g)].length !== 1
        )
          return [];
        return [{ fact, text: value.text }];
      }
      if (type === 'schedule') {
        if (
          value.kind !== 'schedule' ||
          !TIME_RANGE.test(value.text) ||
          (scoped && !scheduleSources.has(fact.sourceId))
        )
          return [];
        return [{ fact, text: value.text }];
      }
      return value.kind === 'money'
        ? [{ fact, text: formatKrw(value.amount) }]
        : [];
    });
    const table =
      type === 'schedule'
        ? scheduleRows.filter(({ excerpt }) =>
            isValidAt(excerpt.chunk.validFrom, excerpt.chunk.validTo, at),
          )
        : type === 'notice'
          ? []
          : rows.flatMap(({ chunk, header, cells, key }) => {
              if (
                chunk.documentType !== 'fee' ||
                !isValidAt(chunk.validFrom, chunk.validTo, at)
              )
                return [];
              return header.flatMap((heading, index) => {
                if (
                  !feeColumn(heading, type, appliedCohort) ||
                  !/^\d[\d,]*\s*원$/.test(cells[index].trim())
                )
                  return [];
                const excerpt = tableProof(chunk, key, index);
                return excerpt ? [{ excerpt, value: cells[index] }] : [];
              });
            });
    const normalize = (value: string) =>
      compactText(value)
        .replace(/[～–-]/g, '~')
        .replace(/,/g, '');
    const distinct = new Set([
      ...options.map(({ text }) => normalize(text)),
      ...table.map(({ value }) => normalize(value)),
    ]);
    if (distinct.size !== 1) {
      missing.push(label);
      continue;
    }
    if (table.length) {
      const [{ excerpt }] = table;
      lines.push(excerpt.line);
      excerpts.push(excerpt);
      citations.push({
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
        effectiveAt: at,
      });
    } else {
      const [chosen] = options;
      lines.push(label + ': ' + chosen.text);
      usedFacts.push(chosen.fact);
      citations.push({ kind: 'fact', fact: chosen.fact, effectiveAt: at });
    }
  }
  if (!citations.length)
    return abstain(
      '요청한 반의 승인 비용·수업 시간 자료를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      missing,
    );
  ctx.trace.intent = 'offering_evidence';
  return {
    status: missing.length ? 'partial' : 'answered',
    text: [
      startsAt === undefined
        ? name
        : name + ' · ' + formatKstDate(startsAt) + ' 시작 기수',
      ...lines,
      ...(missing.length
        ? ['확인되지 않은 항목: ' + missing.join(', ') + '.']
        : []),
    ].join('\n'),
    citations,
    usedFacts,
    excerpts,
    instants: startsAt === undefined ? [at] : [at, startsAt],
    missingFields: missing.length ? missing : undefined,
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        units: [],
        periods: [],
        topicIds: schedule ? ['schedule'] : [tuition ? 'fee' : 'material'],
        classIds,
      },
    },
  };
}
