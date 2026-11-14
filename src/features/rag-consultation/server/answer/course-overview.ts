import { gradeBand } from '../query/grade-band.ts';
import { parallelClassSections } from './class-targets.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import type { RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

const requestedGrade = /(?<![가-힣\d])([초중고][1-6])(?!\d)/g;
const courseColumn =
  /^(?:과정|과정명|반|반명|강좌|강좌명|개설반|개설과정|개설과목)$/;
const targetColumn = /^(?:대상|대상학년)$/;
const contentColumn = /^(?:주요내용|수업방식|수업내용|학습내용|과정소개)$/;
const scopeSection =
  /^(?:\d+\.?)?(?:교육|수강)대상(?:및|과|·)개설(?:과목|과정|반)$/;
const simpleOfferingQuestion =
  /^(?:(?:여기|(?:이\s*)?학원)(?:에서는|에서|는)?\s*)?(?:[초중고](?:등)?(?:학생|등부|학교|등학교)|[초중고][1-6])(?:도|은|는|을|이|가)?\s*(?:대상(?:으로)?\s*)?(?:수업|과정|반)(?:도|은|는|이|가|을)?\s*(?:(?:개설|운영)\s*)?(?:안\s*)?(?:하나요|해요|합니까|하는지|있나요|있어요|없나요|없어요)[?!. ]*$/;

const gradeLabel = String.raw`(?:초등학교|중학교|고등학교|초등|중등|고등|[초중고])\s*[1-6](?:\s*학년)?`;
const declaredGradeRange = new RegExp(
  '(' + gradeLabel + ')\\s*부터\\s*(' + gradeLabel + ')\\s*까지',
);
const shortGrade = (label: string) =>
  compactText(label).replace(/(?:등학교|학교|등|학년)/g, '');

function normalizeSchoolWord(question: string): string {
  const studentSyllable = '생'.charCodeAt(0) - 0xac00;
  // Only correct a vowel error in the last syllable of a school-level noun.
  return question.replace(
    /(?<![가-힣])([초중고](?:등)?학)([가-힣])(?=(?:도|은|는|이|가|을|를)?(?:\s|[?!.]|수업|과정|반|$))/g,
    (word, stem: string, ending: string) => {
      const syllable = ending.charCodeAt(0) - 0xac00;
      return Math.floor(syllable / 588) === Math.floor(studentSyllable / 588) &&
        syllable % 28 === studentSyllable % 28
        ? stem + '생'
        : word;
    },
  );
}

function askedSchoolGrades(q: string, grades: readonly string[]) {
  if (grades.length === 1) return gradeBand(grades[0]);
  const long = new RegExp('(' + gradeLabel + ')').exec(q)?.[1];
  if (long) return gradeBand(shortGrade(long));
  const level = /([초중고])(?:등)?(?:학생|등부|학교|등학교)/.exec(q)?.[1];
  return level ? gradeBand(level + '1~' + (level === '초' ? '6' : '3')) : [];
}

function declaredRegularCourses(
  chunks: readonly RagChunk[],
  asOf: number,
): EvidenceExcerpt[] {
  const tables = new Map<string, RagChunk[]>();
  for (const chunk of chunks) {
    if (
      chunk.documentType !== 'academy_info' ||
      chunk.classId !== null ||
      chunk.location.kind !== 'table_row' ||
      chunk.location.tableIndex === undefined ||
      !scopeSection.test(compactText(chunk.location.section ?? ''))
    )
      continue;
    const key = chunk.sourceId + '/' + chunk.location.tableIndex;
    const table = tables.get(key) ?? [];
    table.push(chunk);
    tables.set(key, table);
  }
  for (const table of tables.values()) {
    const evidence: EvidenceExcerpt[] = [];
    let complete = true;
    for (const chunk of table) {
      const row = readEvidenceRow(chunk);
      if (!row || !isCleanPublicEvidence(chunk, asOf)) {
        complete = false;
        break;
      }
      const target = row.column(targetColumn);
      const course = row.column(/^(?:개설반|개설과정|개설과목)$/);
      const category = row.column(/^(?:구분|과목)$/);
      if (
        /^특강$/.test(compactText(row.cells[category] ?? '')) &&
        /시기별개설|별도안내/.test(compactText(row.cells[target] ?? ''))
      )
        continue;
      const excerpt = row.project(target, course);
      if (!excerpt || !gradeBand(row.cells[target] ?? '').length) {
        complete = false;
        break;
      }
      evidence.push(excerpt);
    }
    if (complete && evidence.length) return evidence;
  }
  return [];
}

function schoolOfferingAnswer(
  ctx: AnswerContext,
  summary: string,
  evidence: EvidenceExcerpt[],
): AnswerDraft {
  ctx.trace.intent = 'public_course_overview';
  const draft = fromPublicExcerpts(evidence);
  return { ...draft, text: summary + '\n' + draft.text };
}

function letterPlacementProof(
  ctx: AnswerContext,
  grades: string[],
  sections: string[],
  paragraphs: EvidenceExcerpt[],
): EvidenceExcerpt[] {
  const anchors = ctx.frame.classIds;
  if (grades.length !== 1 || sections.length < 2 || !anchors.length) return [];
  const [grade] = grades;
  const siblings = parallelClassSections(ctx, anchors[0]);
  if (
    !anchors.every((id) => siblings.some(({ klass }) => klass.classId === id))
  )
    return [];
  const family = siblings[0]?.group.replace(/^[초중고][1-6](?:학년)?/, '');
  if (
    !family ||
    !sections.every((section) =>
      siblings.some(
        ({ klass, section: key }) => key === section && klass.grade === grade,
      ),
    )
  )
    return [];
  const marks = sections.map((section) => section + '반');
  return paragraphs.filter(({ chunk, line }) => {
    const body = compactText(line);
    const context = compactText(
      (chunk.location.section ?? '') + ' ' + chunk.text,
    );
    const scope = [
      ...new Set(
        [...context.matchAll(requestedGrade)].map((match) => match[1]),
      ),
    ];
    return (
      marks.every(
        (mark) => body.includes(mark) && context.includes(family + mark),
      ) &&
      (!scope.length || scope.includes(grade)) &&
      /같은학년|동일학년|수준별반이아니|수준별로나누지않|수준에따라나뉘지않/.test(
        body,
      ) &&
      /같은진도|동일한진도|수준별반이아니|수준별로나누지않/.test(body)
    );
  });
}

/** Public academy curriculum and placement rules are independent of any pupil's results. */
export async function answerCourseOverview(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = normalizeSchoolWord(frame.normalized);
  if (
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    /특강|휴강|보강|과제|환불|할인|강사|시간표|몇\s*시|작년|내년|지난|예상/.test(
      q,
    )
  )
    return;
  const grades = [
    ...new Set([...q.matchAll(requestedGrade)].map((match) => match[1])),
  ];
  const letters = [
    ...new Set(
      [...q.matchAll(/(?<![a-z])([a-z])\s*반/g)].map(([, letter]) => letter),
    ),
  ];
  const letterPlacement =
    letters.length >= 2 &&
    /잘\s*하는|실력|수준|레벨|성적/.test(q) &&
    !/명단|이름|연락처|정답률|점수|평균|석차/.test(q) &&
    !frame.matchedStudentIds.length &&
    !frame.selfReference &&
    !frame.unresolvedRelationWords.length;
  const schoolGrades = askedSchoolGrades(q, grades);
  const asksSchoolOffering =
    schoolGrades.length > 0 &&
    /수업|과정|수강|등록|개설|운영/.test(q) &&
    /하나요|해요|합니까|(?:있|없)(?:나요|어요)|받아주|가능|열려|하는지/.test(
      q,
    ) &&
    !frame.classIds.length &&
    !frame.matchedStudentIds.length &&
    !frame.selfReference &&
    !frame.unknownPrograms.length &&
    !frame.unboundProgram;
  const simpleOffering = asksSchoolOffering && simpleOfferingQuestion.test(q);
  const asksDescription =
    /어떤\s*(?:걸|것을|내용).{0,20}(?:수업|배우|만들)|수업\s*(?:은|이)?\s*(?:어떻게|뭐|무슨\s*내용).{0,16}(?:진행|하|배우)|뭘\s*배우/.test(
      q,
    );
  const asksEligibility =
    grades.length === 1 &&
    /받아주|받아주시|등록|수강\s*(?:할|가능)|수강료|학원비/.test(q) &&
    /되면|가능|있|받아주|받아주시/.test(q);
  const aim =
    /([가-힣a-z]{3,})\s*(?:준비|대비)(?:하는)?\s*(?:반|과정|수업)/.exec(q)?.[1];
  const schoolGrouping =
    /학교.{0,18}(?:섞|따로)|반(?:이|은)?\s*따로/.test(q) &&
    !/명단|학생\s*이름|친구|자리/.test(q);
  const numberedPlacement =
    /[1-9]\s*반/.test(q) &&
    /잘\s*하는|성적|실력|수준/.test(q) &&
    /배정|나뉘|다른\s*반|반이|반은|반\s*이에요/.test(q) &&
    frame.classIds.length > 0 &&
    !frame.matchedStudentIds.length &&
    !frame.selfReference;
  if (
    !asksDescription &&
    !asksEligibility &&
    !aim &&
    !schoolGrouping &&
    !numberedPlacement &&
    !letterPlacement &&
    !asksSchoolOffering
  )
    return;

  const searchLimit = 65;
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query:
      (simpleOffering ? q + ' 교육 대상 개설 반' : ctx.question) +
      ' 과정 구성 대상 수업 방식',
    documentTypes: ['academy_info', 'curriculum'],
    limit: searchLimit,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const eligible = hits
    .map(({ chunk }) => chunk)
    .filter(
      (chunk) =>
        isCleanPublicEvidence(chunk, ctx.asOf) &&
        (chunk.classId === null || frame.classIds.includes(chunk.classId)),
    );
  const paragraphs = eligible
    .filter((chunk) => chunk.location.kind === 'paragraph')
    .flatMap((chunk) =>
      splitSentences(chunk.text).map((line) => ({ chunk, line })),
    );
  const rows = eligible.flatMap((chunk) => {
    const row = readEvidenceRow(chunk);
    if (!row) return [];
    const course = row.column(courseColumn);
    const name = row.cells[course];
    return name ? [{ chunk, row, course, name }] : [];
  });

  let evidence: EvidenceExcerpt[] = [];
  if (letterPlacement) {
    evidence = letterPlacementProof(ctx, grades, letters, paragraphs);
    if (!evidence.length)
      return abstain(
        '비교한 반의 수준별 편성 기준을 승인 안내에서 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
    const detailed = evidence.filter(({ line }) =>
      /요일|같은\s*교재|같은\s*진도/.test(line),
    );
    if (detailed.length) evidence = detailed;
  }
  if (asksSchoolOffering && !evidence.length) {
    const admits = (band: number[]) =>
      schoolGrades.some((grade) => band.includes(grade));
    const matches = rows.filter(({ row }) =>
      admits(gradeBand(row.cells[row.column(targetColumn)] ?? '')),
    );
    const schoolLabel =
      grades[0] ??
      (schoolGrades[0] <= 6
        ? '초등학생'
        : schoolGrades[0] <= 9
          ? '중학생'
          : '고등학생');
    if (simpleOffering) {
      const offeredRows = matches.flatMap(({ row, course, name }) => {
        if (/^(?:미개설|없음|[-—]+)$/.test(compactText(name))) return [];
        const excerpt = row.project(course, row.column(targetColumn));
        return excerpt ? [excerpt] : [];
      });
      if (offeredRows.length)
        return schoolOfferingAnswer(
          ctx,
          '현재 ' + schoolLabel + ' 대상 수업을 운영합니다.',
          offeredRows.slice(0, 4),
        );
    }
    const offered =
      ctx.catalog.classes.some(({ grade }) => admits(gradeBand(grade ?? ''))) ||
      matches.length > 0;
    if (!offered) {
      evidence = paragraphs.filter(({ chunk, line }) => {
        const declared = declaredGradeRange.exec(line);
        if (
          !declared ||
          chunk.documentType !== 'academy_info' ||
          chunk.classId !== null ||
          !/학원|아카데미|공방/.test(line) ||
          !/가르치|수강\s*대상|과정.{0,15}운영|수업.{0,15}운영/.test(line) ||
          /예전|작년|강사|출신|이전/.test(line)
        )
          return false;
        const band = gradeBand(
          shortGrade(declared[1]) + '~' + shortGrade(declared[2]),
        );
        return band.length > 0 && !admits(band);
      });
      if (!evidence.length && simpleOffering && hits.length < searchLimit) {
        const scope = declaredRegularCourses(
          hits.map(({ chunk }) => chunk),
          ctx.asOf,
        );
        if (scope.length)
          return schoolOfferingAnswer(
            ctx,
            '현재 승인된 정규 과정 안내에는 ' +
              schoolLabel +
              ' 대상 수업이 없습니다.',
            scope,
          );
      }
      if (!evidence.length)
        return abstain(
          '문의하신 학교급의 개설 여부를 승인 자료에서 확인할 수 없습니다.',
          'INSUFFICIENT_EVIDENCE',
        );
    }
  }
  if (asksEligibility && !evidence.length) {
    const [grade] = grades;
    const absent = new RegExp(
      '^[-*]?\\s*' +
        grade +
        '(?:학년)?\\s*(?:과정|반|수업)(?:은|는|을|를)?\\s*(?:별도로\\s*)?(?:운영|개설|모집)하지\\s*않습니다[.!]?$',
    );
    const available = rows.some(({ row }) =>
      gradeBand(row.cells[row.column(targetColumn)] ?? '').includes(
        gradeBand(grade)[0],
      ),
    );
    if (!available)
      evidence = paragraphs.filter(
        ({ line }) =>
          absent.test(compactText(line).replace(/^[-*]/, '')) ||
          absent.test(line.replace(/\s+/g, ' ').replace(/^[-*]\s*/, '')),
      );
  }
  if (!evidence.length && numberedPlacement) {
    const names = ctx.catalog.classes.filter(({ classId }) =>
      frame.classIds.includes(classId),
    );
    const grade = grades[0] ?? names[0]?.grade;
    const sameGrade = grade && names.every((klass) => klass.grade === grade);
    const family = names[0]?.name
      .replace(/^\S+\s+/, '')
      .replace(/\s*\d+\s*반$/, '')
      .trim();
    if (sameGrade && family && compactText(family).length >= 2) {
      evidence = paragraphs.filter(({ line }) => {
        const body = compactText(line);
        return (
          body.includes(compactText(grade + family)) &&
          /반번호|반배정/.test(body) &&
          /수준|실력|성적/.test(body) &&
          /기준|따라|아니/.test(body)
        );
      });
    }
  }
  if (!evidence.length && schoolGrouping && frame.classIds.length === 1) {
    const klass = ctx.catalog.classes.find(
      ({ classId }) => frame.classIds[0] === classId,
    );
    const school =
      klass && /^([가-힣]{2,}(?:초|중|고))\s*\d\s*학년/.exec(klass.name)?.[1];
    if (school && frame.compact.includes(school)) {
      evidence = rows.flatMap(({ row, course }) => {
        const target = row.column(targetColumn);
        const label = compactText(row.cells[target] ?? '');
        if (!label.includes('학교별') || !label.includes(school)) return [];
        const excerpt = row.project(course, target);
        return excerpt ? [excerpt] : [];
      });
    }
  }
  if (!evidence.length && (asksDescription || aim)) {
    const askedGrade =
      grades.length === 1 ? gradeBand(grades[0])[0] : undefined;
    const matches = rows.flatMap(({ row, course, name }) => {
      const content = row.column(contentColumn);
      const target = row.column(targetColumn);
      const label = compactText(name);
      const matchesCourse =
        asksDescription && label.length >= 4 && frame.compact.includes(label);
      const matchesGoal =
        aim &&
        askedGrade !== undefined &&
        gradeBand(row.cells[target] ?? '').includes(askedGrade) &&
        compactText(row.cells[content] ?? '').includes(compactText(aim));
      if ((!matchesCourse && !matchesGoal) || content < 0) return [];
      const excerpt = matchesGoal
        ? row.project(course, target, content)
        : row.project(course, content);
      return excerpt ? [excerpt] : [];
    });
    evidence = matches;
  }
  if (!evidence.length) return;
  if (new Set(evidence.map(({ line }) => compactText(line))).size !== 1)
    return abstain(
      '해당 과정의 승인 안내가 서로 달라 확인이 필요합니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'public_course_overview';
  return fromPublicExcerpts([evidence[0]]);
}
