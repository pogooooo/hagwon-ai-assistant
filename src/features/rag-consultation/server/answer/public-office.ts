import { compactText, splitSentences } from '../text/normalize.ts';
import { hasExplicitClockTime } from '../text/time.ts';
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

const openingAnchor =
  /운영시간|영업시간|개원시간|문을?열|문을?닫|학원(?:은|이|이요)몇시(?:에|부터|까지)?(?:열|닫)/;
const otherHours = /상담|수업|강의|자습실|셔틀|도서관|별관|특강/;
const methodAnchor = /상담(?:을|은|이)?(?:어떻게)?(?:신청|예약|접수)/;
const actionable = /메뉴|홈페이지|전화|방문|데스크|신청서|링크|온라인|현장|앱/;
const applies = /신청|예약|접수/;
const invalidMethod = /미정|추후|이전에는|예전에는|변경전|질문[:：]/;
const methodCue = /어떻게|방법|신청하려면|예약하려면/;
const dateCue =
  /기간|기한|마감|몇시|언제|얼마|비용|시간과|시간이랑|시간대|가능시간|된다면/;

export async function answerPublicOffice(ctx: AnswerContext) {
  const { frame } = ctx;
  const q = frame.compact;
  if (
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeDay !== null ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.classIds.length ||
    frame.subjects.length ||
    frame.unknownPrograms.length ||
    frame.topics.some(({ id }) => !['hours', 'schedule'].includes(id)) ||
    frame.selfReference ||
    frame.matchedStudentIds.length ||
    /수강료|비용|교재비|비교|달라|변경|예전|특강/.test(q)
  )
    return;
  const opensOnDay =
    /^(?:[월화수목금토일]요일|평일|주말|공휴일)(?:에도|에|도|은|는)?(?:열어요|열리나요|문열어요|문여나요)[?!.]*$/.test(
      q,
    );
  const field =
    (openingAnchor.test(q) || opensOnDay) && !otherHours.test(q)
      ? 'opening'
      : methodAnchor.test(q) && methodCue.test(q) && !dateCue.test(q)
        ? 'method'
        : undefined;
  if (!field) return;
  const day = /(?:[월화수목금토일]요일|공휴일|평일|주말)/.exec(q)?.[0];
  const atDay = (text: string) =>
    !day ||
    text.includes(day) ||
    (day === '주말' && /토요일.*일요일/.test(text));
  const label = field === 'opening' ? '학원 운영시간' : '상담 신청 방법';
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: ctx.question + ' ' + label,
    documentTypes: ['academy_info', 'policy', 'announcement', 'facility'],
    limit: 36,
  });
  recordChunks(
    ctx.trace,
    hits.map((h) => h.chunk),
  );
  const matches = new Map<string, EvidenceExcerpt>();
  for (const { chunk } of hits) {
    if (
      chunk.classId ||
      chunk.studentId ||
      !isCleanPublicEvidence(chunk, ctx.asOf)
    )
      continue;
    const heading = compactText(
      (chunk.location.section ?? '') + ' ' + chunk.title,
    );
    const row = readEvidenceRow(chunk);
    if (row) {
      const marked = row.cells.findIndex((cell) =>
        field === 'opening'
          ? /^(?:학원)?(?:운영시간|영업시간)$/.test(compactText(cell))
          : /^(?:[가-힣]{0,4})상담(?:신청|예약|접수)(?:방법)?$/.test(
              compactText(cell),
            ),
      );
      const section = compactText(chunk.location.section ?? chunk.title);
      const key =
        marked >= 0
          ? marked
          : field === 'opening' &&
              openingAnchor.test(section) &&
              !otherHours.test(section)
            ? row.column(/^(?:구분|요일|일자|운영일)$/)
            : -1;
      if (key < 0) continue;
      const index = row.column(
        field === 'opening'
          ? /^(?:안내|내용|시간|운영시간)$/
          : /^(?:안내|내용|신청방법|예약방법|절차|방법)$/,
      );
      if (index === key || index < 0) continue;
      const value = row.cells[index];
      if (
        field === 'opening'
          ? !atDay(row.cells[key] + value) ||
            (!hasExplicitClockTime(value) &&
              !/^(?:정기)?휴무$/.test(compactText(value)))
          : !actionable.test(value) || invalidMethod.test(compactText(value))
      )
        continue;
      const excerpt = row.project(key, index);
      if (excerpt) matches.set(compactText(row.cells[key] + value), excerpt);
    } else if (chunk.location.kind === 'paragraph') {
      for (const line of splitSentences(chunk.text)) {
        const body = compactText(line);
        const supports =
          field === 'opening'
            ? hasExplicitClockTime(line) &&
              atDay(body) &&
              !otherHours.test(body) &&
              (openingAnchor.test(body) ||
                (openingAnchor.test(heading) && !otherHours.test(heading)))
            : actionable.test(body) &&
              !invalidMethod.test(body) &&
              (methodAnchor.test(body) ||
                (methodAnchor.test(heading) && applies.test(body)));
        if (supports) matches.set(body, { line, chunk });
      }
    }
  }
  ctx.trace.intent = 'public_office_' + field;
  if (!matches.size)
    return abstain(
      '공개 안내에서 ' +
        label +
        '을 확인할 수 없습니다. 다른 질문을 이어서 남기거나 담당자 상담을 요청할 수 있어요.',
      'INSUFFICIENT_EVIDENCE',
      [label],
    );
  const sources = new Set(
    [...matches.values()].map(({ chunk }) => chunk.documentId),
  );
  if (sources.size > 1 && matches.size > 1)
    return abstain(
      label + '에 관한 공개 안내가 서로 달라 확인이 필요합니다.',
      'CONFLICTING_EVIDENCE',
      [label],
    );
  return fromPublicExcerpts([...matches.values()].slice(0, 4));
}
