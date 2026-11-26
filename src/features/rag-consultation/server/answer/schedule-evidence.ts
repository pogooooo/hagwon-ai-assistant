import { isAssistantDirective } from '../ingest/validation.ts';
import { gradeBand } from '../query/grade-band.ts';
import { isStudentOnlyFollowUp } from '../query/follow-up.ts';
import { resolveQualifiedClasses } from './class-targets.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import {
  formatKstDate,
  isValidAt,
  kstStartOfDay,
  toIsoDate,
  toKstDate,
} from '../text/time.ts';
import {
  abstain,
  className,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { classTableRows, dayWordCovers, explicitClassIds } from './info.ts';
import {
  scheduleChangeInterval,
  tableDateAt,
  tablePeriodAt,
  weekdayAt,
} from './table-dates.ts';
import { supportsExcerpt } from './verify.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

const CLOCK_TIME =
  /(?:[01]?\d|2[0-3]):[0-5]\d|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/;
const WEEKDAY = /[월화수목금토일]요일/;
const ROOM = /강의실|교실|몇\s*호/;
const CLOCK_QUERY = /몇\s*시(?!간)|시작\s*시간/;
const CONDITIONAL =
  /휴강|휴원|보강|특강|시험|방학|연기|변경|대체|공휴일|안\s*하|없음|미정|제외/;

const ROOM_FIELD = /^(?:강의실|교실|수업장소)$/;
const CLASS_FIELD = /^(?:반|반명|반이름|대상반|강좌|과정)$/;
const SUBJECT_ORDER_FIELD = /^(?:과목순서|과목진행순서|수업과목순서|교과순서)$/;
const REGULAR_TIME_FIELD =
  /^(?:수업요일·시간|요일·시간|수업시간|시간|정규수업(?:시간)?|수업시각)$/;
const CLASS_DAY_FIELD = /^(?:요일|수업요일|정규수업요일)$/;

/** A weekly makeup window is distinct from a specific makeup appointment. */
export async function answerWeeklyMakeupWindow(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const weekdays = [
    ...new Set([...q.matchAll(/([월화수목금토일])요일/g)].map((m) => m[1])),
  ];
  if (
    weekdays.length !== 1 ||
    !/보강|보충/.test(q) ||
    !/수업|시간|몇\s*시|언제/.test(q) ||
    /휴원|휴강|휴일|방학|대체|변경|이번|다음|지난|또\s*보강|재보강|신청|비용/.test(
      q,
    ) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod
  )
    return;
  const [day] = weekdays;
  const ids = explicitClassIds(ctx);
  const klass =
    ids.length === 1 &&
    ctx.catalog.classes.find(({ classId }) => classId === ids[0]);
  if (!klass) return;
  const [facts, found] = await Promise.all([
    ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      factTypes: ['schedule'],
    }),
    ctx.documents.searchApprovedChunks({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      query: [klass.name, ...klass.aliases, day + '요일 보강 운영 시간'].join(
        ' ',
      ),
      documentTypes: ['schedule'],
      limit: 65,
    }),
  ]);
  recordFacts(ctx.trace, facts);
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const schedules = facts.filter(
    (fact) =>
      fact.subjectType === 'class' &&
      fact.subjectId === klass.classId &&
      fact.value.kind === 'schedule' &&
      !isAssistantDirective(fact.value.text),
  );
  const uniqueSchedules = new Set(
    schedules.flatMap(({ value }) =>
      value.kind === 'schedule' ? [compactText(value.text)] : [],
    ),
  );
  if (uniqueSchedules.size !== 1) return;
  const [regular] = schedules;
  if (regular.value.kind !== 'schedule' || CONDITIONAL.test(regular.value.text))
    return;
  const target = gradeBand(klass.grade ?? '');
  const knownNames = [klass.name, ...klass.aliases].map(compactText);
  const bareName = compactText(klass.name.replace(/\([^()]*\)\s*$/, ''));
  const typeRows = found.flatMap(({ chunk }) => {
    if (
      chunk.sourceId !== regular.sourceId ||
      chunk.classId !== null ||
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      !/단과반/.test(chunk.location.section ?? '')
    )
      return [];
    const row = readEvidenceRow(chunk);
    if (!row) return [];
    const key = row.column(/^(?:강좌|과정|반|강좌명|과정명)$/);
    const grade = row.column(/^(?:대상|대상학년|학년)$/);
    const band = gradeBand(row.cells[grade] ?? '');
    const label = compactText(row.cells[key] ?? '');
    const qualified =
      label === bareName &&
      target.length > 0 &&
      target.join(',') === band.join(',');
    const uniqueName =
      knownNames.includes(label) &&
      !ctx.catalog.classes.some(
        (other) =>
          other.classId !== klass.classId &&
          [other.name, ...other.aliases].some(
            (name) => compactText(name) === label,
          ),
      );
    if (band.length && target.length && target.join(',') !== band.join(','))
      return [];
    if (!uniqueName && !qualified) return [];
    const proof = row.project(key, ...(grade >= 0 ? [grade] : []));
    return proof ? [proof] : [];
  });
  if (!typeRows.length) return;
  const window = new RegExp(
    day +
      '요일\\s*((?:[01]?\\d|2[0-3]):[0-5]\\d\\s*[~–-]\\s*(?:[01]?\\d|2[0-3]):[0-5]\\d)',
  );
  const candidates = found.flatMap(({ chunk }) => {
    if (
      chunk.sourceId !== regular.sourceId ||
      chunk.location.kind !== 'paragraph' ||
      !isCleanPublicEvidence(chunk, ctx.asOf)
    )
      return [];
    return splitSentences(chunk.text).flatMap((line) => {
      const value = window.exec(line)?.[1];
      return value &&
        /단과반\s*보강/.test(line) &&
        /사이|운영|진행/.test(line) &&
        !/미정|취소|중단/.test(line)
        ? [{ chunk, line, value }]
        : [];
    });
  });
  if (!candidates.length) return;
  if (new Set(candidates.map(({ value }) => compactText(value))).size !== 1)
    return abstain(
      '승인 시간표의 보강 운영 시간이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [rule] = candidates;
  const [course] = typeRows;
  ctx.trace.intent = 'weekly_makeup_window';
  return {
    status: 'answered',
    text: [klass.name + ' 정규 수업 ' + regular.value.text, rule.line].join(
      '\n',
    ),
    citations: [
      { kind: 'fact', fact: regular },
      { kind: 'chunk', chunk: course.chunk, tableColumns: course.tableColumns },
      { kind: 'chunk', chunk: rule.chunk },
    ],
    usedFacts: [regular],
    excerpts: [course, rule],
  };
}

export async function answerScheduleOverlap(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    !/시간.{0,7}겹치|겹치는\s*시간|시간.{0,9}충돌/.test(frame.normalized) ||
    /휴강|보강|특강|방학|변경|대체|공휴일|몇\s*분/.test(frame.normalized) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.negatedClassIds.length
  )
    return;
  const focused =
    frame.matchedStudentIds.length === 1
      ? ctx.access.studentRefs.find(
          ({ studentId }) => studentId === frame.matchedStudentIds[0],
        )?.classIds
      : undefined;
  const ids =
    frame.classIds.length === 2
      ? frame.classIds
      : frame.classIds.length === 1 && focused?.length === 1
        ? [...new Set([...frame.classIds, ...focused])]
        : [];
  if (ids.length !== 2) return;
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['schedule'],
  });
  recordFacts(ctx.trace, facts);
  const clock = '((?:[01]?\\d|2[0-3]):[0-5]\\d)';
  const range = new RegExp(
    '^(.+?)\\s+' + clock + '\\s*[~–-]\\s*' + clock + '$',
  );
  const options = ids.map((id) =>
    facts.flatMap((fact) => {
      if (
        fact.subjectType !== 'class' ||
        fact.subjectId !== id ||
        fact.value.kind !== 'schedule' ||
        isAssistantDirective(fact.value.text) ||
        CONDITIONAL.test(fact.value.text)
      )
        return [];
      const match = range.exec(fact.value.text.trim());
      if (!match) return [];
      const days = [...'월화수목금토일'].filter((day) =>
        dayWordCovers(match[1], day),
      );
      const start = match[2].padStart(5, '0');
      const end = match[3].padStart(5, '0');
      return days.length && start < end
        ? [{ fact, days, start, end, text: fact.value.text }]
        : [];
    }),
  );
  if (
    options.some(
      (choices) =>
        !choices.length ||
        new Set(
          choices.map(
            ({ days, start, end }) => days.join('') + '|' + start + '|' + end,
          ),
        ).size !== 1,
    )
  )
    return abstain(
      '두 반의 정규 시간표를 같은 기준으로 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const [a, b] = options.map(([choice]) => choice);
  const overlap =
    a.days.some((day) => b.days.includes(day)) &&
    a.start < b.end &&
    b.start < a.end;
  ctx.frame = { ...frame, classIds: ids };
  ctx.trace.intent = 'schedule_overlap';
  return {
    status: 'answered',
    text: [
      ...[a, b].map(
        ({ fact, text }) => className(ctx.catalog, fact.subjectId) + ' ' + text,
      ),
      overlap
        ? '두 반의 정규 수업 시간이 겹칩니다.'
        : '두 반의 정규 수업 시간은 겹치지 않습니다.',
    ].join('\n'),
    citations: [a, b].map(({ fact }) => ({ kind: 'fact', fact })),
    usedFacts: [a.fact, b.fact],
  };
}

export function isClassroomLookup(ctx: AnswerContext): boolean {
  const { frame, state } = ctx;
  return (
    (/(?:강의실|교실)(?:은|이|을)?\s*(?:몇\s*호|어디|알려)|몇\s*호\s*(?:강의실|교실)/.test(
      frame.normalized,
    ) ||
      (state?.previousFrame?.topicIds?.includes('classroom') === true &&
        isStudentOnlyFollowUp(ctx))) &&
    frame.topics.every(({ id }) =>
      ['schedule', 'classroom', 'location'].includes(id),
    ) &&
    !/주소|건물|가는\s*길|주차|셔틀|상담|설명회|방문|수업\s*장소\s*변경/.test(
      frame.normalized,
    )
  );
}

const GRID_AXIS = /^(?:교시|시각|수업시간|시간)(?:\([^()]*\))?$/;
const GRID_DAY = /^([월화수목금토일])(?:요일)?$/;
const GRID_DAY_LABEL = String.raw`(?:평일|주말|매일|[월화수목금토일]+(?:요일)?)(?:\s*[·ㆍ,~–-]\s*[월화수목금토일]+(?:요일)?)*`;
const CLOCK_WINDOW = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d\s*[~～–-]\s*(?:[01]?\d|2[0-3]):[0-5]\d`;

function timeRangesByDay(axis: string) {
  return [
    ...axis.matchAll(
      new RegExp(
        '(?<![가-힣0-9])(' + GRID_DAY_LABEL + ')\\s*(' + CLOCK_WINDOW + ')',
        'g',
      ),
    ),
  ];
}

function timeForGridDay(axis: string, day: string) {
  if (/공휴일|휴일|예외|제외|미정/.test(axis)) return;
  const pairs = timeRangesByDay(axis);
  const times = pairs.length
    ? pairs.filter((pair) => dayWordCovers(pair[1], day)).map((pair) => pair[2])
    : [...axis.matchAll(new RegExp(CLOCK_WINDOW, 'g'))].map(
        (match) => match[0],
      );
  return new Set(times).size === 1 ? times[0] : undefined;
}

interface ScheduleSlot {
  classId: string;
  excerpts: Array<EvidenceExcerpt & { displayLine?: string }>;
}

async function collectScheduleSlots(
  ctx: AnswerContext,
  classIds: readonly string[],
  effective: ReturnType<typeof resolveEffectiveTime>,
): Promise<ScheduleSlot[]> {
  const asksClockTime =
    ctx.plannedRequest?.requiredFields.includes('startTime') ||
    CLOCK_QUERY.test(ctx.frame.normalized);

  const asksRoom = ROOM.test(ctx.frame.normalized) || isClassroomLookup(ctx);
  const roomOnly =
    isClassroomLookup(ctx) &&
    !asksClockTime &&
    !/시간표|수업\s*시간|요일/.test(ctx.frame.normalized);
  return Promise.all(
    classIds.map(async (classId) => {
      const rows = await classTableRows(
        ctx,
        classId,
        ['schedule'],
        effective,
        undefined,
        roomOnly ? REGULAR_TIME_FIELD : undefined,
      );
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
        const axis = indices.find((index) =>
          GRID_AXIS.test(compactText(header[index])),
        );
        const gridDays = tableColumns.flatMap((index) => {
          const day = GRID_DAY.exec(compactText(header[index]))?.[1];
          return day ? [{ index, day }] : [];
        });
        const axisText = axis === undefined ? '' : cells[axis];
        const labeledRanges = timeRangesByDay(axisText);
        const displayLine =
          labeledRanges.length && gridDays.length && !roomOnly
            ? gridDays.map(({ day, index }) => {
                const time = timeForGridDay(axisText, day);
                return time
                  ? day + '요일 ' + time + ' (' + cells[index] + ')'
                  : undefined;
              })
            : [];
        if (
          displayLine.some((line) => !line) ||
          (!roomOnly &&
            WEEKDAY.test(ctx.frame.normalized) &&
            labeledRanges.length > 1 &&
            /평일/.test(axisText) &&
            /주말|토|일요일/.test(axisText) &&
            !gridDays.length)
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

        const selected = roomOnly
          ? indices.filter(
              (index) =>
                CLASS_FIELD.test(compactText(header[index])) ||
                ROOM_FIELD.test(compactText(header[index])),
            )
          : indices;
        if (
          roomOnly &&
          !selected.some(
            (index) =>
              ROOM_FIELD.test(compactText(header[index])) &&
              cells[index].trim(),
          )
        )
          return [];
        const excerpt = {
          chunk,
          tableColumns:
            roomOnly || displayLine.length
              ? selected
              : [...new Set([...tableColumns, ...selected])],
          displayLine: displayLine.length ? displayLine.join(' / ') : undefined,
          line: selected
            .map((index) => header[index] + ': ' + cells[index])
            .join(' / '),
        };
        return supportsExcerpt(excerpt) ? [excerpt] : [];
      });
      return { classId, excerpts };
    }),
  );
}

/** Timetable services use the offered session's school level, day and time axis. */
export async function answerClinicHours(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const name = /(?:과제|질문|실험)\s*클리닉/.exec(q)?.[0];
  if (
    !name ||
    !/몇\s*시(?!간)|시작\s*시간/.test(q) ||
    /예약|신청|보강|휴강|비교|상담|비용|몇\s*시간/.test(q) ||
    frame.explicitDates.length > 1 ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.relativeDay !== null ||
    frame.unknownPrograms.length ||
    frame.unboundProgram
  )
    return;
  const ids = explicitClassIds(ctx);
  const classLevels = ctx.catalog.classes
    .filter(({ classId }) => ids.includes(classId))
    .flatMap(({ grade }) => gradeBand(grade ?? ''))
    .map((grade) => (grade <= 6 ? '초등' : grade <= 9 ? '중등' : '고등'));
  const namedLevel = /초등|중등|고등/.exec(q)?.[0];
  const levels = [...new Set(namedLevel ? [namedLevel] : classLevels)];
  if (levels.length !== 1) return;
  const [level] = levels;
  const { at, explicitDay } = resolveEffectiveTime(frame, ctx.asOf);
  const weekday = /([월화수목금토일])요일/.exec(q)?.[1];
  const day = explicitDay === null ? weekday : weekdayAt(explicitDay);
  const missing = () =>
    abstain(
      '해당 학교급의 클리닉 시각을 승인 시간표에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['클리닉 시각'],
    );
  if (
    (weekday && day !== weekday) ||
    (explicitDay !== null && ids.length !== 1)
  )
    return missing();
  if (
    explicitDay !== null &&
    (await findScheduleChanges(ctx, ids[0], toIsoDate(toKstDate(explicitDay))))
      .length
  )
    return missing();
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [level, name, '시간표 요일 교시 시각'].join(' '),
    documentTypes: ['schedule'],
    limit: 45,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const options = hits.flatMap(({ chunk }) => {
    if (
      (chunk.classId && !ids.includes(chunk.classId)) ||
      !isCleanPublicEvidence(chunk, at)
    )
      return [];
    const row = readEvidenceRow(chunk);
    const header = chunk.location.header;
    if (!row || !header) return [];
    const axis = row.column(GRID_AXIS);
    const clock = row.cells[axis] ?? '';
    if (CONDITIONAL.test(clock)) return [];
    const selected = header.flatMap((heading, i) => {
      const candidate = GRID_DAY.exec(compactText(heading))?.[1];
      const raw = row.cells[i].split(/\s*[·ㆍ]\s*/)[0];
      const label = compactText(raw);
      const expected = compactText(name);
      const sectionLevel = /초등|중등|고등/.exec(
        chunk.location.section ?? '',
      )?.[0];
      if (
        !candidate ||
        (day && day !== candidate) ||
        !(
          label === level + expected ||
          (label === expected && sectionLevel === level)
        )
      )
        return [];
      const time = timeForGridDay(clock, candidate);
      return time ? [{ index: i, day: candidate, time }] : [];
    });
    const excerpt =
      selected.length &&
      row.project(axis, ...selected.map(({ index }) => index));
    return excerpt ? [{ excerpt, selected }] : [];
  });
  if (!options.length) return missing();
  const hours = new Map<string, string>();
  for (const { selected } of options) {
    for (const { day, time } of selected) {
      if (
        hours.has(day) &&
        compactText(hours.get(day) ?? '') !== compactText(time)
      )
        return abstain(
          '같은 요일의 승인 클리닉 시각이 서로 다릅니다.',
          'CONFLICTING_EVIDENCE',
        );
      hours.set(day, time);
    }
  }
  ctx.trace.intent = 'clinic_schedule';
  const answer = fromPublicExcerpts(options.map(({ excerpt }) => excerpt));
  return {
    ...answer,
    text:
      level +
      ' ' +
      name +
      ' ' +
      [...hours].map(([day, time]) => day + '요일 ' + time).join(' / '),
    citations: answer.citations.map((citation) => ({
      ...citation,
      effectiveAt: at,
    })),
  };
}

/** Resolve the applicability period before using the modified timetable's lesson rows. */
export async function answerScheduleValidityPeriod(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const term = /기말|중간고사|방학/.exec(q)?.[0];
  if (
    !term ||
    !/시간표/.test(q) ||
    !/언제\s*까지|적용\s*기간|종료\s*일|정규.{0,12}(?:복귀|돌아)/.test(q) ||
    /휴강|휴원|보강|셔틀|수강료|비교/.test(q) ||
    frame.explicitDates.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.months.length ||
    frame.unboundProgram ||
    frame.unknownPrograms.length ||
    frame.unresolvedRelationWords.length
  )
    return;
  const explicit = explicitClassIds(ctx);
  const allowed = ctx.access.studentRefs.filter(({ studentId }) =>
    ctx.access.allowedStudentIds.includes(studentId),
  );
  const ids = explicit.length
    ? explicit
    : allowed.length === 1
      ? (allowed[0].classIds ?? [])
      : [];
  const [classId] = ids;
  const klass =
    ids.length === 1
      ? ctx.catalog.classes.find((entry) => entry.classId === classId)
      : undefined;
  const missing = () =>
    abstain(
      '해당 반의 변경 시간표 적용 기간을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['변경 시간표 적용 기간'],
    );
  if (!klass) return missing();

  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['schedule'],
    query: klass.name + ' ' + term + ' 변경 시간표 적용 기간 정규 시간표 복귀',
    limit: 50,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const gradesOfClass = gradeBand(klass.grade ?? '');
  const gradePrefix = /^(?:[초중고][1-6])(?:[·,/](?:[초중고])?[1-6])*(?:학년)?/;
  const classCourse = compactText(klass.name).replace(gradePrefix, '');
  const courseFamily = classCourse.replace(/[a-z\d]+반$/i, '반');
  const wantsResume = /원래|정규|복귀|돌아/.test(q);
  const candidates = hits.flatMap(({ chunk }) => {
    if (
      (chunk.classId && chunk.classId !== classId) ||
      !isCleanPublicEvidence(chunk, ctx.asOf) ||
      ![chunk.title, chunk.location.section ?? ''].some((heading) =>
        heading.includes(term),
      )
    )
      return [];
    const row = readEvidenceRow(chunk);
    if (!row) return [];
    const key = row.column(/^(?:대상|대상반|반|반명|대상학년|학년)$/);
    const period = row.column(/^(?:적용기간|변경기간|운영기간)$/);
    const resume = row.column(
      /^(?:비고|복귀일|정규복귀일|정규시간표|정규시간표복귀)$/,
    );
    const label = compactText(row.cells[key] ?? '');
    const grades = gradeBand(gradePrefix.exec(label)?.[0] ?? '');
    const course = label.replace(gradePrefix, '');
    const familyMatch =
      gradesOfClass.length > 0 &&
      gradesOfClass.every((grade) => grades.includes(grade)) &&
      course !== '' &&
      (course === classCourse || course === courseFamily);
    const matching = ctx.catalog.classes.filter((entry) =>
      [entry.name, ...entry.aliases].some(
        (name) => compactText(name) === label,
      ),
    );
    const exact = matching.length === 1 && matching[0].classId === classId;
    const bounds = tablePeriodAt(row.cells[period] ?? '', ctx.asOf);
    if ((!exact && !familyMatch) || !bounds) return [];
    const notes = compactText(row.cells[resume] ?? '');
    const resumeDate = /복귀일|정규시간표/.test(
      chunk.location.header?.[resume] ?? '',
    )
      ? /(?:\d{4}년)?\d{1,2}월\d{1,2}일(?:\([월화수목금토일]\))?/.exec(
          notes,
        )?.[0]
      : /((?:\d{4}년)?\d{1,2}월\d{1,2}일(?:\([월화수목금토일]\))?)(?:부터|에)정규/.exec(
          notes,
        )?.[1];
    const end = toKstDate(bounds.to);
    const resumeMonth = Number(resumeDate?.match(/\d{1,2}(?=월)/)?.[0]);
    const resumeAt = resumeDate
      ? tableDateAt(
          resumeDate,
          end.year + Number(end.month === 12 && resumeMonth === 1),
        )
      : undefined;
    const hasResume = resumeAt !== undefined && resumeAt > bounds.to;
    const resumeValue = hasResume ? resumeAt : undefined;
    const excerpt = row.project(
      key,
      period,
      ...(wantsResume && hasResume ? [resume] : []),
    );
    return excerpt
      ? [
          {
            excerpt,
            hasResume,
            resumeValue,
            periodValue: bounds.from + '|' + bounds.to,
          },
        ]
      : [];
  });
  if (!candidates.length) return missing();
  const complete = wantsResume
    ? candidates.filter(({ hasResume }) => hasResume)
    : candidates;
  const options = complete.length ? complete : candidates;
  if (
    new Set(candidates.map(({ periodValue }) => periodValue)).size > 1 ||
    (wantsResume &&
      new Set(complete.map(({ resumeValue }) => resumeValue)).size > 1)
  )
    return abstain(
      '해당 반의 승인 시간표 적용 기간 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [{ excerpt, hasResume }] = options;
  ctx.trace.intent = 'schedule_validity_period';
  return fromPublicExcerpts(
    [excerpt],
    wantsResume && !hasResume ? ['정규 시간표 복귀일'] : [],
  );
}

/** Bound public timetable fields and premise checks keep the verified class as the row key. */
export async function answerClassScheduleFields(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const text = frame.normalized;
  if (
    frame.explicitDates.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek !== null ||
    frame.relativePeriod !== null ||
    frame.months.length ||
    frame.unboundProgram ||
    frame.unknownPrograms.length ||
    frame.flags.attitude ||
    frame.flags.prediction ||
    frame.flags.causal ||
    frame.flags.compare ||
    frame.groupReference ||
    frame.matchedStudentIds.length > 1 ||
    /휴강|휴원|보강|시험|방학|개정|이전|예전|비교|말고|제외|상담|셔틀|통학|강의실|교실|요금/.test(
      text,
    ) ||
    frame.topics.some(({ id }) => id !== 'schedule' && id !== 'hours')
  )
    return;

  const asksOrder = /(?:과목|교과)(?:별)?\s*(?:진행\s*)?순서/.test(text);
  const regular = /(?:매일|날마다).{0,12}(?:가[는나요]|수업|하[는나요])/.test(
    text,
  );
  const weekdayGuess =
    /([월화수목금토일])요일(?:이|은|는)?\s*(?:맞죠|맞나요|맞아요|맞는지)/.exec(
      text,
    );
  const checkingClass =
    frame.matchedStudentIds.length === 1 &&
    frame.classIds.length === 1 &&
    /\d\s*반(?:이죠|이 맞| 맞죠|인가요)/.test(text) &&
    /수업\s*시간|(?:끝|시작).{0,8}시간|몇\s*시/.test(text);
  const usual =
    ctx.access.role === 'student' &&
    /(?:우리|울|내|제)\s*반/.test(text) &&
    ((/원래|평소/.test(text) && /몇\s*시|시간표|수업\s*시간/.test(text)) ||
      /수업(?:은|이)?\s*몇\s*시\s*부터\s*몇\s*시\s*까지/.test(text));
  if (
    (!asksOrder && !regular && !weekdayGuess && !checkingClass && !usual) ||
    (frame.flags.previousRevision && !usual)
  )
    return;

  const mentioned = explicitClassIds(ctx);
  const grades = [
    ...new Set(
      [...text.matchAll(/(?<![가-힣])([초중고][1-6])(?![\d가-힣])/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (grades.length > 1) return;
  const [grade] = grades;
  const fromGrade = grade
    ? ctx.catalog.classes
        .filter((klass) => klass.grade === grade)
        .map(({ classId }) => classId)
    : [];
  const classIds = checkingClass
    ? ctx.studentClassIds
    : frame.matchedStudentIds.length
      ? ctx.studentClassIds.filter(
          (id) => !frame.classIds.length || mentioned.includes(id),
        )
      : mentioned.length
        ? mentioned
        : fromGrade;
  if (classIds.length !== 1 || frame.negatedClassIds.includes(classIds[0]))
    return;
  const [classId] = classIds;
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return;
  const exact = [klass.name, ...klass.aliases]
    .map(compactText)
    .filter(
      (label) =>
        !ctx.catalog.classes.some(
          (other) =>
            other.classId !== classId &&
            [other.name, ...other.aliases].some(
              (name) => compactText(name) === label,
            ),
        ),
    );
  const scoped = {
    ...ctx,
    frame: {
      ...frame,
      classIds,
      normalized: weekdayGuess ? text.replace(weekdayGuess[0], '') : text,
    },
  };
  const currentFacts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['schedule'],
  });
  recordFacts(ctx.trace, currentFacts);
  const sources = new Set(
    currentFacts
      .filter(
        (fact) =>
          fact.subjectType === 'class' &&
          fact.subjectId === classId &&
          fact.value.kind === 'schedule',
      )
      .map(({ sourceId }) => sourceId),
  );
  const rows = await classTableRows(
    scoped,
    classId,
    ['schedule'],
    undefined,
    undefined,
    REGULAR_TIME_FIELD,
  );
  const candidates = rows.flatMap(({ chunk, tableColumns }) => {
    const { cells, header } = chunk.location;
    if (
      !header ||
      !cells ||
      !tableColumns ||
      (sources.size && !sources.has(chunk.sourceId)) ||
      !canReadRecord(ctx.access, chunk, []) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      return [];
    const key = tableColumns.find(
      (i) =>
        CLASS_FIELD.test(compactText(header[i])) &&
        exact.includes(compactText(cells[i])),
    );
    const field = tableColumns.find((i) =>
      (asksOrder ? SUBJECT_ORDER_FIELD : REGULAR_TIME_FIELD).test(
        compactText(header[i]),
      ),
    );
    if (key === undefined || field === undefined) return [];
    const value = cells[field];
    if (
      asksOrder
        ? !/(?:→|➝|다음|순서)/.test(value)
        : !CLOCK_TIME.test(value) || CONDITIONAL.test(value)
    )
      return [];
    const day = asksOrder
      ? undefined
      : tableColumns.find((i) => CLASS_DAY_FIELD.test(compactText(header[i])));
    const schedule = day === undefined ? value : cells[day] + ' ' + value;
    if (
      (regular || weekdayGuess) &&
      !'월화수목금토일'
        .split('')
        .some((weekday) => dayWordCovers(schedule, weekday))
    )
      return [];
    const columns = day === undefined ? [key, field] : [key, day, field];
    const excerpt = {
      chunk,
      tableColumns: columns,
      line: columns
        .map((index) => header[index] + ': ' + cells[index])
        .join(' / '),
    };
    return supportsExcerpt(excerpt)
      ? [{ excerpt, value: compactText(schedule) }]
      : [];
  });
  if (!candidates.length) {
    if (!asksOrder && !checkingClass && !weekdayGuess) return;
    return abstain(
      '해당 반의 요청 항목을 승인 시간표에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  }
  if (new Set(candidates.map(({ value }) => value)).size > 1)
    return abstain(
      '해당 반의 승인 시간표에 서로 다른 값이 있습니다.',
      'CONFLICTING_EVIDENCE',
    );
  const { excerpt } = candidates[0];
  ctx.frame = scoped.frame;
  ctx.trace.intent = asksOrder
    ? 'class_subject_order'
    : 'class_schedule_confirmation';
  return {
    status: 'answered',
    text: excerpt.line,
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
      },
    ],
    excerpts: [excerpt],
    usedFacts: [],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        classIds,
        topicIds: ['schedule'],
        units: [],
        periods: [],
      },
    },
  };
}

async function findScheduleChanges(
  ctx: AnswerContext,
  classId: string,
  isoDate: string,
) {
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: ['schedule_change'],
    asOf: ctx.asOf,
    effectiveAt: ctx.asOf,
  });
  recordFacts(ctx.trace, facts);
  const names = ctx.catalog.classes
    .filter((entry) => entry.classId === classId)
    .flatMap((entry) => [entry.name, ...entry.aliases])
    .map(compactText)
    .filter((name) => name.length >= 3);
  return facts.filter((fact) => {
    if (fact.value.kind !== 'schedule_change') return false;
    if (fact.value.event) {
      const day = tableDateAt(isoDate, 0);
      const interval = scheduleChangeInterval(fact.value);
      if (
        day === undefined ||
        !interval ||
        interval.start >= day + 24 * 60 * 60 * 1000 ||
        day >= interval.end
      )
        return false;
    } else if (fact.value.date !== isoDate) return false;
    if (fact.subjectType === 'class') return fact.subjectId === classId;
    if (fact.subjectType !== 'academy') return false;
    const text = compactText(fact.value.text);
    return (
      /학원전체|전수업|모든수업|전체휴강|휴원/.test(text) ||
      names.some((name) => text.includes(name))
    );
  });
}

/** A day referred to as "그날" comes from the last cited event, then is looked up again. */
export async function answerEventDayFollowUp(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const previous = ctx.state?.previousFrame;
  if (
    previous?.domain !== 'info' ||
    previous.eventDay === undefined ||
    previous.classIds?.length !== 1 ||
    !/^(?:그\s*날|그\s*날짜|그때)(?:은|는|에|에도|도)?\s/.test(
      frame.normalized,
    ) ||
    !/수업|휴강|시간표/.test(frame.normalized) ||
    /보강|셔틀|차량|강의실|교실|상담|시험|수강료|다른|말고|이전|이후|전날|다음\s*날/.test(
      frame.normalized,
    ) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.relativeWeek ||
    frame.flags.compare ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.groupReference ||
    frame.unresolvedRelationWords.length ||
    frame.matchedStudentIds.length > 1
  )
    return;
  const [classId] = previous.classIds;
  const specified = explicitClassIds(ctx);
  if (
    frame.negatedClassIds.includes(classId) ||
    (specified.length && (specified.length !== 1 || specified[0] !== classId))
  )
    return;
  const { eventDay } = previous;
  const changes = await findScheduleChanges(
    ctx,
    classId,
    toIsoDate(toKstDate(eventDay)),
  );
  const details = changes.flatMap((fact) =>
    fact.value.kind === 'schedule_change' &&
    !isAssistantDirective(fact.value.text)
      ? [fact.value]
      : [],
  );
  if (
    changes.length !== details.length ||
    new Set(
      details.map(({ changeType, time, text }) =>
        [changeType, time, compactText(text)].join('|'),
      ),
    ).size > 1
  )
    return abstain(
      '해당 반과 날짜의 승인 일정이 서로 달라 확인이 필요합니다.',
      'CONFLICTING_EVIDENCE',
    );

  ctx.frame = { ...frame, classIds: [classId] };
  if (!details.length) {
    const row = await answerDatedClassSchedule(ctx, classId, eventDay);
    return (
      row ??
      abstain(
        '그날 적용되는 승인 수업 일정을 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      )
    );
  }
  ctx.trace.intent = 'event_day_schedule';
  const [change] = details;
  const date = formatKstDate(eventDay);
  return {
    status: 'answered',
    text: [
      date,
      change.changeType === 'cancel' ? '휴강' : '보강',
      change.time,
      change.text,
    ]
      .filter(Boolean)
      .join(' · '),
    citations: changes.map((fact) => ({ kind: 'fact', fact })),
    usedFacts: changes,
    instants: [eventDay],
    conversationUpdate: { previousFrame: previous },
  };
}

async function datedScheduleRow(
  ctx: AnswerContext,
  classId: string,
): Promise<AnswerDraft | undefined> {
  const { frame, asOf } = ctx;
  const text = frame.normalized;
  if (
    frame.explicitDates.length !== 1 ||
    frame.explicitDates[0].operator !== 'at' ||
    !/시간표|수업\s*시간|몇\s*시|강의실|교실/.test(text) ||
    /상담|설명회|방문|셔틀|차량|보강|휴강|휴원|신청|수업료/.test(text) ||
    frame.flags.compare ||
    frame.flags.previousRevision ||
    frame.topics.some(
      ({ id }) => !['schedule', 'hours', 'classroom', 'location'].includes(id),
    )
  )
    return;

  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  const { explicitDay } = resolveEffectiveTime(frame, asOf);
  if (!klass || explicitDay === null) return;
  const date = toKstDate(explicitDay);
  const askedWeekday = /([월화수목금토일])요일/.exec(text)?.[1];
  const actualWeekday = '일월화수목금토'[
    new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  ];
  if (askedWeekday && askedWeekday !== actualWeekday)
    return abstain(
      '질문에 적힌 날짜와 요일이 일치하지 않습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  return answerDatedClassSchedule(ctx, classId, explicitDay);
}

export async function answerDatedClassSchedule(
  ctx: AnswerContext,
  classId: string,
  day: number,
): Promise<AnswerDraft | undefined> {
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return;
  const date = toKstDate(day);
  const names = [klass.name, ...klass.aliases]
    .map(compactText)
    .filter(
      (name) =>
        !ctx.catalog.classes.some(
          (other) =>
            other.classId !== classId &&
            [other.name, ...other.aliases].some(
              (alias) => compactText(alias) === name,
            ),
        ),
    );
  const results = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [klass.name, '적용 날짜 수업 시간 강의실', formatKstDate(day)].join(
      ' ',
    ),
    documentTypes: ['schedule'],
    limit: 60,
  });
  recordChunks(
    ctx.trace,
    results.map(({ chunk }) => chunk),
  );
  const candidates = results.flatMap(({ chunk }) => {
    const { kind, cells, header } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      (chunk.classId && chunk.classId !== classId) ||
      !canReadRecord(ctx.access, chunk, []) ||
      !isValidAt(chunk.validFrom, chunk.validTo, day) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      return [];
    const fields = header.map(compactText);
    const classColumn = fields.findIndex((value) =>
      /^(?:반|반명|강좌|과정|대상반)$/.test(value),
    );
    const dayColumn = fields.findIndex((value) =>
      /^(?:적용날짜|날짜|수업일|수업날짜|일자)$/.test(value),
    );
    const timeColumn = fields.findIndex((value) =>
      /^(?:수업시간|시간|수업시각|변경시간)$/.test(value),
    );
    const roomColumn = fields.findIndex((value) =>
      /^(?:강의실|교실|장소)$/.test(value),
    );
    const rawDay = cells[dayColumn] ?? '';
    if (
      !names.includes(compactText(cells[classColumn] ?? '')) ||
      tableDateAt(
        rawDay.replace(/\s*\([월화수목금토일](?:요일)?\)$/, ''),
        date.year,
      ) !== day
    )
      return [];
    const time = cells[timeColumn] ?? '';
    const room = cells[roomColumn] ?? '';
    const cancelled = /^(?:휴강|휴원|수업\s*없음)$/.test(time.trim());
    const conflictsWithTime =
      !cancelled &&
      fields.some(
        (field, index) =>
          /^(?:비고|상태|특이사항)$/.test(field) &&
          /휴강|휴원|수업\s*없|미정|취소|제외/.test(cells[index]),
      );
    const tableColumns = [
      classColumn,
      dayColumn,
      timeColumn,
      ...(cancelled ? [] : [roomColumn]),
    ].filter((index) => index >= 0 && cells[index].trim());
    const excerpt = {
      chunk,
      tableColumns,
      line: tableColumns
        .map((index) => header[index] + ': ' + cells[index])
        .join(' / '),
    };
    return [
      {
        excerpt,
        complete:
          tableDateAt(rawDay, date.year) === day &&
          !conflictsWithTime &&
          (cancelled ||
            (CLOCK_TIME.test(time) &&
              (!ROOM.test(ctx.frame.normalized) || /[가-힣\d]/.test(room)))) &&
          supportsExcerpt(excerpt),
        key: compactText(time + '|' + (cancelled ? '' : room)),
      },
    ];
  });
  if (!candidates.length) return;
  if (
    candidates.some(({ complete }) => !complete) ||
    new Set(candidates.map(({ key }) => key)).size > 1 ||
    (await findScheduleChanges(ctx, classId, toIsoDate(date))).length > 0
  )
    return abstain(
      '해당 날짜의 변경 시간과 장소를 승인 자료에서 확정할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const { excerpt } = candidates[0];
  ctx.trace.intent = 'dated_schedule_row';
  return {
    status: 'answered',
    text: excerpt.line,
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
        effectiveAt: day,
      },
    ],
    excerpts: [excerpt],
    usedFacts: [],
  };
}

/** Answers bounded schedule questions directly from verified table projections. */
export async function answerFromScheduleEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const classIds = resolveQualifiedClasses(ctx);
  if (classIds.length === 1) {
    const dated = await datedScheduleRow(ctx, classIds[0]);
    if (dated) return dated;
  }
  const targetCount = explicitClassIds(ctx).length;
  const narrowedCourse = classIds.length < targetCount;
  const expandedCourse = classIds.length > targetCount;
  const intentIds = frame.topics.map(({ id }) => id);
  const asksClassArrival =
    classIds.length === 1 &&
    ctx.studentClassIds.includes(classIds[0]) &&
    frame.relativeDay !== null &&
    frame.explicitDates.length === 0 &&
    CLOCK_QUERY.test(frame.normalized) &&
    /(?:학원|수업)(?:에|은|에는)?\s*(?:가|오|도착)|등원/.test(
      frame.normalized,
    ) &&
    intentIds.every((id) => id === 'hours' || id === 'schedule') &&
    !/상담|설명회|체험|방문|셔틀|차량/.test(frame.normalized);
  const asksRoomAndSchedule =
    intentIds.includes('schedule') &&
    intentIds.every((id) => id === 'schedule' || id === 'location') &&
    ROOM.test(frame.normalized) &&
    !/오시는\s*길|주소|위치|역에서|주차/.test(frame.normalized);
  const asksRoomOnly = classIds.length === 1 && isClassroomLookup(ctx);
  const asksEnrolledSchedule =
    classIds.length === 1 &&
    ctx.studentClassIds.includes(classIds[0]) &&
    frame.matchedStudentIds.length === 1 &&
    intentIds.length === 1 &&
    intentIds[0] === 'schedule' &&
    (/수업\s*시간|시간표/.test(frame.normalized) ||
      (ctx.state?.previousFrame?.topicIds?.includes('schedule') &&
        isStudentOnlyFollowUp(ctx)));
  // A question can ask for the regular class time and a separate lesson type.
  // The regular timetable cannot confirm an unlisted lesson type.
  const asksTimeAndNativeLesson =
    classIds.length === 1 &&
    intentIds.includes('native') &&
    intentIds.every(
      (id) =>
        id === 'schedule' ||
        id === 'hours' ||
        id === 'native' ||
        id === 'teacher',
    ) &&
    /수업(?:은|이|을)?\s*몇\s*시/.test(frame.normalized) &&
    !/담임|담당|누구|누가|성함/.test(frame.normalized);
  const asksNarrowedSchedule =
    narrowedCourse &&
    intentIds.length === 0 &&
    /시간\s*(?:알려|궁금|어떻게|좀|언제)/.test(frame.normalized);
  if (
    classIds.length === 0 ||
    (!asksClassArrival &&
      !asksRoomAndSchedule &&
      !asksRoomOnly &&
      !asksEnrolledSchedule &&
      !asksNarrowedSchedule &&
      !asksTimeAndNativeLesson &&
      (intentIds.length !== 1 ||
        intentIds[0] !== 'schedule' ||
        !/시간표|몇\s*시(?!간)|수업\s*시간|요일/.test(frame.normalized))) ||
    CONDITIONAL.test(frame.normalized) ||
    /평일|주말|[월화수목금토일]욜/.test(frame.normalized) ||
    /몇\s*분|몇\s*시간|동안|언제\s*부터|몇\s*번/.test(frame.normalized) ||
    (!asksClassArrival && /까지/.test(frame.normalized)) ||
    frame.flags.compare ||
    frame.flags.previousRevision
  )
    return undefined;

  let scheduleContext = expandedCourse
    ? { ...ctx, frame: { ...frame, classIds } }
    : ctx;
  if (asksClassArrival && frame.relativeDay !== null) {
    const today = toKstDate(ctx.asOf);
    const date = toKstDate(
      kstStartOfDay({ ...today, day: today.day + frame.relativeDay }),
    );
    scheduleContext = {
      ...ctx,
      frame: { ...frame, explicitDates: [{ ...date, operator: 'at' }] },
    };
  }
  const effective = resolveEffectiveTime(scheduleContext.frame, ctx.asOf);
  const datedRequest =
    scheduleContext.frame.explicitDates[0]?.operator === 'at' &&
    effective.explicitDay !== null &&
    classIds.length === 1;
  if (datedRequest && effective.explicitDay !== null) {
    const date = toKstDate(effective.explicitDay);
    const namedDay = /([월화수목금토일])요일/.exec(frame.normalized)?.[1];
    const actualDay = '일월화수목금토'[
      new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    ];
    if (namedDay && namedDay !== actualDay)
      return abstain(
        '질문에 적힌 날짜와 요일이 일치하지 않습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
    const changes = await findScheduleChanges(
      ctx,
      classIds[0],
      toIsoDate(date),
    );
    if (changes.length) {
      if (
        asksClassArrival ||
        CLOCK_QUERY.test(frame.normalized) ||
        ROOM.test(frame.normalized)
      ) {
        return abstain(
          '해당 날짜에 수업 변경 공지가 있어 정규 시각이나 장소를 안내하기 어렵습니다.',
          'INSUFFICIENT_EVIDENCE',
        );
      }
      const statements = changes.flatMap(({ value }) =>
        value.kind === 'schedule_change' ? [value.text] : [],
      );
      ctx.trace.intent = 'schedule_override';
      return {
        status: 'answered',
        text: [...new Set(statements)].join('\n'),
        citations: changes.map((fact) => ({ kind: 'fact', fact })),
        usedFacts: changes,
        instants: [effective.explicitDay],
      };
    }
  }
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
  if (
    prefersStructured &&
    currentFacts.length &&
    !narrowedCourse &&
    !expandedCourse &&
    !asksClassArrival &&
    !asksRoomOnly &&
    !asksEnrolledSchedule
  )
    return undefined;

  const slots = (
    await collectScheduleSlots(scheduleContext, classIds, effective)
  ).map((slot) => {
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
  });
  if (!slots.some(({ excerpts }) => excerpts.length)) {
    return asksClassArrival
      ? abstain(
          '해당 날짜의 등원 시각을 시간표에서 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        )
      : undefined;
  }
  if (!frame.classIds.length && slots.some(({ excerpts }) => !excerpts.length))
    return undefined;
  const missingFields = slots
    .filter(({ excerpts }) => excerpts.length === 0)
    .map(({ classId }) => className(ctx.catalog, classId) + ' 시간표');
  const excerpts = slots.flatMap((slot) => slot.excerpts);
  if (
    asksTimeAndNativeLesson &&
    !excerpts.some(({ chunk, tableColumns }) =>
      tableColumns?.some(
        (index) =>
          /원어민\s*(?:수업|강의|회화)/.test(
            chunk.location.header?.[index] ?? '',
          ) &&
          !/^(?:\s*|[-–—]+|미정|미확인)$/.test(
            chunk.location.cells?.[index]?.trim() ?? '',
          ),
      ),
    )
  )
    missingFields.push('원어민 수업');
  const prefix =
    effective.explicitDay === null
      ? ''
      : formatKstDate(effective.at) + ' 기준 ';
  const lines = slots.flatMap(({ classId, excerpts }) =>
    excerpts.map(
      ({ line, displayLine }) =>
        prefix +
        className(ctx.catalog, classId) +
        ' 수업: ' +
        (displayLine ?? line),
    ),
  );
  if (missingFields.length)
    lines.push('확인되지 않은 항목: ' + missingFields.join(', '));

  if (expandedCourse) ctx.frame = scheduleContext.frame;
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
        topicIds:
          asksRoomOnly && !asksRoomAndSchedule ? ['classroom'] : ['schedule'],
        classIds,
      },
    },
  };
}
