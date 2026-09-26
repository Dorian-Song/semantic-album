import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { jpeg, multipart, testApp } from './helpers.js';

test('export: each original once, byte for byte, with XMP sidecars and every album name', async () => {
  const t = await testApp();
  try {
    const mk = async (name: string) => JSON.parse((await t.app.inject({ method: 'POST', url: '/api/albums', payload: { name } })).body).id as string;
    const A = await mk('Trip');
    const B = await mk('Best of');
    const upload = async (albumId: string, files: { name: string; data: Buffer }[]) => {
      const job = JSON.parse(
        (await t.app.inject({ method: 'POST', url: '/api/imports', payload: { albumId, files: files.map((f, i) => ({ key: String(i), name: f.name, size: f.data.length })) } })).body,
      );
      for (const [i, f] of files.entries()) {
        const { payload, headers } = multipart(f.name, f.data);
        await t.app.inject({ method: 'POST', url: `/api/imports/${job.id}/files?itemKey=${i}`, payload, headers });
      }
    };
    const shared = await jpeg(1).toBuffer();
    const other = await jpeg(2).toBuffer();
    await upload(A, [{ name: 'beach.jpg', data: shared }]);
    await upload(B, [
      { name: 'beach.jpg', data: other },
      { name: 'best-beach.jpg', data: shared },
    ]);
    const sharedId = t.services.ctx.db.prepare(`SELECT id FROM assets WHERE byte_size = ?`).pluck().get(shared.length) as string;
    await t.app.inject({ method: 'PATCH', url: `/api/photos/${sharedId}/description`, payload: { manualCaption: 'Sunset at the "old" pier & café' } });

    const created = await t.app.inject({ method: 'POST', url: '/api/exports', payload: { albumIds: [A, B] } });
    assert.equal(created.statusCode, 201, created.body);
    const id = JSON.parse(created.body).id;
    let state = '';
    for (let i = 0; i < 100 && state !== 'completed'; i++) {
      state = JSON.parse((await t.app.inject({ method: 'GET', url: `/api/exports/${id}` })).body).state;
      if (state !== 'completed') await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(state, 'completed');

    const res = await t.app.inject({ method: 'GET', url: `/api/exports/${id}/download` });
    assert.equal(res.headers['content-type'], 'application/zip');
    const files = unzipSync(new Uint8Array(res.rawPayload));
    const photos = Object.keys(files).filter((f) => f.startsWith('album-export/photos/') && !f.endsWith('.xmp')).sort();
    assert.deepEqual(photos, ['album-export/photos/beach (2).jpg', 'album-export/photos/beach.jpg']);

    const meta = JSON.parse(strFromU8(files['album-export/metadata.json']!)) as { photos: { file: string; sha256: string; albums: string[]; description: string }[] };
    const sharedRecord = meta.photos.find((p) => p.description?.startsWith('Sunset'))!;
    assert.deepEqual(sharedRecord.albums, ['Best of', 'Trip']);
    assert.ok(Buffer.from(files[`album-export/${sharedRecord.file}`]!).equals(shared), 'original bytes unchanged');
    const xmp = strFromU8(files[`album-export/${sharedRecord.file}.xmp`]!);
    assert.match(xmp, /Sunset at the &quot;old&quot; pier &amp; café/);
    assert.match(strFromU8(files['album-export/metadata.csv']!), /"Sunset at the ""old"" pier & café"/);

    assert.equal((await t.app.inject({ method: 'POST', url: '/api/exports', payload: { albumIds: [A], assetIds: [sharedId] } })).statusCode, 400);
    assert.equal(await t.services.exports.removeExpired(Date.now() + 25 * 3600_000), 1);
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/exports/${id}` })).statusCode, 404);
  } finally {
    await t.close();
  }
});
