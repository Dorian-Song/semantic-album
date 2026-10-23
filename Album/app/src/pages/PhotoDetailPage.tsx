import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { listAlbums } from '../api/albums';
import { displayUrl, getPhoto, getPhotoContext, originalUrl, thumbnailUrl } from '../api/photos';
import type { AlbumRef, PhotoDetail } from '../api/types';
import { Icon } from '../components/common/Icon';
import { ErrorState, Loading } from '../components/common/states';
import { AddToAlbumDialog, DeletePhotoDialog, EditDescriptionDialog, MovePhotoDialog, RemoveFromAlbumDialog } from '../components/dialogs/PhotoDialogs';
import { DescriptionBlock } from '../components/photos/DescriptionBlock';
import { Lightbox } from '../components/photos/Lightbox';
import { formatBytes, formatTakenAt } from '../format';
import { getSearchContext } from '../hooks/searchContext';

type DetailDialog = { kind: 'edit' } | { kind: 'add' } | { kind: 'delete' } | { kind: 'move'; from: AlbumRef } | { kind: 'remove'; album: AlbumRef } | null;

/** Formats the browser shows natively; zooming them uses the original file for full detail. */
const NATIVE = new Set(['jpeg', 'png', 'gif', 'webp']);

function FileInfo({ photo }: { photo: PhotoDetail }) {
  // Absent metadata is omitted, never shown as an empty row.
  const rows: [string, string][] = [['Filename', photo.filename], ['Format', photo.format.toUpperCase()]];
  if (photo.width && photo.height) rows.push(['Dimensions', `${photo.width} × ${photo.height}`]);
  rows.push(['File size', formatBytes(photo.byteSize)]);
  if (photo.takenAt) rows.push(['Date taken', formatTakenAt(photo.takenAt)]);
  if (photo.camera) rows.push(['Camera', [photo.camera.make, photo.camera.model].filter(Boolean).join(' ')]);
  if (photo.location) rows.push(['Location', `${photo.location.lat.toFixed(5)}, ${photo.location.lon.toFixed(5)}`]);
  return (
    <dl className="info-list">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function megapixels(p: PhotoDetail): string | null {
  return p.width && p.height ? `${((p.width * p.height) / 1e6).toFixed(1)} MP` : null;
}

export function PhotoDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const albumCtx = params.get('album');
  const search = params.get('from') === 'search' ? getSearchContext() : null;
  const searchIndex = search ? search.items.findIndex((i) => i.id === id) : -1;
  const fromSearch = search !== null && searchIndex >= 0;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DetailDialog>(null);
  const [zoomed, setZoomed] = useState(params.get('zoom') === '1');
  const photo = useQuery({ queryKey: ['photo', id, albumCtx], queryFn: () => getPhoto(id, albumCtx) });
  const albums = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  const serverContext = useQuery({
    queryKey: ['photoContext', id, albumCtx],
    queryFn: () => getPhotoContext(id, albumCtx),
    retry: false,
    enabled: !fromSearch,
  });
  // From search results, step through the results in the order they were shown.
  const context = fromSearch
    ? {
        data: {
          index: searchIndex,
          total: search.items.length,
          prevId: search.items[searchIndex - 1]?.id ?? null,
          nextId: search.items[searchIndex + 1]?.id ?? null,
          window: search.items.slice(Math.max(0, searchIndex - 12), searchIndex + 13),
        },
      }
    : serverContext;
  const strip = useRef<HTMLOListElement>(null);

  const hrefFor = (pid: string, zoom = false) => {
    const q = new URLSearchParams();
    if (fromSearch) q.set('from', 'search');
    else if (albumCtx) q.set('album', albumCtx);
    if (zoom) q.set('zoom', '1');
    const s = q.toString();
    return `/photos/${pid}${s ? `?${s}` : ''}`;
  };
  const backHref = fromSearch ? search.href : albumCtx ? `/albums/${albumCtx}` : '/photos';
  const ctxAlbum = photo.data?.albums.find((a) => a.id === albumCtx);
  const albumInfo = new Map((albums.data ?? []).map((a) => [a.id, a]));
  const prevId = context.data?.prevId ?? null;
  const nextId = context.data?.nextId ?? null;
  const go = (pid: string | null) => pid && void navigate(hrefFor(pid, zoomed), { replace: zoomed });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (zoomed || document.querySelector('dialog[open]')) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft') go(prevId);
      else if (e.key === 'ArrowRight') go(nextId);
      else if (e.key === 'z' || (e.key === 'Enter' && t === document.body)) setZoomed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [id, context.data]);

  /** After this photo leaves the current list, show its neighbour or go back. */
  const leave = () => void navigate(nextId ? hrefFor(nextId) : prevId ? hrefFor(prevId) : backHref, { replace: true });

  if (photo.isPending) return <Loading />;
  if (photo.isError) {
    return (
      <>
        <ErrorState error={photo.error} />
        <Link to={backHref}>Back</Link>
      </>
    );
  }
  const p = photo.data;
  const close = () => setDialog(null);
  const counter = context.data ? `${(context.data.index + 1).toLocaleString()} of ${context.data.total.toLocaleString()}` : undefined;
  const backLabel = fromSearch ? 'search results' : albumCtx ? (ctxAlbum?.name ?? 'album') : 'All Photos';
  const moveFrom = ctxAlbum ?? (p.albums.length === 1 ? p.albums[0] : undefined);
  const mp = megapixels(p);

  return (
    <div className="detail">
      <div className="detail-main">
        <div className="detail-top">
          <div>
            <Link to={backHref} className="back-link">
              <Icon name="arrowLeft" size={18} /> Back to {backLabel}
            </Link>
            {ctxAlbum && albumInfo.get(ctxAlbum.id) && (
              <p className="muted small">
                {ctxAlbum.name} · {albumInfo.get(ctxAlbum.id)!.photoCount.toLocaleString()} photos
              </p>
            )}
          </div>
          <div className="button-row">
            <button type="button" className="btn icon-only" aria-label="View full size (Z)" title="View full size (Z)" onClick={() => setZoomed(true)}>
              <Icon name="expand" />
            </button>
            <a className="btn icon-only" href={originalUrl(p.id)} download={p.filename} aria-label="Download original" title="Download original">
              <Icon name="download" />
            </a>
          </div>
        </div>

        <div className="viewer">
          <button type="button" className="viewer-image" onClick={() => setZoomed(true)} aria-label="Open full size">
            <img src={displayUrl(p.id)} alt={p.description?.effective ?? p.filename} />
          </button>
          {prevId && (
            <Link to={hrefFor(prevId)} className="viewer-nav viewer-prev" aria-label="Previous photo">
              <Icon name="chevronLeft" size={24} />
            </Link>
          )}
          {nextId && (
            <Link to={hrefFor(nextId)} className="viewer-nav viewer-next" aria-label="Next photo">
              <Icon name="chevronRight" size={24} />
            </Link>
          )}
          {counter && <span className="viewer-count">{counter}</span>}
        </div>

        {context.data && context.data.window.length > 1 && (
          <div className="filmstrip-wrap">
            <button type="button" className="strip-scroll" aria-label="Scroll thumbnails left" onClick={() => strip.current?.scrollBy({ left: -400, behavior: 'smooth' })}>
              <Icon name="chevronLeft" />
            </button>
            <ol className="filmstrip" ref={strip} aria-label="Nearby photos">
              {context.data.window.map((w) => (
                <li key={w.id}>
                  <Link to={hrefFor(w.id)} aria-current={w.id === p.id ? 'true' : undefined} replace>
                    <img src={thumbnailUrl(w.id)} alt={w.filename} loading="lazy" />
                  </Link>
                </li>
              ))}
            </ol>
            <button type="button" className="strip-scroll" aria-label="Scroll thumbnails right" onClick={() => strip.current?.scrollBy({ left: 400, behavior: 'smooth' })}>
              <Icon name="chevronRight" />
            </button>
          </div>
        )}
      </div>

      <aside className="detail-side" aria-label="Photo details">
        <header className="detail-head">
          <h1 className="detail-title">{p.filename}</h1>
          {p.takenAt && <p className="muted">{formatTakenAt(p.takenAt)}</p>}
          {p.width && p.height && (
            <p className="muted small">
              {p.width} × {p.height}
              {mp && ` · ${mp}`}
            </p>
          )}
        </header>

        <section className="side-section">
          <h2>Description</h2>
          <DescriptionBlock photo={p} onEdit={() => setDialog({ kind: 'edit' })} />
        </section>

        <section className="side-section">
          <h2>Albums</h2>
          <ul className="membership-list">
            {p.albums.map((a) => {
              const info = albumInfo.get(a.id);
              return (
                <li key={a.id}>
                  <Link to={`/albums/${a.id}`} className="membership">
                    <span className="membership-thumb">{info?.coverPhotoId ? <img src={thumbnailUrl(info.coverPhotoId)} alt="" /> : <Icon name="image" />}</span>
                    <span>
                      <span className="membership-name">{a.name}</span>
                      {info && <span className="muted small">{info.photoCount.toLocaleString()} photos</span>}
                    </span>
                  </Link>
                  <button type="button" className="icon-btn" aria-label={`Remove from ${a.name}`} title={`Remove from ${a.name}`} onClick={() => setDialog({ kind: 'remove', album: a })}>
                    <Icon name="x" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="button-row">
            <button type="button" className="btn btn-soft btn-small" onClick={() => setDialog({ kind: 'add' })}>
              <Icon name="plus" size={16} /> Add to album
            </button>
            {moveFrom ? (
              <button type="button" className="btn btn-soft btn-small" onClick={() => setDialog({ kind: 'move', from: moveFrom })}>
                <Icon name="arrowRight" size={16} /> Move to album
              </button>
            ) : (
              <details className="menu">
                <summary className="btn btn-soft btn-small">
                  <Icon name="arrowRight" size={16} /> Move to album
                </summary>
                <div className="menu-list" role="menu">
                  {p.albums.map((a) => (
                    <button key={a.id} type="button" role="menuitem" onClick={() => setDialog({ kind: 'move', from: a })}>
                      Move out of {a.name}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>
        </section>

        <section className="side-section">
          <h2>File information</h2>
          <FileInfo photo={p} />
        </section>

        <section className="side-section">
          <h2>Actions</h2>
          <div className="action-list">
            {ctxAlbum && (
              <button type="button" className="action" onClick={() => setDialog({ kind: 'remove', album: ctxAlbum })}>
                <Icon name="image" size={20} />
                <span>
                  <strong>Remove from {ctxAlbum.name}</strong>
                  <span className="muted small">This photo will stay in your library.</span>
                </span>
              </button>
            )}
            <button type="button" className="action action-danger" onClick={() => setDialog({ kind: 'delete' })}>
              <Icon name="trash" size={20} />
              <span>
                <strong>Delete from Library</strong>
                <span className="muted small">Removes this photo from every album.</span>
              </span>
            </button>
          </div>
        </section>
      </aside>

      {zoomed && (
        <Lightbox
          src={NATIVE.has(p.format) ? originalUrl(p.id) : displayUrl(p.id)}
          alt={p.description?.effective ?? p.filename}
          title={p.filename}
          counter={counter}
          onClose={() => setZoomed(false)}
          onPrev={prevId ? () => go(prevId) : undefined}
          onNext={nextId ? () => go(nextId) : undefined}
        />
      )}
      {dialog?.kind === 'edit' && <EditDescriptionDialog photo={p} onClose={close} />}
      {dialog?.kind === 'add' && <AddToAlbumDialog photoIds={[p.id]} alreadyIn={p.albums} onClose={close} />}
      {dialog?.kind === 'move' && <MovePhotoDialog photoIds={[p.id]} from={dialog.from} onClose={close} onMoved={() => dialog.from.id === albumCtx && leave()} />}
      {dialog?.kind === 'remove' && (
        <RemoveFromAlbumDialog photoIds={[p.id]} album={dialog.album} onClose={close} onDone={() => (dialog.album.id === albumCtx || p.albums.length === 1) && leave()} />
      )}
      {dialog?.kind === 'delete' && <DeletePhotoDialog photoIds={[p.id]} onClose={close} onDone={leave} />}
    </div>
  );
}
