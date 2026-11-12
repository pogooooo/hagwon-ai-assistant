// 기준서 예시 세트 채점기. 정답표(expected.json)는 여기서만 읽고 모델 입력에는 넣지 않는다.
//   node evaluate.mjs --check          입력 파일만 검사(외부 호출 없음)
//   node evaluate.mjs <출력폴더>       evidence/를 읽어 채점
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assignmentInputSchema } from '../../classify.mjs';

const here = (name) => new URL(name, import.meta.url);
const json = async (url) => JSON.parse(await readFile(url, 'utf8'));
const expected = await json(here('./expected.json'));
const rubrics = {
  M: await readFile(here('../../rubrics/math-behavior-rubric.md'), 'utf8'),
  E: await readFile(here('../../rubrics/english-behavior-rubric.md'), 'utf8'),
};
const hasHangul = (s) => /[가-힣]/.test(s);

const inputs = {};
const seen = new Set();
for (const [name, gold] of Object.entries(expected)) {
  const input = assignmentInputSchema.parse(await json(here(`./${name}.json`)));
  if (input.assignmentId !== name) throw Error('assignmentId 불일치: ' + name);
  const ids = input.items.map((i) => i.itemId);
  if (JSON.stringify(ids) !== JSON.stringify(Object.keys(gold)))
    throw Error('입력과 정답표의 문항 ID가 다릅니다: ' + name);
  for (const { itemId, text } of input.items) {
    if (seen.has(itemId)) throw Error('중복 문항 ID: ' + itemId);
    seen.add(itemId);
    if (input.subject === 'M') {
      // 수학 예시는 기준서의 문장을 그대로 쓴다.
      if (!rubrics.M.includes(text))
        throw Error('기준서에 없는 수학 문항: ' + itemId);
    } else {
      // 영어 예시는 기준서의 영어 문장에 발문을 붙였다. 영어 문장이 기준서에 있는지만 본다.
      const sentences = text.match(/[A-Z][A-Za-z ,'[\]/]*[a-z]+[.?]/g) ?? [];
      const missing = sentences.filter(
        (s) => !rubrics.E.includes(s.replace(/[.?]$/, '')),
      );
      if (!sentences.length || missing.length)
        throw Error(
          `기준서에 없는 영어 문장: ${itemId} ${JSON.stringify(missing)}`,
        );
    }
  }
  inputs[name] = input;
}
console.log(
  `입력 검사 통과: ${Object.keys(inputs).length}개 파일, ${seen.size}문항`,
);
if (process.argv[2] === '--check' || !process.argv[2]) process.exit(0);

const dir = process.argv[2];
const totals = {};
const rows = [];
for (const [name, gold] of Object.entries(expected)) {
  const { subject } = inputs[name];
  const t = (totals[subject] ??= {
    items: 0,
    exact: 0,
    wholeQuote: 0,
    promptQuote: 0,
    adoptedTags: 0,
    quoteFailed: 0,
    in: 0,
    out: 0,
    requests: 0,
    missing: [],
  });
  let evidence;
  try {
    evidence = await json(path.join(dir, 'evidence', name + '.json'));
  } catch {
    t.missing.push(name);
    t.items += Object.keys(gold).length;
    continue;
  }
  if (JSON.stringify(evidence.assignment) !== JSON.stringify(inputs[name]))
    throw Error('검증 기록의 입력이 예시 파일과 다릅니다: ' + name);
  for (const u of evidence.usage) {
    t.requests += 1;
    t.in += u?.promptTokens ?? 0;
    t.out += u?.completionTokens ?? 0;
  }
  evidence.assignment.items.forEach(({ itemId, text }, index) => {
    const result = evidence.runs[0][index];
    const adopted = result.tags.filter((tag) => tag.status === 'adopted');
    const got = adopted.map((tag) => tag.tagId).sort();
    const want = [...gold[itemId]].sort();
    const exact = JSON.stringify(got) === JSON.stringify(want);
    t.items += 1;
    if (exact) t.exact += 1;
    for (const tag of adopted) {
      t.adoptedTags += 1;
      if (tag.quote === text) t.wholeQuote += 1;
      if (subject === 'E' && hasHangul(tag.quote)) t.promptQuote += 1;
    }
    t.quoteFailed += result.tags.filter((tag) => !tag.quoteVerified).length;
    rows.push({
      itemId,
      want: want.join('+'),
      got: got.join('+') || '(없음)',
      exact,
      disposition: result.disposition,
      other: result.tags
        .filter((tag) => tag.status !== 'adopted')
        .map((tag) => `${tag.tagId}=${tag.status}`)
        .join(' '),
      quotes: result.tags.map((tag) =>
        tag.quote === text ? '(문항 전체)' : tag.quote,
      ),
    });
  });
}
console.log(JSON.stringify({ totals, rows }, null, 2));
