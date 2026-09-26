import type { Db } from '../db/connection.js';
import type { Env } from '../config/env.js';

export type ServiceState = 'ok' | 'unreachable' | 'disabled' | 'not_configured';

export interface Health {
  status: 'ok' | 'degraded';
  services: { database: ServiceState; n8n: ServiceState; embedding: ServiceState };
}

async function probe(url: string): Promise<ServiceState> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** Only the database is required; n8n and embedding may be down without breaking browsing or Words search. */
export async function checkHealth(db: Db, env: Env): Promise<Health> {
  let database: ServiceState = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    database = 'unreachable';
  }
  const [n8n, embedding] = await Promise.all([
    env.n8nBaseUrl ? probe(`${env.n8nBaseUrl}/healthz`) : Promise.resolve<ServiceState>('not_configured'),
    env.vllmEnabled ? probe(`${env.vllmBaseUrl}/health`) : Promise.resolve<ServiceState>('disabled'),
  ]);
  return { status: database === 'ok' ? 'ok' : 'degraded', services: { database, n8n, embedding } };
}
