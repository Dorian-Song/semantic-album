import { PermanentTaskError, ServiceUnavailableError } from '../processing/task-service.js';

/** JSON contract with the "Album enrichment" n8n workflow (automation/n8n/workflow.mjs). */
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

export const purgeUrl = (webhookUrl: string) => `${webhookUrl.replace(/\/$/, '')}/purge`;

/**
 * Posts to an n8n webhook. n8n problems that affect every photo (down, wrong secret, workflow not
 * published) pause the queue; a rejected payload is permanent; a workflow error is retried.
 */
async function post(url: string, secret: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Album-Secret': secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = (err as Error).name === 'TimeoutError' ? 'did not answer in time' : 'is not reachable';
    throw new ServiceUnavailableError(`n8n ${why}`, 60_000);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave null
  }
  if (res.ok) return json;
  const detail = (json as { error?: unknown; message?: unknown } | null)?.error ?? (json as { message?: unknown } | null)?.message;
  const msg = typeof detail === 'string' ? detail.slice(0, 300) : `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new ServiceUnavailableError('n8n rejected the webhook secret', 10 * 60_000);
  if (res.status === 404) throw new ServiceUnavailableError('The n8n workflow is not published (webhook not found)', 5 * 60_000);
  if (res.status === 400 || res.status === 422) throw new PermanentTaskError(`n8n rejected the request: ${msg}`);
  throw new Error(`n8n workflow error: ${msg}`);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export async function postEnrichment(webhookUrl: string, secret: string, req: EnrichmentRequest): Promise<EnrichmentResult> {
  const r = (await post(webhookUrl, secret, req, 30_000)) as Partial<EnrichmentResult> | null;
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

export async function postPurge(webhookUrl: string, secret: string, assetId: string): Promise<{ deleted: number }> {
  const r = (await post(purgeUrl(webhookUrl), secret, { assetId }, 30_000)) as { deleted?: unknown } | null;
  return { deleted: typeof r?.deleted === 'number' ? r.deleted : 0 };
}
