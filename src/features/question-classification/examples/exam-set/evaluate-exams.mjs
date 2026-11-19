// 공유 평가 데이터(문제지 PDF + 문항목록.csv + 정답지.csv) 실행·채점기.
// 문제지의 각 쪽을 사진 한 장처럼 이미지로 만들어 숙제 등록 1단계와 같은 경로
// (판독 → 문항 ID → 쪽수 결정 → 분류 1회)로 분석하고, 정답지의 대분류로 채점한다.
// 평가 데이터는 저장소 밖에 두며 PDF·이미지·결과를 저장소에 넣지 않는다.
//   node --env-file=.env.local evaluate-exams.mjs run <데이터폴더> <출력폴더> [--only 2026년_03월]
//   node evaluate-exams.mjs score <데이터폴더> <출력폴더> [--only …] [--json]
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import catalog from '../../rubrics/tags.json' with { type: 'json' };
import { classifyAssignment, readSheet } from '../../pipeline.mjs';
import { readSheetFromText, readSheetOcr } from '../../ocr-page.mjs';
import { itemsFromPhoto, pagesFromReadings } from '../../read-page.mjs';

const require = createRequire(import.meta.url);
const pdfjs = await import(
  pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
);

// 따옴표 안 쉼표를 허용하는 작은 CSV 해석기.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.map((r) =>
    Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])),
  );
}
const csv = async (file) =>
  parseCsv((await readFile(file, 'utf8')).replace(/^﻿/, ''));

const areaOf = new Map(catalog.tags.map((t) => [t.tagId, t.area]));
const normArea = (s) => s.replace(/\s+/g, '');
const numberKey = (s) => {
  const digits = String(s).match(/\d+/g);
  return digits?.length === 1 ? String(Number(digits[0])) : String(s).trim();
};

async function load(dataDir, only) {
  const list = await csv(path.join(dataDir, '문항목록.csv'));
  const gold = new Map(
    (await csv(path.join(dataDir, '정답지.csv'))).map((r) => [r['문항 ID'], r]),
  );
  const pages = new Map();
  for (const r of list) {
    const file = r['문제지 파일명'];
    if (only && !only.some((o) => file.startsWith(o))) continue;
    const key = file + '#' + r['쪽'];
    if (!pages.has(key))
      pages.set(key, {
        key,
        file,
        page: Number(r['쪽']),
        subject: file.includes('영어') ? 'E' : 'M',
        items: [],
      });
    pages.get(key).items.push({
      id: r['문항 ID'],
      number: r['문항 번호'],
      sharedPage: r['공통 지문·발문 쪽'] || null,
      area: gold.get(r['문항 ID'])?.['채점할 대분류'] ?? '',
      basis: gold.get(r['문항 ID'])?.['대분류 근거 구분'] ?? '',
    });
  }
  return [...pages.values()];
}

const docs = new Map();
async function renderPage(dataDir, file, pageNo) {
  if (!docs.has(file))
    docs.set(
      file,
      await pdfjs.getDocument({
        data: new Uint8Array(await readFile(path.join(dataDir, file))),
      }).promise,
    );
  const doc = docs.get(file);
  const page = await doc.getPage(pageNo);
  // 긴 변 약 2000px: 휴대폰으로 한 쪽을 찍은 사진과 비슷한 해상도.
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({
    scale: 2000 / Math.max(base.width, base.height),
  });
  const { canvas, context } = doc.canvasFactory.create(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  if (!flags.includes('--split')) return [canvas.toBuffer('image/jpeg', 85)];
  // 실험(--split): 두 단 시험지를 왼쪽·오른쪽 절반으로 잘라 따로 판독한다(판독 호출 2배).
  // 가운데를 조금 겹쳐 단 경계의 글자가 잘리지 않게 한다.
  const half = Math.ceil(canvas.width * 0.53);
  return [0, canvas.width - half].map((x) => {
    const part = doc.canvasFactory.create(half, canvas.height);
    part.context.drawImage(
      canvas,
      x,
      0,
      half,
      canvas.height,
      0,
      0,
      half,
      canvas.height,
    );
    return part.canvas.toBuffer('image/jpeg', 85);
  });
}

const safe = (key) => key.replace(/[^\w가-힣.-]+/g, '_');

async function runPage(dataDir, out, page) {
  const started = Date.now();
  const record = { key: page.key };
  try {
    const images = await renderPage(dataDir, page.file, page.page);
    let detected = [];
    const readingPasses = [];
    const reads = [];
    for (const bytes of images) {
      // --ocr: HCX-005 판독 대신 CLOVA OCR로 글자를 읽고 번호로 문항을 나눈다.
      const source = { bytes, mime: 'image/jpeg' };
      // --paddle: images 모드로 저장한 쪽 이미지를 PaddleOCR이 읽은 마크다운(<출력폴더>/paddle/)을 쓴다.
      const part = flags.includes('--paddle')
        ? readSheetFromText(
            await readFile(
              path.join(out, 'paddle', safe(page.key) + '.md'),
              'utf8',
            ),
          )
        : flags.includes('--ocr')
          ? await readSheetOcr(source)
          : await readSheet(source, page.subject);
      // 절반을 겹쳐 자르면 같은 번호가 양쪽에서 읽힐 수 있다: 먼저 온 정상 판독을 쓴다.
      for (const item of part.detected) {
        const k = detected.findIndex(
          (d) => d.displayNumber === item.displayNumber,
        );
        if (k < 0) detected.push(item);
        else if (detected[k].holdReason && !item.holdReason) detected[k] = item;
      }
      part.readingPasses.forEach((pass, n) => {
        readingPasses[n] = [...(readingPasses[n] ?? []), ...pass];
      });
      reads.push(...part.reads);
    }
    record.reads = reads;
    record.readingPasses = readingPasses;
    const pageId =
      'exam-' +
      safe(page.key)
        .replace(/[^\w-]/g, '')
        .slice(-40);
    const items = itemsFromPhoto(pageId, 1, detected).map((i) => ({
      ...i,
      text: i.holdReason ? '' : i.text,
      printedPage: pagesFromReadings(
        readingPasses.map((pass) =>
          pass.filter((r) => r.displayNumber === i.displayNumber),
        ),
      ),
    }));
    record.items = items;
    if (items.length) {
      const {
        record: classified,
        usage,
        retries,
        runs,
      } = await classifyAssignment({
        assignmentId: pageId,
        subject: page.subject,
        items: items.map(({ itemId, displayNumber, text, figure }) => ({
          itemId,
          page: 1,
          displayNumber,
          text,
          ...(figure ? { figure } : {}),
        })),
      });
      record.classification = classified;
      record.runs = runs;
      record.classifyUsage = usage;
      record.retries = retries;
    }
  } catch (error) {
    record.error = error.message;
    if (error.raw) record.raw = error.raw;
  }
  record.seconds = (Date.now() - started) / 1000;
  await writeFile(
    path.join(out, 'pages', safe(page.key) + '.json'),
    JSON.stringify(record, null, 2) + '\n',
  );
  console.error(
    page.key,
    record.error ? '오류 ' + record.error.slice(0, 120) : '완료',
    record.seconds + '초',
  );
  return record;
}

function scorePage(page, rec) {
  const detected = rec?.items ?? [];
  const byKey = new Map();
  for (const d of detected) {
    const k = numberKey(d.displayNumber);
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }
  const classified = new Map(
    (rec?.classification?.items ?? []).map((i) => [i.itemId, i]),
  );
  return page.items.map((g) => {
    const found = byKey.get(numberKey(g.number))?.[0];
    const c = found && classified.get(found.itemId);
    const tags = (c?.tags ?? []).filter((t) => t.status === 'adopted');
    const areas = [...new Set(tags.map((t) => normArea(areaOf.get(t.tagId))))];
    const want = normArea(g.area);
    return {
      ...g,
      file: page.file,
      page: page.page,
      error: rec?.error,
      found: !!found,
      held: found ? !!found.holdReason || !found.text.trim() : null,
      holdReason: found?.holdReason,
      pageOk: found ? found.printedPage === page.page : null,
      itemStatus: c?.itemStatus ?? (found ? 'missing' : null),
      tags: tags.map((t) => t.tagId),
      areas,
      exact: !!want && areas.length === 1 && areas[0] === want,
      includes: !!want && areas.includes(want),
    };
  });
}

function summarize(rows, pages, records) {
  const pct = (n, d) =>
    d ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : '-';
  const out = {};
  for (const subject of ['M', 'E', 'all']) {
    const ps = pages.filter((p) => subject === 'all' || p.subject === subject);
    const keys = new Set(ps.map((p) => p.key));
    const rs = rows.filter((r) => keys.has(r.file + '#' + r.page));
    const graded = rs.filter((r) => r.area);
    const found = rs.filter((r) => r.found);
    const recs = ps.map((p) => records.get(p.key)).filter(Boolean);
    out[subject] = {
      쪽: ps.length,
      쪽오류: recs.filter((r) => r.error).length,
      문항: rs.length,
      번호재현율: pct(found.length, rs.length),
      쪽수정답: pct(found.filter((r) => r.pageOk).length, found.length),
      판독보류: pct(found.filter((r) => r.held).length, found.length),
      대분류정확: pct(graded.filter((r) => r.exact).length, graded.length),
      대분류포함: pct(graded.filter((r) => r.includes).length, graded.length),
      미분류: pct(graded.filter((r) => !r.areas.length).length, graded.length),
      오분류: pct(
        graded.filter((r) => r.areas.length && !r.includes).length,
        graded.length,
      ),
      답한비율: pct(graded.filter((r) => r.areas.length).length, graded.length),
      낸답중정답: pct(
        graded.filter((r) => r.exact).length,
        graded.filter((r) => r.areas.length).length,
      ),
      // 기준선: 판단 없이 모든 문항을 가장 흔한 정답 대분류로 답했을 때.
      최빈값기준선: (() => {
        const count = {};
        for (const r of graded)
          count[normArea(r.area)] = (count[normArea(r.area)] ?? 0) + 1;
        const [top, n] = Object.entries(count).sort(
          (a, b) => b[1] - a[1],
        )[0] ?? ['-', 0];
        return top + ' ' + pct(n, graded.length);
      })(),
      판독통과시정확: pct(
        graded.filter((r) => r.found && !r.held && r.exact).length,
        graded.filter((r) => r.found && !r.held).length,
      ),
      분류재시도: recs.reduce((n, r) => n + (r.retries ?? 0), 0),
      호출수: recs.reduce(
        (n, r) => n + (r.reads?.length ?? 0) + (r.classifyUsage?.length ?? 0),
        0,
      ),
      토큰: recs
        .flatMap((r) => [
          ...(r.reads ?? []).map((x) => x.usage),
          ...(r.classifyUsage ?? []),
        ])
        .filter(Boolean)
        .reduce((n, u) => n + (u.totalTokens ?? 0), 0),
    };
  }
  return out;
}

// 판독과 무관한 분류 성능을 재기 위한 대조군: PDF 글자 층에서 문항 원문을 잘라 바로 분류한다.
// 영어는 글자 층이 온전하지만 수학은 수식이 빠지므로 영어에만 쓴다.
const docTexts = new Map();
async function documentText(dataDir, file) {
  if (docTexts.has(file)) return docTexts.get(file);
  if (!docs.has(file))
    docs.set(
      file,
      await pdfjs.getDocument({
        data: new Uint8Array(await readFile(path.join(dataDir, file))),
      }).promise,
    );
  const doc = docs.get(file);
  let text = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    for (const item of content.items)
      text += item.str + (item.hasEOL ? '\n' : '');
    text += '\n';
  }
  docTexts.set(file, text);
  return text;
}
export function splitExamText(text) {
  const items = new Map();
  const shared = [];
  // 머리말 "[41～42] 다음 글을 읽고, 물음에 답하시오." 뒤 지문은 범위 안 문항에 붙인다.
  const marks = [
    ...text.matchAll(
      /(?:^|\n)\s*(?:\[(\d+)\s*[~～∼]\s*(\d+)\]|(\d{1,2})\.\s)/g,
    ),
  ];
  marks.forEach((m, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].index : text.length;
    const body = text.slice(m.index, end).trim();
    if (m[1]) shared.push({ from: +m[1], to: +m[2], text: body });
    else if (!items.has(+m[3]))
      items.set(+m[3], body.replace(/^\d{1,2}\.\s*/, ''));
  });
  return new Map(
    [...items].map(([n, body]) => {
      const passages = shared.filter((s) => s.from <= n && n <= s.to);
      return [n, [...passages.map((s) => s.text), body].join('\n')];
    }),
  );
}
async function runTextPage(dataDir, out, page) {
  const record = { key: page.key, mode: 'text' };
  try {
    const byNumber = splitExamText(await documentText(dataDir, page.file));
    const pageId =
      'text-' +
      safe(page.key)
        .replace(/[^\w-]/g, '')
        .slice(-40);
    record.items = page.items.map((g) => ({
      itemId: pageId + '-' + g.number,
      displayNumber: g.number,
      printedPage: page.page,
      text: (byNumber.get(Number(g.number)) ?? '').replace(/\s+\n/g, '\n'),
    }));
    const {
      record: classified,
      usage,
      retries,
      runs,
    } = await classifyAssignment({
      assignmentId: pageId,
      subject: page.subject,
      items: record.items.map(({ itemId, displayNumber, text }) => ({
        itemId,
        page: 1,
        displayNumber,
        text,
      })),
    });
    record.classification = classified;
    record.runs = runs;
    record.classifyUsage = usage;
    record.retries = retries;
  } catch (error) {
    record.error = error.message;
  }
  await writeFile(
    path.join(out, 'pages', safe(page.key) + '.json'),
    JSON.stringify(record, null, 2) + '\n',
  );
  console.error(
    page.key,
    record.error ? '오류 ' + record.error.slice(0, 120) : '완료',
  );
  return record;
}

// 이미 성공한 쪽은 건너뛰고, CLOVA 요청 한도(HTTP 429)에 걸린 쪽은 기다렸다가 다시 실행한다.
async function runAll(list, out, runner) {
  for (const page of list) {
    const file = path.join(out, 'pages', safe(page.key) + '.json');
    try {
      if (!JSON.parse(await readFile(file, 'utf8')).error) continue;
    } catch {
      // 아직 실행하지 않은 쪽
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      const record = await runner(page);
      if (!record.error?.includes('HTTP 429')) break;
      await new Promise((resolve) => setTimeout(resolve, 30000 * attempt));
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

const [mode, dataDir, out, ...flags] = process.argv.slice(2);
if (!['run', 'text', 'score', 'images'].includes(mode) || !dataDir || !out)
  throw Error(
    '사용법: evaluate-exams.mjs run|score <데이터폴더> <출력폴더> [--only 접두어,…] [--json]',
  );
const only = flags.includes('--only')
  ? flags[flags.indexOf('--only') + 1].split(',')
  : null;
const pages = await load(dataDir, only);
await mkdir(path.join(out, 'pages'), { recursive: true });
// images: 외부 판독기에 넘길 쪽 이미지를 <출력폴더>/images/에 저장한다(호출 없음).
if (mode === 'images') {
  await mkdir(path.join(out, 'images'), { recursive: true });
  for (const page of pages) {
    const [bytes] = await renderPage(dataDir, page.file, page.page);
    await writeFile(path.join(out, 'images', safe(page.key) + '.jpg'), bytes);
  }
}
if (mode === 'run')
  await runAll(pages, out, (page) => runPage(dataDir, out, page));
if (mode === 'text')
  await runAll(
    pages.filter((p) => p.subject === 'E'),
    out,
    (page) => runTextPage(dataDir, out, page),
  );
const files = new Set(await readdir(path.join(out, 'pages')));
const records = new Map();
for (const p of pages)
  if (files.has(safe(p.key) + '.json'))
    records.set(
      p.key,
      JSON.parse(
        await readFile(path.join(out, 'pages', safe(p.key) + '.json'), 'utf8'),
      ),
    );
const rows = pages
  .filter((p) => records.has(p.key))
  .flatMap((p) => scorePage(p, records.get(p.key)));
const summary = summarize(
  rows,
  pages.filter((p) => records.has(p.key)),
  records,
);
if (flags.includes('--json'))
  console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  console.table(summary);
  for (const r of rows.filter((r) => !r.exact))
    console.log(
      `${r.id} p${r.page} ${!r.found ? '번호누락' + (r.error ? '(쪽 오류)' : '') : r.held ? '판독보류(' + r.holdReason + ')' : ''}` +
        ` 예측 ${r.areas.join('+') || '없음'}[${r.tags.join(',')}] / 정답 ${r.area || '(채점 제외)'}` +
        (r.sharedPage ? ` 공통지문 ${r.sharedPage}쪽` : ''),
    );
}
