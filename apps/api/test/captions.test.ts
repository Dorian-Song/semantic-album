import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { heic, jpeg, multipart, testApp } from './helpers.js';

type T = Awaited<ReturnType<typeof testApp>>;

interface Seen {
  path: string;
  auth: string | undefined;
  body: { model: string; input: { content: { type: string; image_url?: string }[] }[]; text: { format: { type: string } } };
}

/** A stand-in for DeepSeek (/responses) and OpenAI (/v1/responses) with scripted replies. */
function mockProvider() {
  const seen: Seen[] = [];
  const replies: Record<string, ((n: number) => { status: number; body: unknown }) | undefined> = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push({ path, auth: req.headers.authorization, body: JSON.parse(raw) });
      const count = seen.filter((s) => s.path === path).length;
      const reply = replies[path]?.(count) ?? { status: 500, body: { error: { message: 'no script' } } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return { server, seen, replies };
}

const ok = (caption: string, tags: string[], model = 'deepseek-flash') => ({
  status: 200,
  body: { id: 'resp_1', status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ caption, tags }) }] }] },
});

describe('AI descriptions', () => {
  const mock = mockProvider();
  let base = '';
  let t: T;

  before(async () => {
    await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => mock.server.close(() => r())));

  beforeEach(async () => {
    mock.seen.length = 0;
    for (const k of Object.keys(mock.replies)) delete mock.replies[k];
  });

  async function setup(extra: object = {}) {
    t = await testApp({}, { baseDelayMs: 5 });
    t.services.tasks.start();
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { captionsEnabled: true, deepseek: { baseUrl: base, apiKey: 'sk-deepseek-test-1234' }, ...extra },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  async function importOne(name: string, data: Buffer): Promise<string> {
    const album = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/albums', payload: { name: `A ${name}` } })).body).id as string;
    const job = JSON.parse((await t.app.inject({ method: 'POST', url: '/api/imports', payload: { albumId: album, files: [{ key: name, name, size: data.length }] } })).body);
    const { payload, headers } = multipart(name, data);
    await t.app.inject({ method: 'POST', url: `/api/imports/${job.id}/files?itemKey=${name}`, payload, headers });
    return (t.services.ctx.db.prepare(`SELECT asset_id FROM import_items WHERE job_id = ?`).pluck().get(job.id) as string);
  }

  async function detail(id: string) {
    return JSON.parse((await t.app.inject({ method: 'GET', url: `/api/photos/${id}` })).body);
  }

  test('settings never return saved secrets', async () => {
    await setup();
    try {
      const s = JSON.parse((await t.app.inject({ method: 'GET', url: '/api/settings' })).body);
      assert.deepEqual(s.deepseek.apiKey, { saved: true, last4: '1234' });
      assert.ok(!JSON.stringify(s).includes('sk-deepseek-test'));
      await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { deepseek: { apiKey: null } } });
      assert.equal(JSON.parse((await t.app.inject({ method: 'GET', url: '/api/settings' })).body).deepseek.apiKey.saved, false);
      assert.equal((await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { deepseek: { baseUrl: 'ftp://x' } } })).statusCode, 400);
    } finally {
      await t.close();
    }
  });

  test('DeepSeek writes the AI draft, tags become searchable, and enrichment is queued', async () => {
    mock.replies['/responses'] = () => ok('A golden retriever running on a sandy beach at sunset.', ['dog', 'beach', 'sunset']);
    await setup();
    try {
      const id = await importOne('dog.jpg', await jpeg(1).toBuffer());
      await t.services.tasks.idle();
      const d = await detail(id);
      assert.equal(d.description.ai, 'A golden retriever running on a sandy beach at sunset.');
      assert.deepEqual(d.description.tags, ['dog', 'beach', 'sunset']);
      assert.equal(d.description.provider, 'deepseek');
      assert.equal(d.processing.caption.state, 'succeeded');
      assert.equal(d.processing.enrichment.state, 'pending');

      const req = mock.seen[0]!;
      assert.equal(req.auth, 'Bearer sk-deepseek-test-1234');
      assert.equal(req.body.model, 'deepseek-flash');
      assert.equal(req.body.text.format.type, 'json_object');
      assert.ok(req.body.input[0]!.content[1]!.image_url!.startsWith('data:image/jpeg;base64,'));

      const hits = t.services.ctx.db.prepare(`SELECT asset_id FROM photo_fts WHERE photo_fts MATCH ?`).pluck().all('retriever');
      assert.deepEqual(hits, [id]);
    } finally {
      await t.close();
    }
  });

  test('HEIC is sent as its JPEG derivative', async (ctx) => {
    mock.replies['/responses'] = () => ok('A red square.', ['red']);
    await setup();
    try {
      const data = await heic(t.dir, 5);
      if (!data) return ctx.skip('heif-enc not installed');
      await importOne('IMG.HEIC', data);
      await t.services.tasks.idle();
      assert.ok(mock.seen[0]!.body.input[0]!.content[1]!.image_url!.startsWith('data:image/jpeg;base64,'));
    } finally {
      await t.close();
    }
  });

  test('OpenAI is used only when DeepSeek cannot process the photo', async () => {
    mock.replies['/responses'] = () => ({ status: 400, body: { error: { message: 'unsupported image' } } });
    mock.replies['/v1/responses'] = () => ok('A cat asleep on a sofa.', ['cat', 'sofa'], 'gpt-test');
    await setup({ openai: { baseUrl: `${base}/v1`, apiKey: 'sk-openai-test-9999', model: 'gpt-test', fallbackEnabled: true } });
    try {
      const id = await importOne('cat.jpg', await jpeg(2).toBuffer());
      await t.services.tasks.idle();
      const d = await detail(id);
      assert.equal(d.description.provider, 'openai');
      assert.equal(d.processing.caption.provider, 'openai');
      assert.deepEqual(mock.seen.map((s) => s.path), ['/responses', '/v1/responses']);
      assert.equal(mock.seen[1]!.body.text.format.type, 'json_schema');
    } finally {
      await t.close();
    }
  });

  test('without a fallback, a rejected photo fails and can be retried', async () => {
    mock.replies['/responses'] = (n) => (n === 1 ? { status: 200, body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] } } : ok('A bicycle.', ['bicycle']));
    await setup();
    try {
      const id = await importOne('bike.jpg', await jpeg(3).toBuffer());
      await t.services.tasks.idle();
      assert.equal((await detail(id)).processing.caption.state, 'failed');
      assert.match((await detail(id)).processing.caption.error, /did not return JSON/);
      await t.app.inject({ method: 'POST', url: '/api/processing/caption/retry-failed' });
      await t.services.tasks.idle();
      assert.equal((await detail(id)).description.ai, 'A bicycle.');
    } finally {
      await t.close();
    }
  });

  test('transient errors are retried; a rejected key pauses the queue without spending attempts', async () => {
    mock.replies['/responses'] = (n) => (n < 3 ? { status: 503, body: { error: { message: 'busy' } } } : ok('A tram.', ['tram']));
    await setup();
    try {
      const id = await importOne('tram.jpg', await jpeg(4).toBuffer());
      await t.services.tasks.idle();
      assert.equal((await detail(id)).description.ai, 'A tram.');

      mock.replies['/responses'] = () => ({ status: 401, body: { error: { message: 'invalid key' } } });
      const other = await importOne('boat.jpg', await jpeg(5).toBuffer());
      await new Promise((r) => setTimeout(r, 100));
      const caption = t.services.tasks.summary().find((k) => k.kind === 'caption')!;
      assert.match(caption.pausedReason ?? '', /rejected the API key/);
      assert.equal(t.services.ctx.db.prepare(`SELECT attempts FROM processing_tasks WHERE asset_id = ? AND kind = 'caption'`).pluck().get(other), 0);
    } finally {
      await t.close();
    }
  });

  test('nothing is sent while AI descriptions are turned off', async () => {
    mock.replies['/responses'] = () => ok('x', []);
    await setup({ captionsEnabled: false });
    try {
      await importOne('private.jpg', await jpeg(6).toBuffer());
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(mock.seen.length, 0);
    } finally {
      await t.close();
    }
  });

  test('a manual description survives regenerating the AI draft', async () => {
    mock.replies['/responses'] = (n) => ok(n === 1 ? 'First draft about a lake.' : 'Second draft about a mountain lake.', ['lake']);
    await setup();
    try {
      const id = await importOne('lake.jpg', await jpeg(7).toBuffer());
      await t.services.tasks.idle();
      await t.app.inject({ method: 'PATCH', url: `/api/photos/${id}/description`, payload: { manualCaption: 'Our cabin trip, day one' } });
      const res = await t.app.inject({ method: 'POST', url: `/api/photos/${id}/caption` });
      assert.equal(res.statusCode, 202);
      await t.services.tasks.idle();
      const d = await detail(id);
      assert.equal(d.description.manual, 'Our cabin trip, day one');
      assert.equal(d.description.effective, 'Our cabin trip, day one');
      assert.equal(d.description.ai, 'Second draft about a mountain lake.');
      const hits = t.services.ctx.db.prepare(`SELECT asset_id FROM photo_fts WHERE photo_fts MATCH ?`).pluck().all('cabin');
      assert.deepEqual(hits, [id]);
      const revisions = t.services.ctx.db.prepare(`SELECT revision FROM processing_tasks WHERE asset_id = ? AND kind = 'enrichment' ORDER BY revision`).pluck().all(id);
      assert.deepEqual(revisions, [1, 2]);
    } finally {
      await t.close();
    }
  });
});
