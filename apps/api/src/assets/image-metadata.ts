import exifr from 'exifr';

/** Capture metadata read from EXIF. Every field is null when the file does not carry it; nothing is inferred. */
export interface CaptureMetadata {
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
}

const EMPTY: CaptureMetadata = { takenAt: null, cameraMake: null, cameraModel: null, gpsLat: null, gpsLon: null };

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;

/** EXIF "2023:07:14 10:22:01" (+ optional OffsetTimeOriginal) → "2023-07-14T10:22:01[+02:00]". Local time is kept as written. */
export function exifDateToIso(raw: unknown, offset: unknown): string | null {
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

export async function readCaptureMetadata(file: string): Promise<CaptureMetadata> {
  let tags: Record<string, unknown> | undefined;
  try {
    tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'Make', 'Model'],
      reviveValues: false,
    });
  } catch {
    tags = undefined;
  }
  let gps: { latitude: number; longitude: number } | undefined;
  try {
    gps = await exifr.gps(file);
  } catch {
    gps = undefined;
  }
  if (!tags && !gps) return EMPTY;

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
