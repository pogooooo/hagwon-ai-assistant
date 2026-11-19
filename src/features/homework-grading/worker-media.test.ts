import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { workerGradingMedia } from '../../../deploy/cloudflare/grading-media.mjs';
import { configureGradingMedia, cropAnswer, decodeUploads } from './media.ts';
import { item, reading } from './test-fixtures.ts';

test('Worker grading codecs render and crop photo and PDF pixels and enforce upload limits', async (t) => {
  // Wrangler supplies precompiled WebAssembly.Module imports. Run the same
  // codecs in Node tests without a Worker account or external requests.
  const hooks = registerHooks({
    load(url, ctx, next) {
      if (!url.endsWith('.wasm')) return next(url, ctx);
      return {
        shortCircuit: true,
        format: 'module',
        source:
          "import {readFileSync} from 'node:fs'; export default new WebAssembly.Module(readFileSync(new URL(import.meta.url)));",
      };
    },
  });
  t.after(() => hooks.deregister());
  configureGradingMedia(workerGradingMedia);
  const canvas = createCanvas(128, 96);
  const paint = canvas.getContext('2d');
  paint.fillStyle = 'white';
  paint.fillRect(0, 0, 128, 96);
  paint.fillStyle = '#101010';
  paint.fillRect(35, 25, 45, 35);
  const png = canvas.toBuffer('image/png');
  const ref = reading(item('MATH'), '', {
    regions: [{ page_no: 1, bbox: [0.25, 0.25, 0.75, 0.75] }],
  });
  async function inspect(bytes: Uint8Array) {
    const image = await loadImage(Buffer.from(bytes));
    const dest = createCanvas(image.width, image.height);
    const ctx = dest.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, image.width, image.height).data;
    let dark = 0,
      sumX = 0,
      sumY = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] >= 100 || rgba[i + 3] <= 240) continue;
      dark++;
      sumX += (i / 4) % image.width;
      sumY += Math.floor(i / 4 / image.width);
    }
    return {
      width: image.width,
      height: image.height,
      dark,
      centerX: Math.round(sumX / dark),
      centerY: Math.round(sumY / dark),
    };
  }
  for (const mime of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    const [page] = await decodeUploads([
      { mime, bytes: mime === 'image/png' ? png : canvas.toBuffer(mime) },
    ]);
    const clip = await cropAnswer(page, ref);
    assert.ok(clip);
    const pixels = await inspect(clip.bytes);
    assert.deepEqual([pixels.width, pixels.height], [64, 48]);
    assert.ok(pixels.dark > 1400);
  }
  const exif = Buffer.from(
    'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
    'hex',
  );
  const jpeg = canvas.toBuffer('image/jpeg');
  for (let orientation = 1; orientation <= 8; orientation++) {
    exif[28] = orientation;
    const bytes = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
    const [oriented] = await decodeUploads([{ mime: 'image/jpeg', bytes }]);
    assert.deepEqual(
      await inspect(oriented.bytes),
      await inspect(bytes),
      `EXIF ${orientation}`,
    );
  }
  const pdf = await PDFDocument.create();
  pdf.addPage([128, 96]).drawText('2/3', { x: 42, y: 40, size: 17 });
  pdf
    .addPage([128, 96])
    .drawImage(await pdf.embedPng(png), { x: 0, y: 0, width: 128, height: 96 });
  const render = async () =>
    decodeUploads([{ mime: 'application/pdf', bytes: await pdf.save() }]);
  const pages = await render();
  assert.deepEqual(
    pages.map((p) => p.page_no),
    [1, 2],
  );
  for (const page of pages) {
    const crop = await cropAnswer(page, {
      ...ref,
      regions: [{ ...ref.regions[0], page_no: page.page_no }],
    });
    assert.ok(crop);
    const pixels = await inspect(crop.bytes);
    assert.equal(pixels.width, 128);
    assert.equal(pixels.height, 96);
    assert.ok(pixels.dark > (page.page_no === 1 ? 30 : 5000));
  }
  pdf.addPage([128, 96]);
  await assert.rejects(render, { code: 'PAGE_LIMIT' });
  await assert.rejects(
    decodeUploads([
      {
        mime: 'image/png',
        bytes: createCanvas(1500, 1100).toBuffer('image/png'),
      },
    ]),
    { code: 'INPUT_UNREADABLE' },
  );
  await assert.rejects(
    decodeUploads([
      { mime: 'image/png', bytes: new Uint8Array(3 * 1024 * 1024 + 1) },
    ]),
    { code: 'UPLOAD_LIMIT' },
  );
});
