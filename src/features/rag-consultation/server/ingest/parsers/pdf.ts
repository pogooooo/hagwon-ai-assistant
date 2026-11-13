/**
 * PDF 파서(pdf.js). 텍스트 레이어가 있는 페이지는 글자 위치로, 없는 페이지(스캔)는 렌더링 → OCR 로 같은 레이아웃 분석을 한다.
 * - 보안: 스크립트 실행·글꼴 eval 끔(isEvalSupported=false), 암호 PDF 는 실패 처리, 페이지 수·OCR 페이지 수 제한, 페이지별 메모리 정리.
 * - 출처: 페이지 번호를 정규화 Markdown 의 `<!-- page N -->` 로 남긴다.
 */
import {
  analyzePage,
  mergeAcrossPages,
  toMarkdown,
  type LayoutBlock,
} from './layout.ts';
import { denoiseRgba, isNoiseWord } from './ocr.ts';
import type {
  OcrEngine,
  PageExtraction,
  ParsedFile,
  ParseLimits,
  ParseWarning,
  PositionedText,
} from './types.ts';

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** 한글 CID 글꼴(Adobe-Korea1)·표준 글꼴 해석용 데이터 경로(패키지에 포함). */
function pdfjsDataPaths() {
  const root = dirname(
    createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),
  );
  return {
    cMapUrl: join(root, 'cmaps') + '/',
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
  };
}

type PdfRuntime = {
  library: PdfJs;
  options: NonNullable<Parameters<PdfJs['getDocument']>[0]> & object;
};
let pdfRuntime: Promise<PdfRuntime> | undefined;
let loadPdfRuntime = async (): Promise<PdfRuntime> => ({
  library: await import('pdfjs-dist/legacy/build/pdf.mjs'),
  options: pdfjsDataPaths(),
});

export function configurePdfRuntime(load: () => Promise<PdfRuntime>) {
  loadPdfRuntime = load;
  pdfRuntime = undefined;
}

const MIN_TEXT_CHARS = 20;
const OCR_TARGET_WIDTH = 1500;
const OCR_MAX_DIMENSION = 2400;
const OCR_ACCEPT_CONFIDENCE = 70;
const UNCERTAIN_NUMBER_CONFIDENCE = 75;
const REVIEW_CONFIDENCE = 65;

function isGarbled(text: string): boolean {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) return false;
  const bad = chars.filter((c) => /[�-]/.test(c)).length;
  return bad / chars.length > 0.3;
}

interface PageData {
  page: number;
  width: number;
  items: PositionedText[];
  extraction: PageExtraction;
}

type Canvas = import('@napi-rs/canvas').Canvas;

async function renderPage(
  page: import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy,
  scale: number,
): Promise<Canvas> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return canvas;
}

async function rotated(
  source: Canvas,
  degrees: number,
  scale = 1,
): Promise<Uint8Array> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const swap = degrees === 90 || degrees === 270;
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const canvas = createCanvas(swap ? h : w, swap ? w : h);
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(source, -w / 2, -h / 2, w, h);
  return canvas.toBuffer('image/png');
}

async function renderForOcr(
  page: import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy,
  scale: number,
): Promise<Canvas> {
  const canvas = await renderPage(page, scale);
  const context = canvas.getContext('2d');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  denoiseRgba(image.data, canvas.width, canvas.height);
  context.putImageData(image, 0, 0);
  return canvas;
}

async function ocrPage(
  page: import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy,
  pageNumber: number,
  engine: OcrEngine,
): Promise<PageData> {
  const base = page.getViewport({ scale: 1 });
  const maxScale = Math.min(
    3,
    OCR_MAX_DIMENSION / Math.max(base.width, base.height),
  );
  const initialScale = Math.min(maxScale, OCR_TARGET_WIDTH / base.width);
  let canvas = await renderForOcr(page, initialScale);

  let rotation = 0;
  let result = await engine.recognize(canvas.toBuffer('image/png'));
  if (result.confidence < OCR_ACCEPT_CONFIDENCE) {
    // 뒤집히거나 돌아간 스캔: 저해상도로 다른 방향을 시험해 신뢰도가 가장 높은 방향을 고른다.
    let best = { degrees: 0, confidence: result.confidence };
    for (const degrees of [180, 90, 270]) {
      const trial = await engine.recognize(await rotated(canvas, degrees, 0.6));
      if (trial.confidence > best.confidence)
        best = { degrees, confidence: trial.confidence };
    }
    if (best.degrees !== 0 && best.confidence > result.confidence + 5) {
      rotation = best.degrees;
      if (rotation === 90 || rotation === 270) {
        // Match the target width after the page is turned upright.
        const uprightScale = Math.min(maxScale, OCR_TARGET_WIDTH / base.height);
        if (uprightScale > initialScale * 1.1)
          canvas = await renderForOcr(page, uprightScale);
      }
      result = await engine.recognize(await rotated(canvas, rotation));
    }
  }
  const words = result.words.filter((word) => !isNoiseWord(word));
  const numeric = words.filter((word) => /\d/.test(word.text));
  const uncertain = numeric.filter(
    (word) => word.confidence < UNCERTAIN_NUMBER_CONFIDENCE,
  );
  const confidence = Math.round(result.confidence);
  const width =
    rotation === 90 || rotation === 270 ? canvas.height : canvas.width;
  return {
    page: pageNumber,
    width,
    items: words.map((word) => ({
      text: word.text,
      x0: word.x0,
      x1: word.x1,
      top: word.y0,
      size: Math.max(1, word.y1 - word.y0),
      startsSegment: word.startsSegment,
      confidence: word.confidence,
    })),
    extraction: {
      page: pageNumber,
      method: 'ocr',
      confidence,
      rotation,
      uncertainTokens: [...new Set(uncertain.map((word) => word.text))],
      needsReview:
        confidence < REVIEW_CONFIDENCE ||
        (numeric.length > 0 && uncertain.length / numeric.length > 0.34),
    },
  };
}

export async function parsePdf(
  bytes: Uint8Array,
  options: { limits: ParseLimits; getOcr: () => Promise<OcrEngine | null> },
): Promise<
  Omit<ParsedFile, 'format' | 'stats'> & {
    pageCount: number;
    ocrPages: number;
    tables: number;
  }
> {
  const { library: pdfjs, options: pdfOptions } = await (pdfRuntime ??=
    loadPdfRuntime());
  const warnings: ParseWarning[] = [];
  let document: import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...pdfOptions,
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
    maxImageSize: 64 * 1024 * 1024,
  });
  try {
    document = await loadingTask.promise;
  } catch (error) {
    const name = (error as { name?: string }).name;
    return {
      status: 'failed',
      error: name === 'PasswordException' ? 'encrypted' : 'corrupt',
      text: '',
      pages: [],
      warnings,
      pageCount: 0,
      ocrPages: 0,
      tables: 0,
    };
  }
  try {
    if (document.numPages > options.limits.maxPages) {
      return {
        status: 'failed',
        error: 'too_many_pages',
        text: '',
        pages: [],
        warnings,
        pageCount: document.numPages,
        ocrPages: 0,
        tables: 0,
      };
    }
    const pages: PageData[] = [];
    let ocrPages = 0;
    let engine: OcrEngine | null | undefined;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        if (page.rotate)
          warnings.push({
            code: 'rotated_page',
            page: pageNumber,
            detail: `${page.rotate}`,
          });
        const content = await page.getTextContent();
        const items: PositionedText[] = [];
        let spaceBefore = false;
        let raw = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          raw += item.str;
          if (item.str.trim() === '') {
            spaceBefore = item.str.length > 0;
            continue;
          }
          const t = pdfjs.Util.transform(viewport.transform, item.transform);
          const size = Math.hypot(t[2], t[3]) || 1;
          items.push({
            text: item.str,
            x0: t[4],
            x1: t[4] + item.width,
            top: t[5] - size * 0.88,
            size,
            eol: item.hasEOL,
            spaceBefore,
          });
          spaceBefore = /\s$/.test(item.str);
        }
        const textChars = raw.replace(/\s/g, '').length;
        const garbled = isGarbled(raw);
        if (garbled) warnings.push({ code: 'garbled_text', page: pageNumber });
        if (textChars >= MIN_TEXT_CHARS && !garbled) {
          pages.push({
            page: pageNumber,
            width: viewport.width,
            items,
            extraction: { page: pageNumber, method: 'text' },
          });
          continue;
        }
        if (ocrPages >= options.limits.maxOcrPages) {
          warnings.push({ code: 'ocr_page_limit', page: pageNumber });
          pages.push({
            page: pageNumber,
            width: viewport.width,
            items: [],
            extraction: {
              page: pageNumber,
              method: 'empty',
              needsReview: true,
            },
          });
          continue;
        }
        engine ??= await options.getOcr();
        if (!engine) {
          warnings.push({ code: 'ocr_unavailable', page: pageNumber });
          pages.push({
            page: pageNumber,
            width: viewport.width,
            items: [],
            extraction: {
              page: pageNumber,
              method: 'empty',
              needsReview: true,
            },
          });
          continue;
        }
        ocrPages += 1;
        const data = await ocrPage(page, pageNumber, engine);
        warnings.push({
          code: 'ocr_used',
          page: pageNumber,
          detail: `confidence ${data.extraction.confidence}, rotation ${data.extraction.rotation}`,
        });
        if (data.extraction.needsReview)
          warnings.push({ code: 'ocr_low_confidence', page: pageNumber });
        pages.push(data);
      } finally {
        page.cleanup();
      }
    }

    // 문서 전체 본문 글자 크기(텍스트 레이어 페이지 기준)로 제목을 판단한다.
    const textSizes = pages
      .filter((p) => p.extraction.method === 'text')
      .flatMap((p) => p.items.map((item) => item.size));
    const bodySize = textSizes.length
      ? [...textSizes].sort((a, b) => a - b)[Math.floor(textSizes.length / 2)]
      : undefined;
    let blocks: LayoutBlock[] = [];
    for (const data of pages) {
      if (data.items.length === 0) {
        if (data.extraction.method !== 'empty')
          warnings.push({ code: 'page_empty', page: data.page });
        continue;
      }
      const result = analyzePage(data.items, {
        page: data.page,
        pageWidth: data.width,
        ocr: data.extraction.method === 'ocr',
        bodySize: data.extraction.method === 'text' ? bodySize : undefined,
      });
      if (result.columns === 2)
        warnings.push({ code: 'two_column_layout', page: data.page });
      if (result.columns > 2)
        warnings.push({
          code: 'multi_column_layout',
          page: data.page,
          detail: String(result.columns),
        });
      blocks.push(...result.blocks);
    }
    const merged = mergeAcrossPages(blocks);
    blocks = merged.blocks;
    if (merged.merged > 0)
      warnings.push({
        code: 'table_merged_across_pages',
        detail: `${merged.merged}`,
      });
    const text = blocks.length ? toMarkdown(blocks) : '';
    const extraction = pages.map((p) => p.extraction);
    const needsReview = extraction.some((p) => p.needsReview);
    return {
      status: !text ? 'failed' : needsReview ? 'needs_review' : 'ok',
      ...(text ? {} : { error: 'empty' as const }),
      text,
      pages: extraction,
      warnings,
      pageCount: document.numPages,
      ocrPages,
      tables: blocks.filter((b) => b.kind === 'table').length,
    };
  } finally {
    await loadingTask.destroy();
  }
}
