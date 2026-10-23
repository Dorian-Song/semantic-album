import { RejectedError, ServiceUnavailableError } from './errors.js';
import { answers, errorMessage, NoAnswerError, sendJson } from './http.js';

/** JSON contract with the "Album enrichment" n8n workflow (n8n/workflow.mjs). */
export interface EnrichmentRequest {
  assetId: string;
  taskId: string;
  revision: number;
  caption: string;
  tags: string[];
}

export interface EnrichmentResult {
  key: string;
  assetId: string;
  revision: number;
  caption: string;
  tags: string[];
  keywords: string[];
  categories: string[];
  wordCount: number;
  /** Data Table row the workflow wrote and read back. */
  rowId: number;
  storedAt: string;
}

export interface N8nTarget {
  webhookUrl: string;
  secret: string;
}

const purgeUrl = (webhookUrl: string) => `${webhookUrl.replace(/\/$/, '')}/purge`;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The connection to the n8n webhooks. Problems that affect every photo (down, wrong secret, workflow not
 * published) are "unavailable"; a refused payload is "rejected"; a workflow error is transient. Only text is sent.
 */
async function call(url: string, secret: string, body: unknown): Promise<unknown> {
  let reply;
  try {
    reply = await sendJson(url, { headers: { 'X-Album-Secret': secret }, body, timeoutMs: 30_000 });
  } catch (err) {
    if (err instanceof NoAnswerError) throw new ServiceUnavailableError(`n8n ${err.timedOut ? 'did not answer in time' : 'is not reachable'}`, 60_000);
    throw err;
  }
  if (reply.ok) return reply.json;
  const msg = errorMessage(reply.json) ?? `HTTP ${reply.status}`;
  if (reply.status === 401 || reply.status === 403) throw new ServiceUnavailableError('n8n rejected the webhook secret', 10 * 60_000);
  if (reply.status === 404) throw new ServiceUnavailableError('The n8n workflow is not published (webhook not found)', 5 * 60_000);
  if (reply.status === 400 || reply.status === 422) throw new RejectedError(`n8n rejected the request: ${msg}`);
  throw new Error(`n8n workflow error: ${msg}`);
}

export async function enrich(target: N8nTarget, req: EnrichmentRequest): Promise<EnrichmentResult> {
  const r = (await call(target.webhookUrl, target.secret, req)) as Partial<EnrichmentResult> | null;
  if (
    !r ||
    r.key !== `${req.assetId}:${req.revision}` ||
    typeof r.caption !== 'string' ||
    !r.caption.trim() ||
    !isStrings(r.tags) ||
    !isStrings(r.keywords) ||
    !isStrings(r.categories) ||
    typeof r.rowId !== 'number'
  ) {
    throw new Error('n8n returned an unexpected response; check the workflow');
  }
  return r as EnrichmentResult;
}

/** Deletes the workflow's records of a photo. */
export async function purge(target: N8nTarget, assetId: string): Promise<{ deleted: number }> {
  const r = (await call(purgeUrl(target.webhookUrl), target.secret, { assetId })) as { deleted?: unknown } | null;
  return { deleted: typeof r?.deleted === 'number' ? r.deleted : 0 };
}

export function n8nAnswers(baseUrl: string): Promise<boolean> {
  return answers(`${baseUrl}/healthz`);
}
