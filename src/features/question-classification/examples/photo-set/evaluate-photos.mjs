// 교재 사진 평가 세트(manifest.json) 실행·채점기. 정답은 여기서만 읽고 모델 입력에는 넣지 않는다.
//   node --env-file=.env.local evaluate-photos.mjs run <출력폴더> [--control] [--only page-01,page-07]
//       사진마다 숙제 등록 1단계와 같은 경로(readSheet → itemsFromPhoto → 쪽수 결정 → 분류 1회)를 실행하고
//       원자료를 <출력폴더>/pages/에 저장한다. --control은 정답 원문을 같은 묶음으로 분류해
//       판독과 무관한 분류 상한을 함께 잰다.
//   node evaluate-photos.mjs score <출력폴더> [--json]
//       저장된 원자료만 읽어 채점한다(외부 호출 없음).
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAssignment, readSheet } from '../../pipeline.mjs';
import { itemsFromPhoto, pagesFromReadings } from '../../read-page.mjs';

const here = (name) => new URL(name, import.meta.url);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const manifest = await json(here('./manifest.json'));
const expected = Object.assign(
  {},
  ...Object.values(await json(here('../rubric-set/expected.json'))),
);

// 인쇄 번호 비교: 0009, 9., 9번은 모두 9로 본다. 숫자가 없으면 원문 그대로.
export const numberKey = (s) => {
  const digits = String(s).match(/\d+/g);
  return digits?.length === 1 ? String(Number(digits[0])) : String(s).trim();
};

// 표기 차이(공백, 유니코드 위첨자, 빼기·따옴표 모양, LaTeX 괄호)를 접고 글자 bigram으로 비교한다.
const norm = (s) =>
  s
    .normalize('NFKC')
    .replace(/\\left|\\right|\$|\^|\{|\}/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase();
const bigrams = (s) => {
  const t = norm(s);
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
};
const overlap = (a, b) => {
  let n = 0;
  for (const [g, c] of a) n += Math.min(c, b.get(g) ?? 0);
  return n;
};
const size = (m) => [...m.values()].reduce((x, y) => x + y, 0);
export const dice = (x, y) => {
  const a = bigrams(x);
  const b = bigrams(y);
  return size(a) + size(b) ? (2 * overlap(a, b)) / (size(a) + size(b)) : 1;
};
// y의 bigram 중 x에 들어 있는 비율(y가 x에 포함되었는가).
const containment = (x, y) => {
  const a = bigrams(x);
  const b = bigrams(y);
  return size(b) ? overlap(a, b) / size(b) : 1;
};
const koreanPrompt = (text) => {
  const i = text.search(/[가-힣]/);
  return i < 0 ? text : text.slice(text.lastIndexOf(' ', i) + 1);
};

async function pool(tasks, limit) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

async function runPage(page, out, control) {
  const filename = fileURLToPath(here('./' + page.image));
  const started = Date.now();
  const record = { image: page.image };
  try {
    const { detected, readingPasses, reads } = await readSheet(
      filename,
      page.subject,
    );
    record.reads = reads;
    record.readingPasses = readingPasses;
    record.detected = detected;
    const pageId = 'eval-' + page.image.replace(/\W+/g, '-');
    // 수동 쪽수 없이 등록하는 경우와 같다: 문항 ID용 쪽수는 1, 표시 쪽수는 판독에서 고른다.
    const items = itemsFromPhoto(pageId, 1, detected).map((i) => ({
      ...i,
      text: i.holdReason ? '' : i.text,
    }));
    // 숙제 등록 화면은 문항마다 그 번호를 읽은 판독의 쪽수로 표시 쪽수를 정한다.
    record.items = items.map((i) => ({
      ...i,
      printedPage: pagesFromReadings(
        readingPasses.map((pass) =>
          pass.filter((r) => r.displayNumber === i.displayNumber),
        ),
      ),
    }));
    record.printedPage = pagesFromReadings(readingPasses);
    if (items.length) {
      const { record: classified, usage } = await classifyAssignment({
        assignmentId: pageId,
        subject: page.subject,
        items: items.map(({ itemId, page, displayNumber, text, figure }) => ({
          itemId,
          page,
          displayNumber,
          text,
          ...(figure ? { figure } : {}),
        })),
      });
      record.classification = classified;
      record.classifyUsage = usage;
    }
  } catch (error) {
    record.error = error.message;
    if (error.raw) record.raw = error.raw;
  }
  if (control) {
    try {
      const { record: classified } = await classifyAssignment({
        assignmentId: 'control-' + page.image.replace(/\W+/g, '-'),
        subject: page.subject,
        items: page.items.map((g, n) => ({
          itemId: g.itemId,
          page: 1,
          displayNumber: String(n + 1),
          text: g.text,
        })),
      });
      record.control = classified;
    } catch (error) {
      record.controlError = error.message;
    }
  }
  record.seconds = (Date.now() - started) / 1000;
  await writeFile(
    path.join(out, 'pages', page.image + '.json'),
    JSON.stringify(record, null, 2) + '\n',
  );
  console.error(
    page.image,
    record.error ? 'ERROR ' + record.error : 'ok',
    record.seconds + 's',
  );
}

const adopted = (item) =>
  (item?.tags ?? [])
    .filter((t) => t.status === 'adopted')
    .map((t) => t.tagId)
    .sort()
    .join('+');

function scorePage(page, rec) {
  const want = new Map(page.items.map((g) => [numberKey(g.printedNumber), g]));
  const rows = [];
  const detected = rec.items ?? [];
  const byKey = new Map();
  for (const d of detected) {
    const k = numberKey(d.displayNumber);
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }
  const extras = [...byKey.keys()].filter((k) => !want.has(k));
  const classified = new Map(
    (rec.classification?.items ?? []).map((i) => [i.itemId, i]),
  );
  const control = new Map((rec.control?.items ?? []).map((i) => [i.itemId, i]));
  for (const [k, g] of want) {
    const found = byKey.get(k)?.[0];
    const gold = [...expected[g.itemId]].sort().join('+');
    const row = {
      image: page.image,
      itemId: g.itemId,
      number: g.printedNumber,
      found: !!found,
      numberExact: found ? found.displayNumber === g.printedNumber : false,
      pageOk: found ? found.printedPage === page.printedPage : false,
      gold,
    };
    if (found) {
      row.held = !!found.holdReason || !found.text.trim();
      row.holdReason = found.holdReason;
      if (!row.held) {
        row.similarity = +dice(found.text, g.text).toFixed(3);
        const others = page.items.filter((o) => o.itemId !== g.itemId);
        // 다른 문항의 고유한 발문이 이 전사에 들어 있으면 경계가 합쳐진 것이다.
        row.mergedWith = others
          .filter(
            (o) =>
              koreanPrompt(o.text) !== koreanPrompt(g.text) &&
              containment(found.text, koreanPrompt(o.text)) > 0.8 &&
              containment(g.text, koreanPrompt(o.text)) < 0.8,
          )
          .map((o) => o.printedNumber);
        // 자기 발문이 빠졌거나(잘림), 영어 공유 지문이 빠진 경우.
        row.promptCoverage = +containment(
          found.text,
          koreanPrompt(g.text),
        ).toFixed(3);
        if (page.subject === 'E') {
          const passage = g.text.slice(
            0,
            g.text.length - koreanPrompt(g.text).length,
          );
          row.passageCoverage = passage.trim()
            ? +containment(found.text, passage).toFixed(3)
            : null;
        }
      }
      const c = classified.get(found.itemId);
      row.itemStatus = c?.itemStatus ?? 'missing';
      row.got = adopted(c);
    } else row.got = '';
    row.typeExact = row.got === gold;
    if (control.size)
      row.controlExact = adopted(control.get(g.itemId)) === gold;
    rows.push(row);
  }
  return {
    image: page.image,
    subject: page.subject,
    goldPage: page.printedPage,
    gotPage: rec.printedPage ?? null,
    error: rec.error,
    extras: extras.map((k) => byKey.get(k).map((d) => d.displayNumber)).flat(),
    duplicates: detected
      .filter(
        (d) => d.holdReason === '같은 문항 번호가 사진에서 여러 번 감지됨',
      )
      .map((d) => d.displayNumber),
    rows,
    calls: (rec.reads?.length ?? 0) + (rec.classifyUsage?.length ?? 0),
    tokens: [
      ...(rec.reads ?? []).map((r) => r.usage),
      ...(rec.classifyUsage ?? []),
    ]
      .filter(Boolean)
      .reduce((n, u) => n + (u.totalTokens ?? 0), 0),
  };
}

function summarize(pages) {
  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-');
  const out = {};
  for (const subject of ['M', 'E', 'all']) {
    const ps = pages.filter((p) => subject === 'all' || p.subject === subject);
    const rows = ps.flatMap((p) => p.rows);
    const found = rows.filter((r) => r.found);
    const passed = found.filter((r) => !r.held);
    const clean = passed.filter(
      (r) => r.similarity >= 0.9 && !r.mergedWith.length,
    );
    const merged = passed.filter((r) => r.mergedWith.length);
    const truncated = passed.filter((r) => r.promptCoverage < 0.8);
    const passageLost = passed.filter(
      (r) => r.passageCoverage != null && r.passageCoverage < 0.7,
    );
    const held = found.filter((r) => r.held);
    const typeOk = rows.filter((r) => r.typeExact);
    const typeWrong = rows.filter((r) => r.got && !r.typeExact);
    const typeNone = rows.filter((r) => !r.got);
    const typeOkOnPassed = passed.filter((r) => r.typeExact);
    out[subject] = {
      pages: ps.length,
      pageErrors: ps.filter((p) => p.error).length,
      쪽수정답: `${ps.filter((p) => p.gotPage === p.goldPage).length}/${ps.length}`,
      쪽수빈칸: ps.filter((p) => p.gotPage == null).length,
      쪽수오답: ps.filter((p) => p.gotPage != null && p.gotPage !== p.goldPage)
        .length,
      문항쪽수정답: pct(found.filter((r) => r.pageOk).length, found.length),
      문항: rows.length,
      번호재현율: pct(found.length, rows.length),
      번호누락: rows.length - found.length,
      번호표기일치: pct(
        found.filter((r) => r.numberExact).length,
        found.length,
      ),
      번호오탐: ps.reduce((n, p) => n + p.extras.length, 0),
      중복번호보류: ps.reduce((n, p) => n + p.duplicates.length, 0),
      판독보류: `${held.length} (${pct(held.length, found.length)})`,
      원문정상: `${clean.length}/${passed.length} (${pct(clean.length, passed.length)})`,
      평균유사도: passed.length
        ? (
            passed.reduce((n, r) => n + r.similarity, 0) / passed.length
          ).toFixed(3)
        : '-',
      경계합쳐짐: merged.length,
      발문잘림: truncated.length,
      공유지문누락: passageLost.length,
      유형정확_전체: `${typeOk.length}/${rows.length} (${pct(typeOk.length, rows.length)})`,
      유형정확_판독통과: `${typeOkOnPassed.length}/${passed.length} (${pct(typeOkOnPassed.length, passed.length)})`,
      유형오답: typeWrong.length,
      유형없음: typeNone.length,
      ...(rows.some((r) => 'controlExact' in r)
        ? {
            유형정확_정답원문대조: `${rows.filter((r) => r.controlExact).length}/${rows.length}`,
          }
        : {}),
      호출수: ps.reduce((n, p) => n + p.calls, 0),
      토큰: ps.reduce((n, p) => n + p.tokens, 0),
    };
  }
  return out;
}

const [mode, dir, ...flags] = process.argv.slice(2);
if (!['run', 'score'].includes(mode) || !dir)
  throw Error(
    '사용법: evaluate-photos.mjs run|score <출력폴더> [--control] [--only a,b] [--json]',
  );
const only = flags.includes('--only')
  ? flags[flags.indexOf('--only') + 1].split(',')
  : null;
const selected = manifest.filter(
  (p) => !only || only.some((o) => p.image.startsWith(o)),
);
if (mode === 'run') {
  await mkdir(path.join(dir, 'pages'), { recursive: true });
  await pool(
    selected.map((p) => () => runPage(p, dir, flags.includes('--control'))),
    1, // CLOVA 요청 한도(429)를 넘지 않도록 한 장씩 실행한다.
  );
}
const files = new Set(await readdir(path.join(dir, 'pages')));
const scored = [];
for (const p of selected)
  if (files.has(p.image + '.json'))
    scored.push(
      scorePage(p, await json(path.join(dir, 'pages', p.image + '.json'))),
    );
const summary = summarize(scored);
if (flags.includes('--json'))
  console.log(JSON.stringify({ summary, pages: scored }, null, 2));
else {
  console.table(summary);
  for (const p of scored) {
    const bad = p.rows.filter(
      (r) =>
        !r.found ||
        r.held ||
        !r.typeExact ||
        r.similarity < 0.9 ||
        r.mergedWith?.length,
    );
    console.log(
      `\n${p.image} 쪽수 ${p.gotPage ?? '∅'}/${p.goldPage}` +
        (p.error ? ' 오류: ' + p.error : '') +
        (p.extras.length ? ' 오탐: ' + p.extras.join(',') : ''),
    );
    for (const r of bad)
      console.log(
        `  ${r.number}: ${!r.found ? '누락' : r.held ? '보류(' + r.holdReason + ')' : 'sim ' + r.similarity}` +
          (r.mergedWith?.length ? ' 합쳐짐:' + r.mergedWith : '') +
          (r.passageCoverage != null && r.passageCoverage < 0.7
            ? ' 지문누락'
            : '') +
          ` 유형 ${r.got || '∅'} / 정답 ${r.gold}` +
          ('controlExact' in r
            ? r.controlExact
              ? ' (원문대조 맞음)'
              : ' (원문대조도 틀림)'
            : ''),
      );
  }
}
