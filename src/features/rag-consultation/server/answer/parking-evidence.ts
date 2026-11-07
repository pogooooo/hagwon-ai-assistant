import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { supportsExcerpt } from './verify.ts';

const PARKING =
  /주차장|주차비|주차권|주차\s*(?:요금|할인|확인|가능|공간)|(?:무료|유료)\s*주차/;
const PRICE = /무료|유료|\d[\d,]*\s*원/;
const AMENITY = /수유실|유아\s*휴게실|기저귀\s*교환대|장애인\s*화장실/;
const VISIT_PURPOSES = [
  /상담/,
  /레벨\s*(?:테스트|진단)/,
  /공개\s*수업/,
  /등\s*[·ㆍ/]?\s*하원|등원|하원|데리러|데려다|픽업/,
];

function visitPurposes(text: string): number[] {
  return VISIT_PURPOSES.flatMap((pattern, index) =>
    pattern.test(text) ? [index] : [],
  );
}

/** Parking permission and the price for a particular visit are separate facts. */
export async function answerParkingEvidence(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const text = frame.normalized;
  const noPurpose =
    /상담|레벨\s*(?:테스트|진단)|공개\s*수업|등원|하원/.test(text) &&
    /(?:안\s*(?:가|하|받)|없이|아니(?:고|라)|말고|제외)/.test(text);
  const purposes = noPurpose ? [] : visitPurposes(text);
  const asksFee =
    /주차\s*(?:비|료|요금|얼마)|(?:무료|유료)(?:예요|에요|인가|\s*주차)|주차.{0,12}(?:무료|유료|얼마)/.test(
      text,
    );
  const asksUsage =
    !asksFee ||
    /주차장|차\s*(?:가져|끌)|(?:잠깐\s*)?대도|주차\s*(?:되나요|가능)/.test(
      text,
    );
  const amenity = AMENITY.exec(text)?.[0];
  if (
    !frame.topics.some(({ id }) => id === 'parking') ||
    (!asksFee && !amenity) ||
    frame.topics.some(({ id }) => !['parking', 'location'].includes(id)) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    /변경|예전|작년|내년|장기\s*주차|주차\s*(?:벌금|과태료)/.test(text)
  )
    return;

  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [ctx.question, '주차장 이용 무료 주차비', amenity ?? ''].join(' '),
    documentTypes: ['facility', 'academy_info', 'policy'],
    limit: 28,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const excerpts = found.flatMap<EvidenceExcerpt>(({ chunk }) => {
    if (
      chunk.visibility !== 'academy_public' ||
      chunk.classId ||
      !canReadRecord(ctx.access, chunk, []) ||
      chunk.suspicious ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      /게시판|질문\s*답변/.test(chunk.title)
    )
      return [];
    const { header, cells, kind } = chunk.location;
    if (
      kind === 'table_row' &&
      header &&
      cells &&
      header.length === cells.length
    ) {
      const key = header.findIndex((label) =>
        /^(?:항목|시설|구분)$/.test(compactText(label)),
      );
      const detail = header.findIndex((label) =>
        /^(?:내용|안내|시설안내|이용안내|이용기준)$/.test(compactText(label)),
      );
      if (
        key < 0 ||
        detail < 0 ||
        !/^(?:주차|주차장|수유실|유아휴게실|기저귀교환대|장애인화장실)$/.test(
          compactText(cells[key]),
        )
      )
        return [];
      const tableColumns = [key, detail];
      const line = tableColumns
        .map((i) => header[i] + ': ' + cells[i])
        .join(' / ');
      return supportsExcerpt({ chunk, line, tableColumns })
        ? [{ chunk, line, tableColumns }]
        : [];
    }
    if (kind !== 'paragraph') return [];
    return splitSentences(chunk.text)
      .filter(
        (line) =>
          PARKING.test(line) ||
          (amenity && compactText(line).includes(compactText(amenity))),
      )
      .map((line) => ({ chunk, line }))
      .filter(supportsExcerpt);
  });
  const applies = (line: string) => {
    const noted = visitPurposes(line);
    if (!noted.length)
      return !/방문\s*시|경우에만|에\s*한해|고객\s*전용/.test(line);
    return (
      purposes.length > 0 &&
      purposes.every((purpose) => noted.includes(purpose))
    );
  };
  const rates = excerpts.filter(
    ({ line }) =>
      PRICE.test(line) &&
      /주차권|주차장|주차비|주차.{0,32}(?:무료|유료|요금)|(?:무료|유료).{0,20}주차/.test(
        line,
      ) &&
      applies(line),
  );
  const rate = rates[0];
  const priceKey = (line: string) =>
    [...line.matchAll(/(?:무료|유료|\d[\d,]*\s*원|\d+\s*(?:시간|분))/g)]
      .map(([value]) => compactText(value))
      .join('|');
  if (new Set(rates.map(({ line }) => priceKey(line))).size > 1)
    return abstain(
      '같은 방문 목적의 승인 주차 안내에서 요금 기준이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );

  // When a fee condition is unconfirmed, retain only the independently supported use statement.
  const usage = excerpts.flatMap((excerpt) => {
    if (!/주차장|주차\s*(?:가능|금지|공간)/.test(excerpt.line)) return [];
    if (!PRICE.test(excerpt.line) || applies(excerpt.line)) return [excerpt];
    if (excerpt.tableColumns) return [];
    const line = excerpt.line.split(/[,，]/)[0].trim();
    return !PRICE.test(line) &&
      /이용|쓸\s*수|주차\s*가능|주차장/.test(line) &&
      supportsExcerpt({ ...excerpt, line })
      ? [{ ...excerpt, line }]
      : [];
  })[0];
  const amenityProof = amenity
    ? excerpts.find(
        ({ line }) =>
          compactText(line).includes(compactText(amenity)) &&
          /이용|운영|있습니다|없습니다|없음|제공|마련|\d+\s*층/.test(line),
      )
    : undefined;
  const missing = [
    ...(asksFee && !rate ? ['방문 목적에 해당하는 주차 요금'] : []),
    ...(!usage && asksUsage && (!rate || !/주차장|주차\s*가능/.test(rate.line))
      ? ['주차장 이용']
      : []),
    ...(amenity && !amenityProof ? [amenity] : []),
  ];
  const proofs = [
    ...new Set(
      [asksUsage ? usage : undefined, rate, amenityProof].filter(
        (item): item is EvidenceExcerpt => !!item,
      ),
    ),
  ];
  if (!proofs.length)
    return abstain(
      '요청하신 주차 또는 시설 정보를 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      missing,
    );
  ctx.trace.intent = 'parking_fields';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      ...new Set(proofs.map(({ line }) => line)),
      ...(missing.length ? ['확인되지 않은 항목: ' + missing.join(', ')] : []),
    ].join('\n'),
    citations: proofs.map(({ chunk, tableColumns }) => ({
      kind: 'chunk',
      chunk,
      tableColumns,
    })),
    excerpts: proofs,
    usedFacts: [],
  };
}
