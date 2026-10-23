import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { listAlbums } from '../api/albums';
import { thumbnailUrl } from '../api/photos';
import { getFacets, searchPhotos, type SearchMode, type SearchParams } from '../api/search';
import { getSettings } from '../api/settings';
import { Icon } from '../components/common/Icon';
import { Callout, EmptyState, ErrorState, Loading } from '../components/common/states';
import { setSearchContext } from '../hooks/searchContext';

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'words', label: 'Words', hint: 'Descriptions, tags, text in images, and file names' },
  { value: 'meaning', label: 'Meaning', hint: 'What the photo looks like' },
  { value: 'both', label: 'Both', hint: 'Words and meaning combined' },
];

const KIND_NAMES: Record<string, string> = {
  photo: 'Photos',
  screenshot: 'Screenshots',
  document: 'Documents',
  illustration: 'Illustrations',
  other: 'Other',
};

const PAGE = 60;

function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

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
  const kind = params.get('kind') ?? '';

  const request: SearchParams = {
    query: q,
    mode,
    ...(albumIds.length ? { albumIds } : {}),
    ...(takenFrom ? { takenFrom } : {}),
    ...(takenTo ? { takenTo } : {}),
    ...(camera ? { camera } : {}),
    ...(kind ? { kind } : {}),
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
  const selectedAlbums = albumIds.map((id) => albums.data?.find((a) => a.id === id)).filter((a) => a !== undefined);
  const f = facets.data;
  const hasDates = (f?.taken.withDate ?? 0) > 0;
  const hasCameras = (f?.cameras.length ?? 0) > 0;
  const hasKinds = (f?.kinds.length ?? 0) > 1;

  return (
    <>
      <header className="page-title">
        <h1 className="display-title">{q ? 'Search results' : 'Search'}</h1>
        <p className="muted">Find the moments that matter.</p>
      </header>

      <div className="search-panel">
        <div className="search-scope">
          <span className="field-label">Search in</span>
          <div className="chip-row">
            {selectedAlbums.length === 0 && <span className="chip chip-plain">All albums</span>}
            {selectedAlbums.map((a) => (
              <span key={a.id} className="chip">
                {a.coverPhotoId && <img src={thumbnailUrl(a.coverPhotoId)} alt="" />}
                {a.name}
                <button type="button" aria-label={`Stop searching in ${a.name}`} onClick={() => toggleAlbum(a.id)}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
            <details className="menu">
              <summary className="btn btn-ghost btn-small">
                <Icon name="plus" size={16} /> {selectedAlbums.length ? 'Add albums' : 'Choose albums'} <Icon name="chevronDown" size={16} />
              </summary>
              <div className="menu-list scope-list">
                <label>
                  <input type="checkbox" checked={albumIds.length === 0} onChange={() => update('albums', null)} />
                  All albums
                </label>
                {albums.data?.map((a) => (
                  <label key={a.id}>
                    <input type="checkbox" checked={albumIds.includes(a.id)} onChange={() => toggleAlbum(a.id)} />
                    <span className="scope-thumb">{a.coverPhotoId && <img src={thumbnailUrl(a.coverPhotoId)} alt="" />}</span>
                    {a.name}
                  </label>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className="search-mode">
          <span className="field-label" id="mode-label">
            Search mode
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="mode-label">
            {MODES.map((m) => (
              <label key={m.value} title={m.hint} className={mode === m.value ? 'is-active' : ''}>
                <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => update('mode', m.value)} />
                {m.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {(hasDates || hasCameras || hasKinds) && (
        <div className="filters" aria-label="Filters">
          {hasKinds && (
            <label>
              Type
              <select value={kind} onChange={(e) => update('kind', e.target.value)}>
                <option value="">Any</option>
                {f?.kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {KIND_NAMES[k.kind] ?? k.kind} ({k.count.toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
          )}
          {hasDates && (
            <>
              <label>
                Taken from
                <input type="date" value={takenFrom} min={f?.taken.earliest ?? undefined} max={f?.taken.latest ?? undefined} onChange={(e) => update('from', e.target.value)} />
              </label>
              <label>
                to
                <input type="date" value={takenTo} min={f?.taken.earliest ?? undefined} max={f?.taken.latest ?? undefined} onChange={(e) => update('to', e.target.value)} />
              </label>
            </>
          )}
          {hasCameras && (
            <label>
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
      )}

      {!q && <EmptyState title="Type something to search for" icon="search" />}
      {results.isPending && q && <Loading label="Searching…" />}
      {results.isError && <ErrorState error={results.error} onRetry={() => void results.refetch()} />}

      {first && (
        <div className="results-head" aria-live="polite">
          <div>
            <h2>
              {first.total.toLocaleString()} photo{first.total === 1 ? '' : 's'} found
            </h2>
            <p className="muted">
              {selectedAlbums.length ? `from ${names(selectedAlbums.map((a) => a.name))}` : 'from all albums'} · {Math.round(first.timingsMs.total)} ms
            </p>
          </div>
          {first.meaning === 'ok' && first.total > 0 && <p className="muted small results-note">Best matches first; photos further down match less well.</p>}
        </div>
      )}
      {first?.fallbackToWords && (
        <Callout tone="warn" title="Meaning search is unavailable right now">
          <p>
            {first.meaningReason}. Showing <strong>Words</strong> results instead.
          </p>
        </Callout>
      )}
      {first && first.corrections.length > 0 && (
        <Callout>
          <p>
            No exact match for {first.corrections.map((c) => `“${c.from}”`).join(', ')}; showing results for {first.corrections.map((c) => `“${c.to}”`).join(', ')}.
          </p>
        </Callout>
      )}
      {first && first.excludedForMissingMetadata > 0 && (
        <p className="muted small">
          {first.excludedForMissingMetadata.toLocaleString()} photo{first.excludedForMissingMetadata === 1 ? '' : 's'} in scope have no date or camera information and are
          not included by the filter.
        </p>
      )}

      {first && first.total === 0 && (
        <EmptyState title="No matching photos" icon="search">
          <p>{mode === 'words' ? 'Try other words, or search by Meaning to find photos by what they show.' : 'Try different words or search in more albums.'}</p>
        </EmptyState>
      )}

      <ul className="result-grid">
        {items.map((p) => (
          <li key={p.id} className="result-card">
            <Link to={`/photos/${p.id}?from=search`} className="result-thumb">
              <img src={thumbnailUrl(p.id)} alt={p.filename} loading="lazy" />
              <span className="result-albums">
                {p.albums.slice(0, 3).map((a) => (
                  <span key={a.id} className="result-album">
                    {a.name}
                  </span>
                ))}
                {p.albums.length > 3 && <span className="result-album">+{p.albums.length - 3}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {results.hasNextPage && (
        <button type="button" className="btn load-more" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
          {results.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
      {first && first.total > 0 && !results.hasNextPage && (
        <footer className="results-footer">
          <p>Didn’t find what you’re looking for?</p>
          <p className="muted">Try different words, switch the search mode, or search in more albums.</p>
        </footer>
      )}
    </>
  );
}
