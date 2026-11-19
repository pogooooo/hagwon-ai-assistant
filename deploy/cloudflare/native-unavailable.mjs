export function createCanvas() {
  throw new Error('Native canvas is unavailable in Cloudflare Workers');
}

// 숙제 사진의 수학 문항 자르기(ocr-page.mjs)가 가져온다. 없으면 모듈을 불러오는 단계에서 앱 전체가 실패한다.
export async function loadImage() {
  throw new Error('Native canvas is unavailable in Cloudflare Workers');
}

export async function createWorker() {
  throw new Error('Native OCR is unavailable in Cloudflare Workers');
}
