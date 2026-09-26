# n8n (self-hosted Community edition)

The enrichment workflow runs on open-source n8n. The same `compose.yaml` is used locally and on the cloud server; only `.env` differs. Design background: [backend design, "Hosting n8n"](../../docs/backend-design.md#hosting-n8n).

## Local stage

`./start.sh` at the repository root starts the container when `N8N_MODE=local` in the root `.env`. On first run it creates `automation/n8n/.env` from `.env.example` with a fresh `N8N_ENCRYPTION_KEY`. Back that file up: without the key, credentials stored in the `album-n8n_n8n_data` volume cannot be decrypted.

- Editor: <http://localhost:5678>. The first visit asks you to create the **owner** account.
- Health: `curl http://localhost:5678/healthz`
- Logs: `docker logs -f album-n8n`
- `./stop.sh` stops the container but keeps the volume. `docker compose -f automation/n8n/compose.yaml down -v` deletes all n8n data.

## Accounts

Community edition cannot share workflows between users. Only the owner and the user who created a workflow can see it. So:

1. Create the owner account (the team's admin login).
2. In **Settings → Users**, invite a member account for the assessor. Without SMTP configured, n8n shows an invite link to copy.
3. Log in as that member and create the enrichment workflow and its Data Table there, so the assessor account owns them.

## Server stage

1. Install Docker on the server and copy this folder together with the local `.env`. Keep the same `N8N_ENCRYPTION_KEY` if you migrate the volume; otherwise export and re-import the workflow.
2. In `.env`, switch to the server block (`N8N_HOST`, `N8N_PROTOCOL=https`, `WEBHOOK_URL`, `N8N_SECURE_COOKIE=true`, `N8N_PROXY_HOPS=1`).
3. Put an HTTPS reverse proxy in front of `127.0.0.1:5678`. A minimal Caddyfile:

   ```text
   n8n.example.com {
       reverse_proxy 127.0.0.1:5678
   }
   ```

4. `docker compose up -d`, then log in and import the workflow export from this folder.
5. In the root `.env` of the machine running Album, set `N8N_MODE=remote`, `N8N_BASE_URL=https://n8n.example.com`, and the new `N8N_WEBHOOK_URL`. Nothing else in the backend changes.

## Files

- `compose.yaml`: container definition, pinned image version.
- `.env.example`: settings template (the real `.env` is gitignored).
- `workflows/` (added in build step 5): exported enrichment and purge workflows.
