import type { RagChunk } from '../types.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { toKstDate } from '../text/time.ts';
import {
  abstain,
  abstainForUncertainOcr,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';
import { weekdayAt, tableDateAt } from './table-dates.ts';

const EVENT = /발표회|공개\s*수업|설명회|전시회|학예회|체험회|시상식/;
const ASKS_DATE_TIME = /일시(?=와|가|는|도|를|,|\s|$)/;
const EVENT_PREFIX_NOISE =
  /^(?:제?\d+회|[월화수목금토일]요일|이번|다음|올해|학원|공식|우리|저희|정기)$/;
const DATE =
  /(?<!\d)(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일(?:\s*\([월화수목금토일](?:요일)?\))?/;
const EVENT_DATE_MODIFIER = new RegExp(
  String.raw`${DATE.source}(?:\s*[월화수목금토일]요일)?(?:\s*에(?=\s|$))?(?:\s*(?:열리는|개최되는|진행하는|진행되는|예정인)(?=\s|$))?`,
  'g',
);
const CLOCK_TOKEN =
  /^(?:(오전|오후)\s*)?(?:(\d{1,2}):(\d{2})|(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?)/;
const CLOCK_SEPARATOR = /^\s*([~～〜–—-]|부터)\s*/;
const CLOCK_LABEL_SUFFIX =
  /^\s*(?:(?:시작|개최|진행|운영)(?:\s*(?:예정(?:입니다)?|합니다|됩니다))?|열립니다|예정(?:입니다)?|\(예정\))?[.!。]?\s*$/;
const DATE_PREFIX = new RegExp(
  String.raw`^(${DATE.source})(?:\s*([월화수목금토일])요일)?(?:에)?(?=\s|$)`,
);
const VENUE_PREFIX = /^([\p{L}\p{N}][\p{L}\p{N} ·()/-]{0,60}?)에서(?=\s|$)/u;
const EVENT_PREDICATE =
  /\s+(?:열립니다|열려요|개최됩니다|개최합니다|진행됩니다|진행합니다|시작됩니다|시작합니다)[.!。]?$/;
const NON_ASSERTED_EVENT =
  /접수|리허설|집합|신청|하원|후보|검토|원래|당초|예전|지난번|만약|(?:하|인|할|될)\s*경우|(?:이|라|으)면|\bif\b|[가-힣]면\s|상황에\s*따라|아닌|아니라|않습니다/;

const VENUE = /^(?:장소|행사장소|개최장소|진행장소|공연장소)$/;
const START =
  /^(?:일시|시각|행사시각|행사일시|개최일시|시작시각|시작시간|공연시간|진행시간|운영시간|시간)$/;
const DAY = /^(?:날짜|행사일|행사일자|개최일|개최일자|일정)$/;
const NON_EVENT_SECTION =
  /접수|참관신청|등록방법|리허설|준비물|집합|하원|정규수업|운영변경/;
const UNCONFIRMED = /미정|추후\s*(?:공지|안내)|확인\s*중|취소|변경될\s*수/;

type Field = 'place' | 'clock' | 'day';
type Candidate = {
  key: string;
  excerpt: EvidenceExcerpt;
  display?: string;
} & (
  | { field: 'clock'; endKey?: string }
  | { field: 'day'; scopeOnly?: boolean; dateText: string }
  | { field: 'place' }
);
const FIELD_LABEL: Record<Field, string> = {
  place: '행사 장소',
  clock: '행사 시각',
  day: '행사 날짜',
};

function eventName(text: string, kind: string) {
  const match = EVENT.exec(text);
  if (!match || compactText(match[0]) !== kind) return undefined;
  const prefix = text
    .slice(0, match.index)
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(EVENT_DATE_MODIFIER, ' ')
    .replace(/(?<!\d)(?:\d{4}\s*년\s*)?\d{1,2}\s*월/g, ' ')
    .trim();
  const words = prefix.split(/\s+/).filter(Boolean);
  const firstNameWord = words.findIndex(
    (word) => !EVENT_PREFIX_NOISE.test(word),
  );
  const qualifier =
    firstNameWord < 0
      ? ''
      : compactText(words.slice(firstNameWord).join(' ')).replace(
          /^[「『“"'[(]|[」』”"')\]]$/g,
          '',
        );
  return { qualifier, key: qualifier + kind };
}

function readClockToken(value: string) {
  const match = CLOCK_TOKEN.exec(value);
  if (!match) return;
  const [, meridiem, colonHour, colonMinute, hourWord, minuteWord] = match;
  const hour = Number(colonHour ?? hourWord);
  const minute = Number(colonMinute ?? minuteWord ?? 0);
  if (hour > 23 || minute > 59 || (meridiem && (hour < 1 || hour > 12))) return;
  const minutes = meridiem
    ? ((hour % 12) + (meridiem === '오후' ? 12 : 0)) * 60 + minute
    : colonHour || hour > 12 || hour === 0
      ? hour * 60 + minute
      : undefined;
  return {
    text: match[0],
    key:
      minutes === undefined ? 'hour:' + hour + ':' + minute : String(minutes),
    minutes,
  };
}

/** Keep the clock expression intact so a broken end cannot masquerade as a start. */
function readEventClock(value: string) {
  const start = readClockToken(value);
  if (!start) return;
  let length = start.text.length;
  let endKey: string | undefined;
  let display: string | undefined;
  const separator = CLOCK_SEPARATOR.exec(value.slice(length));
  if (separator) {
    const end = readClockToken(value.slice(length + separator[0].length));
    if (!end && separator[1] !== '부터') return;
    length += separator[0].trimEnd().length;
    if (end) {
      if (
        start.minutes !== undefined &&
        end.minutes !== undefined &&
        end.minutes < start.minutes
      )
        return;
      length = start.text.length + separator[0].length + end.text.length;
      endKey = end.key;
      const until = /^\s*까지/.exec(value.slice(length));
      if (separator[1] === '부터' && !until) return;
      if (until) length += until[0].length;
      if (separator[1] !== '부터')
        display = start.text + '~' + end.text + (until?.[0] ?? '');
    }
  }
  const particle = /^에/.exec(value.slice(length))?.[0] ?? '';
  length += particle.length;
  if (!/^(?:\s|[.!。(]|$)/.test(value.slice(length))) return;
  return {
    key: start.key,
    endKey,
    text: value.slice(0, length),
    display: display && display + particle,
  };
}

function clockCandidate(
  excerpt: EvidenceExcerpt,
  clock: NonNullable<ReturnType<typeof readEventClock>>,
): Candidate {
  const { line } = excerpt;
  const display =
    clock.display && line.split(clock.text).length === 2
      ? line.replace(clock.text, clock.display)
      : undefined;
  return {
    field: 'clock',
    key: clock.key,
    endKey: clock.endKey,
    excerpt,
    display,
  };
}

function statementSubject(line: string, kind: string) {
  const event = EVENT.exec(line);
  const name = eventName(line, kind);
  if (!event || !name) return;
  const tail = line.slice(event.index + event[0].length);
  const particle = /^(?:는|은|가|이)\s+/.exec(tail);
  if (particle && !EVENT.test(tail))
    return { name, body: tail.slice(particle[0].length) };
}

function readDatePrefix(date: RegExpExecArray, year: number) {
  return tableDateAt(date[1] + (date[2] ? ' (' + date[2] + ')' : ''), year);
}

function canceledOccurrence(line: string, kind: string, year: number) {
  const statement = statementSubject(line, kind);
  if (!statement) return;
  const date = DATE_PREFIX.exec(statement.body);
  const rest = statement.body.slice(date?.[0].length ?? 0).trimStart();
  if (
    !/^(?:취소(?:되었습니다|됐습니다|됩니다|합니다)|(?:열리지|진행하지|개최하지)\s+않습니다)[.!。]?$/.test(
      rest,
    )
  )
    return;
  const day = date && readDatePrefix(date, year);
  if (!date || typeof day === 'number')
    return { name: statement.name.key, day };
}

function projectStatement(
  line: string,
  chunk: RagChunk,
  kind: string,
  year: number,
) {
  if (UNCONFIRMED.test(line) || NON_ASSERTED_EVENT.test(line)) return;
  const statement = statementSubject(line, kind);
  if (!statement) return;
  const { name, body } = statement;
  const predicate = EVENT_PREDICATE.exec(body);
  if (!predicate) return;
  let rest = body.slice(0, predicate.index).trim();
  const excerpt = { chunk, line };
  const candidates: Candidate[] = [];
  const add = (field: Field, key: string, matched: string) => {
    if (!key || candidates.some((candidate) => candidate.field === field))
      return false;
    candidates.push(
      field === 'day'
        ? { field, key, excerpt, dateText: matched }
        : { field, key, excerpt },
    );
    rest = rest.slice(matched.length).trimStart();
    return true;
  };
  while (rest) {
    const date = DATE_PREFIX.exec(rest);
    const clock = readEventClock(rest);
    const venue = VENUE_PREFIX.exec(rest);
    if (date) {
      const day = readDatePrefix(date, year);
      if (day === undefined || !add('day', String(day), date[0])) return;
    } else if (clock) {
      if (candidates.some(({ field }) => field === 'clock')) return;
      candidates.push(clockCandidate(excerpt, clock));
      rest = rest.slice(clock.text.length).trimStart();
    } else if (venue) {
      if (!add('place', compactText(venue[1]), venue[0])) return;
    } else {
      return;
    }
  }
  if (candidates.some(({ field }) => field !== 'day'))
    return { name, candidates };
}

function projectFields(chunk: RagChunk, year: number) {
  const out: Candidate[] = [];
  const add = (label: string, value: string, excerpt?: EvidenceExcerpt) => {
    if (!excerpt || !value || UNCONFIRMED.test(value)) return;
    const key = compactText(label);
    if (
      VENUE.test(key) &&
      !/^(?:없음|없습니다|온라인(?:여부)?\s*미확인)$/.test(value)
    )
      out.push({ field: 'place', key: compactText(value), excerpt });
    if (
      /접수|리허설|집합|신청|하원|종료|끝나는|(?:까지|이전).{0,12}(?:도착|입장|모이|준비)/.test(
        value,
      )
    )
      return;
    if (!START.test(key) && !DAY.test(key)) return;
    const dates = [...value.matchAll(new RegExp(DATE.source, 'g'))];
    const day = dates.length === 1 ? tableDateAt(dates[0][0], year) : undefined;
    const trailing = /^\s*[.!。]?\s*$/;
    const clockText =
      dates.length === 0
        ? value.trimStart()
        : day !== undefined && dates[0].index === 0
          ? value.slice(dates[0][0].length).trimStart()
          : undefined;
    let clock: ReturnType<typeof readEventClock>;
    if (START.test(key) && clockText !== undefined) {
      const parsed = readEventClock(clockText);
      if (
        parsed &&
        CLOCK_LABEL_SUFFIX.test(clockText.slice(parsed.text.length))
      )
        clock = parsed;
    }
    if (clock) out.push(clockCandidate(excerpt, clock));
    if (day !== undefined)
      out.push({
        field: 'day',
        key: String(day),
        dateText: dates[0][0],
        excerpt,
        scopeOnly:
          !clock && (clockText === undefined || !trailing.test(clockText)),
      });
  };
  let occurrence = 'paragraph';
  const row = readEvidenceRow(chunk);
  if (row) {
    const rowName = row.column(/^(?:행사|행사명|프로그램)$/);
    const label = row.column(/^(?:항목|구분|항목명)$/);
    const value = row.column(/^(?:내용|상세내용|안내|값)$/);
    if (label >= 0 && value >= 0) {
      occurrence = 'table:' + chunk.location.tableIndex;
      add(row.cells[label], row.cells[value], row.project(label, value));
    } else {
      occurrence = 'row:' + chunk.chunkId;
      const { header } = chunk.location;
      header?.forEach((name, column) => {
        if (
          VENUE.test(compactText(name)) ||
          START.test(compactText(name)) ||
          DAY.test(compactText(name))
        )
          add(
            name,
            row.cells[column],
            row.project(...(rowName < 0 ? [column] : [rowName, column])),
          );
      });
    }
  } else if (chunk.location.kind === 'paragraph') {
    for (const line of splitSentences(chunk.text)) {
      const labeled =
        /^(?:[-•]\s*)?([가-힣 ]{1,18}?)(?:\s*[:：]\s*|(?:은|는)\s+)(.+)$/.exec(
          line,
        );
      if (labeled) add(labeled[1], labeled[2], { chunk, line });
    }
  }
  return { occurrence, candidates: out };
}

/** Each requested field must be supported by the selected event, not a nearby schedule. */
export async function answerEventLogistics(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const event = EVENT.exec(q);
  if (
    !event ||
    !/어디|장소/.test(q) ||
    (!ASKS_DATE_TIME.test(q) &&
      !/몇\s*시(?!간)|시작\s*(?:시간|시각)|(?:행사|개최|공연)\s*(?:시간|시각)|장소와\s*(?:시간|시각)/.test(
        q,
      )) ||
    /비교|변경|취소|리허설|접수|신청|마감|몇\s*시간|수강료|회비|정원|몇\s*명|담당\s*강사|종료|끝나/.test(
      q,
    ) ||
    [...q.matchAll(new RegExp(EVENT.source, 'g'))].length !== 1 ||
    frame.explicitDates.length > 1 ||
    frame.months.length > 1 ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.relativeWeek
  )
    return;
  const kind = compactText(event[0]);
  const requested = eventName(q, kind);
  const required: Field[] = ['place', 'clock'];
  if (ASKS_DATE_TIME.test(q) || /날짜|며칠|몇\s*월/.test(q))
    required.unshift('day');
  const ids = explicitClassIds(ctx);
  if (!requested || ids.length > 1) return;
  const year = toKstDate(ctx.asOf).year;
  const at = ctx.asOf;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: at,
    query: [ctx.question, event[0], '일시 장소 시작 시각'].join(' '),
    documentTypes: ['announcement', 'schedule', 'academy_info'],
    limit: 60,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const groups = new Map<
    string,
    {
      name: string;
      candidates: Candidate[];
      needsScanReview: boolean;
    }
  >();
  const cancellations: NonNullable<ReturnType<typeof canceledOccurrence>>[] =
    [];
  const attach = (
    chunk: RagChunk,
    name: ReturnType<typeof eventName>,
    occurrence: string,
    candidates: Candidate[],
  ) => {
    if (
      !name ||
      (requested.qualifier && requested.qualifier !== name.qualifier)
    )
      return;
    const needsScanReview = Boolean(
      chunk.extraction?.needsReview || chunk.extraction?.uncertainTokens.length,
    );
    const { section, sectionIndex, page } = chunk.location;
    const clean: Candidate[] = [];
    if (isCleanPublicEvidence(chunk, at, section ?? '')) {
      for (const candidate of candidates) {
        if (isCleanPublicEvidence(chunk, at, candidate.excerpt.line)) {
          clean.push(candidate);
        } else if (
          candidate.field === 'day' &&
          isCleanPublicEvidence(chunk, at, candidate.dateText)
        ) {
          // A clear date can identify the occurrence without quoting its unreadable time.
          clean.push({ ...candidate, scopeOnly: true });
        }
      }
    }
    if (!clean.length && !needsScanReview) return;
    const key = JSON.stringify([
      chunk.sourceId,
      name.key,
      section ?? (occurrence === 'paragraph' ? page : undefined),
      sectionIndex,
      occurrence,
    ]);
    const group = groups.get(key) ?? {
      name: name.key,
      candidates: [],
      needsScanReview: false,
    };
    group.candidates.push(...clean);
    group.needsScanReview ||= needsScanReview;
    groups.set(key, group);
  };
  for (const { chunk } of hits) {
    const section = chunk.location.section ?? '';
    if (
      chunk.visibility !== 'academy_public' ||
      chunk.suspicious ||
      (chunk.classId !== null && !ids.includes(chunk.classId)) ||
      (ids.length && chunk.classId !== ids[0]) ||
      /게시판|문의\s*모음/.test(chunk.title) ||
      NON_EVENT_SECTION.test(compactText(chunk.location.section ?? ''))
    )
      continue;
    if (chunk.location.kind === 'paragraph') {
      for (const [index, line] of splitSentences(chunk.text).entries()) {
        const cancellation = canceledOccurrence(line, kind, year);
        if (cancellation && isCleanPublicEvidence(chunk, at, line))
          cancellations.push(cancellation);
        const statement = projectStatement(line, chunk, kind, year);
        if (statement)
          attach(
            chunk,
            statement.name,
            'statement:' + chunk.chunkId + ':' + index,
            statement.candidates,
          );
      }
    }
    const row = readEvidenceRow(chunk);
    const rowName = row?.column(/^(?:행사|행사명|프로그램)$/) ?? -1;
    const fromSection = eventName(section, kind);
    const fromTitle = eventName(chunk.title, kind);
    if (EVENT.test(section) && !fromSection) continue;
    const name =
      rowName >= 0 && row
        ? eventName(row.cells[rowName], kind)
        : fromSection?.qualifier
          ? fromSection
          : (fromTitle ?? fromSection);
    if (
      !name ||
      (requested.qualifier && requested.qualifier !== name.qualifier)
    )
      continue;
    const { occurrence, candidates } = projectFields(chunk, year);
    attach(chunk, name, occurrence, candidates);
  }
  const date = frame.explicitDates[0];
  const yearInQuery = /(?<!\d)(\d{4})\s*년/.exec(q)?.[1];
  const weekdays = new Set(
    [...q.matchAll(/([월화수목금토일])요일/g)].map(([, day]) => day),
  );
  const matchesDate = (candidates: Candidate[]) => {
    if (!date && !frame.months.length && !yearInQuery && !weekdays.size)
      return true;
    return candidates.some((candidate) => {
      if (candidate.field !== 'day') return false;
      const instant = Number(candidate.key);
      const day = toKstDate(instant);
      return (
        (!weekdays.size ||
          (weekdays.size === 1 && weekdays.has(weekdayAt(instant)))) &&
        (!yearInQuery || day.year === Number(yearInQuery)) &&
        (!frame.months.length || frame.months.includes(day.month)) &&
        (!date ||
          (date.operator === 'at' &&
            day.month === date.month &&
            day.day === date.day &&
            (!Number.isFinite(date.year) || day.year === date.year)))
      );
    });
  };
  const options = [...groups.values()].filter(
    ({ candidates }) => candidates.length > 0 && matchesDate(candidates),
  );
  ctx.trace.intent = 'event_logistics';
  if (
    options.some(({ name, candidates }) =>
      cancellations.some((cancellation) => {
        if (cancellation.name !== name) return false;
        const dates = candidates.filter(({ field }) => field === 'day');
        return (
          cancellation.day === null ||
          !dates.length ||
          dates.some(({ key }) => key === String(cancellation.day))
        );
      }),
    )
  )
    return abstain(
      '해당 행사 회차의 승인 자료에 취소 안내가 있어 장소와 시각을 확정할 수 없습니다.',
      'CONFLICTING_EVIDENCE',
    );
  if (new Set(options.map(({ name }) => name)).size > 1)
    return {
      status: 'clarify',
      text: '어느 행사의 장소와 시각을 확인할까요? 행사 이름을 알려 주세요.',
      citations: [],
      usedFacts: [],
    };
  const distinctValues = new Map<Field, Set<string>>();
  for (const { candidates } of options) {
    for (const { field, key } of candidates) {
      const values = distinctValues.get(field) ?? new Set<string>();
      values.add(key);
      distinctValues.set(field, values);
    }
  }
  const conflicts = (field: Field) =>
    (distinctValues.get(field)?.size ?? 0) > 1;
  if (conflicts('day'))
    return abstain(
      '행사 날짜가 다른 공지를 함께 찾았습니다. 요청한 행사 날짜를 확인해 주세요.',
      'CONFLICTING_EVIDENCE',
    );
  const ends = new Set(
    options.flatMap(({ candidates }) =>
      candidates.flatMap((candidate) =>
        candidate.field === 'clock' && candidate.endKey !== undefined
          ? [candidate.endKey]
          : [],
      ),
    ),
  );
  const asksStartOnly =
    !ASKS_DATE_TIME.test(q) && /몇\s*시(?!간)|시작\s*(?:시간|시각)/.test(q);
  const unquotable = (candidate: Candidate) =>
    conflicts(candidate.field) ||
    (candidate.field === 'day' && candidate.scopeOnly) ||
    (candidate.field === 'clock' &&
      ends.size > 1 &&
      (!asksStartOnly || candidate.endKey !== undefined));
  const hasEnd = (candidate: Candidate) =>
    candidate.field === 'clock' && candidate.endKey !== undefined;
  const ranked = options
    .map(({ candidates }) =>
      required.flatMap((field) => {
        const matching = candidates.filter(
          (candidate) =>
            candidate.field === field &&
            !candidates.some(
              (other) =>
                other.excerpt === candidate.excerpt && unquotable(other),
            ),
        );
        const preferred = matching.find(hasEnd) ?? matching[0];
        return preferred ? [preferred] : [];
      }),
    )
    .sort(
      (a, b) =>
        b.length - a.length || Number(b.some(hasEnd)) - Number(a.some(hasEnd)),
    );
  const [selected] = ranked;
  if (!selected?.length) {
    const matchingScanNeedsReview = [...groups.values()].some(
      ({ needsScanReview, candidates }) =>
        needsScanReview &&
        (!candidates.some(({ field }) => field === 'day') ||
          matchesDate(candidates)),
    );
    if (matchingScanNeedsReview) return abstainForUncertainOcr();
    return abstain(
      '요청한 행사의 장소와 시각을 승인 공지에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      required.map((field) => FIELD_LABEL[field]),
    );
  }
  const excerpts = [
    ...new Map(
      selected.map(({ excerpt }) => [
        excerpt.chunk.chunkId + '|' + excerpt.line,
        excerpt,
      ]),
    ).values(),
  ];
  const missing = required.filter(
    (field) => !selected.some((candidate) => candidate.field === field),
  );
  const draft = fromPublicExcerpts(
    excerpts,
    missing.map((field) => FIELD_LABEL[field]),
  );
  const display = new Map(
    selected.flatMap(({ excerpt, display }) =>
      display ? [[excerpt.line, display]] : [],
    ),
  );
  return {
    ...draft,
    text: draft.text
      .split('\n')
      .map((line) => display.get(line) ?? line)
      .join('\n'),
    unresolvedFields: missing.includes('clock') ? ['startTime'] : undefined,
  };
}
