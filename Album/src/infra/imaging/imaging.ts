import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import exifr from 'exifr';
import sharp from 'sharp';
import { newId } from '../../shared/ids.js';
import type { ImageFormat } from './format.js';

const run = promisify(execFile);

/** External decoders found on PATH. sharp's bundled libvips cannot decode HEVC HEIC or BMP. */
export interface DecoderTools {
  heifDec: string | null;
  ffmpeg: string | null;
  magick: string | null;
}

/** No available decoder could read the image. */
export class UndecodableImageError extends Error {}

/** Capture metadata read from EXIF. Every field is null when the file does not carry it; nothing is inferred. */
export interface CaptureMetadata {
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
}

export interface Derived {
  /** Displayed size, after orientation is applied. */
  width: number;
  height: number;
  display: Buffer;
  thumbnail: Buffer;
}

/** Formats sharp decodes itself (its libheif is built with AV1 only, so AVIF but not HEIC). */
const SHARP_NATIVE: ReadonlySet<ImageFormat> = new Set(['jpeg', 'png', 'gif', 'webp', 'tiff', 'avif']);
const DISPLAY_LONG_EDGE = 2560;
const THUMBNAIL_LONG_EDGE = 512;
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;

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

/** EXIF "2023:07:14 10:22:01" (+ optional OffsetTimeOriginal) → "2023-07-14T10:22:01[+02:00]". Local time is kept as written. */
function exifDateToIso(raw: unknown, offset: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = EXIF_DATE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === '0000' || mo === '00' || d === '00') return null;
  const tz = typeof offset === 'string' && OFFSET.test(offset.trim()) ? offset.trim() : '';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\0/g, '').trim();
  return t || null;
}

/** Image operations: decode any supported format, resize, read metadata. */
export class Imaging {
  private constructor(readonly tools: DecoderTools) {}

  /** Detects which external decoders are installed. */
  static async create(): Promise<Imaging> {
    const [heifDec, ffmpeg, magick] = await Promise.all([which('heif-dec'), which('ffmpeg'), which('magick')]);
    return new Imaging({ heifDec, ffmpeg, magick });
  }

  /**
   * Builds the display JPEG and the thumbnail; the original is never modified. `scratchDir` holds intermediate
   * decodes. Throws UndecodableImageError when no decoder can read the file.
   */
  async derive(file: string, format: ImageFormat, scratchDir: string): Promise<Derived> {
    if (SHARP_NATIVE.has(format)) {
      try {
        return await this.render(file);
      } catch {
        // fall through to external decoders (e.g. an unusual AVIF profile)
      }
    }
    const decoded = await this.decodeExternally(file, format, scratchDir);
    if (!decoded) throw new UndecodableImageError('unsupported_format');
    try {
      return await this.render(decoded);
    } catch {
      throw new UndecodableImageError('unsupported_format');
    } finally {
      await fs.rm(decoded, { force: true });
    }
  }

  /** A JPEG no larger than `longEdge` on its longer side. */
  resizeJpeg(image: Buffer, longEdge: number, quality: number): Promise<Buffer> {
    return sharp(image).resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  }

  /** Renders an SVG as PNG. */
  svgToPng(svg: string): Promise<Buffer> {
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  async readMetadata(file: string): Promise<CaptureMetadata> {
    let tags: Record<string, unknown> | undefined;
    try {
      tags = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'Make', 'Model'], reviveValues: false });
    } catch {
      tags = undefined;
    }
    let gps: { latitude: number; longitude: number } | undefined;
    try {
      gps = await exifr.gps(file);
    } catch {
      gps = undefined;
    }
    const lat = gps && Number.isFinite(gps.latitude) ? gps.latitude : null;
    const lon = gps && Number.isFinite(gps.longitude) ? gps.longitude : null;
    // 0,0 is what many devices write when they have no fix.
    const hasFix = lat !== null && lon !== null && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    return {
      takenAt: exifDateToIso(tags?.DateTimeOriginal ?? tags?.CreateDate, tags?.OffsetTimeOriginal),
      cameraMake: text(tags?.Make),
      cameraModel: text(tags?.Model),
      gpsLat: hasFix ? lat : null,
      gpsLon: hasFix ? lon : null,
    };
  }

  private async render(input: string): Promise<Derived> {
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
      base.clone().resize(THUMBNAIL_LONG_EDGE, THUMBNAIL_LONG_EDGE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer(),
    ]);
    const width = (swap ? meta.height : meta.width) ?? 0;
    const height = (swap ? meta.width : meta.height) ?? 0;
    return { width, height, display, thumbnail };
  }

  /** Decodes a file sharp cannot read into a temporary PNG. Returns null if every available decoder fails. */
  private async decodeExternally(file: string, format: ImageFormat, scratchDir: string): Promise<string | null> {
    const t = this.tools;
    const heifDec = { bin: t.heifDec, argv: (i: string, o: string) => [i, o] };
    const ffmpeg = { bin: t.ffmpeg, argv: (i: string, o: string) => ['-hide_banner', '-loglevel', 'error', '-y', '-i', i, '-frames:v', '1', o] };
    const magick = { bin: t.magick, argv: (i: string, o: string) => [`${i}[0]`, o] };
    const order = format === 'bmp' ? [magick, ffmpeg] : [heifDec, magick, ffmpeg];
    for (const decoder of order) {
      if (!decoder.bin) continue;
      const out = path.join(scratchDir, `${newId()}.png`);
      try {
        await run(decoder.bin, decoder.argv(file, out), { timeout: 120_000 });
        await fs.access(out);
        return out;
      } catch {
        await fs.rm(out, { force: true });
      }
    }
    return null;
  }
}
