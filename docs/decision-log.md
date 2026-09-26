# Decision log

This log records where the design differs from the *Team Formation and Role Assignment* document (13 September 2026) and why. Add new entries at the end with a date.

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
- If n8n orchestrated captioning, it would handle photo bytes, and the assessor-visible execution history would contain users' images. Keeping n8n text-only gives a cleaner privacy boundary.
- The low-code part is still load-bearing: enrichment results reach the local index only through the workflow's Data Table write and read, and retries are idempotent because of the upsert key.

## 2026-09-26 — Self-hosted open-source n8n instead of n8n Cloud

**Decision:** run the Community edition on the team's own cloud server with a public HTTPS address, instead of paying for four months of n8n Cloud. Develop against a local Docker instance with the same configuration, and migrate by changing only the backend's webhook URL and secret.
**Consequences:** Community edition cannot share workflows between users, so the workflow and Data Table are created under the assessor's member account (or on a dedicated instance). Data Tables are available and limited to 200 MiB by default, which is ample for text rows.

## 2026-09-26 — Model choices

- **Vision:** DeepSeek is primary. OpenAI is used only when DeepSeek fails for a photo, keeping cost low. The provider is recorded per caption.
- **Embedding:** Qwen3-VL-Embedding-2B, one pinned revision, 2048 dimensions. It is fixed for the project, and a startup guard prevents mixing vectors from a different model.
- **Hardware:** the development GPU is an 8 GB RTX 4060 Laptop, not the 12 GB assumed earlier, so memory settings are conservative and must be measured.

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
