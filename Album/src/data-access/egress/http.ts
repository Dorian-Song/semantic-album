import http from 'node:http';
import https from 'node:https';

export interface HttpReply {
  status: number;
  ok: boolean;
  json: unknown;
  /** The Retry-After header, if the service sent one. */
  retryAfter: string | null;
}

/** The request never got an answer (network error or timeout). */
export class NoAnswerError extends Error {
  constructor(
    readonly timedOut: boolean,
    code?: string,
  ) {
    super(timedOut ? 'timed out' : `could not be reached${code ? ` (${code})` : ''}`);
  }
}

/**
 * Connections are kept open and reused. With hundreds of requests in flight, opening a fresh TLS connection for
 * each one at the same moment fails: fetch gives up on a connection after 10 s, and a burst of 800 to DeepSeek lost
 * about a fifth of its requests that way. Here a connection may take as long as the request's own time limit.
 */
const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };

/**
 * Sends one JSON request and reads the JSON answer. Only configured destinations are called: every URL comes
 * from settings. Request and response bodies are never logged.
 */
export function sendJson(url: string, opts: { headers?: Record<string, string>; body?: unknown; timeoutMs: number; method?: string }): Promise<HttpReply> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: opts.method ?? 'POST',
        agent: agents[target.protocol as 'http:' | 'https:'],
        headers: { 'Content-Type': 'application/json', ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }), ...opts.headers },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) => reject(new NoAnswerError(signal.aborted, (err as NodeJS.ErrnoException).code)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // leave null
          }
          const status = res.statusCode ?? 0;
          const retryAfter = res.headers['retry-after'];
          resolve({ status, ok: status >= 200 && status < 300, json, retryAfter: typeof retryAfter === 'string' ? retryAfter : null });
        });
      },
    );
    req.on('error', (err) => reject(new NoAnswerError(signal.aborted, (err as NodeJS.ErrnoException).code)));
    req.end(body);
  });
}

/** Whether a health URL answers with 2xx within 1.5 s. */
export async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** A provider's error message, shortened. */
export function errorMessage(json: unknown): string | null {
  const body = json as { error?: { message?: unknown } | string; message?: unknown } | null;
  const err = body?.error;
  const msg = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : typeof body?.message === 'string' ? body.message : null;
  return msg ? msg.slice(0, 300) : null;
}

/** "Retry-After" as milliseconds (seconds or an HTTP date). */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(1_000, s * 1000);
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(1_000, t - Date.now());
}
