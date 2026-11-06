import { isAssistantDirective } from '../ingest/validation.ts';
import { compactText } from '../text/normalize.ts';
import type { RagChunk } from '../types.ts';
import {
  abstain,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { namedTeacher } from './evidence.ts';
import { explicitClassIds } from './info.ts';
import { supportsExcerpt } from './verify.ts';

const PROFILE_FIELDS = [
  {
    label: '경력',
    request: /경력|약력|몇\s*년.{0,8}가르치/,
    heading: /^(?:경력|약력)$/,
    value: /\S/,
  },
  {
    label: '상담 가능 시간',
    request: /상담.{0,8}(?:언제|몇\s*시|가능\s*시간)|상담\s*시간/,
    heading: /^(?:상담(?:가능)?(?:시간)?|원장상담)$/,
    value: /\d{1,2}:\d{2}|\d{1,2}\s*시/,
  },
  {
    label: '학력',
    request: /학력|출신\s*대학|어느\s*대학/,
    heading: /^(?:학력|출신대학)$/,
    value: /\S/,
  },
] as const;

type ProfileField = (typeof PROFILE_FIELDS)[number];

function profileName(value: string): string | undefined {
  return /^([가-힣]{2,4})\s*(?:수석\s*)?(?:강사|교사|원장|부원장|선생님|담임)?$/.exec(
    value.trim(),
  )?.[1];
}

function profileExcerpts(
  chunk: RagChunk,
  name: string,
  field: ProfileField,
): EvidenceExcerpt[] {
  const { section, header, cells, kind } = chunk.location;
  if (kind === 'table_row') {
    if (
      !header ||
      !cells ||
      !/^(?:이름|성명|강사(?:명)?|선생님)$/.test(compactText(header[0])) ||
      profileName(cells[0] ?? '') !== name
    )
      return [];
    return header.flatMap((heading, index) => {
      if (
        !field.heading.test(compactText(heading)) ||
        !field.value.test(cells[index] ?? '')
      )
        return [];
      return [
        {
          chunk,
          tableColumns: [0, index],
          line:
            header[0] + ': ' + cells[0] + ' / ' + heading + ': ' + cells[index],
        },
      ];
    });
  }
  const lines = chunk.text.split('\n');
  const firstLineName = profileName(lines[0].replace(/^\[[^\]\n]+\]\s*/, ''));
  if ((firstLineName ?? profileName(section ?? '')) !== name) return [];
  return lines.flatMap((sourceLine) => {
    const line = sourceLine.replace(/^\s*(?:[-*•]\s+)?/, '').trim();
    const label = /^([^:：]+)[:：]\s*(.+)$/.exec(line);
    return label &&
      field.heading.test(compactText(label[1])) &&
      field.value.test(label[2])
      ? [{ chunk, line }]
      : [];
  });
}

/** Join an approved class assignment with explicitly labelled profile evidence. */
export async function answerTeacherProfile(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { normalized, topics } = ctx.frame;
  if (
    !/강사|선생|교사|쌤|샘|담임/.test(normalized) ||
    topics.some(({ id }) => id !== 'teacher' && id !== 'schedule') ||
    /수업\s*(?:시간|일정)|시간표|요일|연락처|전화번호/.test(normalized)
  )
    return;
  const fields = PROFILE_FIELDS.filter(({ request }) =>
    request.test(normalized),
  );
  const classes = explicitClassIds(ctx);
  if (!fields.length || classes.length !== 1) return;

  const { at } = resolveEffectiveTime(ctx.frame, ctx.asOf);
  const facts = (
    await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      effectiveAt: at,
      factTypes: ['teacher'],
    })
  ).filter(
    (fact) => fact.subjectType === 'class' && fact.subjectId === classes[0],
  );
  recordFacts(ctx.trace, facts);
  const name =
    facts[0]?.value.kind === 'text'
      ? profileName(facts[0].value.text)
      : undefined;
  if (
    !name ||
    facts.some(
      ({ value, sourceId }) =>
        value.kind !== 'text' ||
        profileName(value.text) !== name ||
        sourceId !== facts[0].sourceId,
    )
  ) {
    return abstain(
      '요청하신 반의 담당 강사와 소개 자료를 함께 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  }

  const fact = facts[0];
  const requestedTeacher = namedTeacher(normalized);
  if (requestedTeacher && requestedTeacher !== name)
    return abstain(
      '문의하신 강사의 담당 반과 소개 자료가 일치하는지 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
    );
  const matches = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [name, ...fields.map(({ label }) => label)].join(' '),
    documentTypes: ['teacher'],
    limit: 40,
  });
  const chunks = matches
    .map(({ chunk }) => chunk)
    .filter(
      (chunk) =>
        chunk.sourceId === fact.sourceId &&
        chunk.visibility === 'academy_public' &&
        (!chunk.classId || chunk.classId === classes[0]) &&
        !chunk.suspicious &&
        !isAssistantDirective(chunk.text) &&
        !chunk.extraction?.needsReview &&
        !chunk.extraction?.uncertainTokens.length,
    );
  recordChunks(ctx.trace, chunks);

  const excerpts: EvidenceExcerpt[] = [];
  const missing: string[] = [];
  for (const field of fields) {
    const candidates = chunks
      .flatMap((chunk) => profileExcerpts(chunk, name, field))
      .filter(supportsExcerpt);
    const unique = new Map(
      candidates.map((excerpt) => [compactText(excerpt.line), excerpt]),
    );
    if (unique.size === 1) excerpts.push([...unique.values()][0]);
    else missing.push(field.label);
  }
  ctx.trace.intent = 'teacher_profile';
  if (!excerpts.length && !/누구|누가|성함|이름/.test(normalized))
    return abstain(
      '문의하신 강사 소개 항목을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      missing,
    );
  return {
    status: missing.length ? 'partial' : 'answered',
    text: [
      `담당 강사는 ${name}입니다.`,
      ...excerpts.map(({ line }) => line),
      ...(missing.length ? [`확인되지 않은 항목: ${missing.join(', ')}.`] : []),
    ].join('\n'),
    citations: [
      { kind: 'fact', fact, effectiveAt: at },
      ...excerpts.map(({ chunk, tableColumns }) => ({
        kind: 'chunk' as const,
        chunk,
        tableColumns,
        effectiveAt: at,
      })),
    ],
    usedFacts: [fact],
    excerpts,
    ...(missing.length
      ? { missingFields: missing, reasonCode: 'PARTIAL_EVIDENCE' as const }
      : {}),
  };
}
