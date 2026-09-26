import { useState } from 'react';
import { listPhotos } from '../api/photos';
import { useShellDialogs } from '../app/shell-context';
import { EmptyState, ErrorState, Loading } from '../components/common/states';
import { ExportDialog } from '../components/dialogs/ExportDialog';
import { AddToAlbumDialog, DeletePhotoDialog } from '../components/dialogs/PhotoDialogs';
import { PhotoGrid } from '../components/photos/PhotoGrid';
import { SelectionBar } from '../components/photos/SelectionBar';
import { usePhotoPages } from '../hooks/usePhotoPages';
import { useSelection } from '../hooks/useSelection';

export function AllPhotosPage() {
  const open = useShellDialogs();
  const pages = usePhotoPages(['photos', 'all'], (offset, limit) => listPhotos(offset, limit));
  const { selected, toggle, clear, setAll } = useSelection();
  const [dialog, setDialog] = useState<'add' | 'delete' | 'export' | null>(null);
  const ids = [...selected];

  return (
    <>
      <header className="page-title">
        <h1 className="display-title">All Photos</h1>
        <p className="muted">{pages.total > 0 ? `${pages.total.toLocaleString()} photos, newest first` : 'Everything in your library.'}</p>
      </header>
      <SelectionBar count={selected.size} onClear={clear} onSelectAll={() => setAll(pages.photos.map((p) => p.id))}>
        <button type="button" className="btn btn-small" onClick={() => setDialog('add')}>
          Add to album
        </button>
        <button type="button" className="btn btn-small" onClick={() => setDialog('export')}>
          Export
        </button>
        <button type="button" className="btn btn-small btn-danger" onClick={() => setDialog('delete')}>
          Delete from library
        </button>
      </SelectionBar>
      {pages.isPending && <Loading />}
      {pages.isError && <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />}
      {pages.data && pages.total === 0 && (
        <EmptyState title="Your library is empty">
          <button type="button" className="btn btn-primary" onClick={() => open('import-photos')}>
            Import Photos
          </button>
        </EmptyState>
      )}
      <PhotoGrid photos={pages.photos} hrefFor={(id) => `/photos/${id}`} selected={selected} onToggle={toggle} />
      {pages.hasNextPage && (
        <button type="button" className="btn load-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
      {dialog === 'add' && <AddToAlbumDialog photoIds={ids} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeletePhotoDialog photoIds={ids} onClose={() => setDialog(null)} onDone={clear} />}
      {dialog === 'export' && <ExportDialog scope={{ assetIds: ids }} label={`${ids.length} photo${ids.length === 1 ? '' : 's'}`} onClose={() => setDialog(null)} />}
    </>
  );
}
