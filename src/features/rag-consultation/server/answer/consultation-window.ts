import { compactText } from '../text/normalize.ts';
import { formatKstDate, toKstDate } from '../text/time.ts';
import type { RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type EvidenceExcerpt,
} from './context.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';
import { tableDateAt } from './table-dates.ts';
import { supportsExcerpt } from './verify.ts';

type Field = 'period' | 'open' | 'close';

const labels: Record<Field, string> = {
  period: '상담 운영 기간',
  open: '상담 신청 시작일',
  close: '상담 신청 마감일',
};
const consultation = /상담\s*(?:주간|기간|일정|운영)|(?:학부모|보호자)\s*상담/;
const parent = /학부모|보호자/;
const otherEvent = /입학\s*상담|진로\s*상담|발표회|재등록|설명회/;
const operation = /상담\s*(?:주간|기간|일정|운영|(?:을\s*)?(?:진행|드립))/;
const withdrawn =
  /변경|취소|휴강|제외|미운영|연기|중단|하지\s*(?:않|마|못)|받지\s*(?:않|못)/;
const booking = '(?:신청|접수|예약)';
const start = '(?:시작(?:일)?|개시(?:일)?)';
const end = '(?:마감(?:일)?|기한|종료(?:일)?)';
const signupColumn = {
  open: new RegExp('^(?:상담)?' + booking + start + '$'),
  close: new RegExp('^(?:상담)?' + booking + end + '$'),
};
const signupLabel = {
  open: new RegExp(
    '^(?:상담\\s*(?:시간\\s*)?)?' + booking + '\\s*' + start + '\\s*[:：]?\\s*',
  ),
  close: new RegExp(
    '^(?:상담\\s*(?:시간\\s*)?)?' + booking + '\\s*' + end + '\\s*[:：]?\\s*',
  ),
};

const year = '(?:\\d{4}\\s*년\\s*)?';
const month = '\\d{1,2}\\s*월\\s*';
const day = '\\d{1,2}\\s*일(?:\\s*\\([월화수목금토일](?:요일)?\\))?(?!\\s*\\()';
const fullDate = '(?<!\\d)' + year + month + day;
const range = new RegExp(
  '(' +
    fullDate +
    ')\\s*(~|～|–|—|부\\s*터|\\s-\\s)\\s*(' +
    '(?:' +
    year +
    month +
    ')?' +
    day +
    ')(?:\\s*(까\\s*지))?',
  'g',
);
const dateOnly = new RegExp('^' + fullDate + '$');
const datePrefix = new RegExp('^' + fullDate);
const periodLabel = new RegExp(
  '^(?:운영\\s*기간\\s*[:：]\\s*)?' + range.source + '$',
);
const markedDate = new RegExp('(' + fullDate + ')\\s*(부\\s*터|까\\s*지)', 'g');

interface RawClaim {
  field: Field;
  value: string;
  excerpt: EvidenceExcerpt;
}

interface DateClaim extends RawClaim {
  dates: [number] | [number, number];
}

function requestedFields(question: string): Field[] {
  const period =
    /상담\s*(?:주간\s*)?(?:운영\s*)?(?:주간|기간|일정)(?:은|이|을)?\s*(?:언제|며칠|알려|이랑|하고|및|과|와|,)/;
  if (!period.test(question)) return [];
  const fields: Field[] = ['period'];
  const has = (cue: string) =>
    new RegExp(booking + '(?:은|는|을|이)?\\s*' + cue).test(question);
  if (has('(?:언제\\s*부터|' + start + ')')) fields.push('open');
  if (has('(?:언제\\s*까지|' + end + ')')) fields.push('close');
  return fields.length > 1 ? fields : [];
}

function dateParts(value: string) {
  const match =
    /^(?:(\d{4})\s*년\s*)?(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일/.exec(value);
  return {
    year: Number(match?.[1]) || undefined,
    month: Number(match?.[2]) || undefined,
  };
}

function parsePeriod(
  value: string,
  inferredYear: number,
): [number, number] | undefined {
  const matches = [...value.matchAll(range)];
  if (matches.length !== 1) return;
  const [, first, separator, last, inclusive] = matches[0];
  if (separator.startsWith('부') && !inclusive) return;
  const fromParts = dateParts(first);
  const toParts = dateParts(last);
  const fromYear =
    fromParts.year ??
    (toParts.year === undefined
      ? inferredYear
      : toParts.year - Number((toParts.month ?? 0) < (fromParts.month ?? 0)));
  const monthChanged =
    toParts.month !== undefined && toParts.month < (fromParts.month ?? 0);
  const from = tableDateAt(first, fromYear);
  const to = tableDateAt(
    toParts.month === undefined ? fromParts.month + '월 ' + last : last,
    fromYear + Number(monthChanged),
  );
  if (from !== undefined && to !== undefined && from <= to) return [from, to];
}

function readClaims(
  chunk: RagChunk,
  asOf: number,
  parentOnly: boolean,
): RawClaim[] {
  const heading = chunk.location.section ?? chunk.title;
  if (
    otherEvent.test(heading) ||
    /게시판|질문\s*답변|문의\s*모음/.test(chunk.title)
  )
    return [];
  const claims: RawClaim[] = [];
  const add = (field: Field, value: string, excerpt: EvidenceExcerpt) => {
    if (
      isCleanPublicEvidence(chunk, asOf, excerpt.line) &&
      supportsExcerpt(excerpt)
    )
      claims.push({ field, value, excerpt });
  };
  const row = readEvidenceRow(chunk);
  if (row) {
    const scoped = consultation.test(heading);
    const event = row.column(/^(?:행사|행사명|프로그램)$/);
    const eventName = row.cells[event] ?? '';
    if (event >= 0 ? !consultation.test(eventName) : !scoped) return [];
    if (
      otherEvent.test(eventName) ||
      (parentOnly && !parent.test(heading + ' ' + eventName))
    )
      return [];
    const period = row.column(/^(?:상담(?:기간|주간|일정)|운영기간)$/);
    for (const [field, index] of [
      ['period', period],
      ['open', row.column(signupColumn.open)],
      ['close', row.column(signupColumn.close)],
    ] as const) {
      const excerpt =
        event >= 0 ? row.project(event, index) : row.project(index);
      if (excerpt && !withdrawn.test(row.cells[index]))
        add(field, row.cells[index].trim(), excerpt);
    }
    return claims;
  }
  if (chunk.location.kind !== 'paragraph') return [];
  const scoped = consultation.test(heading);
  for (const line of chunk.text
    .split(/(?<=[.!?。])(?:\s+|(?=[가-힣]))|\n+/)
    .map((part) => part.trim())) {
    if (!line || otherEvent.test(line) || withdrawn.test(line)) continue;
    const excerpt = { chunk, line };
    if (
      (!parentOnly || parent.test(heading + ' ' + line)) &&
      (operation.test(line) || (scoped && periodLabel.test(line))) &&
      !/신청|접수|예약/.test(line)
    )
      add('period', line, excerpt);

    const explicitBooking = /상담\s*(?:시간\s*)?(?:신청|접수|예약)/.test(line);
    const dates = explicitBooking ? [...line.matchAll(markedDate)] : [];
    const bookingRange =
      /^(?:상담\s*(?:시간\s*)?)?(?:신청|접수|예약)(?:은|는)?\s*/.exec(line);
    const linkedDates =
      dates.length === 2 &&
      bookingRange &&
      bookingRange[0].length === dates[0].index &&
      !line.slice(dates[0].index + dates[0][0].length, dates[1].index).trim();
    if (/마감되었|마감됐/.test(line)) continue;
    for (const field of ['open', 'close'] as const) {
      const labeled =
        (scoped || explicitBooking) && signupLabel[field].exec(line);
      if (labeled) {
        const token = datePrefix.exec(line.slice(labeled[0].length))?.[0];
        if (token) add(field, token, excerpt);
      } else if (dates.length === 1 || linkedDates) {
        const marker = field === 'open' ? '부터' : '까지';
        for (const [, token, role] of dates) {
          if (compactText(role) === marker) add(field, token, excerpt);
        }
      }
    }
  }
  return claims;
}

function uniqueClaim(claims: DateClaim[], field: Field): DateClaim | undefined {
  const values = claims.filter((claim) => claim.field === field);
  if (new Set(values.map(({ dates }) => dates.join(','))).size === 1)
    return values[0];
}

export async function answerConsultationWindow(ctx: AnswerContext) {
  const { frame, asOf } = ctx;
  const fields = requestedFields(frame.normalized);
  if (!fields.length || otherEvent.test(frame.normalized)) return;
  const missing = () =>
    abstain(
      '상담 운영 기간과 신청 일정을 같은 회차의 승인 자료에서 확인하기 어렵습니다.',
      'INSUFFICIENT_EVIDENCE',
      fields.map((field) => labels[field]),
    );
  const months = frame.months;
  const years = [...frame.normalized.matchAll(/(\d{4})\s*년/g)].map((match) =>
    Number(match[1]),
  );
  if (
    months.length > 1 ||
    years.length > 1 ||
    frame.flags.compare ||
    /말고|제외|빼고|아니라|아닌/.test(frame.normalized) ||
    frame.selfReference ||
    frame.explicitDates.length ||
    frame.relativePeriod ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.classIds.length ||
    ctx.studentClassIds.length ||
    frame.matchedStudentIds.length ||
    frame.subjects.length ||
    frame.unknownPrograms.length ||
    frame.unboundProgram
  )
    return missing();

  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf,
    query: ctx.question + ' 학부모 상담 주간 운영 신청 접수 시작 마감',
    documentTypes: ['announcement', 'academy_info', 'schedule', 'policy'],
    limit: 60,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const groups = new Map<string, RawClaim[]>();
  for (const { chunk } of found) {
    if (chunk.classId) continue;
    const { kind, section, sectionIndex } = chunk.location;
    const key =
      kind === 'paragraph' &&
      section &&
      consultation.test(section) &&
      sectionIndex !== undefined
        ? JSON.stringify([chunk.sourceId, sectionIndex])
        : chunk.chunkId;
    const claims = readClaims(chunk, asOf, parent.test(ctx.question));
    if (claims.length) groups.set(key, [...(groups.get(key) ?? []), ...claims]);
  }
  const queryYear = years[0] ?? toKstDate(asOf).year;
  const firstMonth = queryYear * 12 + (months[0] ?? 1);
  const lastMonth = queryYear * 12 + (months[0] ?? 12);
  const overlaps = ([from, to]: [number, number]) => {
    const first = toKstDate(from);
    const last = toKstDate(to);
    return (
      first.year * 12 + first.month <= lastMonth &&
      firstMonth <= last.year * 12 + last.month
    );
  };
  const candidates: DateClaim[][] = [];
  for (const claims of groups.values()) {
    const periods = claims.flatMap((claim) => {
      if (claim.field !== 'period') return [];
      const current = parsePeriod(claim.value, queryYear);
      const previous = parsePeriod(claim.value, queryYear - 1);
      const dates =
        previous && overlaps(previous) && (!current || !overlaps(current))
          ? previous
          : current;
      return dates ? [{ ...claim, dates }] : [];
    });
    const period = uniqueClaim(
      periods.filter(({ dates }) => overlaps(dates)),
      'period',
    );
    if (period?.dates.length !== 2) continue;
    // A generic signup line has no cycle identity inside a multi-cycle section.
    if (!uniqueClaim(periods, 'period')) {
      candidates.push([period]);
      continue;
    }
    const [firstDay, lastDay] = period.dates;
    const event = toKstDate(firstDay);
    const openOrClose = claims.flatMap((claim) => {
      if (claim.field === 'period' || !dateOnly.test(claim.value)) return [];
      const date = dateParts(claim.value);
      const inferredYear =
        event.year - Number(event.month === 1 && date.month === 12);
      const at = tableDateAt(claim.value, inferredYear);
      return at !== undefined && at <= lastDay
        ? [{ ...claim, dates: [at] as [number] }]
        : [];
    });
    const open = uniqueClaim(openOrClose, 'open');
    const close = uniqueClaim(openOrClose, 'close');
    if (open && close && open.dates[0] > close.dates[0]) {
      candidates.push([period]);
      continue;
    }
    candidates.push([
      period,
      ...[open, close].flatMap((claim) =>
        claim && fields.includes(claim.field) ? [claim] : [],
      ),
    ]);
  }
  if (!candidates.length) return missing();
  if (
    fields.some(
      (field) =>
        new Set(
          candidates.flatMap((claims) =>
            claims
              .filter((claim) => claim.field === field)
              .map(({ dates }) => dates.join(',')),
          ),
        ).size > 1,
    )
  )
    return abstain(
      '승인 자료마다 상담 일정이 달라 정확한 회차를 확인해야 합니다.',
      'CONFLICTING_EVIDENCE',
      fields.map((field) => labels[field]),
    );
  const selected = candidates.sort((a, b) => b.length - a.length)[0];
  const absent = fields.filter(
    (field) => !selected.some((claim) => claim.field === field),
  );
  const missingLabels = absent.map((field) => labels[field]);
  if (/어디|장소/.test(frame.normalized)) missingLabels.push('상담 장소');
  if (/몇\s*시|시간대/.test(frame.normalized)) missingLabels.push('상담 시간');
  if (/어떻게|(?:신청|접수|예약)\s*방법/.test(frame.normalized))
    missingLabels.push('상담 신청 방법');
  const draft = fromPublicExcerpts(
    selected.map(({ excerpt }) => excerpt),
    missingLabels,
  );
  draft.text = [
    ...selected.map(
      ({ field, dates }) =>
        labels[field] + ' ' + dates.map(formatKstDate).join(' ~ '),
    ),
    ...(missingLabels.length
      ? ['확인되지 않은 항목 ' + missingLabels.join(', ')]
      : []),
  ].join('\n');
  draft.instants = selected.flatMap(({ dates }) => dates);
  return draft;
}
