import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { listAlbums } from '../api/albums';
import { listPhotos } from '../api/photos';
import { useShellDialogs } from '../app/shell-context';
import { AlbumGrid } from '../components/albums/AlbumCard';
import { EmptyState, ErrorState, Loading } from '../components/common/states';
import { PhotoGrid } from '../components/photos/PhotoGrid';

const BANNER_KEY = 'album.bannerDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_KEY) === '1';
  } catch {
    return false;
  }
}

export function HomePage() {
  const open = useShellDialogs();
  const [bannerHidden, setBannerHidden] = useState(readDismissed);
  const albums = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  const recent = useQuery({ queryKey: ['photos', 'recent'], queryFn: () => listPhotos(0, 12, 'recent') });

  const hideBanner = () => {
    setBannerHidden(true);
    try {
      localStorage.setItem(BANNER_KEY, '1');
    } catch {
      // private mode: hidden for this visit only
    }
  };

  return (
    <>
      {!bannerHidden && (
        <section className="banner">
          <div>
            <h1>Welcome to Album</h1>
            <p>A simple home for your most meaningful moments.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Hide welcome banner" onClick={hideBanner}>
            ×
          </button>
        </section>
      )}
      {bannerHidden && <h1 className="visually-hidden">Home</h1>}

      <section className="section">
        <div className="section-head">
          <h2>My Albums</h2>
          {albums.data && albums.data.length > 6 && <Link to="/albums">View all →</Link>}
        </div>
        {albums.isPending && <Loading />}
        {albums.isError && <ErrorState error={albums.error} onRetry={() => void albums.refetch()} />}
        {albums.data?.length === 0 && (
          <EmptyState title="No albums yet">
            <p>Import a folder to create your first album, or start with an empty one.</p>
            <div className="button-row">
              <button type="button" className="btn btn-primary" onClick={() => open('import-folder')}>
                Import Folder
              </button>
              <button type="button" className="btn" onClick={() => open('new-album')}>
                New Album
              </button>
            </div>
          </EmptyState>
        )}
        {albums.data && albums.data.length > 0 && <AlbumGrid albums={albums.data.slice(0, 6)} />}
      </section>

      {recent.data && recent.data.total > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Recent Photos</h2>
            <Link to="/photos">View all →</Link>
          </div>
          <PhotoGrid photos={recent.data.items} hrefFor={(id) => `/photos/${id}`} />
        </section>
      )}
    </>
  );
}
