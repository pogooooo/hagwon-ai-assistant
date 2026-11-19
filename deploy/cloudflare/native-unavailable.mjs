export function createCanvas() {
  throw new Error('Native canvas is unavailable in Cloudflare Workers');
}

export async function loadImage() {
  throw new Error('Native image decoding is unavailable in Cloudflare Workers');
}

export async function createWorker() {
  throw new Error('Native OCR is unavailable in Cloudflare Workers');
}
