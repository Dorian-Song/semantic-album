export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One REST client for the local backend. Non-2xx responses carry a JSON body we still want to read. */
export async function getJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } });
  const text = await res.text();
  if (!text) throw new ApiError(res.status, `Empty response from ${path}`);
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    throw new ApiError(res.status, `Unexpected response from ${path}`);
  }
}
