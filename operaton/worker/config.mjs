import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Settings come from Album/.env (keys are shared with Album) and may be overridden by the environment. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = readEnvFile(path.resolve(here, '../../Album/.env'));
const get = (name, fallback) => process.env[name] || file[name] || fallback;

export const config = {
  operatonUrl: get('OPERATON_URL', 'http://127.0.0.1:8090/engine-rest'),
  albumUrl: get('ALBUM_URL', `http://127.0.0.1:${get('API_PORT', '3200')}`),
  albumApiKey: get('ALBUM_API_KEY', ''),
  webUrl: get('ALBUM_WEB_URL', `http://127.0.0.1:${get('WEB_PORT', '5173')}`),
  deepseekUrl: get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
  deepseekModel: get('DEEPSEEK_MODEL', 'deepseek-flash'),
  deepseekKey: get('DEEPSEEK_API_KEY', ''),
  baserowUrl: get('BASEROW_URL', 'http://localhost:8085').replace(/\/$/, ''),
  baserowToken: get('BASEROW_TOKEN', ''),
  photosTable: get('BASEROW_TABLE_PHOTOS', ''),
  submissionsTable: get('BASEROW_TABLE_SUBMISSIONS', ''),
  makeWebhookUrl: get('MAKE_WEBHOOK_URL', ''),
  makeWebhookSecret: get('MAKE_WEBHOOK_SECRET', ''),
};

/** JSON request helper. Throws an Error carrying `status` for non-2xx answers. */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep null
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? (typeof json?.error === 'string' ? json.error : null) ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`${method} ${new URL(url).pathname}: ${msg}`), { status: res.status });
  }
  return json;
}
