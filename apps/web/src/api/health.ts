export type ServiceState = 'ok' | 'unreachable' | 'disabled' | 'not_configured';

export interface Health {
  status: 'ok' | 'degraded';
  services: { database: ServiceState; n8n: ServiceState; embedding: ServiceState };
}

/** 503 still carries a health body, so read it regardless of status. */
export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  return (await res.json()) as Health;
}
