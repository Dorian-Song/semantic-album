import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import type { Embedder } from '../src/inference/embedder.js';
import type { SearchResponse } from '../src/search/search-service.js';
import { editDistance, queryTerms } from '../src/search/lexical-search.js';
import { multipart, testApp } from './helpers.js';

type T = Awaited<ReturnType<typeof testApp>>;

/** Photos embed as their mean colour; the words red/green/blue embed as pure colour directions. */
const colourEmbedder: Embedder = {
  modelId: 'test/colour',
  revision: '1',
  dimension: 3,
  async embedQuery(text) {
    const t = text.toLowerCase();
    return Float32Array.from([t.includes('red') ? 1 : 0.05, t.includes('green') ? 1 : 0.05, t.includes('blue') ? 1 : 0.05]);
  },
  async embedImage(jpeg) {
    const { channels } = await sharp(jpeg).stats();
    return Float32Array.from(channels.slice(0, 3).map((c) => c.mean + 1));
  },
};

async function solid(r: number, g: number, b: number, exif?: { make: string; model: string; date: string }) {
  let img = sharp({ create: { width: 48, height: 48, channels: 3, background: { r, g, b } } }).jpeg();
  if (exif) img = img.withExif({ IFD0: { Make: exif.make, Model: exif.model }, IFD2: { DateTimeOriginal: exif.date } });
  return img.toBuffer();
}

describe('search', () => {
  let t: T;
  const ids: Record<string, string> = {};
  const albums: Record<string, string> = {};

  async function album(name: string) {
    albums[name] = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/albums', payload: { name } })).body).id;
  }
  async function add(albumName: string, key: string, data: Buffer, caption: string) {
    const job = JSON.parse(
      (await t.app.inject({ method: 'POST', url: '/api/imports', payload: { albumId: albums[albumName], files: [{ key, name: `${key}.jpg`, size: data.length }] } })).body,
    );
    const { payload, headers } = multipart(`${key}.jpg`, data);
    await t.app.inject({ method: 'POST', url: `/api/imports/${job.id}/files?itemKey=${key}`, payload, headers });
    ids[key] = t.services.ctx.db.prepare(`SELECT asset_id FROM import_items WHERE job_id = ?`).pluck().get(job.id) as string;
    await t.app.inject({ method: 'PATCH', url: `/api/photos/${ids[key]}/description`, payload: { manualCaption: caption } });
  }
  async function search(body: object): Promise<SearchResponse> {
    const res = await t.app.inject({ method: 'POST', url: '/api/search', payload: body });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as SearchResponse;
  }

  before(async () => {
    t = await testApp({}, {}, undefined, true, colourEmbedder);
    await album('Holiday');
    await album('Garden');
    await add('Holiday', 'firetruck', await solid(220, 20, 20, { make: 'Fujifilm', model: 'X-T4', date: '2025:07:10 12:00:00' }), 'A fire truck parked on a street');
    await add('Holiday', 'lake', await solid(20, 40, 220, { make: 'Apple', model: 'iPhone 15', date: '2024:05:01 09:30:00' }), 'A calm lake under a clear sky');
    await add('Garden', 'lawn', await solid(30, 200, 40), 'Freshly mown green lawn with a green garden chair');
    // The lake photo is also in Garden: one result, both album names.
    await t.app.inject({ method: 'POST', url: `/api/photos/${ids.lake}/albums`, payload: { albumId: albums.Garden } });
    await t.services.tasks.idle();
  });
  after(async () => t.close());

  test('query terms drop stop words; edit distance is bounded', () => {
    assert.deepEqual(queryTerms('Show me photos of the dog on a beach!'), ['dog', 'beach']);
    assert.equal(editDistance('retreiver', 'retriever', 2), 2);
    assert.equal(editDistance('cat', 'elephant', 2), 3);
  });

  test('Words: prefix match, one result per photo with every album name', async () => {
    const r = await search({ query: 'clea', mode: 'words' }); // prefix of "clear" (4+ letters)
    assert.deepEqual(r.items.map((i) => i.id), [ids.lake]);
    assert.deepEqual(r.items[0]!.albums.map((a) => a.name), ['Garden', 'Holiday']);
    assert.deepEqual(r.items[0]!.matchedBy, ['words']);
  });

  test('Words: scope limits where a photo qualifies, not which albums are listed', async () => {
    const inHoliday = await search({ query: 'lake', mode: 'words', albumIds: [albums.Holiday] });
    assert.deepEqual(inHoliday.items[0]!.albums.map((a) => a.name), ['Garden', 'Holiday']);
    const truckInGarden = await search({ query: 'truck', mode: 'words', albumIds: [albums.Garden] });
    assert.equal(truckInGarden.total, 0);
  });

  test('Words: a misspelt word is corrected to a close indexed word', async () => {
    const r = await search({ query: 'firre truk', mode: 'words' });
    assert.deepEqual(r.items.map((i) => i.id), [ids.firetruck]);
    assert.deepEqual(r.corrections, [
      { from: 'firre', to: 'fire' },
      { from: 'truk', to: 'truck' },
    ]);
    // "grden" is one edit from both "garden" and "green"; the dropped-letter reading wins.
    const g = await search({ query: 'grden', mode: 'words' });
    assert.deepEqual(g.corrections, [{ from: 'grden', to: 'garden' }]);
  });

  test('Meaning: ranks by image similarity to the query', async () => {
    const r = await search({ query: 'something green', mode: 'meaning' });
    assert.equal(r.meaning, 'ok');
    assert.equal(r.items[0]!.id, ids.lawn);
    assert.deepEqual(r.items[0]!.matchedBy, ['meaning']);
  });

  test('Both: fuses the two rankings and shows each photo once', async () => {
    const r = await search({ query: 'blue lake', mode: 'both' });
    assert.equal(r.items[0]!.id, ids.lake);
    assert.deepEqual(r.items[0]!.matchedBy, ['words', 'meaning']);
    assert.equal(new Set(r.items.map((i) => i.id)).size, r.items.length);
  });

  test('capture-date and camera filters exclude photos without that metadata and say so', async () => {
    const r = await search({ query: 'a', mode: 'meaning', takenFrom: '2025-01-01', takenTo: '2025-12-31' });
    assert.deepEqual(r.items.map((i) => i.id), [ids.firetruck]);
    assert.equal(r.excludedForMissingMetadata, 1);
    const cam = await search({ query: 'blue', mode: 'meaning', camera: 'iPhone 15' });
    assert.deepEqual(cam.items.map((i) => i.id), [ids.lake]);
    const facets = JSON.parse((await t.app.inject({ method: 'GET', url: '/api/search/facets' })).body);
    assert.deepEqual(facets.taken, { earliest: '2024-05-01', latest: '2025-07-10', withDate: 2, withoutDate: 1 });
    assert.equal(facets.cameras.length, 2);
  });

  test('photos without a membership are not found', async () => {
    const extra = await search({ query: 'chair', mode: 'words' });
    assert.deepEqual(extra.items.map((i) => i.id), [ids.lawn]);
    await t.app.inject({ method: 'DELETE', url: `/api/photos/${ids.lawn}` });
    assert.equal((await search({ query: 'chair', mode: 'words' })).total, 0);
    assert.ok(!(await search({ query: 'green', mode: 'meaning' })).items.some((i) => i.id === ids.lawn));
  });
});

describe('search without the embedding model', () => {
  test('Meaning falls back to Words explicitly', async () => {
    const t = await testApp({ vllmEnabled: false });
    try {
      const res = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/search', payload: { query: 'anything', mode: 'meaning' } })).body) as SearchResponse;
      assert.equal(res.meaning, 'unavailable');
      assert.equal(res.fallbackToWords, true);
      assert.match(res.meaningReason ?? '', /turned off/);
    } finally {
      await t.close();
    }
  });
});

describe('embedding index model guard', () => {
  test('an empty index adopts the current model; a non-empty one refuses a different model', async () => {
    const t = await testApp({}, {}, undefined, true, colourEmbedder);
    try {
      const db = t.services.ctx.db;
      db.prepare(`INSERT INTO embedding_meta VALUES (1, 'old/model', 'x', 3, '2020-01-01')`).run();
      const album = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/albums', payload: { name: 'G' } })).body).id;
      const data = await solid(10, 10, 200);
      const job = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/imports', payload: { albumId: album, files: [{ key: 'k', name: 'k.jpg', size: data.length }] } })).body);
      const { payload, headers } = multipart('k.jpg', data);
      await t.app.inject({ method: 'POST', url: `/api/imports/${job.id}/files?itemKey=k`, payload, headers });
      await t.services.tasks.idle();
      assert.equal(db.prepare('SELECT model_id FROM embedding_meta').pluck().get(), 'test/colour');
      assert.equal(db.prepare('SELECT count(*) FROM photo_vectors').pluck().get(), 1);

      db.prepare(`UPDATE embedding_meta SET model_id = 'other/model'`).run();
      await t.app.inject({ method: 'POST', url: '/api/processing/embedding/retry-failed' });
      const id = db.prepare('SELECT asset_id FROM photo_vectors').pluck().get() as string;
      t.services.tasks.enqueueNextRevision(id, 'embedding');
      await new Promise((r) => setTimeout(r, 100));
      const k = t.services.tasks.summary().find((s) => s.kind === 'embedding')!;
      assert.match(k.pausedReason ?? '', /must be rebuilt/);
    } finally {
      await t.close();
    }
  });
});
