import { getJson } from './client';

export type ServiceState = 'ok' | 'unreachable' | 'disabled' | 'not_configured';

export interface Health {
  status: 'ok' | 'degraded';
  services: { database: ServiceState; n8n: ServiceState; embedding: ServiceState };
}

export async function fetchHealth(): Promise<Health> {
  return (await getJson<Health>('/api/health')).body;
}
