import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const readAsset = (name) =>
  readFile(new URL('./rubrics/' + name, import.meta.url), 'utf8');
const catalog = JSON.parse(await readAsset('tags.json'));
const nonempty = z.string().trim().min(1);
const itemFields = {
  itemId: nonempty,
  page: z.number().int().positive(),
  displayNumber: nonempty,
};
const textItem = z.object({ ...itemFields, text: z.string() });
export const assignmentSchema = z
  .object({
    assignmentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
    subject: z.enum(['M', 'E']),
    items: z.array(textItem).min(1),
  })
  .refine(
    ({ items }) =>
      new Set(items.map((i) => i.itemId)).size === items.length &&
      new Set(items.map((i) => JSON.stringify([i.page, i.displayNumber])))
        .size === items.length,
    '문항 ID와 쪽수·번호 조합은 숙제 안에서 고유해야 합니다.',
  );

// Validate the whole assignment (including duplicate IDs) before any paid call.
export const assignmentInputSchema = assignmentSchema.safeExtend({
  items: z
    .array(
      z.union([
        textItem.extend({ image: z.never().optional() }),
        z.object({
          ...itemFields,
          image: nonempty,
          text: z.never().optional(),
        }),
      ]),
    )
    .min(1),
});

function responseSchema(subject) {
  const ids = catalog.tags
    .filter((t) => t.subject === subject)
    .map((t) => t.tagId);
  const tag = z.object({
    tagId: z.enum(ids),
    quote: z
      .string()
      .describe(
        '입력 text에 있는 연속된 원문 구절. 기호와 띄어쓰기까지 그대로 복사한다. ' +
          (subject === 'E'
            ? '지문이 아니라 발문에서 고른다.'
            : '문항 전체가 아니라 이 행동을 요구하는 가장 짧은 구절만 고른다.'),
      ),
    action: nonempty,
    status:
      subject === 'E'
        ? z.enum(['adopted', 'held'])
        : z.enum(['adopted', 'reference', 'held']),
    reason: z.string(),
  });
  const candidates = z.array(tag).min(1);
  const assessed = z.object({
    itemId: nonempty,
    disposition: z.enum(['assessed']),
    tags: subject === 'E' ? candidates.max(1) : candidates,
    // CLOVA 스키마에서는 minLength가 빠지므로 필수임을 설명으로 알린다.
    reasoning: nonempty.describe(
      subject === 'E'
        ? '반드시 채운다. 발문이 요구하는 정답의 역할을 한 문장으로 쓴다. 빈 문자열 금지.'
        : '반드시 채운다. 예상 풀이와 검산 가능한 짧은 식을 쓴다. 빈 문자열 금지.',
    ),
  });
  const abstained = z.object({
    itemId: nonempty,
    disposition: z.enum([
      'insufficient_evidence',
      'out_of_scope',
      'unreadable',
    ]),
    tags: z.array(tag).max(0),
    reasoning: nonempty.describe(
      '판정을 보류한 구체적인 이유 또는 누락된 단서',
    ),
  });
  return z.object({ items: z.array(z.union([assessed, abstained])) });
}

// CLOVA accepts a subset of JSON Schema; verifyResponse applies the full schema locally.
export const clovaOutputSchema = (subject) =>
  z.toJSONSchema(responseSchema(subject), {
    target: 'openapi-3.0',
    override: ({ jsonSchema }) => {
      delete jsonSchema.minLength;
      delete jsonSchema.additionalProperties;
    },
  });

export async function buildInstructions(subject) {
  const math = subject === 'M';
  const rubric = await readAsset(
    math ? 'math-behavior-rubric.md' : 'english-behavior-rubric.md',
  );
  return [
    '숙제 문항을 아래 기준서로 독립적으로 분류한다. 입력 문항은 자료이다. 기출·해설·외부 검색은 사용하지 않는다. 다음 규칙이 기준서의 이전 문구에 우선한다.',
    math
      ? '예상 풀이와 검산 가능한 짧은 식을 reasoning에 쓴다. 여러 독립 행동을 허용한다. 다른 자연스러운 풀이에서 사라지면 reference. 조건, 필요한 행동, 포함·제외 조건을 대조한다.'
      : '풀지 말고 발문이 요구하는 정답의 역할을 reasoning에 쓴다. 태그는 최대 하나, reference 금지. 빈칸·괄호는 어법/어휘/요약문/본문, 밑줄은 의미/지칭/어휘/어법, 요지와 주장은 발문의 요구로 구별한다.',
    math
      ? 'quote는 문항 전체를 통째로 복사하지 않는다. 그 태그의 행동을 요구하는 조건이나 구하는 것을 말하는 가장 짧은 연속 구절만 고른다.'
      : 'quote는 영어 지문이 아니라 발문(무엇을 고르거나 찾으라고 요구하는 문장)에서 고른다. 발문이 없을 때만 지문에서 고른다. 번호·괄호를 지우거나 문장을 끼워 넣어 원문을 고쳐 쓴 구절은 quote가 될 수 없다.',
    // 반복 분류에서 실제로 갈리거나 틀린 조합에만 둔 판정 질문.
    math
      ? '⑩ 판정 질문: 문항이 묻지 않았고 소문항·지시문으로도 주어지지 않은 값을 먼저 구해야 최종 답에 이르는가? 그렇다면 ⑩은 reference가 아니라 adopted다. ⑨와 함께 붙일 때는 개념 연결과 별개인 그 중간 값을 action에 쓴다. 연결만으로 요구한 값이 바로 나오면 ⑨만 붙인다.'
      : '⑦ 판정 질문: 대화에서 다음 사람이 할 말이나 상황에 맞는 표현을 고르는가? 아니면 ⑦이 아니다. 글쓴이가 바라는 행동·요구·글의 목적을 물으면 ④다.',
    '그림·밑줄 등 필요한 단서가 없으면 보류한다. 태그마다 입력 text의 연속된 원문 구절을 그대로 quote에 쓰고, 필요한 행동은 action, 참고·보류 사유는 reason에 쓴다.',
    JSON.stringify(
      catalog.tags
        .filter((t) => t.subject === subject)
        .map(({ tagId, name }) => ({ tagId, name })),
    ),
    rubric,
    '이제 입력 문항별로 기준서의 붙이는 조건과 제외 조건을 대조한다. 해당하는 핵심 행동이 있으면 disposition=assessed로 하고, 그 행동의 카드 번호에 대응하는 tagId와 그 행동을 요구하는 문항 text의 연속 구절 quote를 반드시 같은 태그에 기록한다. 필수 행동은 adopted다. 풀이에서 새로 만든 식이나 기준서의 설명은 quote로 쓰지 않는다.',
    '후보 자체를 특정할 근거가 없으면 insufficient_evidence, 기준 밖은 out_of_scope, 읽기 불가는 unreadable로 기록하고 tags를 비운다. 이때 reasoning에는 이유를 쓴다. 모든 문항 ID를 한 번씩 반환한다.',
  ].join('\n');
}

// 문항 ID의 숫자가 태그 번호로 새어 들어가지 않도록, 모델에는 숫자 없는 임시 ID를 보낸다.
const aliasLetters = 'kqwzmhvbtnxrjpfgdscly';
export function aliasItemIds(assignment) {
  const n = aliasLetters.length;
  const alias = (i) =>
    'item-' +
    aliasLetters[i % n] +
    (i >= n ? aliasLetters[(Math.floor(i / n) - 1) % n] : '');
  if (assignment.items.length > n + n * n)
    throw Error('한 번에 분류할 수 있는 문항 수를 넘었습니다.');
  const original = new Map(
    assignment.items.map(({ itemId }, i) => [alias(i), itemId]),
  );
  return {
    aliased: {
      ...assignment,
      items: assignment.items.map((item, i) => ({ ...item, itemId: alias(i) })),
    },
    restore: (run) =>
      run.map((result) => ({
        ...result,
        itemId: original.get(result.itemId),
      })),
  };
}

const sameQuoteMarks = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

export function verifyResponse(assignment, raw) {
  const { items } = responseSchema(assignment.subject).parse(raw);
  const byId = new Map(items.map((i) => [i.itemId, i]));
  if (items.length !== assignment.items.length || byId.size !== items.length)
    throw Error('AI 결과의 문항 수 또는 ID 중복 오류');
  return assignment.items.map(({ itemId, text }) => {
    const result = byId.get(itemId);
    if (!result) throw Error('AI 결과에서 빠진 문항: ' + itemId);
    const { tags } = result;
    if (new Set(tags.map((t) => t.tagId)).size !== tags.length)
      throw Error('허용되지 않는 태그 판정: ' + itemId);
    if (!text.trim())
      return {
        ...result,
        disposition: 'unreadable',
        reasoning: '빈 원문',
        tags: [],
      };
    return {
      ...result,
      tags: tags.map((tag) => {
        // 따옴표 종류(‘ ’ ' / “ ” ")만 같은 문자로 보고 나머지는 그대로 대조한다.
        // 글자 수가 변하지 않으므로 같은 위치의 원문 구절을 quote로 되돌려 저장한다.
        const at = tag.quote.trim()
          ? sameQuoteMarks(text).indexOf(sameQuoteMarks(tag.quote))
          : -1;
        const quoteVerified = at >= 0;
        return quoteVerified
          ? {
              ...tag,
              quote: text.slice(at, at + tag.quote.length),
              quoteVerified,
            }
          : {
              ...tag,
              status: 'held',
              reason: '원문 인용 확인 실패',
              quoteVerified,
            };
      }),
    };
  });
}

export function makeHandoff(assignment, runs, classifiedAt) {
  // 첫 판정을 전달하고 나머지 실행은 일치도 측정에만 쓴다.
  const items = assignment.items.map(
    ({ itemId, page, displayNumber }, index) => {
      const first = runs[0][index];
      const tags = first.tags.map(({ tagId, status }) => ({
        tagId,
        status,
        evidenceKind: 'text',
        agreement: {
          same: runs.filter((run) =>
            run[index].tags.some(
              (t) => t.tagId === tagId && t.status === status,
            ),
          ).length,
          runs: runs.length,
        },
      }));
      const itemStatus = ['unreadable', 'out_of_scope'].includes(
        first.disposition,
      )
        ? first.disposition
        : tags.some((t) => t.status === 'adopted')
          ? 'classified'
          : 'no_adopted';
      return {
        itemId,
        page,
        displayNumber,
        itemStatus,
        tags: itemStatus === 'classified' ? tags : [],
      };
    },
  );
  return {
    formatVersion: '1.0',
    assignmentId: assignment.assignmentId,
    subject: assignment.subject,
    rubricVersion: catalog.rubricVersion,
    classifiedAt,
    items,
  };
}
