import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { newId } from '../shared/ids.js';
import { ItemRejected } from '../storage/staging.js';
import type { ImageFormat } from './format-sniff.js';

const run = promisify(execFile);

/** External decoders found on PATH at startup. sharp's bundled libvips cannot decode HEVC HEIC or BMP. */
export interface DecoderTools {
  heifDec: string | null;
  ffmpeg: string | null;
  magick: string | null;
}

async function which(cmd: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function detectDecoderTools(): Promise<DecoderTools> {
  const [heifDec, ffmpeg, magick] = await Promise.all([which('heif-dec'), which('ffmpeg'), which('magick')]);
  return { heifDec, ffmpeg, magick };
}

/** Formats sharp decodes itself (its libheif is built with AV1 only, so AVIF but not HEIC). */
const SHARP_NATIVE: ReadonlySet<ImageFormat> = new Set(['jpeg', 'png', 'gif', 'webp', 'tiff', 'avif']);

type Decoder = { name: string; argv: (input: string, output: string) => string[]; bin: string | null };

function decodersFor(format: ImageFormat, tools: DecoderTools): Decoder[] {
  const heifDec: Decoder = { name: 'heif-dec', bin: tools.heifDec, argv: (i, o) => [i, o] };
  const ffmpeg: Decoder = {
    name: 'ffmpeg',
    bin: tools.ffmpeg,
    argv: (i, o) => ['-hide_banner', '-loglevel', 'error', '-y', '-i', i, '-frames:v', '1', o],
  };
  const magick: Decoder = { name: 'magick', bin: tools.magick, argv: (i, o) => [`${i}[0]`, o] };
  const order = format === 'bmp' ? [magick, ffmpeg] : [heifDec, magick, ffmpeg];
  return order.filter((d) => d.bin !== null);
}

/** Decodes a file sharp cannot read into a temporary PNG. Returns null if every available decoder fails. */
async function decodeExternally(file: string, format: ImageFormat, tools: DecoderTools, scratchDir: string): Promise<string | null> {
  for (const decoder of decodersFor(format, tools)) {
    const out = path.join(scratchDir, `${newId()}.png`);
    try {
      await run(decoder.bin!, decoder.argv(file, out), { timeout: 120_000 });
      await fs.access(out);
      return out;
    } catch {
      await fs.rm(out, { force: true });
    }
  }
  return null;
}

export interface Derived {
  /** Displayed size, after orientation is applied. */
  width: number;
  height: number;
  display: Buffer;
  thumbnail: Buffer;
}

const DISPLAY_LONG_EDGE = 2560;
const THUMBNAIL_LONG_EDGE = 512;

async function derive(input: string): Promise<Derived> {
  const base = sharp(input, { failOn: 'error' }).rotate(); // rotate() with no angle applies EXIF orientation
  const meta = await sharp(input).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const [display, thumbnail] = await Promise.all([
    base
      .clone()
      .resize(DISPLAY_LONG_EDGE, DISPLAY_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer(),
    base
      .clone()
      .resize(THUMBNAIL_LONG_EDGE, THUMBNAIL_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer(),
  ]);
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  return { width, height, display, thumbnail };
}

/**
 * Builds the display JPEG and the thumbnail. The original is never modified.
 * Throws ItemRejected('unsupported_format') when no decoder can read the file.
 */
export async function makeDerivatives(file: string, format: ImageFormat, tools: DecoderTools, scratchDir: string): Promise<Derived> {
  if (SHARP_NATIVE.has(format)) {
    try {
      return await derive(file);
    } catch {
      // fall through to external decoders (e.g. an unusual AVIF profile)
    }
  }
  const decoded = await decodeExternally(file, format, tools, scratchDir);
  if (!decoded) throw new ItemRejected('unsupported_format');
  try {
    return await derive(decoded);
  } catch {
    throw new ItemRejected('unsupported_format');
  } finally {
    await fs.rm(decoded, { force: true });
  }
}
