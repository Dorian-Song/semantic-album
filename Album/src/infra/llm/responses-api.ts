import { OutputTooLongError, RejectedError, ServiceUnavailableError } from '../../data-access/egress/errors.js';
import { errorMessage, NoAnswerError, retryAfterMs, sendJson } from '../../data-access/egress/http.js';

/**
 * The OpenAI-style Responses API, spoken by both providers. HTTP failures become the shared error categories:
 * account-wide problems (bad key, no balance, rate limit, unknown model) are "unavailable"; problems with this
 * one request are "rejected"; network errors, timeouts, and 5xx are transient.
 */
export async function postResponses(provider: string, url: string, apiKey: string, body: unknown): Promise<Record<string, unknown>> {
  let reply;
  try {
    reply = await sendJson(url, { headers: { Authorization: `Bearer ${apiKey}` }, body, timeoutMs: 120_000 });
  } catch (err) {
    if (err instanceof NoAnswerError) throw new Error(`${provider} ${err.message}`);
    throw err;
  }
  if (reply.ok) {
    if (!reply.json || typeof reply.json !== 'object') throw new Error(`${provider} returned an unreadable response`);
    const json = reply.json as Record<string, unknown>;
    assertCompleted(provider, json);
    return json;
  }
  const detail = errorMessage(reply.json) ?? `HTTP ${reply.status}`;
  switch (reply.status) {
    case 401:
    case 403:
      throw new ServiceUnavailableError(`${provider} rejected the API key (${detail})`, 10 * 60_000);
    case 402:
      throw new ServiceUnavailableError(`${provider} account has insufficient balance`, 10 * 60_000);
    case 404:
      throw new ServiceUnavailableError(`${provider} endpoint or model not found (${detail})`, 10 * 60_000);
    case 429:
      throw new ServiceUnavailableError(`${provider} rate limit reached`, retryAfterMs(reply.retryAfter) ?? 30_000);
    case 400:
    case 413:
    case 415:
    case 422:
      throw new RejectedError(`${provider} could not process this request (${detail})`);
    default:
      throw new Error(`${provider} error: ${detail}`);
  }
}

/** A response that finished badly (content filter, token limit) is unusable. */
function assertCompleted(provider: string, json: Record<string, unknown>): void {
  const status = json.status;
  if (status === undefined || status === 'completed') return;
  const reason = (json.incomplete_details as { reason?: string } | undefined)?.reason ?? errorMessage(json) ?? String(status);
  if (reason === 'max_output_tokens') throw new OutputTooLongError(`${provider} ran past the output limit`);
  throw new RejectedError(`${provider} did not finish the answer (${reason})`);
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
