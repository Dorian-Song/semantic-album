import { ServiceUnavailableError } from './errors.js';
import { errorMessage, NoAnswerError, sendJson } from './http.js';

export interface BaserowTarget {
  baseUrl: string;
  token: string;
}

/** A row as the REST API returns it with user_field_names=true. Link fields come back as [{id, value}]. */
export type BaserowRow = { id: number } & Record<string, unknown>;

/** Baserow refuses batches larger than this (BATCH_ROWS_SIZE_LIMIT). */
const BATCH = 200;

/**
 * The Baserow REST API with a database token. Only text is sent. Down, wrong token or a missing table make the
 * whole service "unavailable"; anything else is a plain error.
 */
async function call(target: BaserowTarget, method: string, path: string, body?: unknown): Promise<unknown> {
  let reply;
  try {
    reply = await sendJson(`${target.baseUrl}${path}`, { method, headers: { Authorization: `Token ${target.token}` }, body, timeoutMs: 60_000 });
  } catch (err) {
    if (err instanceof NoAnswerError) throw new ServiceUnavailableError(`Baserow ${err.timedOut ? 'did not answer in time' : 'is not reachable'}`);
    throw err;
  }
  if (reply.ok) return reply.json;
  const msg = errorMessage(reply.json) ?? (reply.json as { detail?: string } | null)?.detail ?? `HTTP ${reply.status}`;
  if (reply.status === 401 || reply.status === 403) throw new ServiceUnavailableError(`Baserow rejected the database token: ${msg}`);
  if (reply.status === 404) throw new ServiceUnavailableError(`Baserow table not found: ${msg}`);
  throw new Error(`Baserow error: ${msg}`);
}

const rowsPath = (table: number, suffix = '') => `/api/database/rows/table/${table}/${suffix}?user_field_names=true`;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

export async function listRows(target: BaserowTarget, table: number): Promise<BaserowRow[]> {
  const rows: BaserowRow[] = [];
  for (let page = 1; ; page++) {
    const r = (await call(target, 'GET', `${rowsPath(table)}&size=200&page=${page}`)) as { results: BaserowRow[]; next: string | null };
    rows.push(...r.results);
    if (!r.next) return rows;
  }
}

/** Creates rows in batches; returns them with their new ids, in input order. */
export async function createRows(target: BaserowTarget, table: number, items: Record<string, unknown>[]): Promise<BaserowRow[]> {
  const created: BaserowRow[] = [];
  for (const batch of chunks(items)) {
    const r = (await call(target, 'POST', rowsPath(table, 'batch/'), { items: batch })) as { items: BaserowRow[] };
    created.push(...r.items);
  }
  return created;
}

export async function updateRows(target: BaserowTarget, table: number, items: ({ id: number } & Record<string, unknown>)[]): Promise<void> {
  for (const batch of chunks(items)) await call(target, 'PATCH', rowsPath(table, 'batch/'), { items: batch });
}

export async function deleteRows(target: BaserowTarget, table: number, ids: number[]): Promise<void> {
  for (const batch of chunks(ids)) await call(target, 'POST', `/api/database/rows/table/${table}/batch-delete/`, { items: batch });
}

/** One page of rows, optionally sorted by a field name ("-Field" for descending), plus the table's total row count. */
export async function rowPage(target: BaserowTarget, table: number, size: number, orderBy?: string): Promise<{ count: number; rows: BaserowRow[] }> {
  const order = orderBy ? `&order_by=${encodeURIComponent(orderBy)}` : '';
  const r = (await call(target, 'GET', `${rowsPath(table)}&size=${size}${order}`)) as { count: number; results: BaserowRow[] };
  return { count: r.count, rows: r.results };
}
