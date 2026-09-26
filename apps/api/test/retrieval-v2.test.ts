import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseCaptionJson } from '../src/adapters/vision-provider.js';
import type { Embedder } from '../src/inference/embedder.js';
import type { SearchResponse } from '../src/search/search-service.js';
import { jpeg, multipart, testApp } from './helpers.js';

type T = Awaited<ReturnType<typeof testApp>>;

describe('structured descriptions', () => {
  test('objects, kind, and transcribed text are parsed; missing fields stay empty', () => {
    const r = parseCaptionJson(
      JSON.stringify({ caption: 'A receipt.', objects: ['Receipt', 'receipt', 'pen'], tags: ['shopping', 'pen', 'Groceries!'], kind: 'Document', text: 'TOTAL   18.39\r\nVISA' }),
    );
    assert.deepEqual(r.objects, ['receipt', 'pen']);
    assert.deepEqual(r.tags, ['shopping', 'groceries'], 'tags repeating an object are dropped');
    assert.equal(r.kind, 'document');
    assert.equal(r.text, 'TOTAL 18.39\nVISA');
    const old = parseCaptionJson(JSON.stringify({ caption: 'A dog.', tags: ['dog'] }));
    assert.deepEqual([old.objects, old.kind, old.text], [[], null, null]);
    assert.equal(parseCaptionJson(JSON.stringify({ caption: 'x', kind: 'selfie', text: '' })).kind, null);
  });
});

/** Every text embeds to the same direction, so only lexical behaviour is under test here. */
const flat: Embedder = {
  modelId: 'test/flat',
  revision: '1',
  dimension: 2,
  embedQuery: async () => Float32Array.from([1, 0]),
  embedImage: async () => Float32Array.from([1, 0]),
};

describe('retrieval v2', () => {
  let t: T;
  const ids: Record<string, string> = {};

  async function add(key: string, seed: number, fields: { caption: string; objects?: string[]; text?: string; kind?: string }) {
    const album = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/albums', payload: { name: key } })).body).id;
    const data = await jpeg(seed).toBuffer();
    const job = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/imports', payload: { albumId: album, files: [{ key, name: `${key}.jpg`, size: data.length }] } })).body);
    const { payload, headers } = multipart(`${key}.jpg`, data);
    await t.app.inject({ method: 'POST', url: `/api/imports/${job.id}/files?itemKey=${key}`, payload, headers });
    const id = t.services.ctx.db.prepare(`SELECT asset_id FROM import_items WHERE job_id = ?`).pluck().get(job.id) as string;
    ids[key] = id;
    // Stand-in for a caption result, written the way CaptionWorker writes it.
    t.services.ctx.db
      .prepare(
        `INSERT INTO descriptions (asset_id, ai_caption, ai_tags, ai_objects, ai_text, ai_kind, provider, model, prompt_revision, updated_at)
         VALUES (?, ?, '[]', ?, ?, ?, 'deepseek', 'm', 2, '2026-01-01')`,
      )
      .run(id, fields.caption, JSON.stringify(fields.objects ?? []), fields.text ?? null, fields.kind ?? 'photo');
    const { refreshPhotoText } = await import('../src/search/fts-index.js');
    refreshPhotoText(t.services.ctx.db, id);
  }
  async function search(body: object): Promise<SearchResponse> {
    return JSON.parse((await t.app.inject({ method: 'POST', url: '/api/search', payload: body })).body) as SearchResponse;
  }

  before(async () => {
    t = await testApp({}, {}, undefined, true, flat);
    await add('skate', 1, { caption: 'A teenager on a skateboard at a skate park', objects: ['skateboard', 'helmet'] });
    await add('veg', 2, { caption: 'Fresh carrots on a cutting board', objects: ['carrot', 'knife'] });
    await add('shot', 3, { caption: 'A screenshot of a chat conversation', text: 'The lockbox code is 7351\nunit B-114', kind: 'screenshot' });
  });
  after(async () => t.close());

  test('stemming: "skateboarding" finds "skateboard"; "car" does not match "carrot"', async () => {
    assert.deepEqual((await search({ query: 'skateboarding', mode: 'words' })).items.map((i) => i.id), [ids.skate]);
    assert.equal((await search({ query: 'car', mode: 'words' })).total, 0);
    assert.deepEqual((await search({ query: 'carrots', mode: 'words' })).items.map((i) => i.id), [ids.veg]);
  });

  test('listed objects and transcribed text are searchable', async () => {
    assert.deepEqual((await search({ query: 'helmet', mode: 'words' })).items.map((i) => i.id), [ids.skate]);
    assert.deepEqual((await search({ query: 'lockbox 7351', mode: 'words' })).items.map((i) => i.id), [ids.shot]);
  });

  test('filter by image kind', async () => {
    const r = await search({ query: 'a', mode: 'meaning', kind: 'screenshot' });
    assert.deepEqual(r.items.map((i) => i.id), [ids.shot]);
    const facets = JSON.parse((await t.app.inject({ method: 'GET', url: '/api/search/facets' })).body);
    assert.deepEqual(facets.kinds, [
      { kind: 'photo', count: 2 },
      { kind: 'screenshot', count: 1 },
    ]);
  });

  test('editing a description re-embeds its text', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/photos/${ids.veg}/description`, payload: { manualCaption: 'Carrots for soup' } });
    await t.services.tasks.idle();
    assert.equal(t.services.ctx.db.prepare(`SELECT count(*) FROM photo_text_vectors WHERE asset_id = ?`).pluck().get(ids.veg), 1);
  });

  test('outdated descriptions can be refreshed with the current prompt', async () => {
    t.services.ctx.db.prepare(`UPDATE descriptions SET prompt_revision = 1 WHERE asset_id = ?`).run(ids.skate);
    const summary = JSON.parse((await t.app.inject({ method: 'GET', url: '/api/processing' })).body);
    assert.equal(summary.outdatedDescriptions, 1);
    const r = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/processing/caption/refresh-outdated' })).body);
    assert.equal(r.queued, 1);
  });
});
