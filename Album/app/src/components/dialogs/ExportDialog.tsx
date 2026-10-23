import { useMutation, useQuery } from '@tanstack/react-query';
import { createExport, exportDownloadUrl, getExport } from '../../api/exports';
import { Dialog } from '../common/Dialog';
import { FormError } from '../common/states';

/** Builds a ZIP of original photos with their descriptions, tags, and album names, then offers the download. */
export function ExportDialog({ scope, label, onClose }: { scope: { albumIds: string[] } | { assetIds: string[] }; label: string; onClose: () => void }) {
  const start = useMutation({ mutationFn: () => createExport(scope) });
  const jobId = start.data?.id;
  const job = useQuery({
    queryKey: ['export', jobId],
    queryFn: () => getExport(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.state === 'completed' || q.state.data?.state === 'failed' ? false : 1000),
  });
  const j = job.data ?? start.data;

  return (
    <Dialog title={`Export ${label}`} onClose={onClose} wide>
      <p>The ZIP file contains:</p>
      <ul className="dialog-list">
        <li>the original photos, unchanged (a photo in several albums is included once);</li>
        <li>an XMP sidecar next to each photo with its description and tags, readable by Lightroom, digiKam, and darktable;</li>
        <li>
          <code>metadata.json</code> and <code>metadata.csv</code> with descriptions, tags, album names, and capture details where known.
        </li>
      </ul>
      <p className="dialog-note">Search index data is not included. The file is kept for 24 hours.</p>
      {j && j.state !== 'completed' && j.state !== 'failed' && (
        <div role="status">
          <progress max={j.total || 1} value={j.done} aria-label="Export progress" />
          <p className="muted small">
            Preparing {j.done} of {j.total} photos…
          </p>
        </div>
      )}
      {j?.state === 'failed' && <p className="form-error">{j.error ?? 'The export failed.'} Try again.</p>}
      <FormError error={start.error ?? job.error} />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        {j?.state === 'completed' ? (
          <a className="btn btn-primary" href={exportDownloadUrl(j.id)} download={j.filename}>
            Download ZIP ({j.total} photos)
          </a>
        ) : (
          <button type="button" className="btn btn-primary" disabled={start.isPending || (!!j && j.state !== 'failed')} onClick={() => start.mutate()}>
            {j?.state === 'failed' ? 'Try again' : 'Create ZIP'}
          </button>
        )}
      </div>
    </Dialog>
  );
}
