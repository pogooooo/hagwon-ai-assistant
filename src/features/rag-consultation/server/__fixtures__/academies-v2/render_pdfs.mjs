/**
 * 테스트 문서 렌더링(개발 전용 자료 생성 도구 — 서비스 코드가 아님).
 *   documents/<stem>.src.html + <stem>.meta.json → documents/<stem>.pdf
 *
 * - render.format = pdf_text : Chromium(Playwright) 인쇄로 텍스트가 들어 있는 PDF 생성(2단 편집·여러 페이지 표 포함)
 * - render.format = pdf_scan : 같은 방식으로 만든 PDF 를 poppler(pdftoppm)로 이미지화한 뒤 흐림·잡티·기울기·저해상도·회전을
 *                               적용하고(sharp) 이미지 전용 PDF(pdf-lib)로 다시 묶는다 — 텍스트 레이어가 없는 스캔본.
 * 필요: 환경에 설치된 Playwright Chromium, pdftoppm, devDependencies(pdf-lib, sharp, @fontsource/noto-sans-kr).
 *
 *   node src/features/rag-consultation/server/__fixtures__/academies-v2/render_pdfs.mjs <폴더...> [--force]
 * <폴더> 는 documents/ 를 가진 학원 폴더 또는 documents 폴더 자체.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { PDFDocument } = await import('pdf-lib');
const sharp = (await import('sharp')).default;

const fontCss = pathToFileURL(
  require.resolve('@fontsource/noto-sans-kr/400.css'),
).href;
const fontCssBold = pathToFileURL(
  require.resolve('@fontsource/noto-sans-kr/700.css'),
).href;

const args = process.argv.slice(2);
const force = args.includes('--force');
const folders = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a));

function page(meta, body) {
  const twoColumn = meta.render?.layout === 'two_column';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${meta.title.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="${fontCss}"><link rel="stylesheet" href="${fontCssBold}">
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: 'Noto Sans KR', sans-serif; font-size: 10.5pt; line-height: 1.55; color: #111; }
  h1 { font-size: 17pt; margin: 0 0 8pt; column-span: all; }
  h2 { font-size: 12.5pt; margin: 12pt 0 5pt; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; }
  th, td { border: 0.6pt solid #555; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  thead { display: table-header-group; } th { background: #eee; }
  tr { break-inside: avoid; }
  p { margin: 3pt 0; } ul, ol { margin: 3pt 0 3pt 14pt; padding: 0; }
  .cols { column-count: 2; column-gap: 9mm; column-rule: 0.4pt solid #bbb; }
  .cols h2 { break-after: avoid; } .cols p, .cols li { break-inside: avoid; }
</style></head><body>${twoColumn ? splitTitle(body) : body}</body></html>`;
}

/** 2단 편집: 첫 <h1> 은 전체 폭, 나머지는 2단. */
function splitTitle(body) {
  const match = body.match(/^\s*(<h1[\s\S]*?<\/h1>)/i);
  return match
    ? `${match[1]}<div class="cols">${body.slice(match[0].length)}</div>`
    : `<div class="cols">${body}</div>`;
}

const QUALITY = {
  good: { dpi: 150, skew: 0.3, blur: 0, noise: 0.004, jpeg: 82 },
  fair: { dpi: 120, skew: 0.8, blur: 0.4, noise: 0.012, jpeg: 62 },
  poor: { dpi: 90, skew: 1.4, blur: 0.8, noise: 0.03, jpeg: 38 },
};

async function degrade(png, quality, rotate) {
  const q = QUALITY[quality] ?? QUALITY.good;
  let image = sharp(png).grayscale().rotate(q.skew, { background: '#ffffff' });
  if (q.blur > 0) image = image.blur(q.blur);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  // 결정적 잡티(같은 입력 → 같은 출력)
  let seed = data.length % 9973;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < data.length; i += info.channels) {
    if (random() < q.noise) {
      const value = random() < 0.5 ? 40 : 230;
      for (let c = 0; c < info.channels; c += 1) data[i + c] = value;
    }
  }
  let out = sharp(data, { raw: info });
  if (rotate) out = out.rotate(rotate, { background: '#ffffff' });
  return out.jpeg({ quality: q.jpeg }).toBuffer();
}

async function scanPdf(textPdf, meta) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    const src = join(dir, 'src.pdf');
    writeFileSync(src, textPdf);
    const q = QUALITY[meta.render.scan_quality] ?? QUALITY.good;
    execFileSync('pdftoppm', ['-r', String(q.dpi), '-gray', '-png', src, join(dir, 'p')]);
    const pngs = readdirSync(dir).filter((f) => f.startsWith('p') && f.endsWith('.png')).sort();
    const pdf = await PDFDocument.create();
    pdf.setTitle(meta.title);
    pdf.setProducer('scanner');
    for (const name of pngs) {
      const jpg = await degrade(readFileSync(join(dir, name)), meta.render.scan_quality, meta.render.rotate || 0);
      const embedded = await pdf.embedJpg(jpg);
      const rotated = meta.render.rotate === 90 || meta.render.rotate === 270;
      const [w, h] = rotated ? [842, 595] : [595, 842];
      const pdfPage = pdf.addPage([w, h]);
      pdfPage.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    }
    return Buffer.from(await pdf.save());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const browser = await chromium.launch();
const context = await browser.newContext();
let rendered = 0;
for (const folder of folders) {
  const documents = existsSync(join(folder, 'documents')) ? join(folder, 'documents') : folder;
  for (const name of readdirSync(documents).filter((f) => f.endsWith('.meta.json')).sort()) {
    const stem = name.slice(0, -'.meta.json'.length);
    const meta = JSON.parse(readFileSync(join(documents, name), 'utf-8'));
    const format = meta.render?.format;
    if (format !== 'pdf_text' && format !== 'pdf_scan') continue;
    const htmlPath = join(documents, `${stem}.src.html`);
    const outPath = join(documents, `${stem}.pdf`);
    if (!force && existsSync(outPath) && statSync(outPath).mtimeMs > statSync(htmlPath).mtimeMs) continue;
    const browserPage = await context.newPage();
    await browserPage.setContent(page(meta, readFileSync(htmlPath, 'utf-8')), { waitUntil: 'networkidle' });
    await browserPage.evaluate(() => document.fonts.ready);
    const textPdf = await browserPage.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    await browserPage.close();
    const output = format === 'pdf_scan' ? await scanPdf(textPdf, meta) : textPdf;
    writeFileSync(outPath, output);
    rendered += 1;
    console.log(`${format.padEnd(8)} ${String(output.length).padStart(8)}B  ${outPath.replace(process.cwd() + '/', '')}`);
  }
}
await browser.close();
console.log(`rendered ${rendered}`);
