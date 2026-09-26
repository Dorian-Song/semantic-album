# Demonstration script

A recorded end-to-end path for the course presentation, about 8–10 minutes. It follows the path in the [implementation handoff](implementation-handoff.md): import → album → caption and n8n Data Table write/read → Words and Meaning search → detail → edit or move → export, then the privacy boundary.

## Before recording

- `./start.sh`, then wait until **Settings → Services** shows all three services running (the embedding model needs 1–2 minutes after a cold start).
- **Settings → AI descriptions** is on, the DeepSeek test connection works, and **Settings → n8n enrichment** test connection passes.
- The n8n editor is open in a second tab, logged in as the account that owns **Album enrichment**, showing the workflow and the `album_enrichment` Data Table.
- Prepare a fresh folder of 20–40 varied photos (people, pets, food, street, landscape, one iPhone HEIC, one photo with visible text). A small COCO subset works: `datasets/coco/val2017`.
- Optionally reset the library first: `./stop.sh`, move `data/` aside, `./start.sh`.

## Script

1. **Problem (30 s).** Personal archives grow to thousands of photos with meaningless filenames; finding one means scrolling. Album makes them searchable by words and by what they show, while the photos stay on your own computer.
2. **Import a folder (1 min).** Home → **Import Folder**, paste the folder path, and point out the suggested album name. Show the progress card: imported, skipped (a duplicate or a non-image), then **Descriptions**, **Image search index**, and **n8n enrichment** advancing separately. Point out that the photo counts as imported before AI work ends.
3. **Album and detail (1 min).** Open the album, open a photo, use ← → and the filmstrip. Show that date and camera appear only when the file has them, and that a HEIC photo displays.
4. **AI description and n8n (2 min).** On the detail page, show the DeepSeek description, tags, and "Categories from n8n". Switch to n8n: **Executions** shows the run (Receive caption → Validate and normalize → Upsert enrichment row → Read row back → Return enrichment), and the `album_enrichment` table shows the row keyed `assetId:revision`. Explain that the backend accepts the result only after the Data Table write and read-back, and that SQLite stays the source of truth.
5. **Search (2 min).**
   - **Words**: search a word from a description and show the typo correction notice (for example `grden`).
   - **Meaning**: search something not written anywhere (for example "people eating outdoors") and show visually matching photos.
   - **Both**, then narrow **Albums** to one album: a shared photo still lists every album it belongs to.
   - If the photos have dates, use the **Taken from** filter and point out the "no date information" note.
6. **Edit and organise (1 min).** Edit a description, then **Regenerate AI description**: your text stays. **Add to album**, **Move** from one album to another, and **Remove** to show the difference from **Delete from library**.
7. **Export (30 s).** Album → **Export** → **Download ZIP**, and open it to show the originals, the `.xmp` sidecars, and `metadata.csv`.
8. **Resilience (optional, 1 min).** Stop n8n (`docker stop album-n8n`), then import one more photo: its description and search still work, and enrichment shows "paused". Start n8n again and watch it catch up.
9. **Privacy and design choices (1 min).** Settings → **Where your data goes**: originals, thumbnails, database, and search index stay local. DeepSeek sees photos only when descriptions are on, and OpenAI only as a fallback. n8n sees text only. The low-code part is where storing and reading the enrichment record is a visible, inspectable workflow; orchestration stays in code, for the reasons in the [decision log](decision-log.md).

## Figures to quote

From the development machine (RTX 4060 Laptop, 8 GB):

- Embedding model: about 6.1 GB of GPU memory, about 12 photos/s, about 25 ms per text query.
- Caption→image Recall@1/5/10 on 300 COCO images: 72.0 / 94.0 / 98.3%.
- DeepSeek descriptions: about 1.3–2.6 s each, 200 requests in flight.
- `node scripts/search-benchmark.mjs` on the imported COCO library gives recall and p50/p95 latency for all three modes; run it before recording and quote its output.
