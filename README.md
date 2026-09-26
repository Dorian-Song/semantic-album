# Album — a local-first AI photo library

Album is a self-hosted web application for organizing and finding personal photos. It imports images from selected files or a folder on the host machine, keeps its own copies, and lets one photo appear in several albums without storing duplicate bytes. Users can browse albums, edit AI-written descriptions, and search by words or visual meaning. The app is designed as a two-person course project and a usable open-source prototype, not a multi-user photo service.

The interface and project materials are in English. The current visual concepts are in [design/ui-concepts](design/ui-concepts/README.md); they are references, not final Figma files or implemented screens.

## What the application must do

- Create, rename, and delete albums. Import selected image files into an existing album, or import a host folder into a new album named after that folder. Resolve name collisions with a suffix such as `Holiday (2)`.
- Accept common camera and web formats — JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC/HEIF, and AVIF — identified by file content rather than extension. Keep the original bytes unchanged and generate browser-friendly derivatives. A file that cannot be decoded is recorded as an unsupported item and does not stop the batch.
- Keep imported originals, derivatives, and thumbnails in app-owned local storage. Removing the source folder must not remove imported photos.
- Identify identical image bytes by SHA-256. Skip a second copy inside the same album; allow the same stored photo to belong to different albums.
- Remove a photo from one album, move it between albums, or delete it from the library. Deleting the last album reference makes the file eligible for delayed cleanup, and cleanup also removes derived captions, tags, embeddings, and the photo's n8n enrichment row.
- Generate a caption and tags with DeepSeek's vision model. Use OpenAI only as a fallback when DeepSeek cannot process a photo. Let the user edit the caption without a later AI run silently replacing that edit.
- Generate image and query embeddings locally with Qwen3-VL-Embedding-2B (2048 dimensions). Offer **Words**, **Meaning**, and **Both** search across the current album, selected albums, or all albums. Show a shared photo once in results and list every album it belongs to.
- Read capture time, camera, and GPS position from EXIF when a file has them. These fields are optional: never invent or estimate a value, and omit an absent field in the UI. Search can be narrowed by capture date and camera; photos without that field do not match an active filter.
- Export an album or a selection as a ZIP file containing the original photos plus their descriptions, tags, and album names as JSON/CSV and XMP sidecar files.
- Show durable import progress and separate caption/embedding progress. Resume unfinished batches after an app restart; individual file transfers do not need resumable upload. The design target is a 10,000-photo import with no manual intervention, using bounded parallel workers.
- Include a genuine, visible low-code workflow: a self-hosted n8n instance receives caption text, normalizes it, writes an enrichment record to an n8n Data Table, reads that record, and returns it to the backend. The local SQLite database remains the application's source of truth.

## Architecture in one view

```text
Browser (React + TypeScript)
           │ REST/JSON + multipart (+ NDJSON stream for progressive search)
           ▼
Local TypeScript API ── SQLite (albums, references, jobs, search metadata)
           │          └─ app-owned originals / derivatives / thumbnails
           ├── local vLLM process: Qwen3-VL-Embedding-2B
           ├── image tools: sharp/libvips; heif-dec, ffmpeg or ImageMagick for HEIC/AVIF
           ├── cloud vision API: DeepSeek Responses (primary), OpenAI Responses (fallback)
           └── n8n webhook (self-hosted open-source n8n): text enrichment + Data Table write/read
```

The backend, database, and photo files run on the user's machine. n8n is the open-source Community edition, self-hosted on the team's own cloud server with a public HTTPS address so the course assessor can log in and inspect the workspace. During development it runs as a separate local process configured exactly like the server deployment, so migration only changes the webhook URL. The photo-caption API receives image content, and n8n receives caption text; the application must say this clearly when these services are configured. n8n does not receive or own the original photo library.

## Build guidance

- [Backend design](docs/backend-design.md): modules, storage model, image formats, API, state machines, recovery, search, export, and n8n boundary.
- [Frontend structure](docs/frontend-structure.md): pages, reusable components, routes, and proposed file tree.
- [Implementation handoff](docs/implementation-handoff.md): build order and testable acceptance scenarios for another development model.
- [Decision log](docs/decision-log.md): where and why this design differs from the original team-formation plan, including the low-code/code boundary.

Proposed repository shape after implementation: `apps/api/` for the backend, `apps/web/` for the frontend, `automation/n8n/` for the exported workflow and its deployment files, `docs/` for design/operation notes, `design/` for visual references, and root-level start/stop scripts plus package/workspace configuration.

The chosen direction is a TypeScript frontend/backend with SQLite, FTS5, a SQLite vector extension, a managed local vLLM process, and provider-specific Responses adapters. This document specifies behavior; dependency versions and GPU memory use must be verified on the target machine during implementation. The current development machine has an 8 GB RTX 4060 Laptop GPU, so the embedding service must fit in that budget.

## Running locally

Requirements: Node.js 22.12+, pnpm 10, Docker (for the local n8n instance), and a C++ toolchain in case `better-sqlite3` has no prebuilt binary for your Node version. HEIC and BMP need `libheif` tools (`heif-dec`), `ffmpeg`, or ImageMagick. Meaning search needs an NVIDIA GPU (8 GB is enough) with a recent driver.

One-time setup for Meaning search (about 12 GB of downloads):

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python vllm==0.30.0
# Qwen3-VL-Embedding-2B into models/Qwen3-VL-Embedding-2B, with the pinned commit in models/Qwen3-VL-Embedding-2B/REVISION
```

Then set `VLLM_ENABLED=true` in `.env`. Without it, Album works normally and Meaning/Both searches fall back to Words, with a notice.

```bash
./start.sh     # installs dependencies on first run, then starts API, web, and local n8n
./stop.sh      # stops them again
pnpm typecheck
pnpm test
```

- App: <http://localhost:5173>
- API health: <http://localhost:3200/api/health>
- n8n editor: <http://localhost:5678> (setup and `deploy.mjs` in [automation/n8n](automation/n8n/README.md))
- Search benchmark on COCO: `node scripts/search-benchmark.mjs` after importing `datasets/coco/val2017`

Settings live in `.env` (copied from `.env.example`). Logs and PID files are in `.run/`; the photo library is in `data/`.

## Course demonstration

The prototype should demonstrate the problem, working browser/API/database separation, an external API, a low-code workspace with a real Data Table write and read, and privacy/accessibility choices. The course submission also needs a recorded group presentation, slide deck, individual reflections, and links to the version-control record and LCNC workspace. The team has two members.
