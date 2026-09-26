import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import yazl from 'yazl';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { newId, nowIso } from '../shared/ids.js';

export type ExportScope = { albumIds: string[] } | { assetIds: string[] };

export interface ExportProgress {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  total: number;
  done: number;
  /** Suggested download name. */
  filename: string;
  expiresAt: string | null;
  error: string | null;
}

interface ExportPhoto {
  id: string;
  sha256: string;
  format: string;
  objectKey: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  ai: string | null;
  manual: string | null;
  tags: string | null;
  enrichment: string | null;
  /** Filename in the first selected album that contains the photo, else its first imported name. */
  filename: string;
}

const EXPIRY_MS = 24 * 3600_000;
const ROOT = 'album-export';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** XMP sidecar with the description and keywords, read by Lightroom, digiKam, and darktable. */
export function xmpSidecar(caption: string | null, tags: string[]): string {
  const description = caption
    ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(caption)}</rdf:li></rdf:Alt></dc:description>`
    : '';
  const subject = tags.length ? `<dc:subject><rdf:Bag>${tags.map((t) => `<rdf:li>${xmlEscape(t)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>` : '';
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">${description}${subject}</rdf:Description>` +
    `</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n`
  );
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "beach.jpg", "beach (2).jpg", ... */
function uniqueName(name: string, used: Set<string>): string {
  const clean = name.replace(/[/\\\0]/g, '_') || 'photo';
  if (!used.has(clean.toLowerCase())) {
    used.add(clean.toLowerCase());
    return clean;
  }
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/**
 * ZIP exports of original photos with their descriptions, tags, and album names (JSON, CSV, and XMP sidecars).
 * Originals are copied byte for byte; embeddings are not exported. Files expire after a day.
 */
export class ExportService {
  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {}

  private zipKey(id: string): string {
    return `exports/${id}.zip`;
  }

  create(scope: ExportScope): ExportProgress {
    const { db } = this.ctx;
    const ids = this.resolve(scope);
    if (ids.length === 0) throw badRequest('nothing_to_export', 'There are no photos to export');
    const id = newId();
    const now = nowIso();
    db.prepare(`INSERT INTO export_jobs (id, scope, state, total, done, created_at, updated_at) VALUES (?, ?, 'queued', ?, 0, ?, ?)`).run(
      id,
      JSON.stringify(scope),
      ids.length,
      now,
      now,
    );
    void this.build(id, scope, ids).catch((err) => {
      this.log.error({ err, exportId: id }, 'export failed');
      db.prepare(`UPDATE export_jobs SET state = 'failed', updated_at = ? WHERE id = ?`).run(nowIso(), id);
    });
    return this.progress(id);
  }

  /** Visible photos in scope, in a stable order. */
  private resolve(scope: ExportScope): string[] {
    const { db } = this.ctx;
    if ('albumIds' in scope) {
      for (const a of scope.albumIds) if (!db.prepare('SELECT 1 FROM albums WHERE id = ?').get(a)) throw notFound('Album');
      return db
        .prepare(
          `SELECT DISTINCT a.id FROM assets a JOIN album_assets aa ON aa.asset_id = a.id
            WHERE aa.album_id IN (SELECT value FROM json_each(?)) AND a.orphaned_at IS NULL ORDER BY a.created_at, a.id`,
        )
        .pluck()
        .all(JSON.stringify(scope.albumIds)) as string[];
    }
    return db
      .prepare(
        `SELECT a.id FROM assets a WHERE a.id IN (SELECT value FROM json_each(?)) AND a.orphaned_at IS NULL
           AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id) ORDER BY a.created_at, a.id`,
      )
      .pluck()
      .all(JSON.stringify(scope.assetIds)) as string[];
  }

  private async build(id: string, scope: ExportScope, ids: string[]): Promise<void> {
    const { db, store } = this.ctx;
    db.prepare(`UPDATE export_jobs SET state = 'running', updated_at = ? WHERE id = ?`).run(nowIso(), id);
    const preferred = JSON.stringify('albumIds' in scope ? scope.albumIds : []);
    const photoStmt = db.prepare(
      `SELECT a.id, a.sha256, a.format, a.object_key AS objectKey, a.width, a.height, a.taken_at AS takenAt,
              a.camera_make AS cameraMake, a.camera_model AS cameraModel, a.gps_lat AS gpsLat, a.gps_lon AS gpsLon,
              d.ai_caption AS ai, d.manual_caption AS manual, d.ai_tags AS tags, d.enrichment,
              (SELECT display_filename FROM album_assets WHERE asset_id = a.id
                ORDER BY album_id IN (SELECT value FROM json_each(?)) DESC, added_at LIMIT 1) AS filename
         FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id WHERE a.id = ?`,
    );
    const albumStmt = db.prepare(
      `SELECT al.name FROM album_assets aa JOIN albums al ON al.id = aa.album_id WHERE aa.asset_id = ? ORDER BY al.name`,
    );

    const zip = new yazl.ZipFile();
    const tmp = path.join(store.stagingDir, `${id}.zip.part`);
    const written = pipeline(zip.outputStream, createWriteStream(tmp));
    const used = new Set<string>();
    const records: Record<string, unknown>[] = [];
    let done = 0;

    for (const assetId of ids) {
      const p = photoStmt.get(preferred, assetId) as ExportPhoto | undefined;
      if (!p || !p.filename) continue; // removed while exporting
      const file = uniqueName(p.filename, used);
      const tags = p.tags ? (JSON.parse(p.tags) as string[]) : [];
      const categories = p.enrichment ? ((JSON.parse(p.enrichment) as { categories?: string[] }).categories ?? []) : [];
      const caption = p.manual ?? p.ai;
      zip.addFile(store.abs(p.objectKey), `${ROOT}/photos/${file}`, { compress: false }); // photos are already compressed
      zip.addBuffer(Buffer.from(xmpSidecar(caption, tags)), `${ROOT}/photos/${file}.xmp`);
      records.push({
        file: `photos/${file}`,
        sha256: p.sha256,
        format: p.format,
        width: p.width,
        height: p.height,
        takenAt: p.takenAt,
        camera: p.cameraMake || p.cameraModel ? [p.cameraMake, p.cameraModel].filter(Boolean).join(' ') : null,
        location: p.gpsLat !== null && p.gpsLon !== null ? { lat: p.gpsLat, lon: p.gpsLon } : null,
        description: caption,
        descriptionSource: p.manual ? 'user' : p.ai ? 'ai' : null,
        aiDescription: p.ai,
        tags,
        categories,
        albums: albumStmt.pluck().all(assetId) as string[],
      });
      done++;
      if (done % 50 === 0) db.prepare(`UPDATE export_jobs SET done = ?, updated_at = ? WHERE id = ?`).run(done, nowIso(), id);
    }

    zip.addBuffer(Buffer.from(JSON.stringify({ exportedAt: nowIso(), photos: records }, null, 2)), `${ROOT}/metadata.json`);
    const header = ['file', 'description', 'tags', 'categories', 'albums', 'takenAt', 'camera', 'latitude', 'longitude', 'sha256'];
    const rows = records.map((r) => {
      const loc = r.location as { lat: number; lon: number } | null;
      return [r.file, r.description, (r.tags as string[]).join('; '), (r.categories as string[]).join('; '), (r.albums as string[]).join('; '), r.takenAt, r.camera, loc?.lat, loc?.lon, r.sha256]
        .map(csvCell)
        .join(',');
    });
    zip.addBuffer(Buffer.from(`﻿${[header.join(','), ...rows].join('\r\n')}\r\n`), `${ROOT}/metadata.csv`);
    zip.end();
    await written;

    await fs.rename(tmp, store.abs(this.zipKey(id)));
    db.prepare(`UPDATE export_jobs SET state = 'completed', done = ?, total = ?, zip_key = ?, expires_at = ?, updated_at = ? WHERE id = ?`).run(
      done,
      done,
      this.zipKey(id),
      new Date(Date.now() + EXPIRY_MS).toISOString(),
      nowIso(),
      id,
    );
  }

  progress(id: string): ExportProgress {
    const row = this.ctx.db
      .prepare(`SELECT id, state, total, done, scope, expires_at AS expiresAt, created_at AS createdAt FROM export_jobs WHERE id = ?`)
      .get(id) as (Omit<ExportProgress, 'filename' | 'error'> & { scope: string; createdAt: string }) | undefined;
    if (!row) throw notFound('Export');
    const { scope, createdAt, ...rest } = row;
    return {
      ...rest,
      filename: `${this.label(JSON.parse(scope) as ExportScope)} ${createdAt.slice(0, 10)}.zip`,
      error: row.state === 'failed' ? 'The export could not be created' : null,
    };
  }

  private label(scope: ExportScope): string {
    if ('albumIds' in scope && scope.albumIds.length === 1) {
      const name = this.ctx.db.prepare('SELECT name FROM albums WHERE id = ?').pluck().get(scope.albumIds[0]) as string | undefined;
      if (name) return `Album - ${name.replace(/[/\\:*?"<>|]/g, '_')}`;
    }
    return 'Album export';
  }

  /** Path of a finished ZIP for download. */
  file(id: string): { abs: string; filename: string } {
    const p = this.progress(id);
    if (p.state !== 'completed') throw conflict('not_ready', 'The export is not finished yet');
    const key = this.ctx.db.prepare('SELECT zip_key FROM export_jobs WHERE id = ?').pluck().get(id) as string | null;
    if (!key) throw notFound('Export file');
    return { abs: this.ctx.store.abs(key), filename: p.filename };
  }

  /** Startup: exports interrupted by a restart are marked failed (the user can export again). */
  recover(): void {
    this.ctx.db.prepare(`UPDATE export_jobs SET state = 'failed', updated_at = ? WHERE state IN ('queued', 'running')`).run(nowIso());
  }

  /** Removes expired ZIP files. Called by the garbage collector. */
  async removeExpired(now = Date.now()): Promise<number> {
    const { db, store } = this.ctx;
    const rows = db
      .prepare(`SELECT id, zip_key AS key FROM export_jobs WHERE expires_at IS NOT NULL AND expires_at <= ?`)
      .all(new Date(now).toISOString()) as { id: string; key: string | null }[];
    for (const r of rows) {
      await store.remove(r.key);
      db.prepare('DELETE FROM export_jobs WHERE id = ?').run(r.id);
    }
    return rows.length;
  }
}
