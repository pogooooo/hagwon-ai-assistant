import { isAssistantDirective } from '../ingest/validation.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import { toKstDate } from '../text/time.ts';
import type { RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
} from './context.ts';
import { keywordsOf } from './evidence.ts';
import { explicitClassIds } from './info.ts';

type Field = 'start' | 'deadline' | 'weekday';

export function officialStatements(
  chunk: RagChunk,
): Array<{ text: string; reply: boolean }> {
  const board = /게시판|질문\s*답변|문의\s*모음/.test(chunk.title);
  const markers = [
    ...chunk.text.matchAll(
      /(?:^|\s)(?:(?:A\.\s*|답변\s*)\(([^)\n]+)\)\s*:?|Q\.|질문\s*:)\s*/g,
    ),
  ];
  const tagged = [
    ...chunk.text.matchAll(
      /(?:^|\n)\s*(?:\[학원\s*답변\][^\n|]*\|\s*([가-힣a-z0-9 ]{0,30}?(?:데스크|원장|강사|교사|담당자|운영팀|관리자))(?=\s|$)|\[답변\]\s*([^|\n]{1,60})\|\s*\d{4}-\d{2}-\d{2}(?=\s|$)|\[(?:질문|게시글|글\s*\d+)\])/g,
    ),
  ];
  if (
    board &&
    tagged.some(
      (marker) => marker[1] || marker[2] || /^\s*\[글/.test(marker[0]),
    )
  )
    return tagged.flatMap((marker, index) => {
      const author = (marker[1] ?? marker[2] ?? '').trim();
      return /(?:데스크|원장|강사|교사|담당자|운영팀|관리자)$/.test(author) &&
        !/학부모|원생|학생/.test(author)
        ? [
            {
              text: chunk.text.slice(
                marker.index + marker[0].length,
                tagged[index + 1]?.index,
              ),
              reply: true,
            },
          ]
        : [];
    });
  if (!board && !markers.length) return [{ text: chunk.text, reply: false }];
  return markers.flatMap((marker, index) =>
    /데스크|원장|강사|교사|담당자|학원|운영팀|관리자/.test(marker[1] ?? '') &&
    !/학부모|원생|학생/.test(marker[1] ?? '')
      ? [
          {
            text: chunk.text.slice(
              marker.index + marker[0].length,
              markers[index + 1]?.index,
            ),
            reply: true,
          },
        ]
      : [],
  );
}

/** A conflict requires a bound event, the same requested field, and two approved sources. */
export async function answerAnnouncementConflict(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, explicitDates } = ctx.frame;
  if (/변경\s*(전|후)|이전|예전|바뀌기|개정|취소|추가/.test(normalized)) return;
  const deadline =
    /신청|접수|등록/.test(normalized) && /언제\s*까지|마감/.test(normalized);
  const starts =
    /몇\s*시/.test(normalized) && /시작|열려|열리/.test(normalized);
  const weekly =
    /(?:무슨|어느)\s*요일/.test(normalized) && /주간|매주/.test(normalized);
  const field: Field | undefined = deadline
    ? 'deadline'
    : starts
      ? 'start'
      : weekly
        ? 'weekday'
        : undefined;
  if (!field) return;
  const effective = resolveEffectiveTime(ctx.frame, ctx.asOf);
  const day =
    effective.explicitDay !== null
      ? toKstDate(effective.explicitDay)
      : undefined;
  if (
    field === 'start' &&
    (!day || explicitDates.length !== 1 || explicitDates[0].operator !== 'at')
  )
    return;
  const startPattern =
    field === 'start' && day
      ? new RegExp(
          `(?:^|[^0-9])(?:(\\d{4})년)?${day.month}월${day.day}일(?:\\([월화수목금토일]\\))?[^.]{0,18}?((?:[01]?\\d|2[0-3]):[0-5]\\d)\\)?(?:부터|에시작|시작)`,
        )
      : undefined;
  const startMonth = /(?<!\d)(\d{1,2})\s*월\s*부터/.exec(normalized)?.[1];
  if (field === 'weekday' && !startMonth) return;
  const requestedMonth =
    day?.month ??
    (ctx.frame.months.length === 1 ? ctx.frame.months[0] : undefined);
  const labels = [
    ...ctx.catalog.classes.flatMap(({ name, aliases }) => [name, ...aliases]),
    ...ctx.access.studentRefs.flatMap(({ displayLabel, aliases }) => [
      displayLabel,
      ...aliases,
    ]),
  ].map(compactText);
  const anchors = keywordsOf(ctx.question)
    .map(compactText)
    .filter(
      (word) =>
        /^[가-힣]{3,}$/.test(word) &&
        !/^(?:신청|접수|등록|마감|시작|열리|나가|한다|같이|본다|가능|시간|담당|수업|요일|정확)/.test(
          word,
        ) &&
        !labels.some((label) => label.includes(word) || word.includes(label)),
    );
  if (!anchors.length) return;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [ctx.question, ...anchors].join(' '),
    documentTypes: ['announcement'],
    limit: 24,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const targetClasses = explicitClassIds(ctx);
  const claims = new Map<string, Map<string, Set<string>>>();
  for (const { chunk } of found) {
    if (
      chunk.visibility !== 'academy_public' ||
      (chunk.classId && !targetClasses.includes(chunk.classId)) ||
      chunk.location.kind !== 'paragraph' ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length
    )
      continue;
    const heading = compactText(chunk.location.section ?? '');
    const lines = officialStatements(chunk).flatMap(({ text, reply }) => {
      // An official Q&A reply can name the event in its first sentence and
      // give the deadline in a later sentence of that same reply.
      const context = reply && field === 'deadline' ? compactText(text) : '';
      return splitSentences(text).map((sentence) => ({ sentence, context }));
    });
    for (const { sentence, context } of lines) {
      const content = compactText(sentence);
      if (/작년|지난해|재작년/.test(content)) continue;
      const matched = anchors.filter(
        (word) =>
          heading.includes(word) ||
          content.includes(word) ||
          context.includes(word),
      );
      if (!matched.length) continue;
      const start = startPattern?.exec(content);
      if (start?.[1] && Number(start[1]) !== day?.year) continue;
      const close =
        field === 'deadline' && /신청|접수|등록/.test(content)
          ? /(?<!\d)(?:(\d{4})년)?(\d{1,2})월(\d{1,2})일(?:\([월화수목금토일]\))?(?:까지|에마감)/.exec(
              content,
            )
          : null;
      const dayOfWeek =
        field === 'weekday' && content.includes(startMonth + '월부터')
          ? /매주([월화수목금토일])요일/.exec(content)
          : null;
      const value =
        start?.[2].padStart(5, '0') ??
        (close ? String(Number(close[3])) : dayOfWeek?.[1]);
      if (
        !value ||
        (close && requestedMonth && Number(close[2]) !== requestedMonth)
      )
        continue;
      const scope = close
        ? (close[1] ?? '') + '|' + Number(close[2])
        : (startMonth ?? '');
      for (const anchor of matched) {
        const key = anchor + '|' + scope;
        const bySource = claims.get(key) ?? new Map<string, Set<string>>();
        const values = bySource.get(chunk.sourceId) ?? new Set<string>();
        values.add(value);
        bySource.set(chunk.sourceId, values);
        claims.set(key, bySource);
      }
    }
  }
  if (
    ![...claims.values()].some((bySource) => {
      const values = [...bySource.values()];
      return (
        values.length > 1 &&
        values.every((set) => set.size === 1) &&
        new Set(values.flatMap((set) => [...set])).size > 1
      );
    })
  )
    return;
  ctx.trace.intent = 'announcement_conflict';
  return abstain(
    '같은 행사 일정에 대한 승인 안내가 서로 달라 담당자 확인이 필요합니다.',
    'CONFLICTING_EVIDENCE',
    undefined,
    ['CONTRADICTION'],
  );
}
