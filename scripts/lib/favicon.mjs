/**
 * Favicon content-sniffing so the on-disk filename matches the actual image format.
 * Plain .mjs + JSDoc so both .ts (tsx) and .mjs (node) callers work without a build step.
 */

/** @typedef {'svg' | 'ico' | 'png'} FaviconExt */

/**
 * Detect file extension from the buffer's first bytes. Falls back to 'ico'.
 * @param {Buffer | Uint8Array} buf
 * @returns {FaviconExt}
 */
export function detectFaviconExtension(buf) {
  if (!buf || buf.length === 0) return 'ico';
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  // ICO magic: 00 00 01 00 (icon) or 00 00 02 00 (cursor)
  if (
    buf.length >= 4 &&
    buf[0] === 0x00 &&
    buf[1] === 0x00 &&
    (buf[2] === 0x01 || buf[2] === 0x02) &&
    buf[3] === 0x00
  ) {
    return 'ico';
  }
  // SVG: textual XML — match "<?xml …?><svg…>", "<svg xmlns…>", and "<svg/>".
  const head = Buffer.from(buf.slice(0, Math.min(buf.length, 512)))
    .toString('utf8')
    .trimStart();
  if (head.startsWith('<') && /<svg[\s>\/]/i.test(head)) {
    return 'svg';
  }
  return 'ico';
}

/** @type {readonly FaviconExt[]} */
export const FAVICON_EXTS = ['svg', 'ico', 'png'];
