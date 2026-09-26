import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { displayUrl, getPhoto, getPhotoContext, originalUrl, thumbnailUrl } from '../api/photos';
import type { AlbumRef, PhotoDetail } from '../api/types';
import { ErrorState, Loading } from '../components/common/states';
import { AddToAlbumDialog, DeletePhotoDialog, EditDescriptionDialog, MovePhotoDialog, RemoveFromAlbumDialog } from '../components/dialogs/PhotoDialogs';
import { formatBytes, formatTakenAt } from '../format';

type DetailDialog = { kind: 'edit' } | { kind: 'add' } | { kind: 'delete' } | { kind: 'move'; from: AlbumRef } | { kind: 'remove'; album: AlbumRef } | null;

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

export function PhotoDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const albumCtx = params.get('album');
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DetailDialog>(null);
  const photo = useQuery({ queryKey: ['photo', id, albumCtx], queryFn: () => getPhoto(id, albumCtx) });
  const context = useQuery({ queryKey: ['photoContext', id, albumCtx], queryFn: () => getPhotoContext(id, albumCtx), retry: false });
  const strip = useRef<HTMLOListElement>(null);

  const hrefFor = (pid: string) => `/photos/${pid}${albumCtx ? `?album=${albumCtx}` : ''}`;
  const backHref = albumCtx ? `/albums/${albumCtx}` : '/photos';
  const ctxAlbum = photo.data?.albums.find((a) => a.id === albumCtx);
  const prevId = context.data?.prevId ?? null;
  const nextId = context.data?.nextId ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft' && prevId) void navigate(hrefFor(prevId));
      if (e.key === 'ArrowRight' && nextId) void navigate(hrefFor(nextId));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
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

  return (
    <div className="detail">
      <div className="detail-main">
        <div className="detail-top">
          <Link to={backHref} className="back-link">
            ← Back to {albumCtx ? (ctxAlbum?.name ?? 'album') : 'All Photos'}
          </Link>
          <a className="btn btn-small" href={originalUrl(p.id)} download={p.filename}>
            Download original
          </a>
        </div>
        <div className="viewer">
          <img src={displayUrl(p.id)} alt={p.description?.effective ?? p.filename} />
          {prevId && (
            <Link to={hrefFor(prevId)} className="viewer-nav viewer-prev" aria-label="Previous photo">
              ‹
            </Link>
          )}
          {nextId && (
            <Link to={hrefFor(nextId)} className="viewer-nav viewer-next" aria-label="Next photo">
              ›
            </Link>
          )}
          {context.data && (
            <span className="viewer-count">
              {context.data.index + 1} of {context.data.total}
            </span>
          )}
        </div>
        {context.data && context.data.window.length > 1 && (
          <ol className="filmstrip" ref={strip} aria-label="Nearby photos">
            {context.data.window.map((w) => (
              <li key={w.id}>
                <Link to={hrefFor(w.id)} aria-current={w.id === p.id ? 'true' : undefined} replace>
                  <img src={thumbnailUrl(w.id)} alt={w.filename} loading="lazy" />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>

      <aside className="detail-side" aria-label="Photo details">
        <h1 className="detail-title">{p.filename}</h1>
        {p.takenAt && <p className="muted">{formatTakenAt(p.takenAt)}</p>}

        <section className="side-section">
          <h2>Description</h2>
          {p.description?.effective ? <p className="description">{p.description.effective}</p> : <p className="muted">No description yet.</p>}
          {p.description && p.description.tags.length > 0 && (
            <ul className="tags">
              {p.description.tags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'edit' })}>
            {p.description?.effective ? 'Edit description' : 'Add description'}
          </button>
        </section>

        <section className="side-section">
          <h2>Albums</h2>
          <ul className="membership-list">
            {p.albums.map((a) => (
              <li key={a.id}>
                <Link to={`/albums/${a.id}`}>{a.name}</Link>
                <span className="spacer" />
                <button type="button" className="link-btn" onClick={() => setDialog({ kind: 'move', from: a })}>
                  Move
                </button>
                <button type="button" className="link-btn" aria-label={`Remove from ${a.name}`} onClick={() => setDialog({ kind: 'remove', album: a })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'add' })}>
            Add to album
          </button>
        </section>

        <section className="side-section">
          <h2>File information</h2>
          <FileInfo photo={p} />
        </section>

        <section className="side-section">
          <button type="button" className="btn btn-danger" onClick={() => setDialog({ kind: 'delete' })}>
            Delete from library
          </button>
          <p className="muted small">Removes the photo from every album.</p>
        </section>
      </aside>

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
