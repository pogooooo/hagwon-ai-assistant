import { isAssistantDirective } from '../ingest/validation.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { formatKstDate, kstStartOfDay, toKstDate } from '../text/time.ts';
import {
  abstain,
  recordChunks,
  recordFacts,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import {
  tableDateAt,
  tablePeriodContains,
  weekdayAt,
  weekdayInNamedWeek,
} from './table-dates.ts';
import { supportsExcerpt } from './verify.ts';
import { officialStatements } from './announcement-conflict.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

const hhmm = '(?:[01]?\\d|2[0-3]):[0-5]\\d';
const date =
  '(?:\\d{4}년\\s*)?\\d{1,2}월\\s*\\d{1,2}일(?:\\s*\\([월화수목금토일]\\))?';
const closingChange = new RegExp(
  '^(' +
    date +
    ')부터\\s*(' +
    date +
    ')까지\\s*([가-힣\\d ]{2,20}?)' +
    '(?:\\([^()]*\\))?\\s*([월화수목금토일])요일\\s*운영\\s*시간(?:을|은)\\s*(' +
    hhmm +
    ')까지\\s*(?:연장|늘리|늘립|단축|조정)',
);
const vacationHours = new RegExp(
  '(여름|겨울)\\s*방학[^.!?]*?학원\\s*(평일|주말|매일)\\s*운영\\s*시간(?:을|은|이)?\\s*(' +
    hhmm +
    ')\\s*[~–-]\\s*(' +
    hhmm +
    ')',
);

const regularFacility =
  /^([가-힣\d ]{2,20}?)(?:\([^()]*\))?\s+(?=(?:평일|주말|매일|[월화수목금토일]요일)\s)/;

function regularClosingTime(body: string, at: number) {
  const pattern = new RegExp(
    '(?:^|,\\s*|\\s)(' +
      weekdayAt(at) +
      '요일)\\s+(' +
      hhmm +
      ')\\s*[~–-]\\s*(' +
      hhmm +
      ')(?=$|[,.;])',
  );
  return pattern.exec(body);
}

async function answerRegularClosure(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  if (
    !/학원(?:이|은|의)?\s*(?:정기\s*)?(?:쉬는\s*(?:날|요일)|휴무(?:일|요일))/.test(
      frame.normalized,
    ) ||
    frame.explicitDates.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.months.length ||
    frame.classIds.length ||
    /방학|연휴|이번|다음|공사|휴강|보강|몇\s*일/.test(frame.normalized)
  )
    return;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: '학원 운영시간 휴무 정기 휴무일 요일',
    limit: 50,
    documentTypes: ['academy_info', 'facility'],
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const rows = found.flatMap(({ chunk }) => {
    const { kind, cells, header, section } = chunk.location;
    if (
      chunk.classId !== null ||
      chunk.visibility !== 'academy_public' ||
      chunk.suspicious ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      isAssistantDirective(chunk.text) ||
      kind !== 'table_row' ||
      !header ||
      !cells ||
      header.length !== cells.length ||
      !/학원|운영\s*시간/.test(section ?? '')
    )
      return [];
    const dayColumn = header.findIndex((value) =>
      /^(?:요일|구분)$/.test(compactText(value)),
    );
    const hoursColumn = header.findIndex((value) =>
      /^(?:운영시간|운영여부)$/.test(compactText(value)),
    );
    if (
      dayColumn < 0 ||
      hoursColumn < 0 ||
      !/^(?:(?:[월화수목금토일]요일|(?:법정\s*)?공휴일)(?:\s*[·,/및]\s*)?)+$/.test(
        cells[dayColumn],
      ) ||
      !/^(?:정기\s*)?휴무(?:일)?$/.test(cells[hoursColumn])
    )
      return [];
    const tableColumns = [dayColumn, hoursColumn];
    const line = [...new Set([0, ...tableColumns])]
      .map((index) => header[index] + ': ' + cells[index])
      .join(' / ');
    const excerpt = { chunk, line, tableColumns };
    return supportsExcerpt(excerpt) ? [excerpt] : [];
  });
  if (
    !rows.length ||
    new Set(rows.map(({ line }) => compactText(line))).size !== 1
  )
    return;
  const [excerpt] = rows;
  ctx.trace.intent = 'academy_weekly_closure';
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

async function answerRailAccess(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const q = ctx.frame.normalized;
  if (
    !/지하철|전철/.test(q) ||
    !/어디(?:서|에서).{0,5}내|어느\s*역|무슨\s*역|몇\s*번\s*출구/.test(q) ||
    /말고|제외|비교|공사|변경|버스.{0,8}도|셔틀/.test(q)
  )
    return;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: '학원 위치 오시는 길 지하철 전철 대중교통 역 출구 하차',
    documentTypes: ['academy_info', 'facility'],
    limit: 35,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const chunks = found
    .map(({ chunk }) => chunk)
    .filter(
      (chunk) =>
        chunk.classId === null && isCleanPublicEvidence(chunk, ctx.asOf),
    );
  const station = /[가-힣a-z\d]+역(?=\s|에서|에\s|$)/i;
  const route = /출구|하차|도보|내리/;
  const otherTravel = /주차|셔틀|버스|하차하지|내리지|무정차/;
  const directions = chunks.flatMap((chunk) => {
    const row = readEvidenceRow(chunk);
    if (row) {
      const key = row.column(/^(?:항목|구분|교통수단)$/);
      const value = row.column(/^(?:내용|안내|오시는길|이용방법)$/);
      if (
        !/^(?:지하철|전철|대중교통)$/.test(compactText(row.cells[key] ?? '')) ||
        !station.test(row.cells[value] ?? '') ||
        !route.test(row.cells[value]) ||
        otherTravel.test(row.cells[value])
      )
        return [];
      const excerpt = row.project(key, value);
      return excerpt ? [excerpt] : [];
    }
    if (
      chunk.location.kind !== 'paragraph' ||
      !/위치|오시는\s*길|교통/.test(chunk.location.section ?? chunk.title)
    )
      return [];
    return splitSentences(chunk.text)
      .filter(
        (line) =>
          /지하철|전철/.test(line) &&
          station.test(line) &&
          route.test(line) &&
          !otherTravel.test(line),
      )
      .map((line) => ({ chunk, line }));
  });
  if (new Set(directions.map(({ line }) => compactText(line))).size > 1)
    return abstain(
      '승인된 지하철 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const asksAddress = /주소|위치.{0,14}어디|학원(?:은|이)?\s*어디에\s*있/.test(
    q,
  );
  const addresses = asksAddress
    ? chunks.flatMap((chunk) => {
        if (
          directions.length &&
          chunk.sourceId !== directions[0].chunk.sourceId
        )
          return [];
        const row = readEvidenceRow(chunk);
        if (!row) return [];
        const key = row.column(/^(?:항목|구분)$/);
        const value = row.column(/^(?:내용|안내|주소)$/);
        if (compactText(row.cells[key] ?? '') !== '주소') return [];
        const excerpt = row.project(key, value);
        return excerpt ? [excerpt] : [];
      })
    : [];
  if (new Set(addresses.map(({ line }) => compactText(line))).size > 1)
    return abstain('승인된 학원 주소가 서로 다릅니다.', 'CONFLICTING_EVIDENCE');
  if (!directions.length && !addresses.length)
    return abstain(
      '승인된 학원 안내에서 요청한 위치를 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  ctx.trace.intent = 'rail_access';
  return fromPublicExcerpts([addresses[0], directions[0]].filter(Boolean), [
    ...(asksAddress && !addresses.length ? ['학원 주소'] : []),
    ...(!directions.length ? ['지하철 하차역'] : []),
  ]);
}

async function answerAnnouncedClosure(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const namedEvent = /수능|성탄절|크리스마스|추석|설날|어린이날|신정/.exec(
    q,
  )?.[0];
  const event = namedEvent === '크리스마스' ? '성탄절' : namedEvent;
  if (
    !/학원(?:은|이|도)?\s*(?:쉼|쉽|쉬|노는\s*날|휴강|휴원)/.test(q) ||
    !/쉼|쉽|쉬|노는\s*날/.test(q) ||
    (!event && frame.months.length !== 1) ||
    frame.months.length > 1 ||
    frame.classIds.length ||
    frame.matchedStudentIds.length ||
    frame.explicitDates.length ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    /보강|보충|우리\s*반|내\s*반|수강료|일요일마다|정기|비교|[초중고]\d|과정|강좌/.test(
      q,
    )
  )
    return;
  const years = [
    ...new Set([...q.matchAll(/(?<!\d)(\d{4})\s*년/g)].map(([, year]) => year)),
  ];
  if (years.length > 1)
    return abstain(
      '확인할 휴강 연도를 하나로 지정해 주세요.',
      'AMBIGUOUS_SUBJECT',
    );
  const [year] = years;
  const today = toKstDate(ctx.asOf);
  const earliest = kstStartOfDay(today);
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: ['schedule_change'],
    asOf: ctx.asOf,
  });
  recordFacts(ctx.trace, facts);
  const matches = facts.flatMap((fact) => {
    const { value } = fact;
    if (
      fact.subjectType !== 'academy' ||
      value.kind !== 'schedule_change' ||
      value.changeType !== 'cancel' ||
      isAssistantDirective(value.text) ||
      (event === '수능'
        ? !/수능(?:일|날)|대학수학능력시험/.test(compactText(value.text))
        : event &&
          !compactText(value.text)
            .replace(/크리스마스/g, '성탄절')
            .includes(event))
    )
      return [];
    const date = tableDateAt(value.date, today.year);
    if (date === undefined || (!year && date < earliest)) return [];
    const local = toKstDate(date);
    if (
      (year && Number(year) !== local.year) ||
      (frame.months.length && frame.months[0] !== local.month)
    )
      return [];
    return [{ fact, date, text: value.text }];
  });
  if (event && new Set(matches.map(({ date }) => date)).size > 1)
    return abstain(
      '같은 행사에 대한 승인 휴강일이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  if (!matches.length)
    return abstain(
      '해당 기간의 학원 전체 휴강을 승인 공지에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  matches.sort((a, b) => a.date - b.date);
  ctx.trace.intent = 'academy_announced_closure';
  return {
    status: 'answered',
    text: [
      ...new Set(
        matches.map(({ date, text }) => formatKstDate(date) + ' ' + text),
      ),
    ].join('\n'),
    citations: matches.map(({ fact }) => ({ kind: 'fact', fact })),
    usedFacts: matches.map(({ fact }) => fact),
    instants: matches.map(({ date }) => date),
  };
}

async function answerStudyRoomEligibility(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = frame.normalized;
  const room = /자습실|독서실|자습\s*공간/;
  const levels = [
    ...new Set(
      [...q.matchAll(/([초중고])등(?:학생|부|학교)/g)].map((match) => match[1]),
    ),
  ];
  if (
    levels.length !== 1 ||
    !room.test(q) ||
    !/이용|사용|쓸\s*수|들어갈\s*수/.test(q) ||
    /비용|무료|요금|몇\s*시|예약|방학|특강|주말|휴일/.test(q) ||
    frame.explicitDates.length ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.relativeDay !== null ||
    frame.months.length
  )
    return;
  const [target] = levels;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: '자습실 이용 가능 대상 초등부 중등부 고등부 원생',
    documentTypes: ['facility', 'academy_info', 'policy', 'announcement'],
    limit: 48,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const level = new RegExp(target + '등(?:부|학생|학교)');
  const options = hits.flatMap(({ chunk }) => {
    if (chunk.classId !== null || !isCleanPublicEvidence(chunk, ctx.asOf))
      return [];
    const row = readEvidenceRow(chunk);
    const name = row?.column(/^(?:시설|시설명|항목|구분)$/) ?? -1;
    const detail =
      row?.column(/^(?:이용대상|이용안내|비고|내용|안내|설명)$/) ?? -1;
    const projected =
      row && room.test(row.cells[name] ?? '')
        ? row.project(name, detail)
        : undefined;
    const evidence = projected
      ? [projected]
      : chunk.location.kind === 'paragraph'
        ? officialStatements(chunk).flatMap(({ text }) =>
            splitSentences(text).map((line) => ({ chunk, line })),
          )
        : [];
    return evidence.flatMap((excerpt) => {
      const line = compactText(excerpt.line);
      if (!room.test(line) || /방학|특강|주말|한시|시범|외부/.test(line))
        return [];
      const only =
        /((?:[초중고]등(?:부|학생|학교)(?:[·ㆍ/,]|및|와|과)?)+)(?:재원생|원생|학생)?만(?:사용|이용)/.exec(
          line,
        );
      const denied = /이용(?:할수없|불가|금지)|사용(?:할수없|불가|금지)/.test(
        line,
      );
      const allowed = /(?:이용|사용)(?:할수있|이가능|가능|대상)/.test(line);
      if (only) return [{ excerpt, allowed: level.test(only[1]) }];
      const namedLevels = new Set(
        [...line.matchAll(/([초중고])등(?:부|학생|학교)/g)].map(
          (match) => match[1],
        ),
      );
      if (
        level.test(line) &&
        (namedLevels.size === 1 || /모두|공통/.test(line)) &&
        allowed !== denied
      )
        return [{ excerpt, allowed }];
      return [];
    });
  });
  if (!options.length)
    return abstain(
      '해당 학교급의 자습실 이용 조건을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['자습실 이용 대상'],
    );
  if (new Set(options.map(({ allowed }) => allowed)).size > 1)
    return abstain(
      '해당 학교급의 자습실 이용 가능 여부가 승인 안내마다 다릅니다. 학원 데스크에 확인해 주세요.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'study_room_eligibility';
  return fromPublicExcerpts([options[0].excerpt]);
}

export async function answerFacilityHours(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const eligibility = await answerStudyRoomEligibility(ctx);
  if (eligibility) return eligibility;
  const rail = await answerRailAccess(ctx);
  if (rail) return rail;
  const announced = await answerAnnouncedClosure(ctx);
  if (announced) return announced;
  const closure = await answerRegularClosure(ctx);
  if (closure) return closure;
  const vacation =
    /방학/.test(frame.normalized) &&
    /학원/.test(frame.normalized) &&
    /몇\s*시.{0,10}(?:열|문\s*여)|개원\s*시간|여는\s*시간/.test(
      frame.normalized,
    ) &&
    !frame.classIds.length &&
    !frame.relativeWeek &&
    frame.relativeDay === null &&
    !frame.explicitDates.length &&
    !frame.months.length &&
    !frame.relativePeriod;
  const closingDay = /몇\s*시(?:쯤)?\s*까지|닫는\s*시간/.test(frame.normalized)
    ? weekdayInNamedWeek(frame, ctx.asOf)
    : undefined;
  if (
    (!vacation && closingDay === undefined) ||
    /수업|차량|셔틀|각각|비교|언제부터|언제까지/.test(frame.normalized)
  )
    return;
  const at = closingDay ?? ctx.asOf;
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    factTypes: vacation ? ['facility'] : ['facility', 'notice'],
    asOf: ctx.asOf,
    effectiveAt: at,
  });
  recordFacts(ctx.trace, facts);
  let recognized = false;
  const matches = facts.flatMap((fact) => {
    if (
      fact.subjectType !== 'academy' ||
      fact.value.kind !== 'text' ||
      isAssistantDirective(fact.value.text)
    )
      return [];
    const body = fact.value.text.trim();
    if (vacation) {
      const match = vacationHours.exec(body);
      const season = /(?:여름|겨울)\s*방학/.exec(frame.normalized)?.[0];
      const requestedDay = /([월화수목금토일])요일/.exec(frame.normalized)?.[1];
      if (
        !match ||
        (season && !season.startsWith(match[1])) ||
        (requestedDay &&
          ((match[2] === '평일' && '토일'.includes(requestedDay)) ||
            (match[2] === '주말' && !'토일'.includes(requestedDay))))
      )
        return [];
      return [
        {
          fact,
          text:
            match[1] +
            '방학 학원 ' +
            match[2] +
            ' 운영 시간은 ' +
            match[3] +
            '~' +
            match[4] +
            '입니다.',
          key: match.slice(1).join('|'),
          override: true,
        },
      ];
    }
    const match = closingChange.exec(body);
    if (match && frame.compact.includes(compactText(match[3]))) {
      recognized = true;
      if (
        match[4] !== weekdayAt(at) ||
        !tablePeriodContains(match[1] + '~' + match[2], at)
      )
        return [];
      return [
        {
          fact,
          text: body,
          key: compactText(match[3]) + '|' + match[5],
          override: true,
        },
      ];
    }
    const facility = fact.factType === 'facility' && regularFacility.exec(body);
    if (!facility || !frame.compact.includes(compactText(facility[1])))
      return [];
    recognized = true;
    const hours = regularClosingTime(body, at);
    return hours
      ? [
          {
            fact,
            text:
              facility[1] +
              ' ' +
              hours[1] +
              ' 운영 종료는 ' +
              hours[3] +
              '입니다.',
            key: compactText(facility[1]) + '|' + hours[3],
            override: false,
          },
        ]
      : [];
  });
  const overrides = matches.filter(({ override }) => override);
  const applicable = overrides.length ? overrides : matches;
  if (!applicable.length)
    return recognized
      ? abstain(
          '해당 날짜의 시설 운영 시간을 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        )
      : undefined;
  if (new Set(applicable.map(({ key }) => key)).size > 1)
    return abstain(
      '같은 기간의 승인 운영 시간이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [{ fact, text }] = applicable;
  ctx.trace.intent = 'facility_effective_hours';
  return {
    status: 'answered',
    text,
    citations: [{ kind: 'fact', fact, effectiveAt: at }],
    usedFacts: [fact],
  };
}
