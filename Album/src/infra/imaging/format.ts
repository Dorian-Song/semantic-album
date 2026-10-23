/**
 * Image format detection from file content. Extensions and browser MIME types are only hints:
 * a PNG named .jpg is a PNG, and an MP4 named .heic is rejected.
 */

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'tiff' | 'heic' | 'avif';

export const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  avif: 'image/avif',
};

/** Formats every mainstream browser renders directly; others are shown through the JPEG derivative. */
export const BROWSER_NATIVE: ReadonlySet<ImageFormat> = new Set(['jpeg', 'png', 'gif', 'webp']);

/** Bytes needed from the start of a file; covers the ftyp box with its compatible brands. */
export const SNIFF_BYTES = 64;

const HEIF_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs)$/;
const AVIF_BRANDS = /^(avif|avis)$/;
const GENERIC_HEIF_BRANDS = /^(mif1|msf1)$/;

function ascii(b: Uint8Array, offset: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[offset + i] !== s.charCodeAt(i)) return false;
  return true;
}

function brandAt(b: Uint8Array, offset: number): string {
  return String.fromCharCode(b[offset] ?? 0, b[offset + 1] ?? 0, b[offset + 2] ?? 0, b[offset + 3] ?? 0);
}

/** ISO-BMFF: major brand at 8..12, compatible brands from 16 to the end of the ftyp box. */
function sniffFtyp(b: Uint8Array): ImageFormat | null {
  const major = brandAt(b, 8);
  if (HEIF_BRANDS.test(major)) return 'heic';
  if (AVIF_BRANDS.test(major)) return 'avif';
  if (!GENERIC_HEIF_BRANDS.test(major)) return null; // mp4, mov, m4a, ...
  // mif1/msf1 is the generic HEIF brand; the codec is named among the compatible brands.
  const boxEnd = Math.min(b.length, ((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0));
  const compatible: string[] = [];
  for (let o = 16; o + 4 <= boxEnd; o += 4) compatible.push(brandAt(b, o));
  if (compatible.some((c) => AVIF_BRANDS.test(c))) return 'avif';
  return 'heic';
}

export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (ascii(b, 0, 'BM') && b.length >= 26) return 'bmp';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'II*\0') || ascii(b, 0, 'MM\0*')) return 'tiff';
  if (ascii(b, 4, 'ftyp')) return sniffFtyp(b);
  return null;
}
