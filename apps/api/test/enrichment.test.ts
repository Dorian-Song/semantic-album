import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { jpeg, multipart, testApp } from './helpers.js';

type T = Awaited<ReturnType<typeof testApp>>;

/** Runs the workflow's real Code node script, as n8n would for one item. */
const normalizeSource = fs.readFileSync(new URL('../../../automation/n8n/code/normalize-caption.js', import.meta.url), 'utf8');
function normalize(body: unknown): { valid: boolean; error?: string; row?: Record<string, string | number> } {
  return (new Function('$json', normalizeSource)({ body }) as { json: never }).json;
}

/** Mock n8n: the workflow's contract (auth, validation, upsert by key, read back, purge) over an in-memory table. */
function mockN8n(secret: string) {
  const table = new Map<string, Record<string, string | number> & { id: number }>();
  const calls: { path: string; body: { assetId: string } }[] = [];
  let nextId = 1;
  let forceStatus: number | null = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-album-secret'] !== secret) return send(403, { message: 'Authorization data is wrong!' });
      const body = JSON.parse(raw);
      calls.push({ path: req.url ?? '', body });
      if (forceStatus) return send(forceStatus, { error: 'forced' });
      if (req.url === '/webhook/album-enrichment/purge') {
        let deleted = 0;
        for (const [k, r] of table) if (r.assetId === body.assetId) (table.delete(k), deleted++);
        return send(200, { assetId: body.assetId, deleted });
      }
      const out = normalize(body);
      if (!out.valid) return send(422, { error: out.error });
      const row = out.row!;
      const stored: Record<string, string | number> & { id: number } = { ...row, id: table.get(String(row.key))?.id ?? nextId++ };
      table.set(String(row.key), stored);
      const list = (v: unknown) => (v ? String(v).split(', ') : []);
      send(200, { ...stored, tags: list(stored.tags), keywords: list(stored.keywords), categories: list(stored.categories), rowId: stored.id, storedAt: new Date().toISOString() });
    });
  });
  return { server, table, calls, force: (s: number | null) => (forceStatus = s) };
}

function mockDeepSeek() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const text = JSON.stringify({ caption: 'a brown dog   asleep on a sofa in a cosy living room', tags: ['Dog', 'sofa', 'dog'] });
      res.end(JSON.stringify({ status: 'completed', model: 'deepseek-flash', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }));
    });
  });
}

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

describe('n8n Code node script', () => {
  test('rejects malformed input and derives categories', () => {
    assert.deepEqual(normalize({ assetId: 'a b', revision: 1, caption: 'x' }), { valid: false, error: 'assetId must be an ID string' });
    assert.equal(normalize({ assetId: 'a', revision: 0, caption: 'x' }).valid, false);
    assert.equal(normalize({ assetId: 'a', revision: 1, caption: '   ' }).valid, false);
    const ok = normalize({ assetId: 'a1', revision: 2, caption: 'two  kids flying a kite on a beach', tags: ['Kite', 'beach', 'kite', 'the'] });
    assert.equal(ok.valid, true);
    assert.equal(ok.row!.key, 'a1:2');
    assert.equal(ok.row!.caption, 'Two kids flying a kite on a beach.');
    assert.equal(ok.row!.tags, 'kite, beach');
    assert.equal(ok.row!.categories, 'nature, sports');
  });
});

describe('enrichment through n8n', () => {
  const secret = 'test-secret-abcdef';
  const n8n = mockN8n(secret);
  const deepseek = mockDeepSeek();
  let n8nUrl = '';
  let dsUrl = '';
  before(async () => {
    n8nUrl = await listen(n8n.server);
    dsUrl = await listen(deepseek);
  });
  after(async () => {
    await new Promise((r) => n8n.server.close(r));
    await new Promise((r) => deepseek.close(r));
  });

  async function setup(webhookUrl: string): Promise<T> {
    const t = await testApp({ assetGraceMs: 1 }, { baseDelayMs: 5 });
    t.services.tasks.start();
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { captionsEnabled: true, deepseek: { baseUrl: dsUrl, apiKey: 'sk-test-deepseek' }, n8n: { webhookUrl, secret } },
    });
    return t;
  }

  async function importOne(t: T, seed: number): Promise<string> {
    const album = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/albums', payload: { name: `E${seed}` } })).body).id;
    const data = await jpeg(seed).toBuffer();
    const job = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/imports', payload: { albumId: album, files: [{ key: 'k', name: 'p.jpg', size: data.length }] } })).body);
    const { payload, headers } = multipart('p.jpg', data);
    await t.app.inject({ method: 'POST', url: `/api/imports/${job.id}/files?itemKey=k`, payload, headers });
    return t.services.ctx.db.prepare(`SELECT asset_id FROM import_items WHERE job_id = ?`).pluck().get(job.id) as string;
  }

  const detail = async (t: T, id: string) => JSON.parse((await t.app.inject({ method: 'GET', url: `/api/photos/${id}` })).body);
  const search = (t: T, q: string) => t.services.ctx.db.prepare(`SELECT asset_id FROM photo_fts WHERE photo_fts MATCH ?`).pluck().all(q);

  test('a caption is normalised by n8n, stored in its Data Table, and its categories become searchable', async () => {
    const t = await setup(`${n8nUrl}/webhook/album-enrichment`);
    try {
      const id = await importOne(t, 1);
      await t.services.tasks.idle();
      const d = await detail(t, id);
      assert.equal(d.processing.enrichment.state, 'succeeded');
      assert.equal(d.description.ai, 'A brown dog asleep on a sofa in a cosy living room.');
      assert.deepEqual(d.description.tags, ['dog', 'sofa']);
      assert.deepEqual(d.description.enrichment.categories, ['animals', 'indoor']);
      assert.equal(n8n.table.get(`${id}:1`)?.assetId, id);
      assert.deepEqual(search(t, 'animals'), [id]);
    } finally {
      await t.close();
    }
  });

  test('while n8n is down the raw caption stays searchable, and enrichment resumes once it is reachable', async () => {
    const t = await setup('http://127.0.0.1:1/webhook/album-enrichment');
    try {
      const id = await importOne(t, 2);
      await t.services.tasks.idle();
      await new Promise((r) => setTimeout(r, 50));
      const k = t.services.tasks.summary().find((s) => s.kind === 'enrichment')!;
      assert.equal(k.pausedReason, 'n8n is not reachable');
      assert.equal((await detail(t, id)).description.ai, 'a brown dog   asleep on a sofa in a cosy living room'.replace(/\s+/g, ' '));
      assert.deepEqual(search(t, 'sofa'), [id]);

      await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { n8n: { webhookUrl: `${n8nUrl}/webhook/album-enrichment` } } });
      await t.services.tasks.idle();
      assert.equal((await detail(t, id)).processing.enrichment.state, 'succeeded');
    } finally {
      await t.close();
    }
  });

  test('a rejected payload fails the task instead of retrying forever', async () => {
    const t = await setup(`${n8nUrl}/webhook/album-enrichment`);
    try {
      n8n.force(422);
      const id = await importOne(t, 3);
      await t.services.tasks.idle();
      const e = (await detail(t, id)).processing.enrichment;
      assert.equal(e.state, 'failed');
      assert.match(e.error, /n8n rejected the request/);
    } finally {
      n8n.force(null);
      await t.close();
    }
  });

  test('removing a photo from the library deletes its n8n rows, retrying while n8n is down', async () => {
    const t = await setup(`${n8nUrl}/webhook/album-enrichment`);
    try {
      const id = await importOne(t, 4);
      await t.services.tasks.idle();
      assert.ok(n8n.table.has(`${id}:1`));
      await t.app.inject({ method: 'DELETE', url: `/api/photos/${id}` });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(await t.services.gc.runOnce(), 1);

      n8n.force(503);
      await t.services.purge.runOnce();
      assert.equal(t.services.ctx.db.prepare(`SELECT attempts FROM n8n_purge_queue WHERE asset_id = ?`).pluck().get(id), 1);
      assert.ok(n8n.table.has(`${id}:1`));

      n8n.force(null);
      t.services.ctx.db.prepare(`UPDATE n8n_purge_queue SET next_attempt_at = NULL`).run();
      assert.equal(await t.services.purge.runOnce(), 1);
      assert.ok(![...n8n.table.values()].some((r) => r.assetId === id));
      assert.equal(t.services.ctx.db.prepare(`SELECT count(*) FROM n8n_purge_queue`).pluck().get(), 0);
    } finally {
      n8n.force(null);
      await t.close();
    }
  });

  test('the connection test writes, reads back, and removes a test row', async () => {
    const t = await setup(`${n8nUrl}/webhook/album-enrichment`);
    try {
      const r = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/settings/test-n8n' })).body);
      assert.equal(r.ok, true, r.message);
      assert.deepEqual(r.categories, ['animals', 'indoor']);
      assert.equal(r.cleanedUp, 1);
      assert.ok(![...n8n.table.values()].some((row) => row.assetId === 'album-connection-test'));
    } finally {
      await t.close();
    }
  });
});
