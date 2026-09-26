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

// Object queries: the COCO category name ("banana", "stop sign") against the photos whose instance
// annotations contain it. Measures precision of the first page, where a wrong fruit bowl at rank 3 hurts.
const instances = JSON.parse(fs.readFileSync(new URL('../datasets/coco/annotations/instances_val2017.json', import.meta.url), 'utf8'));
const withCategory = new Map(instances.categories.map((c) => [c.id, { name: c.name, files: new Set() }]));
for (const a of instances.annotations) {
  const file = fileOf.get(a.image_id);
  if (idOf.has(file)) withCategory.get(a.category_id).files.add(idOf.get(file));
}
const objectQueries = [...withCategory.values()].filter((c) => c.files.size >= 10);
for (const mode of ['words', 'meaning', 'both']) {
  let p10 = 0;
  let ndcg = 0;
  const worst = [];
  for (const c of objectQueries) {
    const r = await (
      await fetch(`${API}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: c.name, mode, limit: 10 }) })
    ).json();
    const rel = r.items.map((i) => (c.files.has(i.id) ? 1 : 0));
    const p = rel.reduce((a, b) => a + b, 0) / 10;
    const dcg = rel.reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
    const ideal = Array.from({ length: Math.min(10, c.files.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    p10 += p;
    ndcg += dcg / ideal;
    worst.push([p, c.name]);
  }
  results[mode].objectPrecisionAt10 = (100 * p10) / objectQueries.length;
  results[mode].objectNdcgAt10 = ndcg / objectQueries.length;
  results[mode].worstObjects = worst.sort((a, b) => a[0] - b[0]).slice(0, 8).map(([p, n]) => `${n} ${Math.round(p * 100)}%`);
}

console.log(`\ncaption queries (${sample.length}): the described photo's rank; object queries (${objectQueries.length} COCO categories): precision of the top 10`);
console.log('\nmode      R@1    R@5    R@10   MRR@10  p50 ms  p95 ms   obj P@10  obj nDCG@10');
for (const [mode, r] of Object.entries(results)) {
  console.log(
    `${mode.padEnd(8)} ${r.recallAt1.toFixed(1).padStart(5)}  ${r.recallAt5.toFixed(1).padStart(5)}  ${r.recallAt10.toFixed(1).padStart(5)}  ` +
      `${r.mrrAt10.toFixed(3).padStart(6)}  ${r.latencyMs.p50.toFixed(0).padStart(6)}  ${r.latencyMs.p95.toFixed(0).padStart(6)}` +
      `   ${r.objectPrecisionAt10.toFixed(1).padStart(6)}   ${r.objectNdcgAt10.toFixed(3).padStart(8)}` +
      (r.fellBackToWords ? `  (${r.fellBackToWords} fell back to Words)` : ''),
  );
}
for (const [mode, r] of Object.entries(results)) console.log(`weakest object queries (${mode}): ${r.worstObjects.join(', ')}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ date: new Date().toISOString(), library: idOf.size, queries: sample.length, results }, null, 2));
