import { isAssistantDirective } from '../ingest/validation.ts';
import { compactText } from '../text/normalize.ts';
import {
  isValidAt,
  kstStartOfDay,
  makePeriod,
  shiftPeriod,
  toKstDate,
} from '../text/time.ts';
import {
  abstain,
  recordChunks,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import { tablePeriodOverlapping, weekdayAt } from './table-dates.ts';
import { fromPublicExcerpts, readEvidenceRow } from './public-evidence.ts';
import { supportsExcerpt } from './verify.ts';

export function isCalendarWeekQuery({ frame }: AnswerContext): boolean {
  return (
    frame.explicitDates.length === 1 &&
    frame.explicitDates[0].operator === 'at' &&
    /(?:\d월\s*\d{1,2}일|\d{4}-\d{1,2}-\d{1,2})\s*주(?!차|말)/.test(
      frame.normalized,
    )
  );
}

function curriculumWindow(
  ctx: AnswerContext,
  asksSupplies: boolean,
): { from: number; to: number } | undefined {
  const { frame, asOf } = ctx;
  const now = toKstDate(asOf);
  const today = kstStartOfDay(now);
  if (
    frame.explicitDates.length === 1 &&
    frame.explicitDates[0].operator === 'at'
  ) {
    const { explicitDay } = resolveEffectiveTime(frame, asOf);
    if (explicitDay === null) return;
    const requested = frame.explicitDates[0];
    const actual = toKstDate(explicitDay);
    if (
      requested.day !== actual.day ||
      (requested.month && requested.month !== actual.month)
    )
      return;
    return { from: explicitDay, to: explicitDay };
  }
  if (frame.relativeWeek) {
    const offset = { last_week: -1, this_week: 0, next_week: 1 }[
      frame.relativeWeek
    ];
    const weekDay = '월화수목금토일'.indexOf(weekdayAt(today));
    const from = kstStartOfDay({ ...now, day: now.day - weekDay + 7 * offset });
    return { from, to: from + 6 * 86_400_000 };
  }
  if (!asksSupplies) return;
  const months = frame.months;
  const shifted =
    frame.relativePeriod === 'last_month'
      ? -1
      : frame.relativePeriod === 'next_month'
        ? 1
        : frame.relativePeriod === 'this_month'
          ? 0
          : undefined;
  if (months.length === 0 && shifted === undefined) return;
  const month = months[0] ?? now.month + (shifted ?? 0);
  const yearText = /(?<!\d)(20\d{2})\s*년\s*\d{1,2}\s*월/.exec(
    frame.normalized,
  )?.[1];
  const year = yearText
    ? Number(yearText)
    : now.year +
      Number(months.length === 1 && month < now.month && frame.futureCue);
  const start = kstStartOfDay({ year, month, day: 1 });
  const to = kstStartOfDay({ year, month: month + 1, day: 1 }) - 86_400_000;
  return { from: start <= today && today <= to ? today : start, to };
}

export async function answerWeeklyCurriculum(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const weeks = [...q.matchAll(/(?<!\d)(\d{1,2})\s*주\s*차/g)];
  const asksSupplies =
    /준비물|(?:뭐|무엇|뭘).{0,12}(?:가져가|챙겨가|들고\s*가)|집에서.{0,12}(?:챙겨|가져)/.test(
      q,
    );
  const asksResult = /결과물|뭐\s*만들/.test(q);
  const asksTopic = /배워|배우|학습\s*(?:주제|내용)/.test(q);
  const asksActivity =
    /(?:무슨|어떤|뭐|무엇).{0,10}(?:실험|실습|활동)|(?:실험|활동)\s*(?:주제|내용|뭐|무엇)|실험해/.test(
      q,
    );
  const generic = /커리큘럼|실습/.test(q);
  if (
    !(asksSupplies || asksResult || asksTopic || asksActivity || generic) ||
    frame.flags.compare ||
    frame.flags.causal ||
    frame.flags.attitude ||
    frame.flags.prediction ||
    frame.groupReference ||
    frame.matchedStudentIds.length > 1 ||
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.topics.some(({ id }) => !['schedule', 'intro'].includes(id)) ||
    /몇\s*시(?!간)|강의실|교실|정답률|점수|성적|숙제\s*제출|휴강|보강|시험\s*범위|반납|가져와야.{0,10}언제/.test(
      q,
    ) ||
    frame.explicitDates.length > 1 ||
    frame.months.length > 1 ||
    frame.relativeDay !== null ||
    weeks.length > 1
  )
    return;

  const window = curriculumWindow(ctx, asksSupplies);
  const week = weeks.length ? Number(weeks[0][1]) : undefined;
  if (week === undefined && !window) {
    if (frame.explicitDates.length === 1 && isCalendarWeekQuery(ctx))
      return abstain(
        '질문에 적힌 날짜를 확인해 주세요.',
        'INSUFFICIENT_EVIDENCE',
      );
    return;
  }
  const monthly =
    Boolean(window) &&
    week === undefined &&
    !frame.explicitDates.length &&
    !frame.relativeWeek;
  if (monthly && (asksActivity || asksResult || asksTopic || generic)) return;
  const homeOnly = monthly && /집에서|가정에서/.test(q);
  const missing = () =>
    abstain(
      '요청한 반과 기간의 승인 커리큘럼을 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );

  const explicit = explicitClassIds(ctx);
  const enrolled = ctx.studentClassIds.filter(
    (id) => !frame.negatedClassIds.includes(id),
  );
  const personal =
    frame.matchedStudentIds.length > 0 ||
    frame.selfReference ||
    /(?:우리|내|제)\s*반/.test(q);
  const ids =
    (personal || explicit.length !== 1) && enrolled.length
      ? explicit.filter((id) => enrolled.includes(id))
      : explicit;
  if (ids.length !== 1) return missing();
  const [classId] = ids;
  const klass = ctx.catalog.classes.find((entry) => entry.classId === classId);
  if (!klass) return missing();
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
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    upcomingUntil: window && window.to > ctx.asOf ? window.to : undefined,
    query: [
      klass.name,
      week ? week + '주 차' : '기간',
      '주차 학습 주제 실험 활동 실습 결과물 준비물',
    ].join(' '),
    documentTypes: ['schedule', 'academy_info', 'announcement'],
    limit: 80,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );

  const rows = found.flatMap(({ chunk }) => {
    if (
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      (chunk.classId && chunk.classId !== classId)
    )
      return [];
    const row = readEvidenceRow(chunk);
    if (!row) return [];
    const name = row.column(/^(?:과정|과정명|강좌|강좌명|반|반이름|반명)$/);
    const weekIndex = row.column(/^주차$/);
    const periodIndex = row.column(
      /^(?:기간|수업기간|학습기간|적용기간|일정)$/,
    );
    const rowWeek = Number(
      /^(\d{1,2})주차$/.exec(compactText(row.cells[weekIndex] ?? ''))?.[1],
    );
    if (
      !rowWeek ||
      (week !== undefined && rowWeek !== week) ||
      !names.includes(compactText(row.cells[name] ?? ''))
    )
      return [];
    const period = window
      ? tablePeriodOverlapping(row.cells[periodIndex] ?? '', window)
      : undefined;
    const at =
      window && period
        ? Math.max(period.from, window.from, chunk.validFrom)
        : ctx.asOf;
    if (
      !isValidAt(chunk.validFrom, chunk.validTo, at) ||
      (window && (!period || at > Math.min(window.to, period.to)))
    )
      return [];

    const present = (i: number) =>
      !/^(?:[-–—]+|미정|미확인|추후안내)?$/.test(
        compactText(row.cells[i] ?? ''),
      );
    const headers = (chunk.location.header ?? []).map(compactText);
    const lessons = headers.flatMap((label, i) =>
      /^(?:학습주제|학습내용|수업내용|실습결과물|결과물|실습|실험[·ㆍ/]활동주제|실험주제|활동주제|실험내용|활동내용)$/.test(
        label,
      ) && present(i)
        ? [i]
        : [],
    );
    const supply = row.column(
      /^(?:가정|수업|실습|실험)?준비물(?:[·ㆍ/]비고)?$/,
    );
    const hasSupply =
      present(supply) &&
      (!homeOnly ||
        !/^[가-힣]+착용(?:필수|하세요)?[.!]?$/.test(
          compactText(row.cells[supply]),
        ));
    const requested = [
      ...(asksActivity || asksTopic || asksResult || generic ? lessons : []),
      ...(asksSupplies && hasSupply ? [supply] : []),
    ];
    if (!requested.length) return [];
    const missingFields = [
      ...(asksResult && !lessons.some((i) => /결과물|실습/.test(headers[i]))
        ? ['실습 결과물']
        : []),
      ...(asksTopic &&
      !lessons.some((i) => /학습|수업|주제|활동/.test(headers[i]))
        ? ['학습 주제']
        : []),
      ...(asksActivity && !lessons.length ? ['실험·활동 주제'] : []),
      ...(asksSupplies && !hasSupply ? ['준비물'] : []),
    ];
    const excerpt = row.project(
      name,
      weekIndex,
      ...(window ? [periodIndex] : []),
      ...requested,
    );
    return excerpt
      ? [
          {
            excerpt,
            at,
            missingFields,
            key: period ? period.from + '|' + period.to : String(rowWeek),
            signature: requested
              .map((i) => headers[i] + '=' + compactText(row.cells[i]))
              .join('|'),
          },
        ]
      : [];
  });
  if (!rows.length) return missing();
  const grouped = new Map<string, typeof rows>();
  for (const row of rows)
    grouped.set(row.key, [...(grouped.get(row.key) ?? []), row]);
  if (
    (!monthly && grouped.size > 1) ||
    [...grouped.values()].some(
      (group) => new Set(group.map(({ signature }) => signature)).size > 1,
    )
  )
    return abstain(
      '같은 반과 기간의 승인 커리큘럼이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const selected = [...grouped.values()]
    .map(([row]) => row)
    .sort((a, b) => a.at - b.at);
  const missingFields = [
    ...new Set(selected.flatMap((row) => row.missingFields)),
  ];
  const draft = fromPublicExcerpts(
    selected.map((row) => row.excerpt),
    missingFields,
  );
  ctx.trace.intent = 'weekly_curriculum';
  return {
    ...draft,
    citations: selected.map(({ excerpt, at }) => ({
      kind: 'chunk',
      chunk: excerpt.chunk,
      tableColumns: excerpt.tableColumns,
      effectiveAt: at,
    })),
  };
}

/** Read a grade's book from the academy curriculum, scoped to one month or title. */
export async function answerReadingAssignment(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, relativePeriod, months, flags } = ctx.frame;
  const title = /[『「]([^』」]+)[』」]/.exec(normalized)?.[1];
  if (
    !(
      /필독\s*(?:도서|서|책)/.test(normalized) ||
      (title &&
        /몇\s*월|언제/.test(normalized) &&
        /읽|도서|책/.test(normalized))
    ) ||
    /정답률|점수|성적|제출|빌릴|대여|가격|얼마|교재비/.test(normalized) ||
    flags.compare ||
    flags.causal ||
    flags.prediction ||
    months.length > 1
  )
    return;

  const explicitGrades = [
    ...new Set(
      [...normalized.matchAll(/(?<![가-힣])([초중고])\s*([1-6])(?!\d)/g)].map(
        ([, level, grade]) => level + grade,
      ),
    ),
  ];
  const classes = explicitClassIds(ctx);
  const assignedGrades = [
    ...new Set(
      ctx.catalog.classes
        .filter(
          ({ classId, grade }) =>
            classes.includes(classId) && grade && /^[초중고][1-6]$/.test(grade),
        )
        .map(({ grade }) => grade),
    ),
  ];
  const grades = explicitGrades.length ? explicitGrades : assignedGrades;
  if (
    grades.length !== 1 ||
    (explicitGrades.length &&
      ctx.frame.matchedStudentIds.length &&
      (assignedGrades.length !== 1 || assignedGrades[0] !== explicitGrades[0]))
  ) {
    return abstain(
      '필독 도서를 확인할 학년을 하나 지정해 주세요.',
      'INSUFFICIENT_EVIDENCE',
      ['학년'],
    );
  }
  const grade = grades[0];
  const today = toKstDate(ctx.asOf);
  const shift =
    relativePeriod === 'next_month'
      ? 1
      : relativePeriod === 'last_month'
        ? -1
        : 0;
  const [relativeYear, relativeMonth] = shiftPeriod(
    makePeriod(today.year, today.month),
    shift,
  )
    .split('-')
    .map(Number);
  const explicitYear = /(?<!\d)(\d{4})\s*년\s*\d{1,2}\s*월/.exec(
    normalized,
  )?.[1];
  const month =
    months[0] ?? (title && !relativePeriod ? undefined : relativeMonth);
  const year = explicitYear
    ? Number(explicitYear)
    : relativePeriod
      ? relativeYear
      : undefined;
  const bookKey = (value: string) =>
    compactText(value).replace(/[『』「」《》]/g, '');
  const candidates = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [
      grade,
      title ?? '',
      month ? month + '월' : '',
      '필독 도서명 월별 학년',
    ].join(' '),
    documentTypes: ['announcement', 'academy_info', 'schedule'],
    limit: 80,
  });
  recordChunks(
    ctx.trace,
    candidates.map(({ chunk }) => chunk),
  );
  const matches = candidates.flatMap(({ chunk }) => {
    const { kind, header, cells, section } = chunk.location;
    if (
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      chunk.visibility !== 'academy_public' ||
      (chunk.classId && !classes.includes(chunk.classId)) ||
      !/필독/.test(chunk.title + ' ' + (section ?? '')) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      return [];
    const fields = header.map(compactText);
    const monthIndex = fields.findIndex((field) =>
      /^(?:월|해당월|독서월)$/.test(field),
    );
    const gradeIndex = fields.findIndex((field) =>
      /^(?:대상|학년|대상학년)$/.test(field),
    );
    const titleIndex = fields.findIndex((field) =>
      /^(?:도서명|책제목|책이름|필독도서)$/.test(field),
    );
    const date = /^(?:(\d{4})년)?(\d{1,2})월$/.exec(
      compactText(cells[monthIndex] ?? ''),
    );
    const book = cells[titleIndex]?.trim();
    if (
      !date ||
      !book ||
      compactText(cells[gradeIndex] ?? '') !== grade ||
      (month !== undefined && Number(date[2]) !== month) ||
      (year !== undefined &&
        (date[1] ? Number(date[1]) : toKstDate(chunk.validFrom).year) !==
          year) ||
      (title && bookKey(book) !== bookKey(title))
    )
      return [];
    const tableColumns = [monthIndex, gradeIndex, titleIndex];
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, tableColumns, line };
    return supportsExcerpt(excerpt) ? [excerpt] : [];
  });
  if (!matches.length) {
    return abstain(
      '해당 학년과 시기의 필독 도서를 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['필독 도서'],
    );
  }
  if (new Set(matches.map(({ line }) => compactText(line))).size !== 1)
    return abstain(
      '조건에 맞는 승인 도서 목록이 여러 개여서 확인이 필요합니다.',
      'CONFLICTING_EVIDENCE',
    );
  const excerpt = matches[0];
  ctx.trace.intent = 'reading_assignment';
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
  };
}
