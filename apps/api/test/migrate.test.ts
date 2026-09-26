import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-test-'));
  return { db: openDatabase(path.join(dir, 'album.sqlite')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('migrations apply once and are idempotent', () => {
  const { db, cleanup } = tempDb();
  try {
    assert.deepEqual(migrate(db), ['0001_init.sql']);
    assert.deepEqual(migrate(db), []);
    assert.equal(db.prepare('SELECT count(*) FROM model_config').pluck().get(), 1);
  } finally {
    db.close();
    cleanup();
  }
});

test('an asset cannot appear twice in one album but can be in several', () => {
  const { db, cleanup } = tempDb();
  try {
    migrate(db);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO albums VALUES (?, ?, ?, ?)').run('a', 'Holiday', now, now);
    db.prepare('INSERT INTO albums VALUES (?, ?, ?, ?)').run('b', 'Family', now, now);
    db.prepare(`INSERT INTO assets (id, sha256, object_key, format, mime, byte_size, created_at)
                VALUES ('x', 'abc', 'objects/ab/abc', 'jpeg', 'image/jpeg', 10, ?)`).run(now);
    const link = db.prepare('INSERT INTO album_assets VALUES (?, ?, ?, ?)');
    link.run('a', 'x', 'beach.jpg', now);
    link.run('b', 'x', 'beach.jpg', now);
    assert.throws(() => link.run('a', 'x', 'beach.jpg', now), /UNIQUE|PRIMARY KEY/);
    assert.throws(() => db.prepare('INSERT INTO albums VALUES (?, ?, ?, ?)').run('c', 'holiday', now, now), /UNIQUE/);

    // Deleting album A keeps the asset and its membership in B.
    db.prepare('DELETE FROM albums WHERE id = ?').run('a');
    assert.equal(db.prepare('SELECT count(*) FROM album_assets WHERE asset_id = ?').pluck().get('x'), 1);
  } finally {
    db.close();
    cleanup();
  }
});

test('FTS5 prefix search works on the photo index', () => {
  const { db, cleanup } = tempDb();
  try {
    migrate(db);
    db.prepare('INSERT INTO photo_fts (asset_id, caption, tags, filenames) VALUES (?, ?, ?, ?)')
      .run('x', 'Colorful houses on a cliff above the sea', 'coast village', 'cinque-terre.jpg');
    const hits = db.prepare(`SELECT asset_id FROM photo_fts WHERE photo_fts MATCH ?`).pluck().all('clif*');
    assert.deepEqual(hits, ['x']);
  } finally {
    db.close();
    cleanup();
  }
});
