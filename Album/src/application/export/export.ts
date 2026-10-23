import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { FileStore } from '../../data-access/file-store/file-store.js';
import type { ExportState } from '../../data-access/repositories/exports.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { Logger } from '../../infra/observability/log.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { newId, nowIso } from '../../shared/ids.js';

export type ExportScope = { albumIds: string[] } | { assetIds: string[] };

export interface ExportProgress {
  id: string;
  state: ExportState;
  total: number;
  done: number;
  /** Suggested download name. */
  filename: string;
  expiresAt: string | null;
  error: string | null;
}

const EXPIRY_MS = 24 * 3600_000;
const ROOT = 'album-export';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** XMP sidecar with the description and keywords, read by Lightroom, digiKam, and darktable. */
function xmpSidecar(caption: string | null, tags: string[]): string {
  const description = caption ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(caption)}</rdf:li></rdf:Alt></dc:description>` : '';
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
 * Originals are copied byte for byte; vectors are not exported. Each ZIP is deleted a day after it is made.
 */
export class Export {
  constructor(
    private readonly repos: Repositories,
    private readonly files: FileStore,
    private readonly log: Logger,
  ) {}

  create(scope: ExportScope): ExportProgress {
    const exports = this.repos.exports;
    let ids: string[];
    if ('albumIds' in scope) {
      for (const a of scope.albumIds) if (!this.repos.albums.exists(a)) throw notFound('Album');
      ids = exports.photosInAlbums(scope.albumIds);
    } else {
      ids = exports.photosInLibrary(scope.assetIds);
    }
    if (ids.length === 0) throw badRequest('nothing_to_export', 'There are no photos to export');
    const id = newId();
    exports.create(id, JSON.stringify(scope), ids.length, nowIso());
    void this.build(id, scope, ids).catch((err) => {
      this.log.error({ err, exportId: id }, 'export failed');
      exports.setState(id, 'failed', nowIso());
    });
    return this.progress(id);
  }

  private async build(id: string, scope: ExportScope, ids: string[]): Promise<void> {
    const exports = this.repos.exports;
    exports.setState(id, 'running', nowIso());
    const preferred = 'albumIds' in scope ? scope.albumIds : [];
    const zip = new yazl.ZipFile();
    const tmp = this.files.tempPath(`-${id}.zip.part`);
    const written = pipeline(zip.outputStream, this.files.createTempWriteStream(tmp));
    const used = new Set<string>();
    const records: Record<string, unknown>[] = [];
    let done = 0;

    for (const assetId of ids) {
      const p = exports.photo(assetId, preferred);
      if (!p || !p.filename) continue; // removed while exporting
      const file = uniqueName(p.filename, used);
      const tags = p.tags ? (JSON.parse(p.tags) as string[]) : [];
      const categories = p.enrichment ? ((JSON.parse(p.enrichment) as { categories?: string[] }).categories ?? []) : [];
      const caption = p.manual ?? p.ai;
      zip.addFile(this.files.abs(p.objectKey), `${ROOT}/photos/${file}`, { compress: false }); // photos are already compressed
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
        objects: p.objects ? (JSON.parse(p.objects) as string[]) : [],
        textInImage: p.text,
        kind: p.kind,
        categories,
        albums: exports.albumNames(assetId),
      });
      done++;
      if (done % 50 === 0) exports.setDone(id, done, nowIso());
    }

    zip.addBuffer(Buffer.from(JSON.stringify({ exportedAt: nowIso(), photos: records }, null, 2)), `${ROOT}/metadata.json`);
    const header = ['file', 'description', 'tags', 'objects', 'categories', 'kind', 'albums', 'takenAt', 'camera', 'latitude', 'longitude', 'sha256', 'textInImage'];
    const rows = records.map((r) => {
      const loc = r.location as { lat: number; lon: number } | null;
      return [r.file, r.description, (r.tags as string[]).join('; '), (r.objects as string[]).join('; '), (r.categories as string[]).join('; '), r.kind, (r.albums as string[]).join('; '), r.takenAt, r.camera, loc?.lat, loc?.lon, r.sha256, r.textInImage]
        .map(csvCell)
        .join(',');
    });
    zip.addBuffer(Buffer.from(`﻿${[header.join(','), ...rows].join('\r\n')}\r\n`), `${ROOT}/metadata.csv`);
    zip.end();
    await written;

    const key = FileStore.exportKey(id);
    await this.files.promote(tmp, key);
    exports.complete(id, done, key, new Date(Date.now() + EXPIRY_MS).toISOString(), nowIso());
  }

  progress(id: string): ExportProgress {
    const row = this.repos.exports.get(id);
    if (!row) throw notFound('Export');
    return {
      id: row.id,
      state: row.state,
      total: row.total,
      done: row.done,
      expiresAt: row.expiresAt,
      filename: `${this.label(JSON.parse(row.scope) as ExportScope)} ${row.createdAt.slice(0, 10)}.zip`,
      error: row.state === 'failed' ? 'The export could not be created' : null,
    };
  }

  private label(scope: ExportScope): string {
    if ('albumIds' in scope && scope.albumIds.length === 1) {
      const name = this.repos.albums.name(scope.albumIds[0]!);
      if (name) return `Album - ${name.replace(/[/\\:*?"<>|]/g, '_')}`;
    }
    return 'Album export';
  }

  /** A finished ZIP for download. */
  async download(id: string) {
    const p = this.progress(id);
    if (p.state !== 'completed') throw conflict('not_ready', 'The export is not finished yet');
    const key = this.repos.exports.get(id)?.zipKey;
    const opened = key ? await this.files.open(key) : null;
    if (!opened) throw notFound('Export file');
    return { ...opened, filename: p.filename };
  }

  /** Exports interrupted by a restart are marked failed (the user can export again). */
  recover(): void {
    this.repos.exports.failUnfinished(nowIso());
  }

  /** Deletes expired ZIP files and their jobs. */
  async removeExpired(now = Date.now()): Promise<number> {
    const rows = this.repos.exports.expired(new Date(now).toISOString());
    for (const r of rows) {
      await this.files.remove(r.key);
      this.repos.exports.delete(r.id);
    }
    return rows.length;
  }
}
