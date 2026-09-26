# Backend development design

## Scope and architecture

The backend is a single-user TypeScript service. It owns the photo library, metadata, background-job state, search indexes, and local model lifecycle. It exposes a REST API to the separate frontend. A self-hosted n8n instance handles a small, demonstrable text-enrichment workflow; it is not in the critical path for album reads, deletion, or search. Keep modules separate, but do not add microservices, accounts, multi-tenant machinery, message brokers, or distributed transactions.

Recommended choices: Node.js + TypeScript, a small HTTP framework such as Fastify, SQLite with WAL and foreign keys, FTS5 for lexical search, `sqlite-vec` for image vectors, and app-owned files for originals/derivatives/thumbnails. Use a single backend writer process; CPU-heavy image work may run in a small worker-thread or child-process pool, but all SQLite writes go through the main process. The inference engine is a separate **locally managed** vLLM process; start/stop scripts supervise it together with the web and API processes so users do not need to operate it manually.

By default the API listens on `127.0.0.1` only. Host-folder import reads arbitrary directories on the machine, so binding to other interfaces must be an explicit configuration choice.

### Embedding model

The embedding model is fixed: Qwen3-VL-Embedding-2B at its full 2048-dimensional output. Qwen's [model card](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B) identifies the 2B model as multimodal with up to 2048 output dimensions. The [Qwen project](https://github.com/QwenLM/Qwen3-VL-Embedding) documents vLLM usage and requires vLLM 0.14.0 or newer for its example. Pin one Hugging Face revision and one vLLM version in configuration. Store the model ID, revision, and dimension in a one-row `embedding_meta` table when the vector index is created. At startup, refuse vector writes and queries if they differ, rather than mixing incompatible vectors.

Before creating the vector index, check that a text embedding and an image embedding both return 2048 dimensions. The development machine has an 8 GB RTX 4060 Laptop GPU. Start vLLM with an explicit, conservative `--gpu-memory-utilization`, a short `--max-model-len`, and one concurrent image request, then measure. If the model cannot start, leave the vector service unavailable and keep **Words** search usable.

## Proposed tree

```text
apps/api/
  src/
    main.ts                     # composition root, startup recovery, shutdown
    config/
      env.ts                    # data directory, bind address, worker limits, model paths
      model-config.ts           # vision provider settings, embedding pin
    ingress/
      http.ts                   # HTTP server and route registration
      albums.routes.ts
      photos.routes.ts
      imports.routes.ts
      search.routes.ts          # JSON and NDJSON-stream search
      exports.routes.ts
      settings.routes.ts
      progress.routes.ts
      schemas.ts                # request/response validation
    albums/
      album-service.ts          # names, membership, move/remove/delete
      album-repository.ts
    assets/
      asset-service.ts          # global SHA identity, caption edit
      format-sniff.ts           # magic-byte format detection
      derivatives.ts            # display JPEG, thumbnail, external decoders
      image-metadata.ts         # dimensions, orientation, optional EXIF
    imports/
      import-service.ts         # host folder and selected-file intake
      import-worker.ts          # persistent per-item progress, bounded pool
      import-repository.ts
    processing/
      task-service.ts           # caption, embedding, enrichment queues
      caption-worker.ts         # DeepSeek first, OpenAI fallback
      embedding-worker.ts
      enrichment-worker.ts
      progress.ts
    search/
      search-service.ts         # scope, filters, rank, dedupe, membership hydration
      lexical-search.ts         # FTS5 and conservative typo/prefix fallback
      vector-search.ts          # sqlite-vec query
      hybrid-rank.ts
    exports/
      export-service.ts         # ZIP of originals + JSON/CSV/XMP sidecars
    storage/
      object-store.ts           # content-addressed originals and derivatives
      staging.ts                # temporary uploads/copies
      garbage-collector.ts      # delayed orphan cleanup
      reconcile.ts              # startup recovery
    inference/
      vllm-client.ts            # image/text embedding calls
      vllm-supervisor.ts        # managed process health and lifecycle
    adapters/
      vision-provider.ts        # internal caption request/result contract
      deepseek-responses.ts
      openai-responses.ts
    egress/
      responses-client.ts       # outbound vision HTTP, retry, timeout
      n8n-client.ts             # webhook JSON contract and shared secret
    automation/
      enrichment-service.ts     # call n8n, validate response, local fallback
    db/
      connection.ts
      migrations/
      repositories/
    shared/
      errors.ts
      ids.ts
      types.ts
  test/                         # behavioral tests for critical invariants
```

`ingress` owns request validation and streaming input; it does not contain album rules. `egress` owns outbound transport. Each model has its own adapter because similar Responses APIs can differ in supported fields and response details. The core receives a provider-neutral `{caption, tags}` result. Keep business logic in services and SQL in repositories. Avoid duplicating every service behind extra interface layers when there is only one implementation.

## Persistence and ownership

`DATA_DIR` contains `album.sqlite`, `objects/<sha-prefix>/<sha256>` (untouched originals), `derivatives/<sha-prefix>/<sha256>.jpg`, `thumbnails/`, `staging/`, and `exports/`. Store relative object keys in SQLite, never a source-folder path as the canonical image location. Derive the SHA-256 from original bytes before ingestion. Missing EXIF fields remain absent in API responses; never fill them with guesses.

Minimal tables and invariants:

| Table | Main fields and constraints | Purpose |
| --- | --- | --- |
| `albums` | `id`, unique `name`, timestamps | App albums. Allocate `name (2)`, `name (3)` inside a write transaction for imported folder-name collisions. |
| `assets` | `id`, unique `sha256`, object key, detected format, MIME, dimensions, derivative key, nullable `taken_at`, `camera_make`, `camera_model`, `gps_lat`, `gps_lon`, `orphaned_at` | One row and one original file per distinct byte sequence. Metadata columns are null when the file lacks them. |
| `album_assets` | `(album_id, asset_id)` unique, added time, display filename | Many-to-many album membership. Same asset may appear in many albums, never twice in one. |
| `descriptions` | `asset_id` unique, AI draft, manual override, tags, provider/model/prompt revision, enrichment state | Effective caption is manual override when present; AI reruns and n8n enrichment update draft fields only. |
| `import_jobs` / `import_items` | persistent states; unique `(job_id, item_key)`; item outcome reason such as `duplicate_in_album` or `unsupported_format` | Overall batch and each source file, including skip/failure outcome. |
| `processing_tasks` | unique `(asset_id, kind, revision)`, kind `caption` / `embedding` / `enrichment`, state, attempts, next attempt time, error | Independent AI and enrichment work. |
| `n8n_purge_queue` | asset ID, requested time, attempts (no foreign key) | Best-effort deletion of n8n rows for assets that left the library. |
| `export_jobs` | scope, state, item counts, relative ZIP key, expiry | Durable export progress and download. |
| `model_config` | single row: DeepSeek and OpenAI base URL/model/API key, fallback enabled, n8n webhook URL and secret | Current settings. Keys may be stored in this local database for the course prototype; never return their saved values to the browser or logs. |
| `embedding_meta` | single row: model ID, revision, dimension | Guards the vector index against a changed model. |
| `idempotency_keys` | unique key, operation, request fingerprint, saved result | Repeated mutating HTTP request returns the same result; conflicting reuse returns 409. |
| `photo_fts` / `photo_vectors` | FTS5 text index / 2048-dimension vector index keyed by `asset_id` | Search representations rebuilt from authoritative rows if necessary. |

The default search representation includes effective caption, tags, and membership filenames. Rebuild/update FTS when a description, tag, or filename changes. A manual caption edit must be searchable immediately after the transaction commits. If a photo has no album memberships it is hidden from gallery and search, even though the original file remains in the grace period.

Ingestion order: stream/copy into `staging`, compute SHA-256, sniff and validate the format, store or reuse the global object, generate derivatives, then commit `assets`, membership, and item outcome in SQLite. Object movement and SQL cannot share a transaction: use deterministic object paths, temp-file rename, uniqueness constraints, and startup reconciliation to recover a crash between the file and row steps. Serialize operations for the same SHA in the single process. A second upload of the same bytes to the same album is a skipped import item; to another album it creates a membership and reuses the object. Re-adding an orphaned asset clears `orphaned_at`.

### Image formats and derivatives

This follows the approach proven in the team's earlier Matilta project (`file-normalize` / `image-understand` nodes): trust bytes, not extensions; route each detected format to a decoder; treat an undecodable file as a legitimate recorded outcome, not a batch failure.

- **Detection by magic bytes.** JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `GIF8`, BMP `BM`, WebP `RIFF....WEBP`, TIFF `II*\0` / `MM\0*`. For the ISO-BMFF `ftyp` family, read the brand at bytes 8–11: `heic heix hevc heim heis hevm hevs mif1 msf1` are HEIC/HEIF photos, and `avif avis` is AVIF. Other `ftyp` brands (MP4, MOV, M4A) and all video/audio are rejected as `unsupported_format`. Extension and browser MIME are only hints.
- **Originals stay untouched.** The stored object is always the exact imported bytes, so SHA-256 identity and export stay faithful.
- **Display derivative.** For every asset, produce one JPEG with EXIF orientation applied and the long edge capped (for example 2560 px), plus a small thumbnail. Use sharp/libvips for JPEG/PNG/WebP/GIF/BMP/TIFF. sharp's prebuilt libvips generally cannot decode HEVC-based HEIC, so decode HEIC/HEIF and AVIF through an external command — `heif-dec` first, then `ffmpeg` or ImageMagick `magick` — into a staging PNG, then continue with sharp. Detect available tools at startup and report them on the settings page. Animated GIF/WebP use the first frame for derivatives; the original keeps the animation.
- **Consumers.** The browser receives the original only when it is JPEG/PNG/WebP/GIF, and otherwise the derivative. The embedding worker always sends the derivative. The caption worker sends the original when DeepSeek accepts that format and the derivative otherwise; DeepSeek resizes large images itself.
- **Failures.** If no decoder succeeds, the item finishes as `skipped` with reason `unsupported_format`, and the batch continues. Files over a configurable size limit (default 200 MB) are skipped as `too_large` before hashing.
- **Metadata.** Read EXIF with a library that understands HEIC/AVIF containers (for example `exifr`). Store capture time, camera make/model, and GPS only if present.

### Deletion and garbage collection

- **Remove from album** deletes one membership. **Move** inserts the destination membership and deletes the source membership in one transaction; if the destination already contains it, the result still has one destination membership. **Delete from library** removes every membership. **Delete album** removes that album and its memberships, preserving assets still used elsewhere.
- On removal of the last membership, set `orphaned_at` and hide the asset immediately. A default 24-hour grace period applies to the original, derivative, and thumbnail. This is for crash/retry safety, not an advertised undo feature. Restoring membership clears the timestamp.
- The collector must recheck zero memberships and the unchanged/expired `orphaned_at` under a SQLite write transaction before removing the row. Deleting the asset row cascades to its description, tasks, FTS row, and vector, and enqueues an `n8n_purge_queue` entry in the same transaction. Coordinate the file unlink with ingestion of the same SHA in this single-process service; retry incomplete cleanup after a crash. Reconcile old unreferenced staging/object/derivative files by age separately from album-orphan rows. Never delete an object that has an album reference.

## Long-running work and recovery

An import job has `queued → running → completed`, with `paused`, `failed`, and `canceled` terminal/interrupt states where appropriate. An item has `pending → running → imported | skipped | failed`. Caption, embedding, and enrichment are **separate per-asset tasks** with `pending → running → succeeded | failed`; failed items can be retried. Enrichment depends on a succeeded caption. Persist every item outcome and counters derived from items, not just an in-memory percentage. On restart, change stranded `running` work back to `pending`, inspect completed items, and continue the unfinished batch. Do not resubmit already committed imports. Repeated cloud API calls after a crash are possible and may incur cost; local writes remain idempotent.

There are two intake modes. A backend-host folder scan can rediscover source files and continue automatically after restart while that folder still exists; accepted photos remain safe if the source later disappears. For browser-selected files, create a durable job/manifest and upload files individually (no partial-file resume). Files already accepted continue processing after restart; for files whose transfer never completed, ask the user to reselect the same set and send only missing items. The browser cannot reopen arbitrary local files after restart without user action. Never report a batch as complete while manifest items are unreceived.

The frontend polls `GET /api/jobs/:id` (or a shared progress endpoint) every few seconds. Return `{total, imported, skipped, failed, pending}` for import and independent `{done, total, failed}` counts for caption, embedding, and enrichment. A file counts as imported once stored and linked; later AI tasks do not block that result.

### Throughput for a 10,000-photo import

The design target is to import 10,000 photos end to end with no manual intervention. Each stage has its own bounded pool, so a slow stage never blocks a faster one:

| Stage | Bound | Default |
| --- | --- | --- |
| Hash + sniff + derivative (CPU) | worker pool; external HEIC/AVIF decoders count toward it | `max(1, cores - 1)` |
| SQLite commit | single writer, short transactions batched per few items | 1 |
| Cloud caption | setting; back off on HTTP 429/5xx | 4, tuned by measurement |
| Local embedding | GPU capacity; send small batches of derivatives | 1 request in flight |
| n8n enrichment | setting | 2 |

Do not turn a provider's advertised concurrency ceiling into the app's worker count. Retries use exponential backoff through `next attempt time`; after the attempt limit a task stays `failed` and is visible in progress for manual retry. Record per-stage timings so the 10,000-photo run can be reported with real numbers.

## Search contract

UI modes map to backend `words`, `meaning`, `both`. Default to `words` for speed; settings may change the default. `words` searches caption, tags, and filenames using FTS5 token matching with prefix matching and a small, bounded typo-tolerant fallback when useful. This is search assistance, not a promise of Google-equivalent ranking. `meaning` compares a query embedding with stored image embeddings. `both` merges ranked candidate sets with reciprocal-rank fusion. A reranker is out of the first release.

Scope is one album, selected album IDs, or all. Optional metadata filters are capture-date range and camera model; an asset whose field is null does not match an active filter, and the response reports how many in-scope photos lack that field. Filter eligible asset IDs through membership and metadata **before** ranking and pagination. At the 10,000-photo scale, an exact vector scan over the eligible set is acceptable; use a `sqlite-vec` KNN index only if measurement shows it is needed. Deduplicate by global `asset_id`. After choosing a page of asset IDs, fetch **all** of each asset's current album memberships in a separate query, regardless of search scope. For example, searching album A for an asset also in B returns one result with both `A` and `B` in `albums`. Scope determines where a result qualifies, not which membership names are displayed. If local inference is unavailable, `meaning`/`both` report a clear unavailable state or fall back explicitly to `words`; never silently return zero matches.

### Latency target and progressive results

The target is p95 search latency under 3 seconds on a 10,000-photo library, measured with a fixed query set and logged per phase (query embedding, vector scan, FTS, hydration). `words` alone should be far below this.

For `both`, run the lexical and semantic branches in parallel. The first release returns one fused JSON response. If measurement on the target machine shows `both` exceeding the target because of query-embedding or scan time, enable progressive delivery on `POST /api/search/stream` as NDJSON:

```text
{"phase":"words","results":[...],"memberships":{...}}
{"phase":"meaning","results":[...],"memberships":{...}}
{"phase":"done","timings":{...}}
```

The server sends each phase as soon as it is ready. The meaning phase includes only assets not already sent. The frontend appends results in arrival order, deduplicated by `asset_id`, and never reorders cards the user can already see. Either phase may instead carry `{"phase":"meaning","unavailable":true}`. The streaming path covers the first page only; further pages use the normal paginated `POST /api/search`.

## Export

`POST /api/exports` takes one album, several albums, or explicit asset IDs and creates an `export_jobs` record; `GET /api/jobs/:id` reports progress; `GET /api/exports/:id/download` streams the finished ZIP from `DATA_DIR/exports/`. Expire ZIP files after a day.

ZIP layout:

```text
album-export/
  photos/<display filename>              # original bytes; name collisions get " (2)"
  photos/<display filename>.xmp          # dc:description = effective caption, dc:subject = tags
  metadata.json                          # per photo: filename, sha256, caption, AI draft, tags, albums, EXIF fields present
  metadata.csv                           # same fields, flattened for spreadsheets
```

A photo in several selected albums appears once, with all album names listed in metadata. Originals are never rewritten, so tags travel in XMP sidecars, which Lightroom, digiKam, and darktable can read. Embeddings are not exported. Deletion of data is covered by **Delete from library**, whose cleanup removes the derived rows and the n8n record.

## External model and n8n integration

### Vision captions

The caption adapter uses one internal prompt/result contract but separate `deepseek-responses.ts` and `openai-responses.ts` request builders/parsers. DeepSeek is the primary provider. DeepSeek's [vision guide](https://api-docs.deepseek.com/guides/vision/) currently documents `deepseek-flash` image input through Responses `input_image`; validate the configured model at runtime and surface API errors. OpenAI is called only for a photo whose DeepSeek attempt ends in a non-retryable error (format rejected, content refused, invalid response) or exhausts its retries, and only if a fallback key is configured. Record the provider that produced each draft. Treat provider options as provider-specific. Both providers receive photo bytes, so the settings and import flow must disclose that transfer.

### n8n enrichment workflow

For the course's LCNC database-connectivity requirement, the n8n workflow is real application behavior:

```text
caption succeeded -> enrichment task: backend POSTs {assetId, taskId, revision, caption, tags}
                     with header X-Album-Secret
                  -> n8n Webhook (Header Auth) -> validate/normalize text and tags
                  -> Data Table Upsert by stable key "assetId:revision"
                  -> Data Table Get the same row
                  -> Respond to Webhook with normalized data
                  -> backend validates and writes AI draft + tags, updates FTS
```

A second small webhook (or an `op: "delete"` branch) deletes rows by `assetId` for the purge queue. The stable key makes retries yield one logical enrichment row; serialize repeat attempts for the same task. Enrichment results only update AI draft fields and tags; they never overwrite a manual caption. n8n [Data Tables](https://docs.n8n.io/build/work-with-data/data-tables/) and their [row operations](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datatable/rows/) provide the visible low-code storage/retrieval step. Send text and IDs, not images, to this workflow. If n8n is down, keep the raw caption locally, leave the enrichment task pending with backoff, and keep browsing, import, and search operational. Do not treat the n8n table as an authoritative or complete copy of the user's library.

### Hosting n8n

n8n runs as the open-source Community edition, self-hosted rather than on n8n Cloud. It is deployed in two stages with one configuration:

1. **Local stage (now).** A separate local process, preferably the official Docker image (`docker.n8n.io/n8nio/n8n`, pinned tag) with a named volume, on port 5678. The root start/stop scripts manage it when `N8N_MODE=local`. Use the same environment variables as the server: `N8N_ENCRYPTION_KEY` (generated once, kept outside git), `GENERIC_TIMEZONE`, `N8N_HOST`, `N8N_PROTOCOL`, `WEBHOOK_URL`, execution pruning (`EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE`), and `N8N_DATA_TABLES_MAX_SIZE_BYTES` if the 200 MiB default is too small. Locally, `N8N_PROTOCOL=http`, `WEBHOOK_URL=http://localhost:5678/`, and `N8N_SECURE_COOKIE=false`.
2. **Server stage (later).** The same image and variables in Docker Compose on the cloud server behind an HTTPS reverse proxy (for example Caddy), with `N8N_PROTOCOL=https`, the public `WEBHOOK_URL`, and secure cookies. Export the workflow and table schema from the local instance and import them. The backend change is only `N8N_WEBHOOK_URL` and the shared secret.

The backend never depends on local-only n8n details. Keep the exported workflow JSON and a Compose file in `automation/n8n/`.

**Assessor access.** Community edition does not support sharing workflows between users: only the owner and the workflow's creator can see a workflow. Create a member account for the assessor and build (or import) the workflow and Data Table while logged in as that account, so it is the creator. The owner account keeps full access. If that proves awkward on the installed version, run a dedicated instance containing only this project and give the assessor its login. Either way, the n8n instance holds no photo files and no provider API keys; its only secret is the webhook header credential.

## REST surface

These routes are a proposed contract; use consistent IDs, pagination, error bodies, and validation. Host-folder import accepts a directory path **on the backend host**, not a path meaningful only to a remote browser.

| Route | Behavior |
| --- | --- |
| `GET/POST /api/albums`, `GET/PATCH/DELETE /api/albums/:id` | List/create/get/rename/delete albums. Names are unique ignoring case. |
| `GET /api/albums/name-suggestion?name=` | The unique name the backend would assign now (for import dialogs); the final name is assigned on creation. |
| `GET /api/albums/:id/photos` | Paginated album gallery, newest capture first (photos without a capture time by when they were added). |
| `GET /api/photos?order=date\|recent` | All photos in the library: gallery order, or most recently added first (Home). |
| `GET /api/photos/:id/context?album=` | Position, previous/next, and a filmstrip window within an album or all photos. |
| `POST /api/imports` | Create a selected-file job with manifest. Body has either `albumId` or `newAlbumName`; a new name is made unique by the backend. The browser folder picker uses `newAlbumName` = selected root folder name. |
| `POST /api/imports/:id/files`, `POST /api/imports/:id/finish` | Upload one file at a time; close intake when all items are accounted for. |
| `POST /api/imports/folder` | Import a host folder; create an album from folder name unless target album ID supplied; returns job ID. |
| `POST /api/imports/:id/cancel` | Cancel an unfinished import; already imported photos stay. |
| `GET /api/jobs`, `GET /api/jobs/:id` | Unfinished and recently finished jobs; durable import, processing, and export progress. |
| `GET /api/photos/:id?album=`, `GET /api/photos/:id/original`, `GET /api/photos/:id/display`, `GET /api/photos/:id/thumbnail` | Detail (filename as it appears in `album`, if given) and image delivery. `display` returns a browser-renderable image. |
| `PATCH /api/photos/:id/description` | Set/clear manual description override. |
| `POST /api/photos/:id/albums`, `DELETE /api/albums/:id/photos/:photoId` | Add/remove a membership. |
| `POST /api/photos/:id/move`, `DELETE /api/photos/:id` | Move between albums / delete from library. |
| `POST /api/tasks/:id/retry` | Retry a failed caption, embedding, or enrichment task. |
| `POST /api/search` | Query, mode, album scope, optional date/camera filters, page; returns each photo once plus all memberships. |
| `POST /api/search/stream` | Progressive NDJSON variant of the first page (enabled only if needed). |
| `GET /api/search/facets` | Camera models and date range present in the library, for filter controls. |
| `POST /api/exports`, `GET /api/exports/:id/download` | Create and download a ZIP export. |
| `GET/PUT /api/settings` | Search default, vision providers, n8n, worker limits, detected image tools, embedding status; redact secrets on read. |

For repeatable mutations, accept an `Idempotency-Key` and store a fingerprint of the operation. Database uniqueness remains the final guard. Do not place raw local filesystem paths or API keys in search results or logs.
