import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { regenerateCaption } from '../../api/photos';
import { getProcessing, waitingReason } from '../../api/processing';
import type { PhotoDetail } from '../../api/types';
import { useRefreshLibrary } from '../../app/providers';

const PROVIDERS: Record<string, string> = { deepseek: 'DeepSeek', openai: 'OpenAI' };

/** The shown description, who wrote it, and where the AI draft stands. */
export function DescriptionBlock({ photo, onEdit }: { photo: PhotoDetail; onEdit: () => void }) {
  const refresh = useRefreshLibrary();
  const d = photo.description;
  const task = photo.processing.caption;
  const busy = task?.state === 'pending' || task?.state === 'running';
  const kinds = useQuery({ queryKey: ['processing'], queryFn: getProcessing, enabled: busy, refetchInterval: busy ? 3000 : false });
  const reason = waitingReason(kinds.data?.find((k) => k.kind === 'caption'));
  const regenerate = useMutation({ mutationFn: () => regenerateCaption(photo.id), onSuccess: refresh });

  // Refetch this photo while its description is being written, so it appears without a reload.
  const qc = useQueryClient();
  const polling = busy && !reason;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: ['photo', photo.id] }), 3000);
    return () => clearInterval(timer);
  }, [polling, qc, photo.id]);

  return (
    <>
      {d?.effective ? (
        <>
          <p className="description-meta">{d.manual ? 'Written by you' : `AI description${d.provider ? ` · ${PROVIDERS[d.provider] ?? d.provider}` : ''}`}</p>
          <p className="description">{d.effective}</p>
        </>
      ) : (
        <p className="muted">No description yet.</p>
      )}
      {d && d.tags.length > 0 && (
        <ul className="tags" aria-label="Tags">
          {d.tags.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      {d?.text && (
        <details className="image-text">
          <summary>Text in this image</summary>
          <pre>{d.text}</pre>
        </details>
      )}
      {d && d.objects.length > 0 && <p className="muted small">Visible: {d.objects.join(', ')}</p>}
      {d?.enrichment && d.enrichment.categories.length > 0 && (
        <p className="muted small">
          Categories from n8n: {d.enrichment.categories.join(', ')}
        </p>
      )}
      {photo.processing.enrichment?.state === 'failed' && (
        <p className="muted small" role="status">
          n8n enrichment failed: {photo.processing.enrichment.error ?? 'unknown error'}
        </p>
      )}
      {busy && (
        <p className="description-status" role="status">
          {reason ? (
            <>
              AI description waiting: {reason}. <Link to="/settings">Settings</Link>
            </>
          ) : (
            'Writing an AI description…'
          )}
        </p>
      )}
      {task?.state === 'failed' && (
        <p className="form-error" role="alert">
          AI description failed: {task.error ?? 'unknown error'}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="btn btn-small" onClick={onEdit}>
          {d?.effective ? 'Edit description' : 'Add description'}
        </button>
        {task && !busy && (
          <button type="button" className="btn btn-small" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
            {task.state === 'failed' ? 'Try again' : 'Regenerate AI description'}
          </button>
        )}
      </div>
      {d?.manual && d.ai && <p className="muted small">An AI description also exists; your text is shown and searched instead.</p>}
    </>
  );
}
