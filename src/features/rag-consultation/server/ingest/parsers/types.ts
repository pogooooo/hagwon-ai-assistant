/**
 * 문서 파서 공통 타입. 모든 형식(PDF·스캔 PDF·DOCX·HWPX·TXT·Markdown)은 같은 "정규화 Markdown + 페이지 품질" 으로 바뀐다.
 * 정규화 Markdown 규칙(청크 생성기가 읽는 형식):
 *   - `<!-- page N -->` 페이지 시작(표 안에도 올 수 있음: 여러 페이지에 걸친 표)
 *   - `# 제목`, `## 절`, 문단(빈 줄 구분), `| 칸 | 칸 |` 표(첫 행 = 헤더, 다음 줄 구분선)
 */
export type SourceFormat = 'pdf' | 'docx' | 'hwpx' | 'txt' | 'markdown';

export type ExtractionMethod = 'text' | 'ocr' | 'empty';

export interface PageExtraction {
  page: number;
  method: ExtractionMethod;
  /** OCR 평균 단어 신뢰도(0~100). 텍스트 레이어 페이지는 없음 */
  confidence?: number;
  /** OCR 에서 적용한 회전(시계 방향, 도) */
  rotation?: number;
  /** 신뢰도가 낮은 숫자 토큰(금액·날짜·시간 등) — 이 값을 근거로 수치를 답하지 않는다 */
  uncertainTokens?: string[];
  /** 사람이 검수해야 하는 페이지 */
  needsReview?: boolean;
}

export type ExtractionStatus = 'ok' | 'needs_review' | 'partial' | 'failed';

export interface ParseWarning {
  code:
    | 'ocr_used'
    | 'ocr_low_confidence'
    | 'ocr_unavailable'
    | 'ocr_page_limit'
    | 'page_empty'
    | 'garbled_text'
    | 'pii_masked'
    | 'table_merged_across_pages'
    | 'two_column_layout'
    | 'rotated_page'
    | 'decoded_as_euc_kr'
    | 'truncated';
  page?: number;
  detail?: string;
}

export interface ParsedFile {
  format: SourceFormat;
  status: ExtractionStatus;
  /** 정규화 Markdown(실패 시 빈 문자열) */
  text: string;
  pages: PageExtraction[];
  warnings: ParseWarning[];
  /** 실패 사유(status = failed) */
  error?:
    | 'too_large'
    | 'too_many_pages'
    | 'encrypted'
    | 'unsupported_format'
    | 'unsupported_hwp_binary'
    | 'corrupt'
    | 'zip_limits_exceeded'
    | 'empty';
  stats: {
    bytes: number;
    pageCount: number;
    ocrPages: number;
    tables: number;
    parseMs: number;
  };
}

export interface ParseLimits {
  /** 파일 최대 크기(바이트). 기본 20MB */
  maxBytes: number;
  /** PDF 최대 페이지 수. 기본 100 */
  maxPages: number;
  /** OCR 최대 페이지 수(넘는 페이지는 검수 필요). 기본 30 */
  maxOcrPages: number;
  /** ZIP(DOCX/HWPX) 압축 해제 후 최대 크기·항목 수(압축 폭탄 방어) */
  maxUnzippedBytes: number;
  maxZipEntries: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 100,
  maxOcrPages: 30,
  maxUnzippedBytes: 80 * 1024 * 1024,
  maxZipEntries: 3000,
};

/** 위치가 있는 텍스트 조각(PDF 텍스트 레이어 항목 또는 OCR 단어). 좌표는 위→아래로 증가. */
export interface PositionedText {
  text: string;
  x0: number;
  x1: number;
  /** 글자 윗변 */
  top: number;
  /** 글자 높이(≈ 글꼴 크기) */
  size: number;
  /** 줄바꿈 직전 항목(PDF 텍스트 레이어의 hasEOL) */
  eol?: boolean;
  /** 이 항목 앞에 공백이 있었음(PDF 의 공백 항목) */
  spaceBefore?: boolean;
  confidence?: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrEngine {
  readonly id: string;
  /** PNG 이미지를 인식해 단어와 평균 신뢰도를 돌려준다. */
  recognize(png: Uint8Array): Promise<{ words: OcrWord[]; confidence: number }>;
  terminate(): Promise<void>;
}
