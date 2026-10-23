export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** randomUUID needs a secure context; plain-http LAN access falls back to getRandomValues. */
function requestKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * One REST client for the local backend. Errors carry the backend's {error: {code, message}}.
 * Changes carry an Idempotency-Key, so the one automatic retry after a dropped connection cannot act twice.
 */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (method !== 'GET') init.headers = { ...init.headers, 'Idempotency-Key': requestKey() };
  if (options.body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    try {
      await new Promise((r) => setTimeout(r, 500));
      res = await fetch(path, init);
    } catch {
      throw new ApiError(0, 'network_error', 'Album is not responding. Is the backend running?');
    }
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
