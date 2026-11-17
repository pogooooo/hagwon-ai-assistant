/** Read signatures/dimensions before a paid vision request. Never decode or fetch. */
const starts = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, i) => bytes[i] === value);
const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

export function imageMime(bytes: Uint8Array) {
  if (starts(bytes, [255, 216, 255])) return 'image/jpeg';
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return 'image/webp';
  if (starts(bytes, [66, 77])) return 'image/bmp';
  return undefined;
}

export function imageDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (imageMime(bytes)) {
    case 'image/png':
      if (bytes.length >= 24 && ascii(bytes, 12, 16) === 'IHDR')
        return { width: view.getUint32(16), height: view.getUint32(20) };
      break;
    case 'image/bmp':
      if (bytes.length >= 26) {
        const dib = view.getUint32(14, true);
        if (dib === 12)
          return {
            width: view.getUint16(18, true),
            height: view.getUint16(20, true),
          };
        if (dib >= 40)
          return {
            width: view.getInt32(18, true),
            height: Math.abs(view.getInt32(22, true)),
          };
      }
      break;
    case 'image/webp': {
      if (bytes.length < 30) break;
      const kind = ascii(bytes, 12, 16);
      const u24 = (i: number) =>
        bytes[i] + (bytes[i + 1] << 8) + (bytes[i + 2] << 16);
      if (kind === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
      if (kind === 'VP8 ' && starts(bytes.subarray(23), [157, 1, 42]))
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      if (kind === 'VP8L' && bytes[20] === 47) {
        const bits = view.getUint32(21, true);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
        };
      }
      break;
    }
    case 'image/jpeg':
      for (let i = 2; i + 3 < bytes.length;) {
        if (bytes[i++] !== 255) break;
        while (bytes[i] === 255) i++;
        const marker = bytes[i++];
        if (marker === 218 || marker === 217) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (i + 2 > bytes.length) break;
        const size = view.getUint16(i);
        if (size < 2 || i + size > bytes.length) break;
        if (
          [
            192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
          ].includes(marker) &&
          size >= 8
        )
          return {
            width: view.getUint16(i + 5),
            height: view.getUint16(i + 3),
          };
        i += size;
      }
  }
  return undefined;
}

export function validateVisionImage(bytes: Uint8Array) {
  const mime = imageMime(bytes),
    size = imageDimensions(bytes);
  if (!mime || !size || size.width < 4 || size.height < 4)
    throw new Error(
      '이미지 형식 또는 크기를 읽을 수 없습니다. JPG·PNG·WEBP·BMP로 저장해 주세요.',
    );
  if (
    Math.max(size.width, size.height) > 2240 ||
    Math.max(size.width / size.height, size.height / size.width) > 5
  )
    throw new Error(
      '사진은 긴 변 2240px 이하, 가로·세로 비율 5:1 이하로 올려 주세요. 웹 화면에서는 큰 사진을 자동으로 줄입니다.',
    );
  if (bytes.length > 20 * 1024 * 1024)
    throw new Error('이미지는 20MB 이하로 올려 주세요.');
  return mime;
}
