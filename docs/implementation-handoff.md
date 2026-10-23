# Implementation handoff and acceptance checks

This is the build contract for an implementation model. Follow [backend design](backend-design.md), [frontend structure](frontend-structure.md), the [project overview](../README.md), and the [decision log](decision-log.md). The goal is a working, reviewable two-person course prototype with a real n8n workflow. Prefer a small complete vertical slice over broad scaffolding. Do not add accounts, cloud photo storage, remote PostgreSQL/Supabase, distributed queues, or a reranker to the first release.

## Build order

1. Scaffold the separate TypeScript API and web apps, local startup/shutdown commands, persistent `DATA_DIR`, and SQLite migrations. Ensure one command starts the app stack and one stops it; the local vLLM process and, with `N8N_MODE=local`, the local n8n container are managed by these commands.
2. Implement album CRUD, app-owned photo ingestion, magic-byte format detection, display derivatives and thumbnails (including HEIC/HEIF/AVIF through external decoders), optional EXIF extraction, SHA-256 global deduplication, album membership, folder-name collision handling, and remove/move/delete semantics. Build Home, Album, and Detail pages against real endpoints.
3. Add persistent import items and restart recovery. Add separate caption, embedding, and enrichment task records with independent progress, bounded worker pools, and backoff. Run a 10,000-photo import and record per-stage timings.
4. Implement the DeepSeek Responses vision adapter and provider-neutral caption contract, then the OpenAI adapter as a fallback for DeepSeek failures. Save AI draft and manual override separately.
5. Build the n8n text-enrichment and purge workflow on the **local** n8n instance, configured as described in backend design. It must visibly write and read a Data Table row and return a result to the backend. Then deploy the same configuration to the cloud server, import the workflow under the assessor-visible account, and switch only the backend webhook URL and secret. Commit the workflow export and Compose file to `automation/n8n/` as supporting material, not as a substitute for the workspace link.
6. Integrate Qwen3-VL-Embedding-2B (pinned revision, 2048 dimensions) through the managed vLLM service, prove text/image vector shape and memory fit on the 8 GB development GPU, add FTS5/vector indexes and the three search modes. Build scope selection, date/camera filters, and the results page. Measure p95 latency on the 10,000-photo library; enable progressive `/api/search/stream` only if `both` exceeds 3 seconds.
7. Add ZIP export with JSON/CSV/XMP sidecars.
8. Finish settings, error/loading states, responsive and keyboard behavior, privacy explanation, and the demonstration path. Document exact local run commands and required environment variables once implementation exists.

## Acceptance scenarios

| Scenario | Expected result |
| --- | --- |
| Import a host folder named `Holiday`; import another with the same basename | Two albums named `Holiday` and `Holiday (2)`; both contain their imported photos. |
| Import the same bytes twice into album A, then into B | A contains one photo, B contains one photo, and only one original object exists. |
| Delete the source folder after importing | The gallery, detail view, original, and thumbnail still work. |
| Import an iPhone HEIC and an AVIF file | Both are stored byte-for-byte, show thumbnails and a full-size display image in the browser, and get captions and embeddings. |
| Import a `.jpg` file that is really a PNG, and an MP4 renamed to `.heic` | The PNG imports correctly; the MP4 is recorded as `unsupported_format` and the rest of the batch continues. |
| Search album A for an asset also in B | One result appears and its `albums` list contains both A and B. |
| Filter search by a date range when some photos lack capture time | Only photos with a matching capture time appear; the UI states how many photos were excluded for missing dates. |
| Move an asset from A to B when it is already in B | The operation succeeds idempotently; A no longer references it and B has exactly one membership. |
| Delete A when its photo is also in B | B still displays the photo and its object remains. |
| Remove the last membership | The photo disappears from gallery/search; object remains during grace period; eligible cleanup later removes it, its derived rows, and its n8n Data Table row, unless it is re-added. |
| Import 10,000 photos | Completes without manual intervention; failures are listed with reasons and are retryable; stage timings are recorded. |
| Stop during a large import, restart, and resume | Already imported items are not duplicated; pending items continue; durable progress reflects actual outcomes. |
| Interrupt a browser-selected batch before all files arrive | Accepted files resume processing; the UI requests reselection for unreceived files and never marks the batch complete prematurely. |
| Caption a photo, edit its description, then rerun AI captioning | The manual description remains visible and searchable; the AI draft may update separately. |
| DeepSeek rejects a photo | The caption is produced by OpenAI (if configured) and the draft records the provider; without a fallback key the task is `failed` and retryable. |
| Complete a caption with n8n available | n8n Data Table contains one row for the asset/revision; workflow reads it back; local draft/index are updated. |
| Retry the same enrichment request | One logical Data Table row remains and the local result is unchanged. |
| n8n is temporarily unavailable | Raw caption is retained locally, enrichment is retried later, and album browsing/search still work. |
| Move n8n from local to the cloud server | Only the backend webhook URL/secret change; new enrichment rows appear in the cloud Data Table. |
| Local vLLM fails to start | Words search and album features still work; Meaning/Both show an explicit unavailable/fallback state. |
| Search latency on 10,000 photos | p95 is reported per mode; if `both` exceeds 3 s, progressive results show Words first and append Meaning results without reordering or duplicates. |
| Export an album that shares a photo with another selected album | The ZIP contains each original once, XMP sidecars with caption and tags, and metadata listing both albums. |
| A photo has no location metadata | No empty location field is shown. |

## Status (2026-09-26)

Build steps 1–8 are implemented. The streaming search endpoint is not built; add it only if `scripts/search-benchmark.mjs` shows `both` above 3 s at p95. Each acceptance scenario is covered as follows (tests in `apps/api/test/`):

| Scenario | Covered by |
| --- | --- |
| Folder-name collisions; dedup across albums; source folder deleted | `library.test.ts` › folder import |
| HEIC/AVIF display; disguised PNG; MP4 renamed `.heic` | `library.test.ts` › formats and metadata; folder import |
| Search in album A lists A and B; filters exclude missing metadata | `search.test.ts` |
| Move into an album that already has the photo; delete shared album | `library.test.ts` › browser uploads and memberships |
| Last reference removed → hidden, cleaned after grace, n8n row purged | `library.test.ts` › last-reference cleanup; `enrichment.test.ts` |
| Restart mid-import; interrupted browser batch | `processing.test.ts` › restart recovery; `library.test.ts` |
| Manual description survives regeneration | `captions.test.ts` |
| DeepSeek rejects a photo → OpenAI fallback | `captions.test.ts` |
| n8n write/read, retry → one row, n8n unavailable | `enrichment.test.ts` (Code node script run for real); live checks against n8n 2.40.7 |
| vLLM unavailable → explicit Words fallback | `search.test.ts` › search without the embedding model |
| Export with a photo in two selected albums | `export.test.ts` |
| Repeated request with the same Idempotency-Key | `library.test.ts` › idempotency keys |
| 10,000-photo import and p95 latency | manual: import `datasets/coco/val2017` (+ more), then `scripts/search-benchmark.mjs` |

## Practical implementation notes

- Verify library versions and inference behavior against current official documentation before pinning. In particular, test the exact Qwen/vLLM image request format on the 8 GB RTX 4060 desktop GPU with conservative memory settings.
- The development machine already has `heif-dec`/`heif-convert` (libheif 1.23), `ffmpeg` 8.1 with HEVC and AV1 decoders, ImageMagick 7, and Docker. Detect tools at startup instead of assuming them on other machines, and document the optional system packages.
- Keep generated images, SQLite files, API keys, the n8n encryption key, and downloaded model weights outside version control. Ship a sample configuration with placeholders.
- Tests should cover the invariants above, especially cross-album membership hydration, last-reference deletion, duplicate/retry handling, format sniffing, and restart recovery. A small integration test with temporary SQLite/object storage is more useful here than tests that repeat service internals.
- For the presentation, record one end-to-end path: import → album display → caption/n8n Data Table write and read → Words/Meaning search → open detail → edit or move photo → export. Show the self-hosted n8n workspace and explain the privacy boundary honestly: local storage for originals, cloud image processing for AI captions, and text-only processing on the team's own n8n server.
