import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { getAlbum, getAlbumProcessing, listAlbumPhotos } from '../api/albums';
import { thumbnailUrl } from '../api/photos';
import { Icon } from '../components/common/Icon';
import { EmptyState, ErrorState, Loading } from '../components/common/states';
import { DeleteAlbumDialog, RenameAlbumDialog } from '../components/dialogs/AlbumDialogs';
import { ExportDialog } from '../components/dialogs/ExportDialog';
import { ImportPhotosDialog } from '../components/dialogs/ImportDialogs';
import { AddToAlbumDialog, DeletePhotoDialog, MovePhotoDialog, RemoveFromAlbumDialog } from '../components/dialogs/PhotoDialogs';
import { PhotoGrid } from '../components/photos/PhotoGrid';
import { usePhotoPages } from '../hooks/usePhotoPages';
import { useSelection } from '../hooks/useSelection';

type AlbumDialog = 'import' | 'rename' | 'delete' | 'add' | 'move' | 'remove' | 'delete-photos' | 'export' | 'export-selection' | null;

function Stage({ label, done, total }: { label: string; done: number; total: number }) {
  const finished = done >= total;
  return (
    <div className="stage">
      {finished ? <Icon name="checkCircle" size={22} className="stage-done" /> : <span className="spinner" aria-hidden="true" />}
      <div>
        <p className="stage-label">{label}</p>
        <p className="muted small">
          {done.toLocaleString()} of {total.toLocaleString()} complete
        </p>
      </div>
    </div>
  );
}

export function AlbumPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const menu = useRef<HTMLDetailsElement>(null);
  const album = useQuery({ queryKey: ['album', id], queryFn: () => getAlbum(id) });
  const pages = usePhotoPages(['albumPhotos', id], (offset, limit) => listAlbumPhotos(id, offset, limit));
  const processing = useQuery({
    queryKey: ['albumProcessing', id],
    queryFn: () => getAlbumProcessing(id),
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.caption.done < d.caption.total || d.embedding.done < d.embedding.total) ? 3000 : 30_000;
    },
  });
  const { selected, toggle, clear, setAll } = useSelection();
  const [dialog, setDialog] = useState<AlbumDialog>(null);
  const close = () => setDialog(null);
  const openFromMenu = (d: AlbumDialog) => {
    menu.current?.removeAttribute('open');
    setDialog(d);
  };

  if (album.isPending) return <Loading />;
  if (album.isError) {
    return (
      <>
        <ErrorState error={album.error} />
        <Link to="/albums">Back to albums</Link>
      </>
    );
  }
  const a = album.data;
  const ids = [...selected];
  const ref = { id: a.id, name: a.name };
  const none = selected.size === 0;
  const p = processing.data;
  const busy = p && (p.caption.done < p.caption.total || p.embedding.done < p.embedding.total);

  return (
    <>
      <div className="page-bar">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to="/albums" aria-label="Back to albums" className="icon-btn">
            <Icon name="chevronLeft" />
          </Link>
          <Link to="/albums">Albums</Link>
          <Icon name="chevronRight" size={16} />
          <span aria-current="page">{a.name}</span>
        </nav>
        <div className="button-row">
          <button type="button" className="btn btn-soft" onClick={() => setDialog('import')}>
            <Icon name="upload" /> Import to {a.name}
          </button>
          <details className="menu" ref={menu}>
            <summary className="btn icon-only" aria-label="Album actions">
              <Icon name="more" />
            </summary>
            <div className="menu-list" role="menu">
              <button type="button" role="menuitem" onClick={() => openFromMenu('rename')}>
                <Icon name="pencil" size={16} /> Rename album
              </button>
              <button type="button" role="menuitem" disabled={a.photoCount === 0} onClick={() => openFromMenu('export')}>
                <Icon name="export" size={16} /> Export album
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => openFromMenu('delete')}>
                <Icon name="trash" size={16} /> Delete album
              </button>
            </div>
          </details>
        </div>
      </div>

      <header className="album-header">
        <div className="album-header-cover">
          {a.coverPhotoId ? <img src={thumbnailUrl(a.coverPhotoId)} alt="" /> : <Icon name="image" size={36} />}
        </div>
        <div className="album-header-body">
          <h1 className="display-title">{a.name}</h1>
          <p className="album-count">
            {a.photoCount.toLocaleString()} photo{a.photoCount === 1 ? '' : 's'}
          </p>
          {p && p.caption.total + p.embedding.total > 0 && (
            <div className="stages" aria-live="polite">
              <p className="stage-title">{busy ? 'Processing new photos' : 'All photos processed'}</p>
              <Stage label="Descriptions" {...p.caption} />
              <Stage label="Search index" {...p.embedding} />
            </div>
          )}
        </div>
      </header>

      <div className="toolbar" role="toolbar" aria-label="Selected photos">
        <span className="toolbar-count">
          {selected.size} photo{selected.size === 1 ? '' : 's'} selected
        </span>
        <button type="button" className="btn btn-ghost" disabled={none} onClick={() => setDialog('move')}>
          <Icon name="move" /> Move to Album
        </button>
        <button type="button" className="btn btn-ghost" disabled={none} onClick={() => setDialog('add')}>
          <Icon name="addTo" /> Add to Album
        </button>
        <button type="button" className="btn btn-ghost" disabled={none} onClick={() => setDialog('remove')}>
          <Icon name="minus" /> Remove from {a.name}
        </button>
        <button type="button" className="btn btn-ghost" disabled={none} onClick={() => setDialog('export-selection')}>
          <Icon name="export" /> Export
        </button>
        <button type="button" className="btn btn-ghost danger-text" disabled={none} onClick={() => setDialog('delete-photos')}>
          <Icon name="trash" /> Delete
        </button>
        <span className="spacer" />
        {none ? (
          <button type="button" className="link-btn" disabled={pages.photos.length === 0} onClick={() => setAll(pages.photos.map((x) => x.id))}>
            Select all
          </button>
        ) : (
          <button type="button" className="link-btn" onClick={clear}>
            Clear selection
          </button>
        )}
      </div>

      {pages.isPending && <Loading />}
      {pages.isError && <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />}
      {pages.data && pages.total === 0 && (
        <EmptyState title="This album is empty" icon="upload">
          <p>Import photos or a folder into this album. Photos already here are skipped.</p>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('import')}>
            <Icon name="upload" /> Import photos
          </button>
        </EmptyState>
      )}
      <PhotoGrid photos={pages.photos} hrefFor={(pid) => `/photos/${pid}?album=${a.id}`} selected={selected} onToggle={toggle} />
      {pages.hasNextPage && (
        <button type="button" className="btn load-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          {pages.isFetchingNextPage ? 'Loading…' : `Show more (${(pages.total - pages.photos.length).toLocaleString()} left)`}
        </button>
      )}

      {dialog === 'import' && <ImportPhotosDialog album={ref} onClose={close} />}
      {dialog === 'rename' && <RenameAlbumDialog album={a} onClose={close} />}
      {dialog === 'delete' && <DeleteAlbumDialog album={a} onClose={close} onDeleted={() => void navigate('/albums')} />}
      {dialog === 'add' && <AddToAlbumDialog photoIds={ids} alreadyIn={[ref]} onClose={close} />}
      {dialog === 'move' && <MovePhotoDialog photoIds={ids} from={ref} onClose={close} onMoved={clear} />}
      {dialog === 'remove' && <RemoveFromAlbumDialog photoIds={ids} album={ref} onClose={close} onDone={clear} />}
      {dialog === 'delete-photos' && <DeletePhotoDialog photoIds={ids} onClose={close} onDone={clear} />}
      {dialog === 'export' && <ExportDialog scope={{ albumIds: [a.id] }} label={`“${a.name}”`} onClose={close} />}
      {dialog === 'export-selection' && <ExportDialog scope={{ assetIds: ids }} label={`${ids.length} photo${ids.length === 1 ? '' : 's'}`} onClose={close} />}
    </>
  );
}
