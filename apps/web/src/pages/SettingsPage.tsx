import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchHealth, type Health, type ServiceState } from '../api/health';
import { getProcessing, KIND_LABELS, retryFailed, waitingReason } from '../api/processing';
import { getSettings } from '../api/settings';
import type { KindSummary } from '../api/types';
import { ErrorState, Loading } from '../components/common/states';
import { CaptionSettings } from '../components/settings/CaptionSettings';
import { N8nSettings } from '../components/settings/N8nSettings';
import { PrivacySummary, SearchSettings } from '../components/settings/SearchSettings';

function KindRow({ k }: { k: KindSummary }) {
  const qc = useQueryClient();
  const retry = useMutation({ mutationFn: () => retryFailed(k.kind), onSuccess: () => void qc.invalidateQueries({ queryKey: ['processing'] }) });
  const reason = waitingReason(k);
  const total = k.pending + k.running + k.succeeded + k.failed;
  return (
    <tr>
      <th scope="row">{KIND_LABELS[k.kind]}</th>
      <td>
        {k.succeeded} of {total}
      </td>
      <td>{k.running > 0 ? `${k.running} running` : '—'}</td>
      <td>{k.retrying > 0 ? `${k.retrying} waiting to retry` : '—'}</td>
      <td>
        {k.failed > 0 ? (
          <button type="button" className="link-btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
            Retry {k.failed} failed
          </button>
        ) : (
          '—'
        )}
      </td>
      <td className="muted">{reason ?? (k.pending + k.running > 0 ? 'Working' : 'Idle')}</td>
    </tr>
  );
}

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
  const processing = useQuery({ queryKey: ['processing'], queryFn: getProcessing, refetchInterval: 3000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  return (
    <>
      <h1>Settings</h1>
      {settings.isPending && <Loading />}
      {settings.isError && <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />}
      {settings.data && <CaptionSettings settings={settings.data} />}
      {settings.data && <SearchSettings settings={settings.data} />}
      {settings.data && <N8nSettings settings={settings.data} />}
      {settings.data && <PrivacySummary settings={settings.data} />}
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
      </section>

      <section className="card" aria-labelledby="processing-heading">
        <h2 id="processing-heading">Background processing</h2>
        <p className="muted small">Each photo gets a description and a search index entry after it is imported. These run separately and resume after a restart.</p>
        {processing.isPending && <Loading />}
        {processing.isError && <ErrorState error={processing.error} />}
        {processing.data && (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Done</th>
                <th scope="col">Running</th>
                <th scope="col">Retrying</th>
                <th scope="col">Failed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {processing.data.map((k) => (
                <KindRow key={k.kind} k={k} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
