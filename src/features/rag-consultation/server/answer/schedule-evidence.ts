import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { formatKstDate, isValidAt } from '../text/time.ts';
import {
  className,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { classTableRows, explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

const CLOCK_TIME =
  /(?:[01]?\d|2[0-3]):[0-5]\d|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/;
const WEEKDAY = /[월화수목금토일]요일/;
const ROOM = /강의실|교실|몇\s*호/;
const CLOCK_QUERY = /몇\s*시(?!간)|시작\s*시간/;
const CONDITIONAL =
  /휴강|휴원|보강|특강|시험|방학|연기|변경|대체|공휴일|안\s*하|없음|미정|제외/;

interface ScheduleSlot {
  classId: string;
  excerpts: EvidenceExcerpt[];
}

async function collectScheduleSlots(
  ctx: AnswerContext,
  classIds: readonly string[],
  effective: ReturnType<typeof resolveEffectiveTime>,
): Promise<ScheduleSlot[]> {
  const asksClockTime =
    ctx.plannedRequest?.requiredFields.includes('startTime') ||
    CLOCK_QUERY.test(ctx.frame.normalized);

  const asksRoom = ROOM.test(ctx.frame.normalized);
  return Promise.all(
    classIds.map(async (classId) => {
      const rows = await classTableRows(ctx, classId, ['schedule'], effective);
      const excerpts = rows.flatMap(({ chunk, tableColumns }) => {
        if (
          !tableColumns?.length ||
          !canReadRecord(ctx.access, chunk, []) ||
          chunk.suspicious ||
          isAssistantDirective(chunk.text) ||
          chunk.extraction?.needsReview ||
          chunk.extraction?.uncertainTokens.length
        )
          return [];
        const { cells, header } = chunk.location;
        if (!cells || !header) return [];
        const indices = [...new Set([0, ...tableColumns])];
        if (
          indices.some(
            (index) =>
              index < 0 || index >= cells.length || index >= header.length,
          )
        )
          return [];
        // A shared grid axis may contain separate weekday and weekend times.
        // The existing renderer can project a sub-cell by weekday.
        if (
          WEEKDAY.test(ctx.frame.normalized) &&
          indices.some(
            (index) =>
              /평일/.test(cells[index]) &&
              /주말|토|일요일/.test(cells[index]) &&
              [
                ...cells[index].matchAll(
                  /\d{1,2}:\d{2}\s*[~～–-]\s*\d{1,2}:\d{2}/g,
                ),
              ].length > 1,
          )
        )
          return [];
        const values = indices.map((index) => cells[index]).join(' ');
        if (
          asksRoom &&
          !indices.some(
            (index) => ROOM.test(header[index]) && cells[index].trim(),
          )
        )
          return [];
        if (
          CONDITIONAL.test(values) ||
          (asksClockTime && !CLOCK_TIME.test(values))
        )
          return [];

        const excerpt = {
          chunk,
          tableColumns,
          line: indices
            .map((index) => header[index] + ': ' + cells[index])
            .join(' / '),
        };
        return supportsExcerpt(excerpt) ? [excerpt] : [];
      });
      return { classId, excerpts };
    }),
  );
}

/** Answers bounded schedule questions directly from verified table projections. */
export async function answerFromScheduleEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const classIds = explicitClassIds(ctx);
  if (
    classIds.length === 0 ||
    frame.topics.length !== 1 ||
    frame.topics[0].id !== 'schedule' ||
    !/시간표|몇\s*시(?!간)|수업\s*시간|요일/.test(frame.normalized) ||
    CONDITIONAL.test(frame.normalized) ||
    /평일|주말|[월화수목금토일]욜/.test(frame.normalized) ||
    /몇\s*분|몇\s*시간|동안|까지|언제\s*부터|몇\s*번/.test(frame.normalized) ||
    frame.flags.compare ||
    frame.flags.previousRevision
  )
    return undefined;

  const effective = resolveEffectiveTime(frame, ctx.asOf);
  const expectsQualifiedClass = ctx.catalog.classes.some(
    (entry) =>
      classIds.includes(entry.classId) && /\([초중고][1-6]/.test(entry.name),
  );
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: ['schedule'],
    asOf: ctx.asOf,
    effectiveAt: effective.at,
  });
  recordFacts(ctx.trace, facts);
  const currentFacts = facts.filter(
    (fact) =>
      fact.subjectType === 'class' &&
      classIds.includes(fact.subjectId) &&
      isValidAt(fact.validFrom, fact.validTo, effective.at),
  );
  const prefersStructured =
    (!expectsQualifiedClass && /(?:무슨|어느)\s*요일/.test(frame.normalized)) ||
    (!WEEKDAY.test(frame.normalized) &&
      !ROOM.test(frame.normalized) &&
      !CLOCK_QUERY.test(frame.normalized));
  if (prefersStructured && currentFacts.length) return undefined;

  const slots = (await collectScheduleSlots(ctx, classIds, effective)).map(
    (slot) => {
      // Schedule documents can cover multiple terms. When the approved facts pin
      // a class to a source for this date, another document must not override it.
      const sources = new Set(
        currentFacts
          .filter((fact) => fact.subjectId === slot.classId)
          .map((fact) => fact.sourceId),
      );
      return sources.size === 0
        ? slot
        : {
            ...slot,
            excerpts: slot.excerpts.filter(({ chunk }) =>
              sources.has(chunk.sourceId),
            ),
          };
    },
  );
  if (!slots.some(({ excerpts }) => excerpts.length)) return undefined;
  if (!frame.classIds.length && slots.some(({ excerpts }) => !excerpts.length))
    return undefined;
  const missingFields = slots
    .filter(({ excerpts }) => excerpts.length === 0)
    .map(({ classId }) => className(ctx.catalog, classId) + ' 시간표');
  const excerpts = slots.flatMap((slot) => slot.excerpts);
  const prefix =
    effective.explicitDay === null
      ? ''
      : formatKstDate(effective.at) + ' 기준 ';
  const lines = slots.flatMap(({ classId, excerpts }) =>
    excerpts.map(
      ({ line }) => prefix + className(ctx.catalog, classId) + ' 수업: ' + line,
    ),
  );
  if (missingFields.length)
    lines.push('확인되지 않은 항목: ' + missingFields.join(', '));

  ctx.trace.intent = 'schedule_evidence';
  return {
    status: missingFields.length ? 'partial' : 'answered',
    reasonCode: missingFields.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missingFields.length ? missingFields : undefined,
    text: lines.join('\n'),
    excerpts,
    citations: excerpts.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    usedFacts: [],
    instants: [effective.at],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        units: [],
        periods: [],
        topicIds: ['schedule'],
        classIds,
      },
    },
  };
}
