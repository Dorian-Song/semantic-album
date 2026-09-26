import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { getAlbum, listAlbumPhotos } from '../api/albums';
import { EmptyState, ErrorState, Loading } from '../components/common/states';
import { DeleteAlbumDialog, RenameAlbumDialog } from '../components/dialogs/AlbumDialogs';
import { ExportDialog } from '../components/dialogs/ExportDialog';
import { ImportPhotosDialog } from '../components/dialogs/ImportDialogs';
import { AddToAlbumDialog, DeletePhotoDialog, MovePhotoDialog, RemoveFromAlbumDialog } from '../components/dialogs/PhotoDialogs';
import { PhotoGrid } from '../components/photos/PhotoGrid';
import { SelectionBar } from '../components/photos/SelectionBar';
import { usePhotoPages } from '../hooks/usePhotoPages';
import { useSelection } from '../hooks/useSelection';

type AlbumDialog = 'import' | 'rename' | 'delete' | 'add' | 'move' | 'remove' | 'delete-photos' | 'export' | 'export-selection' | null;

export function AlbumPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const album = useQuery({ queryKey: ['album', id], queryFn: () => getAlbum(id) });
  const pages = usePhotoPages(['albumPhotos', id], (offset, limit) => listAlbumPhotos(id, offset, limit));
  const { selected, toggle, clear, setAll } = useSelection();
  const [dialog, setDialog] = useState<AlbumDialog>(null);
  const close = () => setDialog(null);

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

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/albums" className="back-link">
            ← Albums
          </Link>
          <h1>{a.name}</h1>
          <p className="muted">
            {a.photoCount} photo{a.photoCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={() => setDialog('import')}>
            Import photos
          </button>
          <button type="button" className="btn" onClick={() => setDialog('rename')}>
            Rename
          </button>
          <button type="button" className="btn" disabled={a.photoCount === 0} onClick={() => setDialog('export')}>
            Export
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>
            Delete album
          </button>
        </div>
      </div>

      <SelectionBar count={selected.size} onClear={clear} onSelectAll={() => setAll(pages.photos.map((p) => p.id))}>
        <button type="button" className="btn btn-small" onClick={() => setDialog('add')}>
          Add to album
        </button>
        <button type="button" className="btn btn-small" onClick={() => setDialog('move')}>
          Move to album
        </button>
        <button type="button" className="btn btn-small" onClick={() => setDialog('remove')}>
          Remove from this album
        </button>
        <button type="button" className="btn btn-small" onClick={() => setDialog('export-selection')}>
          Export
        </button>
        <button type="button" className="btn btn-small btn-danger" onClick={() => setDialog('delete-photos')}>
          Delete from library
        </button>
      </SelectionBar>

      {pages.isPending && <Loading />}
      {pages.isError && <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />}
      {pages.data && pages.total === 0 && (
        <EmptyState title="This album is empty">
          <p>Import photos or a folder into this album. Photos already here are skipped.</p>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('import')}>
            Import photos
          </button>
        </EmptyState>
      )}
      <PhotoGrid photos={pages.photos} hrefFor={(pid) => `/photos/${pid}?album=${a.id}`} selected={selected} onToggle={toggle} />
      {pages.hasNextPage && (
        <button type="button" className="btn load-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
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
