/** Pure-JS PNG/JPEG/WebP/GIF dimension reader. Null for unsupported/malformed. Used for Header logoWidth clamping. */

import fs from 'fs';

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Read the first ~32 KB of a file for format-header parsing. */
function readHeaderBuffer(absPath: string, bytes = 32 * 1024): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const stats = fs.fstatSync(fd);
    const size = Math.min(bytes, stats.size);
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** PNG: 8-byte magic + IHDR chunk with big-endian width/height. */
function readPng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.slice(0, 8).equals(magic)) return null;
  if (buf.slice(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** JPEG: FFD8 + scan for SOF markers with payload precision(1)+height(2)+width(2). */
function readJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) return null;
    const marker = buf[offset];
    offset++;
    if (marker === 0xd8 || marker === 0xd9) return null;
    if (offset + 2 > buf.length) return null;
    const segLen = buf.readUInt16BE(offset);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (offset + 7 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    offset += segLen;
  }
  return null;
}

/** WebP: RIFF container with VP8, VP8L, or VP8X chunk at offset 12. */
function readWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buf.slice(8, 12).toString('ascii') !== 'WEBP') return null;
  const chunk = buf.slice(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  return null;
}

/** GIF: 'GIF87a' or 'GIF89a' then 16-bit little-endian width/height. */
function readGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const sig = buf.slice(0, 6).toString('ascii');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Read intrinsic pixel dimensions. Returns null for unsupported (SVG/AVIF/HEIC/ICO) or malformed. Never throws. */
export function readImageDimensions(absPath: string): ImageDimensions | null {
  const buf = readHeaderBuffer(absPath);
  if (!buf) return null;
  return readPng(buf) ?? readJpeg(buf) ?? readWebp(buf) ?? readGif(buf) ?? null;
}

/** Clamp logo width (target 48 px height, 120–260 px wide) so wide logos don't blow out at h-16 w-auto. */
export function computeHeaderLogoWidth(
  dims: ImageDimensions | null,
  opts: { minWidth?: number; maxWidth?: number; targetHeight?: number } = {}
): number {
  const minWidth = opts.minWidth ?? 120;
  const maxWidth = opts.maxWidth ?? 260;
  const targetHeight = opts.targetHeight ?? 48;
  if (!dims || dims.height <= 0) return 180;
  const natural = Math.round((targetHeight / dims.height) * dims.width);
  return Math.max(minWidth, Math.min(maxWidth, natural));
}
