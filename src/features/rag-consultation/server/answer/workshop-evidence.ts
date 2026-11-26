import { cohortNumbers } from './offering-evidence.ts';
import { explicitClassIds } from './info.ts';
import { isAssistantDirective } from '../ingest/validation.ts';
import { gradeBand } from '../query/grade-band.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import {
  abstain,
  recordChunks,
  recordFacts,
  type AnswerContext,
  type AnswerDraft,
  type CitationRequest,
  type EvidenceExcerpt,
} from './context.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

export async function answerWorkshopSession(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const title = /([가-힣a-z]{2,})\s*특강/i.exec(frame.normalized)?.[1];
  const rounds = [...frame.normalized.matchAll(/(?<!\d)(\d+)\s*회차/g)];
  const asksFee = /얼마|수강료|가격|금액|참가비/.test(frame.normalized);
  const asksDate = /날짜|언제|며칠|몇\s*일/.test(frame.normalized);
  if (
    !title ||
    rounds.length !== 1 ||
    (!asksFee && !asksDate) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    /환불|할인|작년|지난|내년|취소|변경|보강/.test(frame.normalized)
  )
    return;
  const round = Number(rounds[0][1]);
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: title + ' 특강 회차 일시 수강료',
    documentTypes: ['announcement', 'schedule', 'fee'],
    limit: 65,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const targetClasses = explicitClassIds(ctx);
  const matches = hits.flatMap(({ chunk }) => {
    if (
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      (chunk.classId && !targetClasses.includes(chunk.classId))
    )
      return [];
    const label = compactText(
      chunk.title + ' ' + (chunk.location.section ?? ''),
    );
    if (!label.includes(compactText(title) + '특강')) return [];
    const row = readEvidenceRow(chunk);
    if (!row) return [];
    const key = row.column(/^(?:회차|수업회차|차시)$/);
    const parsed = /^(?:제\s*)?(\d+)\s*(?:회차|차시)?$/.exec(
      row.cells[key]?.trim() ?? '',
    );
    if (!parsed || Number(parsed[1]) !== round) return [];
    const date = row.column(/^(?:날짜|일시|수업일|수업일시)$/);
    const fee = row.column(/^(?:수강료|참가비|회차별수강료|1회수강료)$/);
    const missing: string[] = [];
    const columns = [key];
    if (asksDate) {
      if (/\d{1,2}월\s*\d{1,2}일|\d{4}-\d{2}-\d{2}/.test(row.cells[date] ?? ''))
        columns.push(date);
      else missing.push('회차 날짜');
    }
    if (asksFee) {
      if (/^\d[\d,]*\s*원$/.test(row.cells[fee]?.trim() ?? ''))
        columns.push(fee);
      else missing.push('회차 수강료');
    }
    const excerpt = columns.length > 1 ? row.project(...columns) : undefined;
    return excerpt ? [{ excerpt, missing }] : [];
  });
  if (!matches.length)
    return abstain(
      '해당 특강 회차의 날짜나 수강료를 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (new Set(matches.map(({ excerpt }) => compactText(excerpt.line))).size > 1)
    return abstain(
      '해당 특강 회차의 승인 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'workshop_session';
  return fromPublicExcerpts([matches[0].excerpt], matches[0].missing);
}

export async function answerCohortAssessment(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const cohorts = cohortNumbers(frame.normalized);
  const [cohort] = cohorts;
  if (
    cohorts.size !== 1 ||
    !/모의\s*고사/.test(frame.normalized) ||
    !/몇\s*(?:번|회)|횟수/.test(frame.normalized) ||
    /몇\s*문제|문항|비교|시험\s*시간|시간표|취소/.test(frame.normalized) ||
    frame.explicitDates.length ||
    frame.relativePeriod ||
    frame.months.length
  )
    return;
  const [classId, other] = explicitClassIds(ctx);
  const klass =
    !other && ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: klass.name + ' ' + cohort + '기 모의고사 실시 횟수',
    documentTypes: ['announcement', 'curriculum', 'schedule'],
    limit: 60,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const classes = [klass.name, ...klass.aliases]
    .map(compactText)
    .filter(
      (label) =>
        label.length >= 4 &&
        !ctx.catalog.classes.some(
          (entry) =>
            entry.classId !== classId &&
            [entry.name, ...entry.aliases].some(
              (alias) => compactText(alias) === label,
            ),
        ),
    );
  const matches = hits.flatMap(({ chunk }) => {
    if (
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      chunk.location.kind !== 'paragraph' ||
      (chunk.classId && chunk.classId !== classId)
    )
      return [];
    return splitSentences(chunk.text).flatMap((line) => {
      const known = cohortNumbers(
        chunk.title + ' ' + (chunk.location.section ?? '') + ' ' + line,
      );
      const count =
        /모의\s*고사(?:는|를|를\s*총|는\s*총)?\s*(\d+)\s*회(?:를|씩)?\s*(?:실시|진행|치릅|봅니다|봅)/.exec(
          line,
        )?.[1];
      return count &&
        known.size === 1 &&
        known.has(cohort) &&
        classes.some((label) =>
          compactText(line + ' ' + (chunk.location.section ?? '')).includes(
            label,
          ),
        ) &&
        !/취소|검토|미정|않/.test(line)
        ? [{ chunk, line, count }]
        : [];
    });
  });
  if (!matches.length)
    return abstain(
      '해당 반과 기수의 승인 모의고사 횟수를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (new Set(matches.map(({ count }) => count)).size > 1)
    return abstain(
      '해당 기수의 승인 모의고사 횟수가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'cohort_assessment_count';
  return fromPublicExcerpts([matches[0]]);
}

const timeRange =
  /(?:[01]?\d|2[0-3]):[0-5]\d\s*[~～–-]\s*(?:[01]?\d|2[0-3]):[0-5]\d/;
const workshopName = /^([가-힣a-z\d·: ]{2,45}?특강)(?:은|는|이|가|을|를|:)\s*/i;
const bandText =
  /([초중고][1-6](?:[·~–-](?:[초중고])?[1-6])*)\s*(?:학년)?\s*대상/;
const requestTime = /시간표|일정|시간|몇\s*시|무슨\s*요일|어느\s*요일|언제/;
const price = /(?:수강료|참가비|교습비)(?:는|은|:)?\s*(\d[\d,]*\s*원)/;
const seasonPattern = /(?:여름|겨울)\s*방학/;
const gradePattern =
  /(?<![가-힣\d])([초중고])?\s*([1-6])\s*학년|(?<![가-힣\d])([초중고])([1-6])(?!\d)/g;

function topicWords(label: string) {
  return label
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => !/^(?:집중|대비|심화|특강)$/.test(word));
}

/** Offerings are separate from regular classes even when their level or subject is shared. */
export async function answerWorkshopEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const season = seasonPattern.exec(q)?.[0];
  const asksFee = /수강료|가격|참가비|얼마/.test(q);
  if (
    !season ||
    !/특강/.test(q) ||
    !requestTime.test(q) ||
    /취소|보강|비교|할인|환불|자리|신청\s*마감|지난|작년|대신/.test(q) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    frame.relativeWeek ||
    frame.relativeDay !== null
  )
    return;

  const grades = [...q.matchAll(gradePattern)];
  const onlyElementary =
    ctx.catalog.classes.length > 0 &&
    ctx.catalog.classes.every(
      ({ grade }) =>
        grade &&
        gradeBand(grade).length &&
        gradeBand(grade).every((value) => value <= 6),
    );
  const grade =
    grades.length === 1
      ? gradeBand(
          (grades[0][1] || grades[0][3] || (onlyElementary ? '초' : '')) +
            (grades[0][2] || grades[0][4]),
        )[0]
      : undefined;
  if (grades.length && grade === undefined) return;

  const names = ctx.catalog.classes.filter(({ classId }) =>
    frame.classIds.includes(classId),
  );
  const aliases =
    names.length === 1
      ? [names[0].name, ...names[0].aliases].map(compactText)
      : [];
  const matches = (name: string) => {
    const words = topicWords(name);
    if (!words.length) return false;
    if (words.every((word) => frame.compact.includes(compactText(word))))
      return true;
    return (
      names.length === 1 &&
      words.every(
        (word) =>
          frame.compact.includes(compactText(word)) ||
          aliases.some((alias) => alias.includes(compactText(word))),
      )
    );
  };
  const gradeMatches = (label: string) =>
    grade === undefined || gradeBand(label).includes(grade);
  const inSeason = (text: string) =>
    compactText(text).includes(compactText(season));

  const [hits, facts] = await Promise.all([
    ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      query: [ctx.question, ...aliases, '특강 기간 요일 시간 수강료'].join(' '),
      documentTypes: ['announcement', 'schedule', 'curriculum'],
      limit: 80,
    }),
    ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      factTypes: ['notice'],
    }),
  ]);
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  recordFacts(ctx.trace, facts);
  const options: Array<{
    name: string;
    text: string;
    fee?: string;
    citation: CitationRequest;
    excerpt?: EvidenceExcerpt;
  }> = [];
  for (const { chunk } of hits) {
    if (
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      chunk.classId !== null ||
      !inSeason(chunk.title + ' ' + (chunk.location.section ?? ''))
    )
      continue;
    const row = readEvidenceRow(chunk);
    if (row) {
      const key = row.column(/^(?:특강|과정|강좌|과정명|강좌명)$/);
      const name = row.cells[key] ?? '';
      const target = row.column(/^(?:대상|대상학년)$/);
      const time = row.column(/^(?:수업|운영)?(?:시간|요일·시간|요일및시간)$/);
      const feeColumn = row.column(/^(?:수강료|참가비)$/);
      const fee = /^\d[\d,]*\s*원$/.test(row.cells[feeColumn] ?? '')
        ? row.cells[feeColumn]
        : undefined;
      if (
        !/특강/.test(name) ||
        !matches(name) ||
        !gradeMatches(row.cells[target] ?? '') ||
        !timeRange.test(row.cells[time] ?? '')
      )
        continue;
      const excerpt = row.project(
        key,
        ...(target >= 0 ? [target] : []),
        time,
        ...(asksFee && fee ? [feeColumn] : []),
      );
      if (excerpt)
        options.push({
          name,
          text: excerpt.line,
          fee,
          excerpt,
          citation: {
            kind: 'chunk',
            chunk,
            tableColumns: excerpt.tableColumns,
          },
        });
      continue;
    }
    if (chunk.location.kind !== 'paragraph') continue;
    for (const line of splitSentences(chunk.text)) {
      const name = workshopName.exec(line)?.[1];
      if (
        !name ||
        !matches(name) ||
        !gradeMatches(bandText.exec(line)?.[1] ?? '') ||
        !timeRange.test(line) ||
        /미정|취소|열지\s*않/.test(line)
      )
        continue;
      const excerpt = { chunk, line };
      options.push({
        name,
        text: line,
        fee: price.exec(line)?.[1],
        excerpt,
        citation: { kind: 'chunk', chunk },
      });
    }
  }
  for (const fact of facts) {
    if (
      fact.subjectType !== 'academy' ||
      fact.value.kind !== 'text' ||
      isAssistantDirective(fact.value.text)
    )
      continue;
    const line = fact.value.text.trim();
    const name = workshopName.exec(line)?.[1];
    if (
      !name ||
      !matches(name) ||
      !gradeMatches(bandText.exec(line)?.[1] ?? '') ||
      !timeRange.test(line) ||
      /미정|취소|열지\s*않/.test(line)
    )
      continue;
    const source = await ctx.documents.getCitableSource({
      access: ctx.access,
      studentIds: [],
      sourceId: fact.sourceId,
      asOf: ctx.asOf,
    });
    if (!source || !inSeason(source.title + ' ' + line)) continue;
    options.push({
      name,
      text: line,
      fee: price.exec(line)?.[1],
      citation: { kind: 'fact', fact },
    });
  }
  if (!options.length) return;
  if (
    new Set(
      options.map(({ name, text, fee }) =>
        [
          compactText(name),
          compactText(timeRange.exec(text)?.[0] ?? ''),
          asksFee ? (fee ?? '') : '',
        ].join('|'),
      ),
    ).size !== 1
  )
    return abstain(
      '해당 특강의 일정 또는 요금 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [selected] = options;
  const missing = asksFee && !selected.fee;
  ctx.trace.intent = 'workshop_schedule';
  return {
    status: missing ? 'partial' : 'answered',
    reasonCode: missing ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing ? ['특강 수강료'] : undefined,
    text:
      selected.text +
      (missing ? '\n확인되지 않은 항목은 특강 수강료입니다.' : ''),
    citations: [selected.citation],
    excerpts: selected.excerpt ? [selected.excerpt] : [],
    usedFacts:
      selected.citation.kind === 'fact' ? [selected.citation.fact] : [],
  };
}
