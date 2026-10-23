import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceState } from '../../api/health';
import { listJobHistory } from '../../api/imports';
import { getProcessing, KIND_LABELS, retryFailed, waitingReason } from '../../api/processing';
import type { ImportJob, KindSummary, TaskKind } from '../../api/types';
import { formatDuration, formatRate } from '../../format';
import { Callout, ErrorState, Loading } from '../common/states';
import { SettingsCard, StatusPill } from './SettingsCard';

const HINTS: Record<TaskKind, string> = {
  caption: 'Cloud AI descriptions and tags.',
  embedding: 'Image vectors from the local model.',
  enrichment: 'Descriptions stored through n8n.',
  text_embedding: 'Description vectors for Meaning search.',
};

function KindRow({ k }: { k: KindSummary }) {
  const qc = useQueryClient();
  const retry = useMutation({ mutationFn: () => retryFailed(k.kind), onSuccess: () => void qc.invalidateQueries({ queryKey: ['processing'] }) });
  const total = k.pending + k.running + k.succeeded + k.failed;
  const pct = total ? Math.round((k.succeeded / total) * 100) : 0;
  const reason = waitingReason(k);
  const active = k.running > 0 || (k.pending > 0 && !reason);
  const t = k.throughput;
  return (
    <li className="kind-row">
      <div className="kind-label">
        <strong>{KIND_LABELS[k.kind]}</strong>
        <span className="muted small">{HINTS[k.kind]}</span>
      </div>
      <div className="kind-progress">
        <div className={`bar bar-${k.kind}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={KIND_LABELS[k.kind]}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">
          {k.succeeded.toLocaleString()} / {total.toLocaleString()} · {pct}%
        </span>
      </div>
      <div className="kind-state">
        {reason ? (
          <StatusPill tone={k.registered ? 'warn' : 'off'}>{k.registered ? 'Paused' : 'Not set up'}</StatusPill>
        ) : active ? (
          <StatusPill tone="busy">Running</StatusPill>
        ) : (
          <StatusPill tone="ok">Idle</StatusPill>
        )}
        {t.finishedSinceStart > 0 && (
          <span className="muted small rate" title="Rate over the last 30 seconds; average and 95th-percentile time per item over the last 500">
            {formatRate(active ? t.perSecond : t.perSecond5m)}
            {t.avgMs !== null && ` · ${formatDuration(t.avgMs)} avg`}
          </span>
        )}
      </div>
      {(reason && k.registered) || k.failed > 0 ? (
        <div className="kind-extra">
          {reason && k.registered && <span className="muted small">{k.pausedReason}</span>}
          {k.failed > 0 && (
            <button type="button" className="link-btn small" disabled={retry.isPending} onClick={() => retry.mutate()}>
              Retry {k.failed.toLocaleString()} failed
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function ProcessingCard() {
  const processing = useQuery({ queryKey: ['processing'], queryFn: getProcessing, refetchInterval: 2000 });
  return (
    <SettingsCard id="processing-heading" icon="settings" title="Background Processing" subtitle="Photos are analysed in the background after import.">
      <Callout>
        <p>Processing runs in the background and resumes after a restart. You can keep using Album while it works.</p>
      </Callout>
      {processing.isPending && <Loading />}
      {processing.isError && <ErrorState error={processing.error} />}
      {processing.data && (
        <ul className="kind-list">
          {processing.data.map((k) => (
            <KindRow key={k.kind} k={k} />
          ))}
        </ul>
      )}
      <p className="muted small">Rates are measured live in this session and reset when Album restarts.</p>
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

function JobTimeline({ job }: { job: ImportJob }) {
  return (
    <li className="history-item">
      <div className="history-head">
        <strong>{job.albumName ?? job.sourceLabel}</strong>
        <span className="muted small">
          {new Date(job.createdAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })} · {job.counts.imported.toLocaleString()} imported
          {job.counts.skipped > 0 && `, ${job.counts.skipped.toLocaleString()} skipped`}
        </span>
      </div>
      <dl className="history-stages">
        {STAGES.map(({ key, label }) => {
          const s = job.stages[key];
          return (
            <div key={key} className={s ? '' : 'is-empty'}>
              <dt>{label}</dt>
              <dd>
                {s ? (
                  <>
                    <span>{formatDuration(s.elapsedMs)}</span>
                    <span className="muted">
                      {formatRate(s.perSecond)}
                      {!s.finishedAt && ' · running'}
                    </span>
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}

export function ImportHistoryCard() {
  const history = useQuery({ queryKey: ['jobs', 'history'], queryFn: () => listJobHistory(8), refetchInterval: 5000 });
  return (
    <SettingsCard id="history-heading" icon="clock" title="Import History" subtitle="How long each stage took, and how many photos per second.">
      {history.isPending && <Loading />}
      {history.data?.length === 0 && <p className="muted">No imports yet.</p>}
      {history.data && history.data.length > 0 && (
        <ul className="history-list">
          {history.data.map((j) => (
            <JobTimeline key={j.id} job={j} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

export function EmbeddingCard({ service }: { service: ServiceState | undefined }) {
  const status =
    service === 'ok' ? <StatusPill tone="ok">Running</StatusPill> : service === 'disabled' ? <StatusPill tone="off">Turned off</StatusPill> : <StatusPill tone="warn">Not running</StatusPill>;
  return (
    <SettingsCard id="embedding-heading" icon="cpu" title="Local Image Embedding Model" subtitle="Powers Meaning search. Runs on this computer's GPU." status={status}>
      {service === 'ok' ? (
        <Callout tone="ok" title="Qwen3-VL-Embedding 2B is ready">
          <p>Photos and search text are turned into vectors locally; nothing is sent anywhere.</p>
        </Callout>
      ) : (
        <Callout tone="warn" title="Meaning search is unavailable">
          <p>{service === 'disabled' ? 'Set VLLM_ENABLED=true in .env and restart Album.' : 'The model is starting or stopped. Words search keeps working.'}</p>
        </Callout>
      )}
      <dl className="info-list">
        <div>
          <dt>Model</dt>
          <dd>Qwen3-VL-Embedding-2B · 2048 dimensions</dd>
        </div>
        <div>
          <dt>Server</dt>
          <dd>vLLM, managed by start.sh</dd>
        </div>
      </dl>
    </SettingsCard>
  );
}

