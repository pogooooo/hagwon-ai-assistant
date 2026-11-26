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
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';

const EDUCATION_FIELD = {
  label: '학력',
  request: /학력|출신\s*대학|어느\s*대학/,
  heading: /^(?:학력|출신대학)$/,
  value: /\S/,
} as const;

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
  EDUCATION_FIELD,
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

async function answerPrincipalEducation(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const q = ctx.frame.normalized;
  if (
    !/(?<![가-힣])(?:학원장|원장)(?:님|쌤|선생님)?(?=\s|$|[은이의도는])/.test(
      q,
    ) ||
    !EDUCATION_FIELD.request.test(q) ||
    /부원장|담임|비교|이전\s*원장|전임\s*원장/.test(q)
  )
    return;
  const { at } = resolveEffectiveTime(ctx.frame, ctx.asOf);
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: '원장 소개 원장 프로필 학력 출신 대학',
    documentTypes: ['teacher', 'academy_info'],
    limit: 40,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const rolePrefixes = new Set([
    '학원',
    '우리',
    '저희',
    '이곳',
    '해당',
    '혹시',
    '현재',
    ctx.catalog.displayName,
    ...ctx.catalog.aliases,
  ]);
  const requested = [
    ...new Set(
      [...q.matchAll(/(?<![가-힣])([가-힣]{2,4})\s+(?:원장|학원장)/g)]
        .map(([, name]) => name)
        .filter((name) => !rolePrefixes.has(name)),
    ),
  ];
  if (requested.length > 1)
    return abstain(
      '확인할 원장의 이름을 하나로 지정해 주세요.',
      'AMBIGUOUS_SUBJECT',
    );
  const [requestedName] = requested;
  const hasDegree = (value: string) =>
    /대학교|대학원|학사|석사|박사|졸업|학위/.test(value) &&
    !/미기재|미확인|비공개|확인\s*중|확인되지/.test(value);
  const candidates = hits.flatMap(({ chunk }) => {
    if (chunk.classId !== null || !isCleanPublicEvidence(chunk, at)) return [];
    const row = readEvidenceRow(chunk);
    if (row) {
      const role = row.column(/^(?:직책|직위|역할)$/);
      const name = row.column(/^(?:이름|성명)$/);
      const education = row.column(EDUCATION_FIELD.heading);
      if (
        !/^(?:학원장|원장)$/.test(compactText(row.cells[role] ?? '')) ||
        (requestedName &&
          profileName(row.cells[name] ?? '') !== requestedName) ||
        !hasDegree(row.cells[education] ?? '')
      )
        return [];
      const excerpt = row.project(
        role,
        ...(name >= 0 ? [name] : []),
        education,
      );
      return excerpt ? [excerpt] : [];
    }
    const role = /^([가-힣]{2,4})\s*원장$/.exec(chunk.location.section ?? '');
    if (!role || (requestedName && role[1] !== requestedName)) return [];
    return profileExcerpts(chunk, role[1], EDUCATION_FIELD).filter(
      (excerpt) => hasDegree(excerpt.line) && supportsExcerpt(excerpt),
    );
  });
  if (!candidates.length)
    return abstain(
      '원장의 학력을 승인 소개 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['원장 학력'],
    );
  if (new Set(candidates.map(({ line }) => compactText(line))).size > 1)
    return abstain(
      '승인된 원장 학력 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'principal_education';
  return fromPublicExcerpts([candidates[0]]);
}

/** Join an approved class assignment with explicitly labelled profile evidence. */
export async function answerTeacherProfile(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const principal = await answerPrincipalEducation(ctx);
  if (principal) return principal;
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
