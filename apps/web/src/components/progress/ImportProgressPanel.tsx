import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { cancelImport, listJobs } from '../../api/imports';
import { getProcessing, KIND_LABELS, waitingReason } from '../../api/processing';
import type { ImportJob, KindSummary, TaskKind } from '../../api/types';
import { useRefreshLibrary } from '../../app/providers';
import { resumeWithFiles, useActiveUploads } from '../../hooks/uploads';
import { formatDuration, formatRate } from '../../format';
import { Icon } from '../common/Icon';
import { FileInput } from '../dialogs/ImportDialogs';

const REASONS: Record<string, string> = {
  unsupported_format: 'not a supported image',
  too_large: 'file is too large',
  source_missing: 'file disappeared before it was copied',
  permission_denied: 'no permission to read the file',
  album_deleted: 'the album was deleted',
  internal_error: 'unexpected error',
};

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

const KINDS: TaskKind[] = ['caption', 'embedding', 'enrichment'];

/** Caption/embedding/enrichment progress, shown apart from import counts: a photo is imported before AI work ends. */
function ProcessingLines({ job, kinds }: { job: ImportJob; kinds: KindSummary[] }) {
  const rows = KINDS.filter((k) => job.processing[k].total > 0);
  if (rows.length === 0) return null;
  return (
    <ul className="job-processing">
      {rows.map((k) => {
        const p = job.processing[k];
        const reason = p.done + p.failed < p.total ? waitingReason(kinds.find((x) => x.kind === k)) : null;
        const clock = job.stages[k];
        const pct = p.total ? ((p.done + p.failed) / p.total) * 100 : 0;
        return (
          <li key={k}>
            <div className="job-stage-line">
              <span>{KIND_LABELS[k]}</span>
              <span className="muted">
                {p.done.toLocaleString()} / {p.total.toLocaleString()}
                {p.failed > 0 && ` · ${p.failed} failed`}
                {reason ? ` · ${reason}` : clock && ` · ${formatRate(clock.perSecond)}`}
              </span>
            </div>
            <div className={`bar bar-thin bar-${k}`} aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Processing that can still advance: some tasks are unfinished and their kind is set up and not paused. */
function processingActive(job: ImportJob, kinds: KindSummary[]): boolean {
  return KINDS.some((k) => {
    const p = job.processing[k];
    return p.done + p.failed < p.total && waitingReason(kinds.find((x) => x.kind === k)) === null;
  });
}

function JobCard({ job, kinds, uploading, onDismiss }: { job: ImportJob; kinds: KindSummary[]; uploading: boolean; onDismiss: () => void }) {
  const refresh = useRefreshLibrary();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const { total, imported, skipped, failed, pending } = job.counts;
  const done = total - pending;
  const terminal = TERMINAL.has(job.state);
  const needsReselect = job.kind === 'files' && !uploading && !terminal && job.missingKeys.length > 0;
  const target = job.albumName ? `“${job.albumName}”` : 'a deleted album';

  const reselect = (files: File[]) => {
    const matched = resumeWithFiles(job, files, refresh);
    setNote(matched === 0 ? 'None of those files belong to this import.' : `Uploading ${matched} file${matched === 1 ? '' : 's'}…`);
  };

  const title =
    job.state === 'completed' ? `Imported into ${target}` : job.state === 'canceled' ? 'Import canceled' : needsReselect ? 'Import waiting for files' : `Importing into ${target}`;

  return (
    <li className="job-card">
      <div className="job-head">
        <strong>{title}</strong>
        {terminal ? (
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
            <Icon name="x" size={16} />
          </button>
        ) : (
          <button type="button" className="link-btn" onClick={() => void cancelImport(job.id).then(refresh)}>
            Cancel
          </button>
        )}
      </div>
      <p className="muted job-source">{job.sourceLabel}</p>
      <div className="bar bar-import" role="progressbar" aria-label="Import progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total || 1}>
        <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <p className="job-counts">
        {imported.toLocaleString()} of {total.toLocaleString()} imported
        {skipped > 0 && ` · ${skipped} skipped`}
        {failed > 0 && ` · ${failed} failed`}
        {job.stages.import && (
          <span className="muted">
            {' '}
            · {formatDuration(job.stages.import.elapsedMs)}, {formatRate(job.stages.import.perSecond)}
          </span>
        )}
      </p>
      <ProcessingLines job={job} kinds={kinds} />
      {needsReselect && (
        <div className="job-reselect">
          <p>
            {job.missingKeys.length} file{job.missingKeys.length === 1 ? ' was' : 's were'} not received. Select the same files again to finish.
          </p>
          <div className="button-row">
            <button type="button" className="btn btn-small" onClick={() => filesRef.current?.click()}>
              Select files
            </button>
            <button type="button" className="btn btn-small" onClick={() => folderRef.current?.click()}>
              Select folder
            </button>
          </div>
          <FileInput inputRef={filesRef} onFiles={reselect} />
          <FileInput inputRef={folderRef} folder onFiles={reselect} />
        </div>
      )}
      {note && <p className="muted">{note}</p>}
      {job.problems.length > 0 && (
        <details>
          <summary>Show skipped and failed files</summary>
          <ul className="job-problems">
            {job.problems.map((p, i) => (
              <li key={i}>
                {p.filename} — {REASONS[p.reason ?? ''] ?? p.reason ?? p.state}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Durable import progress from the backend, polled while anything is running. Survives reloads. */
export function ImportProgressPanel() {
  const refresh = useRefreshLibrary();
  const uploading = useActiveUploads();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const processing = useQuery({ queryKey: ['jobs', 'processing'], queryFn: getProcessing, refetchInterval: 5000 });
  const kinds = processing.data ?? [];
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: listJobs,
    refetchInterval: (q) =>
      (q.state.data ?? []).some((j) => !TERMINAL.has(j.state) || processingActive(j, kinds)) || uploading.size > 0 ? 1500 : 15_000,
  });

  // New photos appear in galleries as they are imported.
  const importedSum = (jobs.data ?? []).reduce((n, j) => n + j.counts.imported, 0);
  const last = useRef(importedSum);
  useEffect(() => {
    if (importedSum !== last.current) {
      last.current = importedSum;
      refresh();
    }
  }, [importedSum, refresh]);

  // A clean finished import tidies itself away; one with skipped or failed files stays until dismissed.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const j of jobs.data ?? []) {
      const clean = j.state === 'completed' && j.problems.length === 0 && j.counts.failed === 0 && !processingActive(j, kinds);
      if (clean && !dismissed.has(j.id) && !timers.current.has(j.id)) {
        timers.current.set(j.id, setTimeout(() => setDismissed((d) => new Set(d).add(j.id)), 6000));
      }
    }
  }, [jobs.data, dismissed, kinds]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const visible = (jobs.data ?? []).filter((j) => !dismissed.has(j.id));
  if (visible.length === 0) return null;
  return (
    <section className="progress-panel" aria-label="Imports" aria-live="polite">
      <ul>
        {visible.map((job) => (
          <JobCard key={job.id} job={job} kinds={kinds} uploading={uploading.has(job.id)} onDismiss={() => setDismissed((d) => new Set(d).add(job.id))} />
        ))}
      </ul>
    </section>
  );
}
