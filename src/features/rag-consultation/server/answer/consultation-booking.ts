import type { QueryFrame } from '../query/parse-query.ts';
import {
  compactText,
  normalizeText,
  splitSentences,
} from '../text/normalize.ts';
import { hasExplicitClockTime } from '../text/time.ts';
import type { RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type EvidenceExcerpt,
} from './context.ts';
import {
  fromPublicExcerpts,
  isCleanEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

const booking = /상담\s*예약/;
const weekday = /[월화수목금토일]요일/;
const qualifierOf = (text: string) =>
  compactText(
    text.replace(
      /^(?:[-*]\s*)?(?:혹시\s+)?(?:(?:(?:우리|저희|이)\s*)?학원(?:의|에서)?(?:\s+|$))?/,
      '',
    ),
  );

/** Identify the target independently of class timetables and signup deadlines. */
export function consultationBookingTimeRequest(frame: QueryFrame) {
  const target = booking.exec(frame.normalized);
  if (
    !target ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.selfReference ||
    frame.matchedStudentIds.length ||
    /마감|기한|까지|방법|소요|몇\s*시간|신청\s*기간/.test(frame.normalized)
  )
    return;
  const tail = frame.normalized.slice(target.index + target[0].length);
  if (/수업|보강|휴강|훈련|강의|수강료|위치|장소|담당/.test(tail)) return;
  const wantsDay = /요일/.test(tail);
  const wantsClock = /몇\s*시(?!간)|시간|시각/.test(tail);
  if (!wantsDay && !wantsClock) return;
  const qualifier = qualifierOf(frame.normalized.slice(0, target.index));
  return { qualifier, wantsDay, wantsClock, namedDay: weekday.exec(tail)?.[0] };
}

// Require a direct predicate on the booking. A clock elsewhere in the paragraph
// (even in another clause of the same sentence) does not describe that booking.
const clock =
  /(?:(?:오전|오후)\s*)?(?:\d{1,2}:\d{2}|\d{1,2}\s*시(?:\s*\d{1,2}\s*분|\s*반)?)/;
const day = /(?:(?:매주|격주)\s*)?[월화수목금토일]요일(?:마다)?/;
const bookingValue = new RegExp(
  /^상담\s*예약(?:\s*(?:시간|일시|일정))?(?:은|는|이|가)?\s*[:：]?\s*/.source +
    '(?<value>(?:' +
    day.source +
    '\\s*)?(?<start>' +
    clock.source +
    ')?' +
    '(?:\\s*[~～–-]\\s*(?<end>' +
    clock.source +
    '))?)' +
    /(?:입니다|이에요|예요|에\s*(?:시작|진행)(?:합니다|됩니다))?[.!。]?$/
      .source,
);

function bookingStatements(chunk: RagChunk) {
  if (chunk.location.kind === 'paragraph')
    return splitSentences(chunk.text).map((line) => ({
      statement: line,
      excerpt: { chunk, line },
    }));
  const row = readEvidenceRow(chunk);
  if (
    !row ||
    !/상담\s*예약$/.test(row.cells[0]) ||
    /취소|미정|연기|변경\s*전/.test(row.cells.join(' '))
  )
    return [];
  const combined = row.column(/^(?:예약)?(?:일시|요일[·/및]?시간)$/);
  const columns =
    combined > 0
      ? [combined]
      : [
          row.column(/^(?:예약)?요일$/),
          row.column(/^(?:예약)?(?:시간|시각)$/),
        ].filter((index) => index > 0);
  if (!columns.length) return [];
  const excerpt = row.project(0, ...columns);
  return excerpt
    ? [
        {
          statement: [row.cells[0], ...columns.map((i) => row.cells[i])].join(
            ' ',
          ),
          excerpt,
        },
      ]
    : [];
}

export async function answerConsultationBookingTime(ctx: AnswerContext) {
  const request = consultationBookingTimeRequest(ctx.frame);
  if (!request) return;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question,
    limit: 60,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const claims = new Map<string, EvidenceExcerpt>();
  const unqualified = new Map<string, EvidenceExcerpt>();
  for (const { chunk } of found) {
    if (
      chunk.studentId ||
      (chunk.classId && !ctx.frame.classIds.includes(chunk.classId))
    )
      continue;
    for (const { statement: raw, excerpt } of bookingStatements(chunk)) {
      if (!isCleanEvidence(chunk, ctx.asOf, excerpt.line)) continue;
      const statement = normalizeText(raw);
      const target = booking.exec(statement);
      if (!target) continue;
      const prefix = qualifierOf(statement.slice(0, target.index));
      if (
        request.qualifier &&
        !prefix.endsWith(request.qualifier) &&
        (prefix ||
          !compactText(chunk.location.section ?? chunk.title).includes(
            request.qualifier,
          ))
      )
        continue;
      const match = bookingValue.exec(statement.slice(target.index))?.groups;
      const value = match?.value.trim();
      if (
        !value ||
        (request.wantsDay && !weekday.test(value)) ||
        (request.namedDay && !value.includes(request.namedDay)) ||
        (request.wantsClock && !match?.start) ||
        (match?.start && !hasExplicitClockTime(match.start)) ||
        (match?.end && (!match.start || !hasExplicitClockTime(match.end)))
      )
        continue;
      claims.set(compactText(value), excerpt);
      if (!request.qualifier && !prefix)
        unqualified.set(compactText(value), excerpt);
    }
  }
  const selected = unqualified.size ? unqualified : claims;
  if (selected.size === 1) return fromPublicExcerpts([...selected.values()]);
  return selected.size
    ? abstain(
        '승인 자료의 상담 예약 일정이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      )
    : abstain(
        '질문하신 상담 예약 일정을 승인 자료에서 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
}
