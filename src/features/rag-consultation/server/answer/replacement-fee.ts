import {
  compactText,
  isDataAbsenceStatement,
  normalizeText,
} from '../text/normalize.ts';
import {
  abstain,
  recordChunks,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
  readEvidenceRow,
} from './public-evidence.ts';
import { supportsExcerpt } from './verify.ts';

const LOSS = /분실|잃어버(?:리|려|린|렸)|잃(?:으면|었)/;
const DAMAGE = /파손|망가(?:지|진|져|졌|뜨)|깨(?:지|진|져|졌)/;
const PAYMENT =
  /돈.{0,5}(?:내|들)|얼마|금액|비용|요금|가격|유료|무료|내야|변상|재발급(?:료|비)/;
const KRW = /(?<![\d,.:])(\d{1,3}(?:,\d{3})+|\d+)\s*원(?![\d.a-z])/gi;
const UNCLEAR_POLICY =
  /미정|별도\s*문의|예정|검토|협의|경우에\s*따라|예를\s*들어|또는|혹은|할인|환불|예외|조건부/;

function incident(text: string) {
  const loss = LOSS.exec(text);
  const damage = DAMAGE.exec(text);
  if (Boolean(loss) === Boolean(damage)) return;
  return loss
    ? { kind: 'loss', match: loss }
    : { kind: 'damage', match: damage! };
}

function itemForms(text: string) {
  const candidate =
    normalizeText(text)
      .replace(/^(?:[-*•·※]|\d+[.)])\s*/, '')
      .split(/(?:^|\s)(?:있는|받은|빌린|대여한|지급된|쓰던|사용하던)\s+/)
      .at(-1) ?? '';
  if (!/^[a-z0-9가-힣][a-z0-9가-힣 ·()\-]{1,60}$/.test(candidate)) return [];
  const key = compactText(candidate);
  return [key, key.replace(/[을를은는이가]$/, '')].filter(
    (form) => form.length >= 2,
  );
}

function charge(text: string, isCell: boolean) {
  const normalized = normalizeText(text);
  if (UNCLEAR_POLICY.test(normalized) || isDataAbsenceStatement(normalized))
    return;
  const amounts = [...normalized.matchAll(KRW)];
  const waived = isCell
    ? /^(?:무료|없음|미부과|면제)$/.test(compactText(normalized))
    : /^(?:무료(?:로)?\s*(?:재발급|재지급|교체)(?:합니다|됩니다)|(?:재발급|재지급|교체)?\s*(?:비용|요금)(?:은|을|이|가)?\s*(?:무료입니다|없습니다|없음|받지\s*않습니다))[.!。]?$/.test(
        normalized,
      );
  if (waived) return amounts.length === 0 ? 0 : undefined;
  if (amounts.length !== 1) return;
  const [match] = amounts;
  const before = normalized.slice(0, match.index).trim();
  const after = normalized.slice(match.index + match[0].length).trim();
  if (/\d\s*[,.:]$|[-−+]$/.test(before)) return;
  const value = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(value)) return;
  if (isCell)
    return !after && /^(?:개당|건당|회당)?$/.test(before) ? value : undefined;
  const payment =
    /^(?:을|를|이|가)?\s*(?:내야|내셔야|납부해야|납부합니다|청구됩니다|청구합니다|부과됩니다|부과합니다|부담해야|부담합니다|듭니다)/.test(
      after,
    );
  const labeled =
    /(?:비용|요금|금액|재발급비|재지급비)(?:이|은|는|가)?\s*[:：]?$/.test(
      before,
    ) && /^(?:입니다|이에요|예요)?[.!。]?$/.test(after);
  return payment || labeled ? value : undefined;
}

function tableIncident(text: string) {
  const condition = compactText(text);
  if (/^분실(?:시|한경우|할때|할경우)?$/.test(condition)) return 'loss';
  if (/^파손(?:시|된경우|될때|될경우)?$/.test(condition)) return 'damage';
}

function statementClaim(
  line: string,
  kind: string,
  itemKeys: readonly string[],
) {
  const normalized = normalizeText(line);
  const trigger = incident(normalized);
  if (!trigger || trigger.kind !== kind) return;
  const { match } = trigger;
  const items = itemForms(normalized.slice(0, match.index));
  if (!items.some((item) => itemKeys.includes(item))) return;
  const policy = normalized
    .slice(match.index + match[0].length)
    .replace(
      /^(?:\s*(?:하면|한\s*경우|할\s*때|했(?:다면|을\s*때|는데)?|되면|된\s*경우|면|었(?:을\s*때|다면)?|다면|을\s*때|시|경우))?\s*[,.:：]?\s*/,
      '',
    );
  if (
    !/^(?:\d|다시\s*(?:받|발급|지급|구매)|재발급|재지급|교체|재구매|비용|요금|무료)/.test(
      policy,
    )
  )
    return;
  return charge(policy, false);
}

export async function answerReplacementFee(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const question = frame.normalized;
  if (
    !PAYMENT.test(question) ||
    (!LOSS.test(question) && !DAMAGE.test(question)) ||
    /환불|수강료|언제|어디|예전|변경|달라/.test(question) ||
    frame.flags.compare
  )
    return;

  ctx.trace.intent = 'item_replacement_fee';
  const missing = () =>
    abstain(
      '문의하신 물품과 조건에 해당하는 비용을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['재발급 비용'],
    );
  const trigger = incident(question);
  if (
    !trigger ||
    frame.unboundProgram ||
    frame.unknownPrograms.length ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeDay !== null ||
    frame.relativePeriod ||
    frame.relativeWeek
  )
    return missing();
  const { kind, match } = trigger;
  const before = question.slice(0, match.index).trim();
  const itemText =
    before ||
    question
      .slice(match.index + match[0].length)
      .replace(/^\s*(?:시|한|된)\s+/, '')
      .split(/\s+(?:재발급|교체|비용|요금|얼마|가격|돈|변상)/)[0];
  const items = itemForms(itemText);
  if (!items.length) return missing();

  const classes = explicitClassIds(ctx);
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [itemText, match[0], '재발급 비용'].join(' '),
    documentTypes: ['policy', 'academy_info', 'announcement', 'fee'],
    limit: 55,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const claims: { amount: number; excerpt: EvidenceExcerpt }[] = [];
  for (const { chunk } of found) {
    if (
      (chunk.classId && !classes.includes(chunk.classId)) ||
      /게시판|질문\s*답변|문의\s*모음/.test(chunk.title)
    )
      continue;
    const row = readEvidenceRow(chunk);
    if (row) {
      const item = row.column(/^(?:물품|품목|대여품|장비|교구|물품명|품목명)$/);
      const condition = row.column(/^(?:사유|상황|조건|구분)$/);
      const cost = row.column(
        /^(?:(?:재발급|재지급|교체|재구매)(?:비|료)|(?:재발급|재지급|교체|재구매)?(?:비용|요금|금액))$/,
      );
      if (
        item < 0 ||
        condition < 0 ||
        cost < 0 ||
        !items.includes(compactText(row.cells[item])) ||
        tableIncident(row.cells[condition]) !== kind
      )
        continue;
      const amount = charge(row.cells[cost], true);
      const excerpt = row.project(item, condition, cost);
      if (
        amount !== undefined &&
        excerpt &&
        isCleanPublicEvidence(chunk, ctx.asOf, excerpt.line)
      )
        claims.push({ amount, excerpt });
    } else if (chunk.location.kind === 'paragraph') {
      for (const line of chunk.text
        .split(/(?<=[.!?。])(?:\s+|(?=[가-힣]))|\n+/)
        .map((line) => line.trim())) {
        const amount = statementClaim(line, kind, items);
        const excerpt = { chunk, line };
        if (
          amount !== undefined &&
          isCleanPublicEvidence(chunk, ctx.asOf, line) &&
          supportsExcerpt(excerpt)
        )
          claims.push({ amount, excerpt });
      }
    }
  }
  if (!claims.length) return missing();
  if (new Set(claims.map(({ amount }) => amount)).size > 1)
    return abstain(
      '같은 물품과 조건에 대한 승인 비용 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  return fromPublicExcerpts([claims[0].excerpt]);
}
