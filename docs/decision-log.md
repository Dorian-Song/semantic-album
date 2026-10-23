# Decision log

This log records where the design differs from the original project plan (13 September 2026) and why. Add new entries at the end with a date.

## 2026-09-26 — Capture metadata is optional, and filters respect that

**Original plan:** structured filtering on capture time, location, and device.
**Decision:** read capture time, camera, and GPS only from EXIF when present; never estimate or invent values. Offer date-range and camera filters; photos lacking the field do not match an active filter, and the UI says how many were excluded. No location filter in the first release: GPS-to-place-name conversion would need an external geocoding service, and many imported photos (screenshots, messaging-app copies) have no GPS.
**Why:** the data depends entirely on the imported files. Showing fabricated or empty fields would mislead the user.

## 2026-09-26 — 10,000 photos is a design target reached through bounded parallelism

**Original plan:** ingest 10,000 images end to end with a dead-letter table.
**Decision:** kept as the target. Each pipeline stage (decode, caption, embedding, enrichment) has its own bounded worker pool. Failed items stay in `import_items` / `processing_tasks` with a reason and can be retried, which serves as the dead-letter record. Per-stage timings are recorded from a real 10,000-photo run.

## 2026-09-26 — p95 < 3 s search, with progressive results as the fallback

**Original plan:** natural-language retrieval with p95 under 3 seconds.
**Decision:** measure p95 per search mode on a 10,000-photo library. If `both` misses the target because of the local model or hardware, run lexical and semantic search in parallel and stream results: Words first, Meaning appended as it arrives, deduplicated, and without reordering visible cards. The target is treated as a measured property, not a promise about the model.

## 2026-09-26 — Export as ZIP with sidecars; deletion covers derived data

**Original plan:** export or delete user data together with derived tags and embeddings.
**Decision:** export produces a ZIP of original photos plus JSON/CSV metadata and XMP sidecars (caption as description, tags as keywords). Original files are never modified. Embeddings are not exported because they have no use outside this model. Deleting a photo from the library eventually removes its description, tags, embedding, search rows, and n8n Data Table row.

## 2026-09-26 — Where the low-code/code boundary falls

**Original plan:** orchestration, scheduling, retry, and failure handling in a visual workflow engine; retrieval and ranking in code.
**Decision:** orchestration stays in the TypeScript backend. n8n owns a real part of the data path: normalizing AI captions and tags, storing them in a Data Table, and reading them back before the backend accepts them. It also deletes those rows when photos leave the library.
**Why:**
- The photo library, SQLite database, and GPU must stay on the user's machine; there is not enough server disk to hold libraries centrally. A cloud n8n instance cannot reach files, SQLite, or the local vLLM process behind the user's NAT without exposing the user's machine to the internet.
- Crash recovery for imports depends on atomic SQLite updates alongside file operations. Splitting that state between a remote workflow engine and a local database would create exactly the distributed-consistency problem the design avoids.
- If n8n orchestrated captioning, it would handle photo bytes, and its visible execution history would contain users' images. Keeping n8n text-only gives a cleaner privacy boundary.
- The low-code part is still load-bearing: enrichment results reach the local index only through the workflow's Data Table write and read, and retries are idempotent because of the upsert key.

## 2026-09-26 — Self-hosted open-source n8n instead of n8n Cloud

**Decision:** run the Community edition on the team's own cloud server with a public HTTPS address, instead of paying for four months of n8n Cloud. Develop against a local Docker instance with the same configuration, and migrate by changing only the backend's webhook URL and secret.
**Consequences:** Community edition cannot share workflows between users, so the workflow and Data Table are created under the member account that should see them (or on a dedicated instance). Data Tables are available and limited to 200 MiB by default, which is ample for text rows.

## 2026-09-26 — Model choices

- **Vision:** DeepSeek is primary. OpenAI is used only when DeepSeek fails for a photo, keeping cost low. The provider is recorded per caption.
- **Embedding:** Qwen3-VL-Embedding-2B, one pinned revision, 2048 dimensions. It is fixed for the project, and a startup guard prevents mixing vectors from a different model.
- **Hardware:** the development GPU is an 8 GB RTX 4060 desktop, not the 12 GB assumed earlier, so memory settings are conservative and must be measured.

## 2026-09-26 — Image formats

**Decision:** detect formats by magic bytes (including HEIC/HEIF/AVIF brands inside `ftyp` boxes), keep originals byte-for-byte, and generate a JPEG display derivative through sharp or external decoders (`heif-dec`, `ffmpeg`, ImageMagick). Undecodable files are recorded as unsupported and do not stop a batch. This reuses the approach from the team's earlier Matilta project.

## 2026-09-26 — Vector search without sqlite-vec

**Decision:** store image vectors as float32 BLOBs in SQLite and search them with an exact in-memory scan.
**Why:** at the 10,000-photo target, a scan of 2048-dimensional vectors takes milliseconds and needs no native extension. The design already allowed this ("use a `sqlite-vec` KNN index only if measurement shows it is needed"). Revisit only if the library grows by an order of magnitude.

## 2026-09-26 — Embedding request format follows the model card, verified by measurement

**Decision:** photos and queries use the same instruction, and the chat template includes the generation prompt.
**Why:** on 300 COCO images, caption→image Recall@1 was 72% with this format, against 45% with vLLM's default template setting and at most 59% with custom query instructions. The first eight-image probe had suggested the opposite; the larger sample showed that was noise.

## 2026-09-26 — 200 concurrent caption requests

**Original plan:** start caption concurrency around 4 and not adopt a provider's advertised ceiling as the worker count.
**Decision (project owner):** 200 requests in flight to DeepSeek, whose account allows 2,500; 4 was far too slow for a 5,000–10,000-photo import. Supporting changes: the setting allows up to 500, originals over 5 MB are sent as the 2560 px derivative to bound memory, and n8n enrichment runs 16 at a time so it keeps up. A 429 still pauses the whole caption queue instead of retrying each photo.

## 2026-09-26 — Retrieval improvements, decided by measurement

**Question:** how to make search better, and whether structured AI output (object lists, transcribed text, image kind) helps or overfits.
**Method:** two benchmarks against the running system, re-run after each change. `scripts/search-benchmark.mjs` uses 5,000 COCO val2017 photos with 500 human-caption queries (rank of the described photo) and 78 object-name queries ("banana", "handbag"; precision of the top 10 against COCO's annotations). `scripts/screens-benchmark.mjs` uses 14 synthetic screenshots (chat, receipt, boarding pass, long e-mail, ...) as a counterweight, because COCO has no screenshots or documents. At 500 queries, Recall@1 has a standard error of about 2 points, so smaller differences are treated as noise.

| Step | Words R@1 / R@10 / obj P@10 | Meaning | Both | Screens top-1 (M / B) |
| --- | --- | --- | --- | --- |
| Baseline | 24.6 / 56.4 / 95.8 | 37.0 / 73.8 / 94.4 | 36.4 / 70.8 / 98.3 | 10 / 12 of 12 |
| Porter stemming, weighted fusion, description-text vector | 26.0 / 55.6 / 96.8 | 39.8 / 77.4 / 95.5 | 39.2 / 75.6 / 97.9 | 14 / 14 of 14 |
| + structured prompt (objects in the tags column) | 23.4 / 54.0 / 95.5 | 39.0 / 77.0 / 95.8 | 37.0 / 77.6 / 97.9 | 12 / 14 |
| objects in a low-weight column | 23.4 / 54.2 / 92.9 | 39.4 / 76.8 / 94.7 | 36.4 / 78.2 / 97.2 | 12 / 14 |
| **main 5 objects with tags, rest low-weight; Both weights 1 / 0.5 / 0.25 (final)** | 24.2 / 56.6 / 95.9 | 39.6 / 76.8 / 94.9 | 37.4 / 78.8 / 98.2 | 12 / 14 |

**Decisions:**
- **Meaning blends two vectors per photo**: the image and the description text, 50/50. In an offline comparison on the same photos, a single vector of image and text together scored worst on object queries (87% vs 93% image-only), while the blend was best (caption Recall@1 26→34%, object P@10 93→95%).
- **Words uses Porter stemming** ("skateboarding" finds "skateboard") and no blanket prefix matching, which had made "car" match "carrot". Prefix matching remains only as a fallback for words of 4+ letters that match nothing. An unstemmed twin index keeps typo corrections readable.
- **Both weights Words by query length** (1 for 1–2 content words, 0.5 for 3–4, 0.25 for longer): keywords are precise for "stop sign" and noisy for full sentences.
- **Structured descriptions are kept, but indexed conservatively.** On COCO photos the new prompt is neutral, within noise, once indexed well. Putting all 10–25 objects at tag weight, or none, both hurt (Doc2Query-- makes the same point: document expansion helps only when noise is controlled). The first five objects, which the model lists as the most prominent, weigh like tags; the rest count little. Transcribed text gets its own column. The image kind powers a Type filter. These fields are for functionality (exact text in long screenshots, filtering, export) rather than for COCO scores.
- **Answers cut off at the output limit** (walls of repeated logos) are retried once with a compact instruction instead of failing.
- **Not done:** a reranker (Qwen3-VL-Reranker would not fit next to the embedding model in 8 GB), query rewriting by an LLM (adds a cloud call and a second of latency to every search), and a controlled vocabulary or synonym list (it would fit COCO's 80 categories and nothing else). Meaning remains weakest on small objects (wine glass, handbag: 5–7 of 10); Both compensates (9–10 of 10).
- Search p95 rose from about 63 ms to about 90 ms with the second vector scan, well within the target.
