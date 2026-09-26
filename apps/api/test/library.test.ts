import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ImportProgress } from '../src/imports/import-service.js';
import type { PhotoDetail } from '../src/photos/photo-queries.js';
import { countFiles, fakeMp4, heic, jpeg, multipart, png, testApp } from './helpers.js';

type T = Awaited<ReturnType<typeof testApp>>;

async function json<R>(t: T, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: R }> {
  const res = await t.app.inject(body === undefined ? { method, url } : { method, url, payload: body as object });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as R };
}

async function createAlbum(t: T, name: string): Promise<string> {
  const res = await json<{ id: string }>(t, 'POST', '/api/albums', { name });
  assert.equal(res.status, 201);
  return res.body.id;
}

/** Imports buffers into an album through the browser-upload API. Returns the finished job. */
async function uploadFiles(t: T, albumId: string, files: { name: string; data: Buffer }[]): Promise<ImportProgress> {
  const manifest = files.map((f, i) => ({ key: `${i}:${f.name}`, name: f.name, size: f.data.length }));
  const job = await json<ImportProgress>(t, 'POST', '/api/imports', { albumId, files: manifest });
  assert.equal(job.status, 201);
  for (const [i, f] of files.entries()) {
    const { payload, headers } = multipart(f.name, f.data);
    const res = await t.app.inject({ method: 'POST', url: `/api/imports/${job.body.id}/files?itemKey=${encodeURIComponent(manifest[i]!.key)}`, payload, headers });
    assert.equal(res.statusCode, 200, res.body);
  }
  return (await json<ImportProgress>(t, 'POST', `/api/imports/${job.body.id}/finish`)).body;
}

async function albumPhotoIds(t: T, albumId: string): Promise<string[]> {
  return (await json<{ items: { id: string }[] }>(t, 'GET', `/api/albums/${albumId}/photos`)).body.items.map((p) => p.id);
}

describe('folder import', () => {
  let t: T;
  before(async () => (t = await testApp()));
  after(async () => t.close());

  test('names albums after folders, deduplicates by content, and survives source deletion', async () => {
    const first = path.join(t.dir, 'src1', 'Holiday');
    const second = path.join(t.dir, 'src2', 'Holiday');
    fs.mkdirSync(path.join(first, 'day2'), { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    const a = await jpeg(1).toBuffer();
    fs.writeFileSync(path.join(first, 'a.jpg'), a);
    fs.writeFileSync(path.join(first, 'day2', 'copy-of-a.jpg'), a);
    fs.writeFileSync(path.join(first, 'b.png'), await png(2));
    fs.writeFileSync(path.join(first, 'really-a-png.jpg'), await png(3));
    fs.writeFileSync(path.join(first, 'clip.heic'), fakeMp4());
    fs.writeFileSync(path.join(first, 'notes.txt'), 'not a photo');
    fs.writeFileSync(path.join(second, 'a.jpg'), a);

    const job1 = await json<ImportProgress>(t, 'POST', '/api/imports/folder', { path: first });
    assert.equal(job1.status, 201);
    await t.services.imports.idle();
    const p1 = (await json<ImportProgress>(t, 'GET', `/api/jobs/${job1.body.id}`)).body;
    assert.equal(p1.state, 'completed');
    assert.equal(p1.albumName, 'Holiday');
    assert.deepEqual(p1.counts, { total: 5, imported: 3, skipped: 2, failed: 0, pending: 0 });
    assert.deepEqual(p1.problems, [{ filename: 'clip.heic', state: 'skipped', reason: 'unsupported_format' }]);

    const job2 = await json<ImportProgress>(t, 'POST', '/api/imports/folder', { path: second });
    await t.services.imports.idle();
    const p2 = (await json<ImportProgress>(t, 'GET', `/api/jobs/${job2.body.id}`)).body;
    assert.equal(p2.albumName, 'Holiday (2)');
    assert.equal(p2.counts.imported, 1);

    // Three distinct byte sequences → three originals, even though "a" is in two albums.
    assert.equal(countFiles(path.join(t.env.dataDir, 'objects')), 3);

    const holiday = await albumPhotoIds(t, p1.albumId!);
    const details = await Promise.all(holiday.map(async (id) => (await json<PhotoDetail>(t, 'GET', `/api/photos/${id}`)).body));
    const disguised = details.find((d) => d.filename === 'really-a-png.jpg')!;
    assert.equal(disguised.format, 'png');
    const shared = details.find((d) => d.filename === 'a.jpg')!;
    assert.deepEqual(shared.albums.map((x) => x.name), ['Holiday', 'Holiday (2)']);

    fs.rmSync(path.join(t.dir, 'src1'), { recursive: true });
    fs.rmSync(path.join(t.dir, 'src2'), { recursive: true });
    for (const kind of ['original', 'display', 'thumbnail']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/photos/${shared.id}/${kind}` });
      assert.equal(res.statusCode, 200, kind);
    }
  });

  test('rejects paths that are not absolute folders', async () => {
    assert.equal((await json(t, 'POST', '/api/imports/folder', { path: 'relative/dir' })).status, 400);
    assert.equal((await json(t, 'POST', '/api/imports/folder', { path: path.join(t.dir, 'missing') })).status, 400);
  });
});

describe('browser uploads and memberships', () => {
  let t: T;
  before(async () => (t = await testApp()));
  after(async () => t.close());

  test('same bytes twice in one album are skipped; another album reuses the object', async () => {
    const A = await createAlbum(t, 'A');
    const B = await createAlbum(t, 'B');
    const bytes = await jpeg(7).toBuffer();
    const pa = await uploadFiles(t, A, [
      { name: 'one.jpg', data: bytes },
      { name: 'again.jpg', data: bytes },
    ]);
    assert.equal(pa.state, 'completed');
    assert.equal(pa.counts.imported, 1);
    assert.equal(pa.counts.skipped, 1);
    const pb = await uploadFiles(t, B, [{ name: 'one.jpg', data: bytes }]);
    assert.equal(pb.counts.imported, 1);
    assert.equal((await albumPhotoIds(t, A)).length, 1);
    assert.equal((await albumPhotoIds(t, B)).length, 1);
    assert.equal(countFiles(path.join(t.env.dataDir, 'objects')), 1);
  });

  test('an interrupted upload pauses the job and lists files to reselect', async () => {
    const C = await createAlbum(t, 'C');
    const data = await jpeg(8).toBuffer();
    const job = await json<ImportProgress>(t, 'POST', '/api/imports', {
      albumId: C,
      files: [
        { key: 'x', name: 'x.jpg', size: data.length },
        { key: 'y', name: 'y.jpg', size: 10 },
      ],
    });
    const { payload, headers } = multipart('x.jpg', data);
    await t.app.inject({ method: 'POST', url: `/api/imports/${job.body.id}/files?itemKey=x`, payload, headers });
    const finished = (await json<ImportProgress>(t, 'POST', `/api/imports/${job.body.id}/finish`)).body;
    assert.equal(finished.state, 'paused');
    assert.deepEqual(finished.missingKeys, ['y']);
    assert.equal(finished.counts.pending, 1);
  });

  test('move into an album that already has the photo leaves exactly one membership', async () => {
    const A = await createAlbum(t, 'Move A');
    const B = await createAlbum(t, 'Move B');
    await uploadFiles(t, A, [{ name: 'm.jpg', data: await jpeg(9).toBuffer() }]);
    const [id] = await albumPhotoIds(t, A);
    assert.equal((await json(t, 'POST', `/api/photos/${id}/albums`, { albumId: B })).status, 200);
    const moved = await json<{ albums: { name: string }[] }>(t, 'POST', `/api/photos/${id}/move`, { fromAlbumId: A, toAlbumId: B });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.albums.map((a) => a.name), ['Move B']);
    assert.deepEqual(await albumPhotoIds(t, A), []);
    assert.deepEqual(await albumPhotoIds(t, B), [id]);
  });

  test('deleting an album keeps photos that are also elsewhere', async () => {
    const A = await createAlbum(t, 'Del A');
    const B = await createAlbum(t, 'Del B');
    await uploadFiles(t, A, [{ name: 'd.jpg', data: await jpeg(10).toBuffer() }]);
    const [id] = await albumPhotoIds(t, A);
    await json(t, 'POST', `/api/photos/${id}/albums`, { albumId: B });
    assert.equal((await json<{ orphaned: number }>(t, 'DELETE', `/api/albums/${A}`)).body.orphaned, 0);
    assert.deepEqual(await albumPhotoIds(t, B), [id]);
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/photos/${id}/original` })).statusCode, 200);
  });

  test('album names are unique regardless of case', async () => {
    await createAlbum(t, 'Travel');
    assert.equal((await json(t, 'POST', '/api/albums', { name: 'travel' })).status, 409);
    assert.equal((await json<{ name: string }>(t, 'GET', '/api/albums/name-suggestion?name=Travel')).body.name, 'Travel (2)');
  });
});

describe('last-reference cleanup', () => {
  let t: T;
  before(async () => (t = await testApp({ assetGraceMs: 60_000 })));
  after(async () => t.close());

  test('an unreferenced photo is hidden at once and deleted only after the grace period', async () => {
    const A = await createAlbum(t, 'Only');
    const res = await uploadFiles(t, A, [{ name: 'gone.jpg', data: await jpeg(11).toBuffer() }]);
    assert.equal(res.counts.imported, 1);
    const [id] = await albumPhotoIds(t, A);
    assert.equal((await json(t, 'DELETE', `/api/albums/${A}/photos/${id}`)).status, 200);

    assert.equal((await json(t, 'GET', `/api/photos/${id}`)).status, 404);
    assert.equal((await json<{ total: number }>(t, 'GET', '/api/photos')).body.total, 0);
    assert.equal(await t.services.gc.runOnce(), 0, 'still in grace period');
    assert.equal(countFiles(path.join(t.env.dataDir, 'objects')), 1);

    assert.equal(await t.services.gc.runOnce(Date.now() + 61_000), 1);
    assert.equal(countFiles(path.join(t.env.dataDir, 'objects')), 0);
    assert.equal(countFiles(path.join(t.env.dataDir, 'thumbnails')), 0);
    const queued = t.services.ctx.db.prepare('SELECT asset_id FROM n8n_purge_queue').pluck().all();
    assert.deepEqual(queued, [id]);
  });

  test('re-adding before cleanup keeps the photo', async () => {
    const A = await createAlbum(t, 'Back');
    const B = await createAlbum(t, 'Back again');
    await uploadFiles(t, A, [{ name: 'back.jpg', data: await jpeg(12).toBuffer() }]);
    const [id] = await albumPhotoIds(t, A);
    await json(t, 'DELETE', `/api/photos/${id}`);
    assert.equal((await json(t, 'GET', `/api/photos/${id}`)).status, 404);
    await uploadFiles(t, B, [{ name: 'back.jpg', data: await jpeg(12).toBuffer() }]);
    assert.equal(await t.services.gc.runOnce(Date.now() + 61_000), 0);
    assert.equal((await json(t, 'GET', `/api/photos/${id}`)).status, 200);
  });
});

describe('formats and metadata', () => {
  let t: T;
  before(async () => (t = await testApp()));
  after(async () => t.close());

  test('EXIF orientation, camera, and absent metadata', async () => {
    const A = await createAlbum(t, 'Meta');
    const rotated = await jpeg(20, 64, 48)
      .withExif({ IFD0: { Make: 'Canon', Model: 'EOS R6' } })
      .withMetadata({ orientation: 6 }) // sharp writes Orientation itself; an IFD0 value would be replaced
      .toBuffer();
    await uploadFiles(t, A, [
      { name: 'rotated.jpg', data: rotated },
      { name: 'plain.png', data: await png(21) },
    ]);
    const ids = await albumPhotoIds(t, A);
    const details = await Promise.all(ids.map(async (id) => (await json<PhotoDetail>(t, 'GET', `/api/photos/${id}`)).body));
    const r = details.find((d) => d.filename === 'rotated.jpg')!;
    assert.deepEqual([r.width, r.height], [48, 64]);
    assert.deepEqual(r.camera, { make: 'Canon', model: 'EOS R6' });
    const p = details.find((d) => d.filename === 'plain.png')!;
    assert.equal(p.takenAt, null);
    assert.equal(p.camera, null);
    assert.equal(p.location, null);
  });

  test('HEIC is stored as-is and displayed through a JPEG derivative', async (ctx) => {
    const data = await heic(t.dir, 30);
    if (!data) return ctx.skip('heif-enc not installed');
    const A = await createAlbum(t, 'iPhone');
    const res = await uploadFiles(t, A, [{ name: 'IMG_0001.HEIC', data }]);
    assert.equal(res.counts.imported, 1, JSON.stringify(res.problems));
    const [id] = await albumPhotoIds(t, A);
    const detail = (await json<PhotoDetail>(t, 'GET', `/api/photos/${id}`)).body;
    assert.equal(detail.format, 'heic');
    const display = await t.app.inject({ method: 'GET', url: `/api/photos/${id}/display` });
    assert.equal(display.headers['content-type'], 'image/jpeg');
    const original = await t.app.inject({ method: 'GET', url: `/api/photos/${id}/original` });
    assert.ok(original.rawPayload.equals(data), 'original bytes unchanged');
  });

  test('a manual description is searchable immediately', async () => {
    const A = await createAlbum(t, 'Words');
    await uploadFiles(t, A, [{ name: 'w.jpg', data: await jpeg(40).toBuffer() }]);
    const [id] = await albumPhotoIds(t, A);
    const res = await json<PhotoDetail>(t, 'PATCH', `/api/photos/${id}/description`, { manualCaption: 'Lighthouse at dusk' });
    assert.equal(res.body.description?.effective, 'Lighthouse at dusk');
    const hits = t.services.ctx.db.prepare(`SELECT asset_id FROM photo_fts WHERE photo_fts MATCH ?`).pluck().all('lighthou*');
    assert.deepEqual(hits, [id]);
  });

  test('detail context follows the album order', async () => {
    const A = await createAlbum(t, 'Order');
    await uploadFiles(t, A, [
      { name: '1.jpg', data: await jpeg(51).toBuffer() },
      { name: '2.jpg', data: await jpeg(52).toBuffer() },
      { name: '3.jpg', data: await jpeg(53).toBuffer() },
    ]);
    const ids = await albumPhotoIds(t, A);
    const ctx = (await json<{ index: number; total: number; prevId: string | null; nextId: string | null }>(t, 'GET', `/api/photos/${ids[1]}/context?album=${A}`)).body;
    assert.deepEqual([ctx.index, ctx.total, ctx.prevId, ctx.nextId], [1, 3, ids[0], ids[2]]);
  });
});

describe('idempotency keys', () => {
  test('a repeated request returns the first response; a reused key for another request is rejected', async () => {
    const t = await testApp();
    try {
      const send = (name: string, key: string) =>
        t.app.inject({ method: 'POST', url: '/api/albums', payload: { name }, headers: { 'idempotency-key': key } });
      const first = await send('Retry me', 'key-0000000001');
      const again = await send('Retry me', 'key-0000000001');
      assert.equal(first.statusCode, 201);
      assert.equal(again.statusCode, 201);
      assert.equal(again.headers['idempotent-replayed'], 'true');
      assert.equal(JSON.parse(again.body).id, JSON.parse(first.body).id);
      assert.equal(t.services.ctx.db.prepare(`SELECT count(*) FROM albums`).pluck().get(), 1);
      assert.equal((await send('Something else', 'key-0000000001')).statusCode, 409);
    } finally {
      await t.close();
    }
  });
});
