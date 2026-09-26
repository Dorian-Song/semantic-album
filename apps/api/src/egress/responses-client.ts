import { OutputTooLongError } from '../adapters/vision-provider.js';
import { PermanentTaskError, ServiceUnavailableError } from '../processing/task-service.js';

/**
 * Outbound calls to OpenAI-compatible Responses endpoints. HTTP failures are translated into the task
 * queue's vocabulary so workers stay simple:
 * - account-wide problems (bad key, no balance, rate limit, unknown model) pause the whole queue;
 * - request problems for this one image are permanent for the task;
 * - network errors, timeouts, and 5xx are transient and retried with backoff.
 */

function providerMessage(json: unknown): string | null {
  const err = (json as { error?: { message?: unknown } | string } | null)?.error;
  const msg = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : null;
  return msg ? msg.slice(0, 300) : null;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(1_000, s * 1000);
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(1_000, t - Date.now());
}

export async function postResponses(provider: string, url: string, apiKey: string, body: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    throw new Error(`${provider} ${reason}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave null
  }
  if (res.ok) {
    if (!json || typeof json !== 'object') throw new Error(`${provider} returned an unreadable response`);
    return json as Record<string, unknown>;
  }

  const detail = providerMessage(json) ?? `HTTP ${res.status}`;
  switch (res.status) {
    case 401:
    case 403:
      throw new ServiceUnavailableError(`${provider} rejected the API key (${detail})`, 10 * 60_000);
    case 402:
      throw new ServiceUnavailableError(`${provider} account has insufficient balance`, 10 * 60_000);
    case 404:
      throw new ServiceUnavailableError(`${provider} endpoint or model not found (${detail})`, 10 * 60_000);
    case 429:
      throw new ServiceUnavailableError(`${provider} rate limit reached`, retryAfterMs(res.headers.get('retry-after')) ?? 30_000);
    case 400:
    case 413:
    case 415:
    case 422:
      throw new PermanentTaskError(`${provider} could not process this photo (${detail})`);
    default:
      throw new Error(`${provider} error: ${detail}`);
  }
}

/** Concatenated output_text parts of a Responses API result. */
export function outputText(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  return output
    .filter((o): o is { type: string; content?: unknown } => typeof o === 'object' && o !== null && (o as { type?: unknown }).type === 'message')
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((c): c is { type: string; text: string } => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

/** A response that finished badly (content filter, token limit) is unusable for this photo. */
export function assertCompleted(provider: string, json: Record<string, unknown>): void {
  const status = json.status;
  if (status === undefined || status === 'completed') return;
  const reason = (json.incomplete_details as { reason?: string } | undefined)?.reason ?? providerMessage(json) ?? String(status);
  if (reason === 'max_output_tokens') throw new OutputTooLongError(`${provider} ran past the output limit`);
  throw new PermanentTaskError(`${provider} did not finish the description (${reason})`);
}
