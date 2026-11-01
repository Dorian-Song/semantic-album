# Operaton (self-hosted, local)

Operaton is an open-source BPMN engine (Apache 2.0), the community fork of Camunda 7 CE. It runs Album's photo-review workflow.

- Start: `docker compose up -d` in this folder (first start ~30 s). The `volume-init` step only fixes data-volume ownership and exits.
- Web apps: <http://127.0.0.1:8090/operaton/app/> — Cockpit (process status), Tasklist (human tasks), Admin (users and groups). Login `demo` / `demo`.
- REST API: <http://127.0.0.1:8090/engine-rest> (no authentication; bound to 127.0.0.1 only).
- Data: H2 database in the `album-operaton_operaton_data` volume. `docker compose down -v` deletes it.
- The built-in invoice example is disabled.

## Photo-review workflow

`processes/photo-review.bpmn` — a contributor submits a photo for a shared album; an AI privacy check reads the photo's description, tags, objects and text in the image from Album (never the image) and asks DeepSeek for a risk level. Low risk is published automatically; medium or high risk goes to an album admin, who approves (optionally editing the caption), asks the contributor for changes, or rejects. Publishing adds the photo to the album through Album's REST API; Album's Baserow sync copies the change to Baserow.

1. `node worker/setup.mjs` — deploys the process and creates the participants, groups and Tasklist filters (safe to rerun).
2. `node worker/worker.mjs` — the external-task worker for the `ai-review` and `publish` steps. It also watches the Baserow **Submissions** table: a new row starts a process, a row set to Withdrawn cancels it, and each running process's status, AI risk and findings and the admin's comment are written back every few seconds. Keys and URLs come from `Album/.env` (`ALBUM_API_KEY`, `DEEPSEEK_API_KEY`, `API_PORT`, `WEB_PORT`, `BASEROW_TOKEN`, `BASEROW_TABLE_PHOTOS`, `BASEROW_TABLE_SUBMISSIONS`); Album's API must be running.

| User | Password | Group | Role |
| --- | --- | --- | --- |
| `alex` | `alex-demo` | contributors | starts "Shared album photo review" in Tasklist, revises when asked |
| `sam` | `sam-demo` | albumAdmins | claims and completes "Review submission" |
| `demo` | `demo` | operaton-admin | Cockpit and Admin |

If DeepSeek fails three times, the photo goes to the admin as medium risk instead of blocking. An unknown photo id becomes an incident in Cockpit.
