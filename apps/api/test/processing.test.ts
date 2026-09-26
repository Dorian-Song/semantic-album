import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { ImportProgress } from '../src/imports/import-service.js';
import { PermanentTaskError, ServiceUnavailableError, type ClaimedTask, type KindSummary } from '../src/processing/task-service.js';
import { reconcileStorage } from '../src/storage/reconcile.js';
import { countFiles, jpeg, testApp } from './helpers.js';

type T = Awaited<ReturnType<typeof testApp>>;

async function importFolder(t: T, name: string, count: number, seed = 0): Promise<ImportProgress> {
  const dir = path.join(t.dir, 'src', name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `p${i}.jpg`), await jpeg(seed + i).toBuffer());
  const res = await t.app.inject({ method: 'POST', url: '/api/imports/folder', payload: { path: dir } });
  assert.equal(res.statusCode, 201, res.body);
  await t.services.imports.idle();
  return progress(t, (JSON.parse(res.body) as ImportProgress).id);
}

async function progress(t: T, id: string): Promise<ImportProgress> {
  return JSON.parse((await t.app.inject({ method: 'GET', url: `/api/jobs/${id}` })).body) as ImportProgress;
}

function kind(t: T, k: string): KindSummary {
  return t.services.tasks.summary().find((s) => s.kind === k)!;
}

function taskRows(t: T, k: string) {
  return t.services.ctx.db.prepare(`SELECT state, attempts, error FROM processing_tasks WHERE kind = ?`).all(k) as { state: string; attempts: number; error: string | null }[];
}

describe('processing tasks', () => {
  test('a new photo queues caption and embedding without blocking the import', async () => {
    const t = await testApp();
    try {
      const job = await importFolder(t, 'Queue', 3);
      assert.equal(job.state, 'completed');
      assert.equal(job.counts.imported, 3);
      assert.deepEqual(job.processing.caption, { total: 3, done: 0, failed: 0 });
      assert.deepEqual(job.processing.embedding, { total: 3, done: 0, failed: 0 });
      assert.deepEqual(job.processing.enrichment, { total: 0, done: 0, failed: 0 });
      assert.equal(kind(t, 'embedding').registered, false);
      assert.equal(kind(t, 'embedding').pending, 3);
      assert.equal(kind(t, 'caption').pausedReason, 'AI descriptions are turned off in Settings');
      assert.ok(t.services.ctx.db.prepare(`SELECT attempts FROM processing_tasks WHERE kind = 'caption'`).pluck().all().every((a) => a === 0));
      assert.ok(job.timings && job.timings.stage.count === 3 && job.timings.ingest.p95Ms >= 0);
    } finally {
      await t.close();
    }
  });

  test('each kind runs independently within its own concurrency limit', async () => {
    const t = await testApp();
    try {
      await importFolder(t, 'Pool', 8);
      let running = 0;
      let peak = 0;
      t.services.tasks.register('embedding', {
        concurrency: () => 2,
        run: async () => {
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 15));
          running--;
          return { provider: 'fake' };
        },
      });
      await t.services.tasks.idle();
      assert.equal(peak, 2);
      assert.equal(kind(t, 'embedding').succeeded, 8);
      assert.equal(kind(t, 'caption').succeeded, 0, 'caption is paused and unaffected by the embedding pool');
    } finally {
      await t.close();
    }
  });

  test('transient errors back off and retry; permanent errors fail at once and can be retried', async () => {
    const t = await testApp();
    try {
      await importFolder(t, 'Retry', 2);
      const seen = new Map<string, number>();
      let permanentOnce = true;
      t.services.tasks.start();
      t.services.tasks.register('embedding', {
        concurrency: () => 1,
        run: async (task: ClaimedTask) => {
          const n = (seen.get(task.id) ?? 0) + 1;
          seen.set(task.id, n);
          if (permanentOnce && seen.size === 2) {
            permanentOnce = false;
            throw new PermanentTaskError('image rejected');
          }
          if (n < 3) throw new Error('timeout');
        },
      });
      await t.services.tasks.idle();
      assert.deepEqual(taskRows(t, 'embedding').map((r) => r.state).sort(), ['failed', 'succeeded']);
      assert.equal(taskRows(t, 'embedding').find((r) => r.state === 'succeeded')!.attempts, 3);

      assert.equal(t.services.tasks.retryFailed('embedding'), 1);
      await t.services.tasks.idle();
      assert.equal(kind(t, 'embedding').succeeded, 2);
    } finally {
      await t.close();
    }
  });

  test('an unavailable service pauses its kind without spending attempts', async () => {
    const t = await testApp();
    try {
      await importFolder(t, 'Down', 4);
      let calls = 0;
      t.services.tasks.register('caption', {
        concurrency: () => 4,
        run: async () => {
          calls++;
          throw new ServiceUnavailableError('No DeepSeek API key configured', 60_000);
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      const s = kind(t, 'caption');
      assert.equal(s.pausedReason, 'No DeepSeek API key configured');
      assert.equal(s.pending, 4);
      assert.ok(calls <= 4, `paused after the first failures, got ${calls} calls`);
      assert.ok(taskRows(t, 'caption').every((r) => r.attempts === 0));
    } finally {
      await t.close();
    }
  });
});

describe('restart recovery', () => {
  test('interrupted items and tasks resume without duplicates', async () => {
    const first = await testApp();
    const job = await importFolder(first, 'Crash', 5, 100);
    const db = first.services.ctx.db;
    // Simulate a crash: one item was committed but its outcome not recorded, one never started, one task mid-run.
    const items = db.prepare(`SELECT id FROM import_items WHERE job_id = ? ORDER BY rowid`).pluck().all(job.id) as string[];
    db.prepare(`UPDATE import_items SET state = 'running', reason = NULL WHERE id = ?`).run(items[0]);
    const fifth = db.prepare(`SELECT asset_id FROM import_items WHERE id = ?`).pluck().get(items[4]) as string;
    db.prepare(`UPDATE import_items SET state = 'pending', asset_id = NULL WHERE id = ?`).run(items[4]);
    db.prepare(`DELETE FROM album_assets WHERE asset_id = ?`).run(fifth);
    db.prepare(`UPDATE import_jobs SET state = 'running' WHERE id = ?`).run(job.id);
    db.prepare(`UPDATE processing_tasks SET state = 'running' WHERE kind = 'caption'`).run();
    await first.stop();

    const second = await testApp({}, {}, first.dir);
    try {
      assert.equal(second.services.tasks.recover(), 5);
      second.services.imports.recover();
      await second.services.imports.idle();
      const after = await progress(second, job.id);
      assert.equal(after.state, 'completed');
      assert.deepEqual(after.counts, { total: 5, imported: 5, skipped: 0, failed: 0, pending: 0 });
      assert.equal(countFiles(path.join(second.env.dataDir, 'objects')), 5);
      const members = second.services.ctx.db.prepare(`SELECT count(*) FROM album_assets WHERE album_id = ?`).pluck().get(after.albumId);
      assert.equal(members, 5);
      assert.equal(kind(second, 'caption').running, 0);
    } finally {
      await second.close();
    }
  });

  test('leftover staging files and unowned objects are cleaned; owned files are kept', async () => {
    const t = await testApp();
    try {
      await importFolder(t, 'Owned', 1, 200);
      const old = new Date(Date.now() - 2 * 3_600_000);
      const stray = path.join(t.env.dataDir, 'staging', 'crashed.part');
      const unowned = path.join(t.env.dataDir, 'objects', 'ab', 'ab'.padEnd(64, '0'));
      fs.writeFileSync(stray, 'partial');
      fs.mkdirSync(path.dirname(unowned), { recursive: true });
      fs.writeFileSync(unowned, 'orphan');
      for (const f of [stray, unowned]) fs.utimesSync(f, old, old);
      const fresh = path.join(t.env.dataDir, 'staging', 'in-flight.part');
      fs.writeFileSync(fresh, 'uploading');

      const res = await reconcileStorage(t.services.ctx, t.app.log);
      assert.deepEqual(res, { staging: 1, unowned: 1 });
      assert.ok(!fs.existsSync(stray) && !fs.existsSync(unowned));
      assert.ok(fs.existsSync(fresh), 'recent files may belong to work in progress');
      assert.equal(countFiles(path.join(t.env.dataDir, 'objects')), 1);
    } finally {
      await t.close();
    }
  });
});
