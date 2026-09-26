#!/usr/bin/env node
// Deploys the Album enrichment workflow to an n8n instance through its public API, then points Album at it.
//
//   node automation/n8n/deploy.mjs
//
// Reads the repository .env: N8N_BASE_URL, N8N_API_KEY (n8n Settings → n8n API), optional N8N_WEBHOOK_BASE
// (public base URL for webhooks; defaults to N8N_BASE_URL), and API_PORT for the Album backend.
// Safe to repeat: the table, credential, and workflow are reused by name, and the webhook secret is rotated.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { buildWorkflow, CREDENTIAL_NAME, ENRICH_PATH, TABLE_COLUMNS, TABLE_NAME, WORKFLOW_NAME } from './workflow.mjs';

function loadEnv() {
  const file = new URL('../../.env', import.meta.url);
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env;
}

const env = loadEnv();
const n8nBase = (env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const webhookBase = (env.N8N_WEBHOOK_BASE || n8nBase).replace(/\/$/, '');
const albumApi = `http://127.0.0.1:${env.API_PORT || 3200}`;
if (!env.N8N_API_KEY) {
  console.error('N8N_API_KEY is not set in .env (create one in n8n: Settings → n8n API).');
  process.exit(1);
}

async function n8n(method, path, body) {
  const res = await fetch(`${n8nBase}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`n8n ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function listAll(path) {
  const out = [];
  let cursor = null;
  do {
    const page = await n8n('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

// 1. Data Table
let table = (await listAll('/data-tables')).find((t) => t.name === TABLE_NAME);
if (!table) {
  table = await n8n('POST', '/data-tables', { name: TABLE_NAME, columns: TABLE_COLUMNS });
  console.log(`created data table ${TABLE_NAME} (${table.id})`);
} else {
  console.log(`using data table ${TABLE_NAME} (${table.id})`);
}

// 2. Workflow lookup (to reuse its credential and webhook IDs)
const existing = (await listAll('/workflows')).find((w) => w.name === WORKFLOW_NAME && !w.isArchived);
const existingFull = existing ? await n8n('GET', `/workflows/${existing.id}`) : null;
const hookNode = (name) => existingFull?.nodes.find((n) => n.name === name);
const oldCredId = hookNode('Receive caption')?.credentials?.httpHeaderAuth?.id;

// 3. Header-auth credential with a fresh secret
const secret = randomBytes(24).toString('base64url');
const credData = { name: 'X-Album-Secret', value: secret };
let credential;
if (oldCredId) {
  credential = await n8n('PATCH', `/credentials/${oldCredId}`, { name: CREDENTIAL_NAME, type: 'httpHeaderAuth', data: credData });
  console.log(`rotated secret of credential ${CREDENTIAL_NAME} (${oldCredId})`);
} else {
  credential = await n8n('POST', '/credentials', { name: CREDENTIAL_NAME, type: 'httpHeaderAuth', data: credData });
  console.log(`created credential ${CREDENTIAL_NAME} (${credential.id})`);
}

// 4. Workflow create/update + publish
const definition = buildWorkflow({
  tableId: table.id,
  credential: { id: credential.id ?? oldCredId, name: CREDENTIAL_NAME },
  webhookIds: { enrich: hookNode('Receive caption')?.webhookId, purge: hookNode('Receive purge request')?.webhookId },
});
const workflow = existing ? await n8n('PUT', `/workflows/${existing.id}`, definition) : await n8n('POST', '/workflows', definition);
await n8n('POST', `/workflows/${workflow.id}/publish`);
console.log(`${existing ? 'updated' : 'created'} and published workflow "${WORKFLOW_NAME}" (${workflow.id})`);

// Keep a reviewable copy without instance-specific secrets.
fs.writeFileSync(new URL('./workflows/album-enrichment.json', import.meta.url), JSON.stringify(definition, null, 2) + '\n');

// 5. Point Album at the workflow
const webhookUrl = `${webhookBase}/webhook/${ENRICH_PATH}`;
const put = await fetch(`${albumApi}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ n8n: { webhookUrl, secret } }),
}).catch(() => null);
if (put?.ok) console.log(`Album now sends enrichment to ${webhookUrl}`);
else {
  console.log(`Album backend not reachable at ${albumApi}; enter these in Album Settings → n8n:`);
  console.log(`  Webhook URL: ${webhookUrl}\n  Secret: ${secret}`);
}

// 6. Smoke test: write, read back, and delete one row
const call = (path, body) =>
  fetch(`${webhookBase}/webhook/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Album-Secret': secret }, body: JSON.stringify(body) });
await new Promise((r) => setTimeout(r, 1000));
const probe = await call(ENRICH_PATH, { assetId: 'album-deploy-check', taskId: 'deploy', revision: 1, caption: 'a test caption from the deploy script', tags: ['Test', 'deploy'] });
const probeBody = await probe.text();
if (!probe.ok) throw new Error(`smoke test failed: ${probe.status} ${probeBody}`);
console.log(`smoke test: ${probeBody}`);
const purge = await call('album-enrichment/purge', { assetId: 'album-deploy-check' });
console.log(`cleanup: ${await purge.text()}`);
