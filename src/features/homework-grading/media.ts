import {
  imageDimensions,
  imageMime,
} from '../rag-consultation/server/ingest/parsers/image.ts';
import { renderGradingPdf } from '../rag-consultation/server/ingest/parsers/pdf.ts';
import { GradingError, type Reading } from './contracts.ts';

export interface ImagePage {
  bytes: Uint8Array;
  mime: string;
  page_no: number;
}
export async function decodeUploads(
  files: { bytes: Uint8Array; mime: string }[],
  maxBytes = 20 * 1024 * 1024,
): Promise<ImagePage[]> {
  if (
    !files.length ||
    files.length > 10 ||
    files.reduce((n, f) => n + f.bytes.length, 0) > maxBytes
  )
    throw new GradingError('UPLOAD_LIMIT', 413);
  const result: ImagePage[] = [];
  try {
    for (const file of files) {
      if (new TextDecoder().decode(file.bytes.subarray(0, 5)) === '%PDF-') {
        if (file.mime !== 'application/pdf')
          throw new GradingError('MEDIA_MISMATCH');
        for (const bytes of await renderGradingPdf(
          file.bytes,
          10 - result.length,
        ))
          result.push({ bytes, mime: 'image/png', page_no: result.length + 1 });
      } else {
        const size = imageDimensions(file.bytes),
          mime = imageMime(file.bytes);
        if (
          !size ||
          !mime ||
          mime !== file.mime ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(mime)
        )
          throw new GradingError('UNSUPPORTED_MEDIA', 415);
        if (
          size.width < 32 ||
          size.height < 32 ||
          size.width * size.height > 20000000 ||
          Math.max(size.width / size.height, size.height / size.width) > 5
        )
          throw new GradingError('INPUT_UNREADABLE');
        const { loadImage, createCanvas } = await import('@napi-rs/canvas');
        const decoded = await loadImage(Buffer.from(file.bytes));
        const scale = Math.min(
          1,
          2200 / Math.max(decoded.width, decoded.height),
        );
        const canvas = createCanvas(
          Math.round(decoded.width * scale),
          Math.round(decoded.height * scale),
        );
        canvas
          .getContext('2d')
          .drawImage(decoded, 0, 0, canvas.width, canvas.height);
        result.push({
          bytes: new Uint8Array(canvas.toBuffer('image/png')),
          mime: 'image/png',
          page_no: result.length + 1,
        });
        canvas.width = 1;
        canvas.height = 1;
      }
      if (result.length > 10) throw new GradingError('PAGE_LIMIT');
    }
  } catch (error) {
    for (const page of result) page.bytes.fill(0);
    if (error instanceof GradingError) throw error;
    throw new GradingError('INPUT_UNREADABLE');
  }
  return result;
}
export async function cropAnswer(
  page: ImagePage,
  reading: Reading,
): Promise<ImagePage | null> {
  const region = reading.regions.find((r) => r.page_no === page.page_no);
  if (!region) return null;
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(page.bytes));
  const [a, b, c, d] = region.bbox;
  const width = Math.ceil((c - a) * image.width),
    height = Math.ceil((d - b) * image.height);
  if (width < 8 || height < 8 || Math.max(width / height, height / width) > 5)
    return null;
  const canvas = createCanvas(width, height);
  canvas
    .getContext('2d')
    .drawImage(
      image,
      Math.floor(a * image.width),
      Math.floor(b * image.height),
      width,
      height,
      0,
      0,
      width,
      height,
    );
  const bytes = new Uint8Array(canvas.toBuffer('image/png'));
  canvas.width = 1;
  canvas.height = 1;
  return { bytes, mime: 'image/png', page_no: page.page_no };
}
