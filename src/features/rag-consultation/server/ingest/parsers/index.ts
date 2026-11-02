/**
 * 원본 파일 → 정규화 Markdown + 페이지 품질. 형식은 확장자가 아니라 파일 내용(매직 바이트)으로 판단한다.
 *   PDF(텍스트·스캔) · DOCX · HWPX · TXT(UTF-8/EUC-KR) · Markdown. 구형 HWP(바이너리)는 지원하지 않음.
 * 모든 결과는 개인정보 가림을 거친다.
 */
import { parseDocx, parseHwpx, ZipLimitError } from './office.ts';
import { createTesseractOcr } from './ocr.ts';
import { parsePdf } from './pdf.ts';
import { maskPersonalData } from './pii.ts';
import {
  DEFAULT_PARSE_LIMITS,
  type OcrEngine,
  type ParsedFile,
  type ParseLimits,
  type ParseWarning,
  type SourceFormat,
} from './types.ts';

export * from './types.ts';
export { createTesseractOcr } from './ocr.ts';
export { PII_MASK } from './pii.ts';

export interface ParseInput {
  bytes: Uint8Array;
  fileName: string;
  limits?: Partial<ParseLimits>;
  /** OCR 엔진. 지정하지 않으면 필요할 때 tesseract.js 를 띄운다. null 이면 OCR 끔. */
  ocr?: OcrEngine | null;
}

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

export function detectFormat(
  bytes: Uint8Array,
  fileName: string,
): SourceFormat | 'hwp_binary' | 'zip_unknown' | 'unknown' {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return 'hwp_binary'; // OLE 복합 문서(구형 HWP/DOC)
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const head = new TextDecoder('latin1').decode(
      bytes.subarray(0, Math.min(bytes.length, 4096)),
    );
    if (head.includes('word/')) return 'docx';
    if (
      head.includes('mimetypeapplication/hwp+zip') ||
      head.includes('Contents/') ||
      /\.hwpx$/i.test(fileName)
    )
      return 'hwpx';
    if (/\.docx$/i.test(fileName)) return 'docx';
    return 'zip_unknown';
  }
  if (/\.(md|markdown)$/i.test(fileName)) return 'markdown';
  if (
    /\.(txt|text|csv)$/i.test(fileName) ||
    !bytes.subarray(0, 4096).includes(0)
  )
    return 'txt';
  return 'unknown';
}

function decodeText(bytes: Uint8Array, warnings: ParseWarning[]): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!text.includes('�')) return text.replace(/^﻿/, '');
  try {
    const euc = new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
    warnings.push({ code: 'decoded_as_euc_kr' });
    return euc;
  } catch {
    return text;
  }
}

/** TXT: 빈 줄 문단, "1. 제목" 같은 짧은 번호 줄은 절 제목으로. */
function txtToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line.length <= 40 &&
      /^\s*([0-9]{1,2}|[ⅠⅡⅢⅣⅤ])[.)]\s*\S/.test(line) &&
      !/[.다]$/.test(line.trim())
        ? `## ${line.trim()}`
        : line,
    )
    .join('\n');
}

export async function parseSourceFile(input: ParseInput): Promise<ParsedFile> {
  const started = Date.now();
  const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS, ...input.limits };
  const warnings: ParseWarning[] = [];
  const base = {
    bytes: input.bytes.length,
    pageCount: 0,
    ocrPages: 0,
    tables: 0,
  };
  const fail = (
    format: SourceFormat,
    error: NonNullable<ParsedFile['error']>,
  ): ParsedFile => ({
    format,
    status: 'failed',
    error,
    text: '',
    pages: [],
    warnings,
    stats: { ...base, parseMs: Date.now() - started },
  });
  if (input.bytes.length === 0) return fail('txt', 'empty');
  if (input.bytes.length > limits.maxBytes) return fail('txt', 'too_large');

  const detected = detectFormat(input.bytes, input.fileName);
  if (detected === 'hwp_binary') return fail('hwpx', 'unsupported_hwp_binary');
  if (detected === 'unknown' || detected === 'zip_unknown')
    return fail('txt', 'unsupported_format');

  let result: ParsedFile;
  if (detected === 'pdf') {
    let created: OcrEngine | null = null;
    try {
      const pdf = await parsePdf(input.bytes, {
        limits,
        getOcr: async () => {
          if (input.ocr !== undefined) return input.ocr;
          created = await createTesseractOcr();
          return created;
        },
      });
      result = {
        format: 'pdf',
        status: pdf.status,
        error: pdf.error,
        text: pdf.text,
        pages: pdf.pages,
        warnings: [...warnings, ...pdf.warnings],
        stats: {
          ...base,
          pageCount: pdf.pageCount,
          ocrPages: pdf.ocrPages,
          tables: pdf.tables,
          parseMs: 0,
        },
      };
    } finally {
      if (created) await (created as OcrEngine).terminate();
    }
  } else if (detected === 'docx' || detected === 'hwpx') {
    try {
      const office =
        detected === 'docx'
          ? parseDocx(input.bytes, limits)
          : parseHwpx(input.bytes, limits);
      result = {
        format: detected,
        status: office.text ? 'ok' : 'failed',
        ...(office.text ? {} : { error: 'empty' as const }),
        text: office.text,
        pages: office.text ? [{ page: 1, method: 'text' }] : [],
        warnings,
        stats: { ...base, pageCount: 1, tables: office.tables, parseMs: 0 },
      };
    } catch (error) {
      return fail(
        detected,
        error instanceof ZipLimitError ? 'zip_limits_exceeded' : 'corrupt',
      );
    }
  } else {
    const text = decodeText(input.bytes, warnings);
    const markdown = detected === 'markdown' ? text : txtToMarkdown(text);
    result = {
      format: detected,
      status: markdown.trim() ? 'ok' : 'failed',
      ...(markdown.trim() ? {} : { error: 'empty' as const }),
      text: markdown,
      pages: [{ page: 1, method: 'text' }],
      warnings,
      stats: { ...base, pageCount: 1, parseMs: 0 },
    };
  }
  const masked = maskPersonalData(result.text);
  if (Object.keys(masked.masked).length > 0) {
    result.warnings.push({
      code: 'pii_masked',
      detail: JSON.stringify(masked.masked),
    });
  }
  return {
    ...result,
    text: masked.text,
    stats: { ...result.stats, parseMs: Date.now() - started },
  };
}
