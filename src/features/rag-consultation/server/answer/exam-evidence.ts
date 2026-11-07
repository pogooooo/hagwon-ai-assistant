import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { parseQuery } from '../query/parse-query.ts';
import { isValidAt, kstStartOfDay, toKstDate } from '../text/time.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { answerDatedClassSchedule } from './schedule-evidence.ts';
import { tableDateAt } from './table-dates.ts';
import { supportsExcerpt } from './verify.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';
import { officialStatements } from './announcement-conflict.ts';

const ADMISSION_TEST =
  /(?:선발|입학|입반|레벨|진단|배치)\s*(?:테스트|시험|평가)/;
const DATED_TEST =
  /(?<!\d)((?:20\d{2}년\s*)?\d{1,2}월\s*\d{1,2}일(?:\s*\([월화수목금토일](?:요일)?\))?)\s*(?:[·,]\s*)?((?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)/g;

/** A follow-up can reuse the confirmed program while its next dated test is looked up again. */
export async function answerAdmissionTestDate(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame, state } = ctx;
  const q = frame.normalized;
  const direct = ADMISSION_TEST.test(q);
  if (
    !/테스트|시험|평가/.test(q) ||
    !/언제|몇\s*시|날짜|일자/.test(q) ||
    (!direct &&
      !/다음\s*(?:테스트|시험|평가)|(?:그|이)\s*(?:테스트|시험|평가)/.test(
        q,
      )) ||
    /학교|기말|중간고사|점수|범위|비용|신청\s*마감|접수\s*기한|비교/.test(q) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.unboundProgram ||
    frame.unknownPrograms.length
  )
    return;
  const previous = state?.previousFrame;
  const prior =
    !frame.classIds.length &&
    previous?.domain === 'info' &&
    previous.question &&
    /테스트|시험|평가/.test(previous.question) &&
    /선발|입학|등록|들어가|지원|레벨|진단|배치/.test(previous.question)
      ? parseQuery(previous.question, {
          access: ctx.access,
          catalog: ctx.catalog,
          config: ctx.config,
        })
      : undefined;
  const ids = frame.classIds.length
    ? frame.classIds
    : prior && !prior.flags.crossTenant && !prior.unauthorizedStudentRefs.length
      ? prior.classIds
      : [];
  if (ids.length !== 1 || (!direct && !prior && !frame.classIds.length)) return;
  const [classId] = ids;
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass || frame.negatedClassIds.includes(classId)) return;
  const names = ctx.catalog.classes.map(({ classId, name, aliases }) => ({
    classId,
    labels: [name, ...aliases]
      .map(compactText)
      .filter((alias) => alias.length >= 3),
  }));
  const classMention = (sentence: string) => {
    const text = compactText(sentence);
    return names.filter(({ labels }) =>
      labels.some((label) => text.includes(label)),
    );
  };
  const matchesClass = (sentence: string) => {
    const mentioned = classMention(sentence);
    return mentioned.length === 1 && mentioned[0].classId === classId;
  };
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['announcement', 'schedule', 'academy_info'],
    query: [klass.name, ...klass.aliases, '선발 테스트 날짜 시각 일정'].join(
      ' ',
    ),
    limit: 55,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const candidates = hits
    .flatMap(({ chunk }) => {
      if (
        !isCleanPublicEvidence(chunk, ctx.asOf) ||
        (chunk.classId && chunk.classId !== classId) ||
        chunk.location.kind !== 'paragraph'
      )
        return [];
      return officialStatements(chunk).flatMap(({ text }) => {
        const sentences = splitSentences(text);
        return sentences.flatMap((line, index) => {
          if (
            !ADMISSION_TEST.test(line) ||
            /취소|미정|연기|검토|예시|신청\s*마감/.test(line)
          )
            return [];
          const context = sentences[index - 1];
          const binding = matchesClass(line)
            ? line
            : !classMention(line).length &&
                context &&
                ADMISSION_TEST.test(context) &&
                matchesClass(context)
              ? context
              : undefined;
          if (!binding) return [];
          const dateTimes = [...line.matchAll(DATED_TEST)];
          if (dateTimes.length !== 1) return [];
          const [match] = dateTimes;
          const beforeDate = line.slice(0, match.index).trimEnd();
          if (
            /(?:접수|신청|등록|상담)\s*(?:시작|마감|일정|기간|일|가능)?(?:은|는|이|가)?\s*[:：]?\s*$/.test(
              beforeDate,
            )
          )
            return [];
          const [, date, time] = match;
          const year = toKstDate(chunk.validFrom).year;
          const lastYear =
            chunk.validTo === null ? year : toKstDate(chunk.validTo - 1).year;
          const [hours, minutes] = time.split(':').map(Number);
          const days = [
            ...new Set(
              [year, lastYear]
                .map((candidateYear) => tableDateAt(date, candidateYear))
                .filter(
                  (day): day is number =>
                    day !== undefined &&
                    isValidAt(chunk.validFrom, chunk.validTo, day),
                ),
            ),
          ];
          if (days.length !== 1) return [];
          const [day] = days;
          const starts = day + (hours * 60 + minutes) * 60_000;
          if (
            starts < ctx.asOf ||
            !isValidAt(chunk.validFrom, chunk.validTo, starts)
          )
            return [];
          const excerpt = { chunk, line };
          const anchor = { chunk, line: binding };
          return supportsExcerpt(excerpt) && supportsExcerpt(anchor)
            ? [{ excerpt, anchor, day, starts }]
            : [];
        });
      });
    })
    .sort((a, b) => a.starts - b.starts);
  if (!candidates.length)
    return abstain(
      '해당 과정의 다음 시험 날짜와 시각을 승인 일정에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const [next] = candidates;
  if (
    new Set(
      candidates
        .filter(({ day }) => day === next.day)
        .map(({ starts }) => starts),
    ).size > 1
  )
    return abstain(
      '같은 시험일의 승인 시각이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const answer = fromPublicExcerpts([next.excerpt]);
  ctx.trace.intent = 'admission_test_date';
  return {
    ...answer,
    excerpts:
      next.anchor.line === next.excerpt.line
        ? [next.excerpt]
        : [next.anchor, next.excerpt],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        classIds: [classId],
        units: [],
        periods: [],
      },
    },
  };
}

const EXAM_DATE =
  /(?:시험|고사)\s*(?:(?:은|는|이|가)\s*)?(?:언제|날짜|일정|일자|날이|일(?:은|이|\s))/;
const PREVIOUS_DAY = /(?:시험|고사)\s*(?:의\s*)?전날/;
const OTHER_REQUEST =
  /점수|성적|정답률|예상|성적표|시험\s*(?:범위|문제|난이도|준비물)|응시료|수강료|신청|결석|자습실|셔틀|담당\s*(?:강사|선생)/;

function asksSchoolExamDate(text: string): boolean {
  return (
    (EXAM_DATE.test(text) || PREVIOUS_DAY.test(text)) &&
    !OTHER_REQUEST.test(text)
  );
}

const schoolKey = (value: string) =>
  compactText(value)
    .replace(/여자중학교$/, '여중')
    .replace(/여자고등학교$/, '여고')
    .replace(/중학교$/, '중')
    .replace(/고등학교$/, '고')
    .replace(/초등학교$/, '초');

/** School exam dates are tied to a catalog enrollment, then to a dated class row. */
export async function answerSchoolExamSchedule(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const range =
    /학교/.test(frame.normalized) &&
    /(?:시험|고사)\s*범위/.test(frame.normalized);
  const missingScope = () =>
    range
      ? abstain(
          '학교·학년·과목에 해당하는 시험 범위를 승인 자료에서 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
          ['학교 시험 범위'],
        )
      : undefined;
  if (
    (!range && !asksSchoolExamDate(frame.normalized)) ||
    frame.flags.attitude ||
    frame.flags.causal ||
    frame.flags.prediction ||
    frame.flags.previousRevision ||
    /비교|각각|말고|제외/.test(frame.normalized) ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.groupReference ||
    frame.matchedStudentIds.length > 1 ||
    frame.subjects.length > 1 ||
    frame.explicitDates.length > 1 ||
    (!range &&
      frame.topics.some(
        ({ id }) =>
          !['schedule', 'hours', 'classroom', 'location'].includes(id),
      ))
  )
    return missingScope();

  const namedStudent = frame.matchedStudentIds.length === 1;
  // A named student's school is authoritative for a question checking an assumption.
  const checkingPremise =
    namedStudent &&
    /같(?:죠|나요|아요|은지)|맞(?:죠|나요|아요|는지)/.test(frame.normalized);
  if (!checkingPremise && frame.explicitDates.length) return missingScope();
  const classIds = (
    namedStudent || !frame.classIds.length
      ? ctx.studentClassIds
      : frame.classIds
  ).filter((id) => !frame.negatedClassIds.includes(id));
  const [classId] = classIds;
  if (
    classIds.length !== 1 ||
    (!checkingPremise && frame.classIds.some((id) => id !== classId))
  )
    return missingScope();
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  const grade = /^([초중고])([1-6])$/.exec(klass?.grade ?? '');
  if (!klass || !grade) return missingScope();
  const name = klass.name.normalize('NFKC');
  const school =
    /^([가-힣]{2,}(?:초등학교|중학교|고등학교|[초중고]))\s*[1-6]\s*학년/.exec(
      name,
    )?.[1];
  if (!school || !schoolKey(school).endsWith(grade[1])) return missingScope();
  const mentionedSchool = /([가-힣]{2,}(?:초등학교|중학교|고등학교))/.exec(
    frame.normalized,
  )?.[1];
  if (
    range &&
    mentionedSchool &&
    schoolKey(mentionedSchool) !== schoolKey(school)
  )
    return missingScope();
  const subject = frame.subjects[0] ?? klass.subject;
  if (
    frame.subjects.length &&
    compactText(subject ?? '') !== compactText(klass.subject ?? '')
  )
    return missingScope();
  const term = /기말|중간/.exec(frame.normalized)?.[0];
  const preceding = PREVIOUS_DAY.test(frame.normalized);

  const matches = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    documentTypes: ['schedule', 'announcement'],
    query: [
      school,
      schoolKey(school),
      grade[2] + '학년',
      subject,
      term,
      range ? '학교 학년 과목 시험 범위' : '학교 학년 시험일 시험 날짜',
    ].join(' '),
    limit: 60,
  });
  recordChunks(
    ctx.trace,
    matches.map(({ chunk }) => chunk),
  );
  const evidence = matches.flatMap<{
    excerpt: EvidenceExcerpt;
    day: number | null;
  }>(({ chunk }) => {
    const { kind, header, cells, section } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      (chunk.classId && chunk.classId !== classId) ||
      !canReadRecord(ctx.access, chunk, []) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      return [];
    const fields = header.map(compactText);
    const schoolColumn = fields.findIndex((field) =>
      /^(?:학교|학교명|대상학교)$/.test(field),
    );
    const gradeColumn = fields.findIndex((field) =>
      /^(?:학년|대상학년)$/.test(field),
    );
    const labels = range
      ? ['시험범위', '고사범위', '평가범위']
      : ['시험일', '시험일자', '시험날짜', '고사일'];
    const dateColumns = fields.flatMap((field, index) =>
      subject && labels.some((label) => field === compactText(subject) + label)
        ? [index]
        : [],
    );
    if (
      dateColumns.length !== 1 ||
      schoolKey(cells[schoolColumn] ?? '') !== schoolKey(school) ||
      ![grade[2], grade[2] + '학년', grade[0]].includes(
        compactText(cells[gradeColumn] ?? ''),
      ) ||
      (term &&
        ![chunk.title, section ?? '', header[dateColumns[0]]].some((value) =>
          value.includes(term),
        ))
    )
      return [];
    const dateColumn = dateColumns[0];
    if (range) {
      if (
        !isValidAt(chunk.validFrom, chunk.validTo, ctx.asOf) ||
        /^(?:[-–—]+|미정|미확인|별도안내|추후안내)$|프린트.{0,12}(?:배부|제공|드립)|담당.{0,8}문의/.test(
          compactText(cells[dateColumn]),
        )
      )
        return [];
      const excerpt = readEvidenceRow(chunk)?.project(
        schoolColumn,
        gradeColumn,
        dateColumn,
      );
      return excerpt ? [{ excerpt, day: null }] : [];
    }
    const year = toKstDate(chunk.validFrom).year;
    const value = cells[dateColumn];
    const finalYear =
      chunk.validTo === null ? year : toKstDate(chunk.validTo - 1).year;
    if (
      !/^\s*\d{4}(?:년|[-./])/.test(value) &&
      (chunk.validTo === null || finalYear - year > 1)
    )
      return [];
    const candidates = [...new Set([year, finalYear])]
      .map((candidateYear) => tableDateAt(value, candidateYear))
      .filter(
        (day): day is number =>
          day !== undefined && isValidAt(chunk.validFrom, chunk.validTo, day),
      );
    const days = [...new Set(candidates)];
    if (days.length !== 1) return [];
    const tableColumns = [schoolColumn, gradeColumn, dateColumn];
    const line = tableColumns
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt) ? [{ excerpt, day: days[0] }] : [];
  });
  if (range) {
    if (!evidence.length) return missingScope();
    if (
      new Set(evidence.map(({ excerpt }) => compactText(excerpt.line))).size > 1
    )
      return abstain(
        '승인 자료에 해당 시험 범위가 서로 다르게 적혀 있습니다.',
        'CONFLICTING_EVIDENCE',
      );
    ctx.trace.intent = 'school_exam_range';
    return fromPublicExcerpts([evidence[0].excerpt]);
  }
  const dates = evidence.flatMap(({ excerpt, day }) =>
    day === null ? [] : [{ excerpt, day }],
  );
  if (!dates.length)
    return abstain(
      '해당 학교·학년·과목의 시험일을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  if (new Set(dates.map(({ day }) => day)).size !== 1)
    return abstain(
      '승인 자료에 해당 시험일이 서로 다르게 적혀 있습니다.',
      'CONFLICTING_EVIDENCE',
    );

  const { excerpt, day } = dates[0];
  const date = toKstDate(day);
  const previousDay = kstStartOfDay({ ...date, day: date.day - 1 });
  const lesson = preceding
    ? await answerDatedClassSchedule(ctx, classId, previousDay)
    : undefined;
  const confirmedLesson = lesson?.status === 'answered' ? lesson : undefined;
  const missingLesson = preceding && !confirmedLesson;
  if (checkingPremise) {
    // A proposed date is the claim being checked, not an effective-time filter.
    ctx.frame = {
      ...frame,
      classIds: [classId],
      explicitDates: [],
      months: [],
      relativePeriod: null,
    };
  }
  ctx.trace.intent = 'school_exam_schedule';
  return {
    status: missingLesson ? 'partial' : 'answered',
    reasonCode: missingLesson ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missingLesson ? ['시험 전날 수업'] : undefined,
    text: [
      excerpt.line,
      confirmedLesson?.text,
      missingLesson
        ? '시험 전날의 수업 여부와 시간은 승인 자료에서 확인할 수 없습니다.'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
    citations: [
      {
        kind: 'chunk',
        chunk: excerpt.chunk,
        tableColumns: excerpt.tableColumns,
        effectiveAt: day,
      },
      ...(confirmedLesson?.citations ?? []),
    ],
    excerpts: [excerpt, ...(confirmedLesson?.excerpts ?? [])],
    usedFacts: [],
    conversationUpdate: {
      previousFrame: {
        domain: 'info',
        classIds: [classId],
        topicIds: ['schedule'],
        units: [],
        periods: [],
        eventDay: preceding ? undefined : day,
      },
    },
  };
}
