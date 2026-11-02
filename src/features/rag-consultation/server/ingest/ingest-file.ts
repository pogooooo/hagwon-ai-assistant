/**
 * 원본 파일(PDF·스캔 PDF·DOCX·HWPX·TXT·Markdown) → 색인용 SourceDocumentInput.
 * 7번 자료 관리 기능이 올린 파일과 메타데이터(승인·유효기간·공개 범위)를 받아 파싱만 한다(자료 관리 자체는 하지 않음).
 */
import type { SourceDocumentInput } from '../types.ts';
import {
  parseSourceFile,
  type OcrEngine,
  type ParsedFile,
  type ParseLimits,
} from './parsers/index.ts';

export type FileDocumentMeta = Omit<SourceDocumentInput, 'text' | 'extraction'>;

export interface PreparedFileDocument {
  parsed: ParsedFile;
  /** 파싱에 실패하면 없음(색인하지 않음) */
  document?: SourceDocumentInput;
  /** 검수 필요(OCR 신뢰도 낮음·부분 인식·개인정보 가림) */
  reviewRequired: boolean;
}

export async function prepareFileDocument(
  meta: FileDocumentMeta,
  file: { bytes: Uint8Array; fileName: string },
  options: { ocr?: OcrEngine | null; limits?: Partial<ParseLimits> } = {},
): Promise<PreparedFileDocument> {
  const parsed = await parseSourceFile({
    bytes: file.bytes,
    fileName: file.fileName,
    ocr: options.ocr,
    limits: options.limits,
  });
  if (parsed.status === 'failed') {
    return { parsed, reviewRequired: true };
  }
  const warnings = parsed.warnings.map((w) =>
    [w.code, w.page ? `p${w.page}` : null, w.detail].filter(Boolean).join(':'),
  );
  return {
    parsed,
    reviewRequired:
      parsed.status !== 'ok' ||
      parsed.warnings.some((w) => w.code === 'pii_masked'),
    document: {
      ...meta,
      text: parsed.text,
      extraction: {
        fileName: file.fileName,
        format: parsed.format,
        status: parsed.status,
        pages: parsed.pages,
        warnings,
      },
    },
  };
}
