import { useQuery } from '@tanstack/react-query';
import { fetchHealth, type Health, type ServiceState } from '../api/health';
import { ErrorState, Loading } from '../components/common/states';

const SERVICE_LABELS: Record<keyof Health['services'], string> = {
  database: 'Library database',
  n8n: 'n8n enrichment',
  embedding: 'Local embedding model',
};

const STATE_TEXT: Record<ServiceState, string> = {
  ok: 'Running',
  unreachable: 'Not reachable',
  disabled: 'Disabled',
  not_configured: 'Not configured',
};

export function SettingsPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 5000 });
  return (
    <>
      <h1>Settings</h1>
      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading">Services</h2>
        {health.isPending && <Loading label="Checking services…" />}
        {health.isError && <ErrorState error={health.error} />}
        {health.data && (
          <dl className="status-list">
            {(Object.keys(SERVICE_LABELS) as (keyof Health['services'])[]).map((key) => (
              <div key={key} className="status-row">
                <dt>{SERVICE_LABELS[key]}</dt>
                <dd data-state={health.data.services[key]}>{STATE_TEXT[health.data.services[key]]}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="muted small">Description model, search, and n8n settings are added with the AI features.</p>
      </section>
    </>
  );
}
