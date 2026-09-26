#!/usr/bin/env node
// Text-in-image retrieval on synthetic screenshots (datasets/screens), a counterweight to the photo-only COCO
// benchmark. Import datasets/screens/images first. Reports the rank of the target screenshot per query and mode.
import fs from 'node:fs';

const API = process.argv.includes('--api') ? process.argv[process.argv.indexOf('--api') + 1] : 'http://127.0.0.1:3200';
const queries = JSON.parse(fs.readFileSync(new URL('../datasets/screens/queries.json', import.meta.url), 'utf8'));
const idOf = new Map();
for (let offset = 0; ; offset += 200) {
  const page = await (await fetch(`${API}/api/photos?offset=${offset}&limit=200`)).json();
  for (const p of page.items) idOf.set(p.filename, p.id);
  if (offset + page.items.length >= page.total) break;
}
const rows = [];
const summary = {};
for (const mode of ['words', 'meaning', 'both']) {
  let top1 = 0;
  let top5 = 0;
  for (const q of queries) {
    const r = await (await fetch(`${API}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q.query, mode, limit: 20 }) })).json();
    const rank = r.items.findIndex((i) => i.id === idOf.get(q.file)) + 1 || null;
    if (rank === 1) top1++;
    if (rank && rank <= 5) top5++;
    rows.push({ mode, query: q.query, rank });
  }
  summary[mode] = `top1 ${top1}/${queries.length}, top5 ${top5}/${queries.length}`;
}
for (const q of queries) console.log(q.query.padEnd(48), ['words', 'meaning', 'both'].map((m) => `${m} ${rows.find((r) => r.mode === m && r.query === q.query).rank ?? '-'}`.padEnd(12)).join(''));
console.log(summary);
