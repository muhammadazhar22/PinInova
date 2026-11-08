/**
 * Tiny deterministic PNG encoder (8-bit RGB, no interlace) + synthetic 64x64 Pin images.
 * Images are derived from an "image id": duplicate Pins share an id and therefore bytes.
 * A variant > 0 changes exactly one pixel row, to exercise perceptual hashing.
 */
import { deflateSync } from "node:zlib";
import { Rng } from "./rng.ts";

export const IMAGE_SIZE = 64;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode RGB pixels (width*height*3 bytes). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Row index changed by image variants (variant v changes row VARIANT_ROW_BASE + v). */
export const VARIANT_ROW_BASE = 20;

export function imagePixels(imageId: number, variant = 0): Uint8Array {
  const S = IMAGE_SIZE;
  const rng = new Rng(imageId ^ 0x9e3779b9);
  const c1 = [rng.int(20, 235), rng.int(20, 235), rng.int(20, 235)];
  const c2 = [rng.int(20, 235), rng.int(20, 235), rng.int(20, 235)];
  // 8x8 grid of block intensities gives well-separated perceptual hashes between image ids.
  const grid = Array.from({ length: 64 }, () => rng.float());
  const px = new Uint8Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const g = grid[(y >> 3) * 8 + (x >> 3)];
      const grad = (x + y) / (2 * (S - 1));
      const t = 0.75 * g + 0.25 * grad;
      const i = (y * S + x) * 3;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(c1[c] * (1 - t) + c2[c] * t);
    }
  }
  if (variant > 0) {
    const y = (VARIANT_ROW_BASE + variant) % S;
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 3;
      for (let c = 0; c < 3; c++) px[i + c] = 255 - px[i + c];
    }
  }
  return px;
}

const pngCache = new Map<string, Buffer>();

export function imagePng(imageId: number, variant = 0): Buffer {
  const key = `${imageId}:${variant}`;
  let buf = pngCache.get(key);
  if (!buf) {
    buf = encodePng(IMAGE_SIZE, IMAGE_SIZE, imagePixels(imageId, variant));
    if (pngCache.size > 5000) pngCache.clear();
    pngCache.set(key, buf);
  }
  return buf;
}
