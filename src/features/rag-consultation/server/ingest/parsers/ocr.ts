/**
 * 스캔 PDF 용 OCR(무료 오픈소스, CPU): tesseract.js(WASM) + 한국어·영어 학습 데이터.
 * - 학습 데이터는 처음 한 번 내려받아 캐시(RAG_MODEL_CACHE_DIR/tesseract)에 둔다. 내려받을 수 없으면 OCR 을 끄고
 *   스캔 페이지를 "검수 필요"로 표시한다(임의로 내용을 복원하지 않음).
 * - 전처리: 회색조 + 3×3 중앙값 필터(점 잡티 제거). 회전: 신뢰도가 낮으면 180/90/270도 저해상도 시험 후 가장 높은 쪽을 고른다.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { OcrEngine, OcrWord } from './types.ts';

export function ocrCacheDir(): string {
  return join(
    process.env.RAG_MODEL_CACHE_DIR ??
      join(homedir(), '.cache', 'axr-rag-models'),
    'tesseract',
  );
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** tesseract.js 워커를 만든다. 패키지나 학습 데이터가 없으면 null. */
export async function createTesseractOcr(
  options: { langs?: string; cacheDir?: string; langPath?: string } = {},
): Promise<OcrEngine | null> {
  const langs = options.langs ?? 'kor+eng';
  const cachePath = options.cacheDir ?? ocrCacheDir();
  try {
    mkdirSync(cachePath, { recursive: true });
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(langs, 1, {
      cachePath,
      ...(options.langPath ? { langPath: options.langPath } : {}),
      logger: () => undefined,
      errorHandler: () => undefined,
    });
    return {
      id: `tesseract.js:${langs}`,
      async recognize(png: Uint8Array) {
        const { data } = await worker.recognize(
          Buffer.from(png),
          {},
          { blocks: true, text: false },
        );
        const words: OcrWord[] = (data.blocks ?? [])
          .flatMap((block) => block.paragraphs)
          .flatMap((paragraph) => paragraph.lines)
          .flatMap((line) => line.words as unknown as TesseractWord[])
          .map((word) => ({
            text: word.text,
            confidence: word.confidence,
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1,
          }));
        return { words, confidence: data.confidence };
      },
      async terminate() {
        await worker.terminate();
      },
    };
  } catch {
    return null;
  }
}

/** RGBA 픽셀 → 회색조 + 3×3 중앙값 필터(제자리 변환). */
export function denoiseRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  const window = new Uint8Array(9);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          window[n] = gray[yy * width + xx];
          n += 1;
        }
      }
      window.sort();
      // (이진화는 시험 결과 신뢰도가 오히려 떨어져 쓰지 않는다: 양호 스캔 86→82, 90도 스캔 89→68)
      const value = window[4];
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
}

/** 표 테두리·잡티가 글자로 인식된 조각(신뢰도 낮은 기호 하나짜리 등)은 버린다. */
export function isNoiseWord(word: OcrWord): boolean {
  const text = word.text.trim();
  if (!text) return true;
  if (/^[|｜\[\]{}()<>“”"'`~^_=+\\/:;.,·ㆍ-]+$/.test(text))
    return word.confidence < 85;
  return word.confidence < 25 && text.length <= 2;
}
