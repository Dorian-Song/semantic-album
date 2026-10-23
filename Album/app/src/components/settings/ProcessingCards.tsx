import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listJobHistory } from '../../api/imports';
import { getProcessing, KIND_LABELS, retryFailed, waitingReason } from '../../api/processing';
import type { ImportJob, KindSummary, TaskKind } from '../../api/types';
import { formatDuration, formatRate } from '../../format';
import { ErrorState, Loading } from '../common/states';
import { SettingsCard, StatusPill } from './SettingsCard';

function KindTile({ k }: { k: KindSummary }) {
  const qc = useQueryClient();
  const retry = useMutation({ mutationFn: () => retryFailed(k.kind), onSuccess: () => void qc.invalidateQueries({ queryKey: ['processing'] }) });
  const total = k.pending + k.running + k.succeeded + k.failed;
  const pct = total ? Math.round((k.succeeded / total) * 100) : 0;
  const reason = waitingReason(k);
  const active = k.running > 0 || (k.pending > 0 && !reason);
  const t = k.throughput;
  return (
    <li className="kind-tile">
      <div className="kind-tile-head">
        <strong>{KIND_LABELS[k.kind]}</strong>
        {reason ? (
          <StatusPill tone={k.registered ? 'warn' : 'off'}>{k.registered ? 'Paused' : 'Not set up'}</StatusPill>
        ) : active ? (
          <StatusPill tone="busy">Running</StatusPill>
        ) : (
          <StatusPill tone="ok">Idle</StatusPill>
        )}
      </div>
      <div className={`bar bar-${k.kind}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={KIND_LABELS[k.kind]}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="kind-tile-foot muted small">
        <span>
          {k.succeeded.toLocaleString()} / {total.toLocaleString()}
        </span>
        {t.finishedSinceStart > 0 ? (
          <span className="rate" title="Rate over the last 30 seconds; average time per item over the last 500">
            {formatRate(active ? t.perSecond : t.perSecond5m)}
            {t.avgMs !== null && ` · ${formatDuration(t.avgMs)} avg`}
          </span>
        ) : (
          <span>{pct}%</span>
        )}
      </div>
      {reason && k.registered && <span className="muted small">{k.pausedReason}</span>}
      {k.failed > 0 && (
        <button type="button" className="link-btn small" disabled={retry.isPending} onClick={() => retry.mutate()}>
          Retry {k.failed.toLocaleString()} failed
        </button>
      )}
    </li>
  );
}

export function ProcessingCard() {
  const processing = useQuery({ queryKey: ['processing'], queryFn: getProcessing, refetchInterval: 2000 });
  return (
    <SettingsCard id="processing-heading" icon="settings" title="Background Processing">
      {processing.isPending && <Loading />}
      {processing.isError && <ErrorState error={processing.error} />}
      {processing.data && (
        <ul className="kind-tiles">
          {processing.data.map((k) => (
            <KindTile key={k.kind} k={k} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

const STAGES: { key: 'import' | TaskKind; label: string }[] = [
  { key: 'import', label: 'Import' },
  { key: 'caption', label: 'Descriptions' },
  { key: 'embedding', label: 'Image index' },
  { key: 'enrichment', label: 'n8n' },
  { key: 'text_embedding', label: 'Text index' },
];

function StageCell({ s }: { s: ImportJob['stages'][keyof ImportJob['stages']] }) {
  if (!s) return <td className="muted">—</td>;
  return (
    <td>
      <span>{formatDuration(s.elapsedMs)}</span>
      <span className="muted small">
        {formatRate(s.perSecond)}
        {!s.finishedAt && ' · running'}
      </span>
    </td>
  );
}

export function ImportHistoryCard() {
  const history = useQuery({ queryKey: ['jobs', 'history'], queryFn: () => listJobHistory(5), refetchInterval: 5000 });
  return (
    <SettingsCard id="history-heading" icon="clock" title="Import History">
      {history.isPending && <Loading />}
      {history.data?.length === 0 && <p className="muted">No imports yet.</p>}
      {history.data && history.data.length > 0 && (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th scope="col">Album</th>
                <th scope="col">Photos</th>
                {STAGES.map(({ key, label }) => (
                  <th key={key} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.data.map((j) => (
                <tr key={j.id}>
                  <th scope="row">
                    <span>{j.albumName ?? j.sourceLabel}</span>
                    <span className="muted small">{new Date(j.createdAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </th>
                  <td>
                    <span>{j.counts.imported.toLocaleString()}</span>
                    {j.counts.skipped > 0 && <span className="muted small">{j.counts.skipped.toLocaleString()} skipped</span>}
                  </td>
                  {STAGES.map(({ key }) => (
                    <StageCell key={key} s={j.stages[key]} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}
