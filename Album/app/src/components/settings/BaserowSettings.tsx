import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBaserow, syncBaserow } from '../../api/baserow';
import { Icon } from '../common/Icon';
import { SettingsCard, StatusPill } from './SettingsCard';

/** The local Baserow copy of the library's text. Counts and top tags are read back from Baserow itself. */
export function BaserowSettings() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ['baserow'], queryFn: getBaserow, refetchInterval: 15_000 });
  const sync = useMutation({ mutationFn: syncBaserow, onSuccess: (s) => qc.setQueryData(['baserow'], s) });
  const s = state.data;
  const status = !s?.configured ? (
    <StatusPill tone="off">Not connected</StatusPill>
  ) : s.running || sync.isPending ? (
    <StatusPill tone="busy">Syncing</StatusPill>
  ) : s.lastError || !s.overview ? (
    <StatusPill tone="warn">Not reachable</StatusPill>
  ) : (
    <StatusPill tone="ok">In sync</StatusPill>
  );

  return (
    <SettingsCard id="baserow-heading" icon="cloud" title="Baserow Database" status={status}>
      <div className="stack">
        {!s?.configured && <p className="muted small">Not configured in .env.</p>}
        {s?.overview && (
          <>
            <dl className="stat-row">
              <div>
                <dt>Albums</dt>
                <dd>{s.overview.albums.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Photos</dt>
                <dd>{s.overview.photos.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Tags</dt>
                <dd>{s.overview.tags.toLocaleString()}</dd>
              </div>
            </dl>
            {s.overview.topTags.length > 0 && (
              <ul className="tags" aria-label="Most used tags in Baserow">
                {s.overview.topTags.map((t) => (
                  <li key={t.name}>
                    {t.name} · {t.photoCount}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="test-row card-foot">
          <button type="button" className="btn btn-soft" disabled={!s?.configured || sync.isPending} onClick={() => sync.mutate()}>
            <Icon name="refresh" size={16} /> {sync.isPending ? 'Syncing…' : 'Sync now'}
          </button>
          <div role="status">
            {s?.lastError ? (
              <p className="form-error small">{s.lastError}</p>
            ) : s?.last && s.lastRunAt ? (
              <p className="muted small">
                Last sync {new Date(s.lastRunAt).toLocaleTimeString()}: {s.last.created} created, {s.last.updated} updated, {s.last.deleted} deleted.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
