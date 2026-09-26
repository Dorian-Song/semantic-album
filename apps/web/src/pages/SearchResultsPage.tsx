import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { listAlbums } from '../api/albums';
import { thumbnailUrl } from '../api/photos';
import { getFacets, searchPhotos, type SearchMode, type SearchParams } from '../api/search';
import { getSettings } from '../api/settings';
import { EmptyState, ErrorState, Loading } from '../components/common/states';
import { setSearchContext } from '../hooks/searchContext';

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'words', label: 'Words', hint: 'Descriptions, tags, and file names' },
  { value: 'meaning', label: 'Meaning', hint: 'What the photo looks like' },
  { value: 'both', label: 'Both', hint: 'Words and meaning combined' },
];

const PAGE = 60;

export function SearchResultsPage() {
  const [params, setParams] = useSearchParams();
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const albums = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  const facets = useQuery({ queryKey: ['facets'], queryFn: getFacets });

  const q = params.get('q') ?? '';
  const mode = (params.get('mode') as SearchMode | null) ?? settings.data?.defaultSearchMode ?? 'words';
  const albumIds = (params.get('albums') ?? '').split(',').filter(Boolean);
  const takenFrom = params.get('from') ?? '';
  const takenTo = params.get('to') ?? '';
  const camera = params.get('camera') ?? '';

  const request: SearchParams = {
    query: q,
    mode,
    ...(albumIds.length ? { albumIds } : {}),
    ...(takenFrom ? { takenFrom } : {}),
    ...(takenTo ? { takenTo } : {}),
    ...(camera ? { camera } : {}),
  };
  const results = useInfiniteQuery({
    queryKey: ['search', request],
    queryFn: ({ pageParam }) => searchPhotos({ ...request, offset: pageParam, limit: PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    enabled: q.trim() !== '' && (params.has('mode') || settings.isSuccess),
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  const first = results.data?.pages[0];
  const href = `/search?${params.toString()}`;

  useEffect(() => {
    if (items.length) setSearchContext({ href, items });
  }, [href, items]);

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const toggleAlbum = (id: string) => {
    const set = new Set(albumIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    update('albums', [...set].join(','));
  };
  const scopeLabel =
    albumIds.length === 0
      ? 'All albums'
      : albumIds.length === 1
        ? (albums.data?.find((a) => a.id === albumIds[0])?.name ?? '1 album')
        : `${albumIds.length} albums`;
  const f = facets.data;
  const hasDates = (f?.taken.withDate ?? 0) > 0;
  const hasCameras = (f?.cameras.length ?? 0) > 0;

  return (
    <>
      <h1>{q ? `Results for “${q}”` : 'Search'}</h1>

      <div className="search-controls">
        <fieldset className="segmented" aria-label="Search by">
          {MODES.map((m) => (
            <label key={m.value} title={m.hint} className={mode === m.value ? 'is-active' : ''}>
              <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => update('mode', m.value)} />
              {m.label}
            </label>
          ))}
        </fieldset>

        <details className="menu scope-menu">
          <summary>
            Albums: <strong>{scopeLabel}</strong>
          </summary>
          <div className="menu-list scope-list">
            <label>
              <input type="checkbox" checked={albumIds.length === 0} onChange={() => update('albums', null)} />
              All albums
            </label>
            {albums.data?.map((a) => (
              <label key={a.id}>
                <input type="checkbox" checked={albumIds.includes(a.id)} onChange={() => toggleAlbum(a.id)} />
                {a.name}
              </label>
            ))}
          </div>
        </details>

        {hasDates && (
          <div className="filter-dates">
            <label>
              Taken from
              <input type="date" value={takenFrom} min={f?.taken.earliest ?? undefined} max={f?.taken.latest ?? undefined} onChange={(e) => update('from', e.target.value)} />
            </label>
            <label>
              to
              <input type="date" value={takenTo} min={f?.taken.earliest ?? undefined} max={f?.taken.latest ?? undefined} onChange={(e) => update('to', e.target.value)} />
            </label>
          </div>
        )}
        {hasCameras && (
          <label className="filter-camera">
            Camera
            <select value={camera} onChange={(e) => update('camera', e.target.value)}>
              <option value="">Any</option>
              {f?.cameras.map((c) => (
                <option key={c.model} value={c.model}>
                  {c.model} ({c.count})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!q && <EmptyState title="Type something to search for" />}
      {results.isPending && q && <Loading label="Searching…" />}
      {results.isError && <ErrorState error={results.error} onRetry={() => void results.refetch()} />}

      {first && (
        <div className="search-notices" aria-live="polite">
          <p className="muted">
            {first.total} result{first.total === 1 ? '' : 's'} · {Math.round(first.timingsMs.total)} ms
          </p>
          {first.meaning === 'ok' && first.total > 0 && (
            <p className="muted small">Sorted by how closely each photo matches; photos further down match less well.</p>
          )}
          {first.fallbackToWords && (
            <p className="notice">
              Meaning search is unavailable right now ({first.meaningReason}). Showing <strong>Words</strong> results instead.
            </p>
          )}
          {first.corrections.length > 0 && (
            <p className="notice">
              No exact match for {first.corrections.map((c) => `“${c.from}”`).join(', ')}; showing results for{' '}
              {first.corrections.map((c) => `“${c.to}”`).join(', ')}.
            </p>
          )}
          {first.excludedForMissingMetadata > 0 && (
            <p className="muted small">
              {first.excludedForMissingMetadata} photo{first.excludedForMissingMetadata === 1 ? '' : 's'} in scope have no date or camera information and are not
              included by the filter.
            </p>
          )}
        </div>
      )}

      {first && first.total === 0 && (
        <EmptyState title="No matching photos">
          <p>
            {mode === 'words'
              ? 'Try other words, or search by Meaning to find photos by what they show.'
              : 'Try different words or widen the album scope.'}
          </p>
        </EmptyState>
      )}

      <ul className="photo-grid result-grid">
        {items.map((p) => (
          <li key={p.id} className="result-card">
            <Link to={`/photos/${p.id}?from=search`} className="photo-link result-thumb">
              <img src={thumbnailUrl(p.id)} alt={p.filename} loading="lazy" />
            </Link>
            <p className="result-albums" title={p.albums.map((a) => a.name).join(', ')}>
              {p.albums.map((a) => a.name).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
      {results.hasNextPage && (
        <button type="button" className="btn load-more" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
          {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
