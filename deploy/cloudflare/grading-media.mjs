import { GradingError } from '../../src/features/homework-grading/contracts.ts';

// Per-isolate admission also covers concurrent requests from different academies.
let busy = false;
async function exclusive(action) {
  if (busy) throw new GradingError('MEDIA_BUSY', 503);
  busy = true;
  try {
    return await action();
  } finally {
    busy = false;
  }
}
const maxOutputPixels = 1_000_000;
function outputScale(width, height, maxScale) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width / height, height / width) > 5
  )
    throw new GradingError('INPUT_UNREADABLE');
  return Math.min(
    maxScale,
    1400 / Math.max(width, height),
    Math.sqrt(maxOutputPixels / (width * height)),
  );
}
// JPEG/PNG carry EXIF directly. WebP stores its TIFF block in a RIFF chunk.
async function photoOrientation(bytes) {
  const { orientation } = await import('exifr/dist/full.esm.mjs');
  let metadata = bytes;
  if (bytes[0] === 0x52) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + length > bytes.length) return 1;
      if (view.getUint32(offset) === 0x45584946) {
        metadata = bytes.subarray(start, start + length);
        if (metadata[0] === 0x45 && metadata[1] === 0x78)
          metadata = metadata.subarray(6);
        break;
      }
      offset = start + length + (length % 2);
    }
    if (metadata === bytes) return 1;
  }
  return (await orientation(metadata).catch(() => 1)) || 1;
}
// EXIF orientations are exact pixel permutations. Copying packed RGBA
// preserves handwriting at every right-angle rotation and reflection.
function orientPixels(PhotonImage, image, orientation) {
  const width = image.get_width(),
    height = image.get_height();
  const transpose = orientation >= 5;
  const outputWidth = transpose ? height : width,
    outputHeight = transpose ? width : height;
  const reverseX = [2, 3, 6, 7].includes(orientation),
    reverseY = [3, 4, 7, 8].includes(orientation);
  const strideX = reverseX ? -1 : 1,
    strideY = reverseY ? -outputWidth : outputWidth;
  const step = transpose ? strideY : strideX,
    rowStep = transpose ? strideX : strideY;
  let rowStart =
    (reverseX ? outputWidth - 1 : 0) +
    (reverseY ? (outputHeight - 1) * outputWidth : 0);
  const rgba = image.get_raw_pixels();
  const source = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const output = new Uint32Array(source.length);
  try {
    let index = 0;
    for (let y = 0; y < height; y++, rowStart += rowStep) {
      let destination = rowStart;
      for (let x = 0; x < width; x++, destination += step)
        output[destination] = source[index++];
    }
    return new PhotonImage(
      new Uint8Array(output.buffer),
      outputWidth,
      outputHeight,
    );
  } finally {
    rgba.fill(0);
    output.fill(0);
  }
}
export const workerGradingMedia = {
  maxPages: 2,
  maxInputBytes: 3 * 1024 * 1024,
  maxImagePixels: 1_500_000,
  decodePhoto(bytes) {
    return exclusive(async () => {
      const { PhotonImage, resize, SamplingFilter } =
        await import('@cf-wasm/photon/workerd');
      const orientation = await photoOrientation(bytes);
      let image = PhotonImage.new_from_byteslice(bytes);
      try {
        if (orientation >= 2 && orientation <= 8) {
          const rotated = orientPixels(PhotonImage, image, orientation);
          image.free();
          image = rotated;
        }
        const w = image.get_width(),
          h = image.get_height();
        const scale = outputScale(w, h, 1);
        if (scale === 1) return image.get_bytes();
        const resized = resize(
          image,
          Math.max(1, Math.floor(w * scale)),
          Math.max(1, Math.floor(h * scale)),
          SamplingFilter.Triangle,
        );
        try {
          return resized.get_bytes();
        } finally {
          resized.free();
        }
      } finally {
        image.free();
      }
    });
  },
  renderPdf(bytes, remainingPages) {
    return exclusive(async () => {
      const { PDFiumLibrary } = await import('@hyzyla/pdfium');
      const { default: wasm } = await import('@hyzyla/pdfium/pdfium.wasm');
      const { PhotonImage } = await import('@cf-wasm/photon/workerd');
      const library = await PDFiumLibrary.init({
        instantiateWasm(imports, receive) {
          const instance = new WebAssembly.Instance(wasm, imports);
          receive(instance, wasm);
          return instance.exports;
        },
      });
      const pages = [];
      try {
        const document = await library.loadDocument(bytes);
        try {
          if (
            document.getPageCount() < 1 ||
            document.getPageCount() > remainingPages
          )
            throw new GradingError('PAGE_LIMIT');
          for (const page of document.pages()) {
            try {
              const { originalWidth, originalHeight } = page.getOriginalSize();
              const scale = outputScale(originalWidth, originalHeight, 2);
              const raster = await page.render({
                colorSpace: 'RGBA',
                render: 'bitmap',
                scale,
              });
              try {
                const image = new PhotonImage(
                  raster.data,
                  raster.width,
                  raster.height,
                );
                try {
                  pages.push(image.get_bytes());
                } finally {
                  image.free();
                }
              } finally {
                raster.data.fill(0);
              }
            } finally {
              page.close();
            }
          }
          return pages;
        } finally {
          document.destroy();
        }
      } catch (error) {
        for (const page of pages) page.fill(0);
        throw error;
      } finally {
        library.destroy();
      }
    });
  },
  mask(bytes, regions) {
    return exclusive(async () => {
      const { PhotonImage } = await import('@cf-wasm/photon/workerd');
      const original = PhotonImage.new_from_byteslice(bytes);
      try {
        const width = original.get_width(),
          pixels = original.get_raw_pixels();
        try {
          for (const r of regions)
            for (let y = r.y; y < r.y + r.height; y++) {
              const start = 4 * (y * width + r.x);
              pixels.fill(255, start, start + 4 * r.width);
            }
          const masked = new PhotonImage(pixels, width, original.get_height());
          try {
            return masked.get_bytes();
          } finally {
            masked.free();
          }
        } finally {
          pixels.fill(0);
        }
      } finally {
        original.free();
      }
    });
  },
  crop(bytes, { x, y, width, height }) {
    return exclusive(async () => {
      const { PhotonImage, crop } = await import('@cf-wasm/photon/workerd');
      const source = PhotonImage.new_from_byteslice(bytes);
      try {
        const cropped = crop(source, x, y, x + width, y + height);
        try {
          return cropped.get_bytes();
        } finally {
          cropped.free();
        }
      } finally {
        source.free();
      }
    });
  },
};
