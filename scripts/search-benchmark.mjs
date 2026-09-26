#!/usr/bin/env node
// Search quality and latency on COCO val2017, against a running Album backend.
//
//   1. Import datasets/coco/val2017 into Album (Import Folder) and let descriptions and embeddings finish.
//   2. node scripts/search-benchmark.mjs [--queries 500] [--api http://127.0.0.1:3200] [--out results.json]
//
// Each query is a human-written COCO caption of one photo in the library (not the AI description Album
// stored), so Words search is tested against independent phrasing. For every mode it reports how often the
// described photo is ranked 1st / in the top 5 / top 10, the mean reciprocal rank, and p50/p95 latency.
import fs from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const API = arg('api', 'http://127.0.0.1:3200');
const N = Number(arg('queries', 500));
const OUT = arg('out', null);
const CAPTIONS = new URL('../datasets/coco/annotations/captions_val2017.json', import.meta.url);

const coco = JSON.parse(fs.readFileSync(CAPTIONS, 'utf8'));
const fileOf = new Map(coco.images.map((i) => [i.id, i.file_name]));
const captionOf = new Map();
for (const a of coco.annotations) if (!captionOf.has(fileOf.get(a.image_id))) captionOf.set(fileOf.get(a.image_id), a.caption.trim());

// Library photos by filename (COCO file names are unique).
const idOf = new Map();
for (let offset = 0; ; offset += 200) {
  const page = await (await fetch(`${API}/api/photos?offset=${offset}&limit=200`)).json();
  for (const p of page.items) idOf.set(p.filename, p.id);
  if (offset + page.items.length >= page.total) break;
}
const targets = [...captionOf.keys()].filter((f) => idOf.has(f));
if (targets.length === 0) {
  console.error('No COCO val2017 photos found in the library. Import datasets/coco/val2017 first.');
  process.exit(1);
}
// Deterministic sample spread over the set.
const step = Math.max(1, Math.floor(targets.length / N));
const sample = targets.filter((_, i) => i % step === 0).slice(0, N);
const processing = await (await fetch(`${API}/api/processing`)).json();
console.log(`library: ${idOf.size} photos, ${targets.length} from COCO; ${sample.length} queries`);
for (const k of processing.kinds) console.log(`  ${k.kind}: ${k.succeeded} done, ${k.pending + k.running} pending, ${k.failed} failed`);

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const results = {};
for (const mode of ['words', 'meaning', 'both']) {
  const ranks = [];
  const wall = [];
  const server = [];
  let unavailable = 0;
  for (const file of sample) {
    const t = performance.now();
    const res = await fetch(`${API}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: captionOf.get(file), mode, limit: 10 }),
    });
    const r = await res.json();
    wall.push(performance.now() - t);
    server.push(r.timingsMs.total);
    if (r.fallbackToWords) unavailable++;
    const rank = r.items.findIndex((i) => i.id === idOf.get(file));
    ranks.push(rank < 0 ? Infinity : rank + 1);
  }
  const at = (k) => (100 * ranks.filter((r) => r <= k).length) / ranks.length;
  results[mode] = {
    recallAt1: at(1),
    recallAt5: at(5),
    recallAt10: at(10),
    mrrAt10: ranks.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / ranks.length,
    latencyMs: { p50: pct(wall, 0.5), p95: pct(wall, 0.95), serverP95: pct(server, 0.95) },
    fellBackToWords: unavailable,
  };
}

console.log('\nmode      R@1    R@5    R@10   MRR@10  p50 ms  p95 ms');
for (const [mode, r] of Object.entries(results)) {
  console.log(
    `${mode.padEnd(8)} ${r.recallAt1.toFixed(1).padStart(5)}  ${r.recallAt5.toFixed(1).padStart(5)}  ${r.recallAt10.toFixed(1).padStart(5)}  ` +
      `${r.mrrAt10.toFixed(3).padStart(6)}  ${r.latencyMs.p50.toFixed(0).padStart(6)}  ${r.latencyMs.p95.toFixed(0).padStart(6)}` +
      (r.fellBackToWords ? `  (${r.fellBackToWords} fell back to Words)` : ''),
  );
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ date: new Date().toISOString(), library: idOf.size, queries: sample.length, results }, null, 2));
