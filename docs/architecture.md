# Backend architecture (Version 3)

This document defines the target module structure of the API: what each module is responsible for, where it sits, and which modules it may use. It describes responsibilities only; how a module achieves them is left to the code. The structure replaces the layout of the Version 2 prototype, in which SQL was spread across 21 files, outbound calls lived in three directories, and modules triggered each other's side effects directly. See [Implementation status](#implementation-status) for what already matches.

## Tiers and deployment

The application has four tiers, deployed on two nodes.

| Tier | Contents | Node |
| --- | --- | --- |
| 1. Presentation | React web app (`Album/app`) | Local |
| 2. Application logic | `infra/` capabilities and `application/` business modules | Local |
| 3. Data access | `data-access/`: SQLite, disk files, external services (including n8n workflows) | Local, calling out to the cloud |
| 4. Database | SQLite file, photo directory (local); Baserow tables (cloud, text only) | Local + cloud |

Tiers and nodes are different things. All four tiers of Album run on the user's machine because the photo library, the database, and the GPU must stay there. The cloud node (the team's server) hosts the low-code services that the data-access tier calls: n8n workflows and Baserow tables. Connections go **only from the local node to the cloud**, over HTTPS with a shared secret; the cloud never calls into the user's machine, and it never receives photo bytes.

`infra/` is not a fifth tier. It holds technical capabilities that are not business rules. `ingress` sits above the business modules (it calls them); the others sit below them (they are called by them). The capabilities `embedding` and `llm` reach external services and so belong to the data-access tier in the four-tier picture, even though the code groups them by capability.

## Placement rules

- **infra/**: a capability with more than one user, offered through one stable interface whose inside is invisible to callers; or a technical part with no business rules (`ingress`).
- **application/**: business. A capability with a single user is part of that user's business (for example, describing a photo belongs to `processing`).
- **data-access/**: storing and fetching only; no decisions.
- **Whoever owns data cleans it up.** Each module offers "delete what belongs to this photo" for its own data; `lifecycle` only decides the order.
- Dependencies point one way: `ingress` → `application` → `infra` capabilities / `data-access` → storage. `infra` never calls `application`.

## Module structure

```text
Album/src/
├─ bootstrap/          wiring, start-up order, shutdown order (outside the four tiers)
├─ shared/             error base types, IDs, time — nothing with business meaning
├─ infra/
│  ├─ ingress/         the only entry point for requests
│  ├─ artifact/        storing a file once (deduplicated) and removing it; per-file lock
│  ├─ imaging/         decode, resize, crop, rewrite metadata; detects decoder tools
│  ├─ embedding/       text or image → vector
│  ├─ llm/             prompt (+ images) → result; providers and fallback inside
│  ├─ observability/   progress roll-up, rates, health and connection tests, logs, reports
│  └─ settings/        start-up config (.env, including secrets) and runtime config
├─ application/
│  ├─ import/          import batches
│  ├─ library/         albums, membership, user descriptions
│  ├─ processing/      turning a stored photo into complete, searchable data
│  ├─ query/           browsing and search
│  ├─ export/          packaging photos and their metadata
│  └─ lifecycle/       permanent removal and leftover clean-up
├─ data-access/
│  ├─ repositories/    SQLite reads and writes, one per kind of data
│  ├─ file-store/      disk files: app storage and read-only access to host folders
│  ├─ search-store/    full-text index and vectors: content, storage, scanning
│  └─ egress/          shared outbound connection, error categories, n8n connection
└─ database/           SQLite schema and its version upgrades
```

## Responsibilities

### bootstrap

Connects the modules and runs them in a safe order. On start: upgrade the schema, requeue interrupted work, remove leftovers of a crash, load vectors, resume unfinished imports and exports, then start background work and timers. On shutdown: stop accepting requests, stop timers, let running work finish, close the database.

### infra/ingress

Receives every request from the browser and replies to it. It accepts requests only from the local front end; identifies what each request asks for and hands it to the right module; checks the *form* of the request (fields present, types, lengths, size limits) but not business conditions; passes uploaded byte streams on without holding them in memory; recognises a repeated submission and returns the earlier answer; replies "started" for long work instead of waiting; turns results and errors into one reply format without exposing internal details; streams downloads and progressive search results; and logs each request without its content. It owns the expiry of its repeated-submission records.

Boundary with `egress`: whoever speaks first. A reply to a browser request is ingress, even when it carries a file; a call the system starts itself is egress.

### infra/artifact

Stores a file in the library exactly once and removes it again. Storing: hands the byte stream to `file-store` (which writes a temporary file and computes SHA-256 on the way), checks the format from the file's content, looks up the hash, discards the temporary file if the bytes are already stored, and otherwise has `imaging` decode it and produce the display version and thumbnail, reads capture metadata, moves the file into permanent storage, and writes the file record. Removing: deletes the original with its display version and thumbnail. It holds the lock that keeps one file from being stored and removed at the same time. It knows nothing about albums. Users: `import`, `lifecycle`.

### infra/imaging

Image operations: decode any supported format, resize, crop into pieces, read and rewrite metadata (for example removing GPS). Detects which decoders are installed. Users: `artifact`, `processing`, `export`.

### infra/embedding

Turns text or an image into a vector, and reports which model, revision, and dimension it uses. Users: `processing`, `query`.

### infra/llm

Takes a prompt, optional images, and the wanted output shape, and returns the result together with the provider that answered. Inside: one adapter per provider (DeepSeek, OpenAI) converting between our format and the provider's, and turning provider errors into a few categories (rate-limited, temporarily unavailable, output cut off, rejected). Fallback policy: switch to OpenAI only when DeepSeek fails for this request; a rate limit is not a failure of the request and is reported to the caller instead. Users: `processing` (descriptions, combining descriptions), `observability` (connection tests).

### infra/observability

Reports what the system is doing; owns no business state. It collects progress from `import` and `processing` (each reports its own), per-album processing counts, throughput and stage timings; checks health of the database, vLLM, providers, n8n, and decoders, and runs connection tests with newly entered settings; keeps one log format that never contains photos, descriptions, or secrets; pushes statistics to Baserow and sends notifications through n8n.

### infra/settings

Answers "what is the current configuration" for every module, whether a value comes from `.env` (read at start-up; changing it needs a restart) or from the settings page (takes effect immediately). Secrets live only in `.env`; the browser sees only whether each one is configured. Validates changes and rejects invalid ones as a whole. Produces the privacy summary: which data goes where under the current configuration.

### application/import

Runs import batches. Creates a batch, lists its files (an upload manifest or a scan of a host folder), records each item's state and outcome, has `artifact` store each file and `library` place it in the album, resumes after a restart, and reports progress. Keeps the import history.

### application/library

The rules of the user's library: create, rename, and delete albums (including names from a folder and the `Holiday (2)` suffix); add, remove, and move photos (a photo appears once per album; one stored file may belong to many albums); set the user's description (a user edit is never replaced by AI); mark a photo as unused when it leaves its last album; list and restore recently deleted photos; request immediate permanent deletion. When membership changes, it refreshes the photo's search content in the same write; when a new photo arrives or a description changes, it registers follow-up work with `processing` in the same write.

### application/processing

Turns a stored photo into complete, searchable data. It orders the steps, limits how many run at once, retries or pauses on failure (a rate limit pauses the whole description queue), records each step's state for progress and for resuming, and offers an entry for other modules to register work inside their own write. Steps: check the photo is still in an album before anything leaves the machine; obey the "AI descriptions enabled" switch; prepare the image (very long or wide images are cut into overlapping pieces); describe each piece through `llm` and combine piece descriptions with a text-only `llm` call; record the AI description and its provider; normalise text through n8n; turn GPS coordinates into place names through n8n (photos without GPS skip this); compute the image and description vectors; refresh search content. It owns the prompt and its version, regeneration of outdated descriptions, single and bulk retries, and the place-name cache's per-photo clean-up.

### application/query

Reads the library for the user and changes nothing. Browsing: album photos, all photos (by capture or import date, by image type), albums with counts and covers, photo detail with all its albums and processing state, previous/next in the list the user came from, file contents for viewing. Search: current album, selected albums, or all; Words, Meaning, or Both; date, camera, type, and place filters, reporting how many photos were excluded for lacking the field; a shared photo appears once with all its albums; Words results first, Meaning appended without moving visible cards; Meaning and Both fall back to Words when embeddings are unavailable. Results are presented as **the most relevant N**, not as a total count. Decides which description to show (user edit over AI) and labels AI text as such. Owns ranking: fusion and weights.

### application/export

Packages photos for the user to take away: an album or a selection, each stored photo once. Contents: unchanged originals, JSON and CSV with descriptions, tags, albums, capture data and place names, and an XMP sidecar per photo. No vectors. Unique file names inside the ZIP. Runs in the background with progress; an export interrupted by a restart is redone or marked failed. Before starting it estimates the size and refuses if disk space is short. Offers "remove location data" (off by default) and warns when photos carry GPS. Deletes its own ZIP files after they expire.

### application/lifecycle

Permanently removes photos that no album uses and cleans up after crashes. It waits out the grace period (shown to the user as Recently deleted), or acts at once on an immediate-delete request; re-checks that the photo is still unused; then has each owner delete its data in order — database records and search content first, then the in-memory vector cache, then the files through `artifact` — so a crash can leave an unused file but never a record without its file. It deletes the cloud records through n8n and keeps retrying, across restarts, until the cloud confirms. On start-up it removes stale temporary files and files that no record refers to.

### data-access/repositories

The only code that knows tables, columns, and SQL. Offers reads and writes per kind of data (file records, albums and membership, descriptions, import batches, tasks, settings, repeated-submission records, export jobs, pending cloud deletions), groups several writes into one all-or-nothing unit when a caller asks, and turns storage errors into meaningful ones ("name already taken").

### data-access/file-store

The only code that touches disk paths. Lays out the data directory; writes a temporary file while computing its hash; moves it into permanent storage; reads, deletes, and lists files; reads files from a host folder without writing to it.

### data-access/search-store

Stores what search needs: decides which fields of a photo go into the full-text index and in which column; keeps vectors on disk and in memory and scans them, filtering to the photos the caller may see *before* taking the top results; refuses vectors from a different embedding model than the one the index was built with; deletes a photo's search data on request.

### data-access/egress

What every outbound call shares: sending and receiving, timeouts, signing, reading a provider's "retry after", logging without content, sending only to configured destinations, and the error categories callers act on. Holds the n8n connection used by `processing` (normalise, place names), `lifecycle` (delete cloud records), and `observability` (statistics, notifications, tests).

### database

The SQLite schema and its version upgrades, run by `bootstrap` at start-up. The photo directory and the Baserow tables are storage too; they appear in the architecture diagram, not as code.

## Low-code components

| Component | Tier | Role |
| --- | --- | --- |
| n8n workflows | Data access | Normalise descriptions and tags; look up place names (with a cache); delete cloud records; receive statistics; send notifications |
| Baserow tables | Database | Normalised description records, place-name cache, statistics snapshots — text only, with public read-only views |
| Penpot | None (design time) | UI design and prototypes |

Workflow definitions and table structures are kept in the repository. n8n never receives photos: its execution history is visible to anyone with access to the workflow, and images there would expose users' photos.

## Main flows

- **Upload:** ingress → import → artifact (file-store, imaging, repositories) → library → processing registered in the same write.
- **Folder import:** as upload, with import reading the host folder through file-store.
- **Processing:** processing → imaging → llm → egress/n8n → embedding → search-store.
- **Search:** ingress → query → embedding, search-store, repositories → streamed reply.
- **Move or remove a photo:** ingress → library → repositories and search-store in one write.
- **Edit a description:** ingress → library → processing (description vector) → search-store.
- **Delete:** library marks unused → lifecycle after the grace period → each owner deletes → egress/n8n deletes cloud records.
- **Export:** ingress → export → repositories, file-store, imaging → ZIP → ingress download.

## Implementation status

The Version 2 code already has the entry point (`ingress/`), a content-addressed file store, a durable task queue with recovery, a composition root, and separate read queries. To reach this structure it needs: SQL moved into repositories; outbound code from `egress/`, `adapters/`, and `inference/` regrouped into `llm`, `embedding`, and `egress`; image operations gathered into `imaging`; direct cross-module calls (search refresh from five places, task enqueueing from workers) replaced by the ownership rules above; health, idempotency storage, and provider tests moved out of `ingress`; and the three search and queue defects in the [code review notes](code-review-2026-09-26.md) fixed where their modules are rewritten.
