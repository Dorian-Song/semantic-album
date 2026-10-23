import { useQuery } from '@tanstack/react-query';
import { listAlbums } from '../api/albums';
import { useShellDialogs } from '../app/shell-context';
import { AlbumGrid } from '../components/albums/AlbumCard';
import { EmptyState, ErrorState, Loading } from '../components/common/states';

export function AlbumsPage() {
  const open = useShellDialogs();
  const albums = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  return (
    <>
      <header className="page-title">
        <h1 className="display-title">Albums</h1>
        <p className="muted">{albums.data ? `${albums.data.length} album${albums.data.length === 1 ? '' : 's'}` : 'Your collections.'}</p>
      </header>
      {albums.isPending && <Loading />}
      {albums.isError && <ErrorState error={albums.error} onRetry={() => void albums.refetch()} />}
      {albums.data?.length === 0 && (
        <EmptyState title="No albums yet">
          <button type="button" className="btn btn-primary" onClick={() => open('new-album')}>
            New Album
          </button>
        </EmptyState>
      )}
      {albums.data && albums.data.length > 0 && <AlbumGrid albums={albums.data} />}
    </>
  );
}
