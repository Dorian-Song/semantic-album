import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { listAlbums } from '../api/albums';
import { listPhotos, thumbnailUrl } from '../api/photos';
import { useShellDialogs } from '../app/shell-context';
import { AlbumGrid } from '../components/albums/AlbumCard';
import { Icon } from '../components/common/Icon';
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

function Banner({ photoIds, onHide }: { photoIds: string[]; onHide: () => void }) {
  return (
    <section className="banner" aria-labelledby="welcome-title">
      <div className="banner-text">
        <h1 id="welcome-title">Welcome to Album</h1>
        <p>A simple home for your most meaningful moments.</p>
      </div>
      {photoIds.length > 0 && (
        <div className="banner-collage" aria-hidden="true">
          {photoIds.slice(0, 3).map((id, i) => (
            <img key={id} src={thumbnailUrl(id)} alt="" className={`collage-${i}`} />
          ))}
        </div>
      )}
      <p className="banner-tagline" aria-hidden="true">
        Good photos,
        <br />
        brighter days
      </p>
      <button type="button" className="icon-btn banner-close" aria-label="Hide welcome banner" onClick={onHide}>
        <Icon name="x" />
      </button>
    </section>
  );
}

export function HomePage() {
  const open = useShellDialogs();
  const [bannerHidden, setBannerHidden] = useState(readDismissed);
  const albums = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  const recent = useQuery({ queryKey: ['photos', 'recent'], queryFn: () => listPhotos(0, 12, 'recent') });
  // The banner collage prefers real photos over screenshots and documents.
  const bannerPhotos = useQuery({ queryKey: ['photos', 'banner'], queryFn: () => listPhotos(0, 3, 'recent', 'photo'), enabled: !bannerHidden });

  const hideBanner = () => {
    setBannerHidden(true);
    try {
      localStorage.setItem(BANNER_KEY, '1');
    } catch {
      // private mode: hidden for this visit only
    }
  };
  const photoIds = (bannerPhotos.data?.items.length ? bannerPhotos.data : recent.data)?.items.map((p) => p.id) ?? [];

  return (
    <>
      {bannerHidden ? <h1 className="visually-hidden">Home</h1> : <Banner photoIds={photoIds} onHide={hideBanner} />}

      <section className="section">
        <div className="section-head">
          <h2>My Albums</h2>
          {albums.data && albums.data.length > 6 && (
            <Link to="/albums" className="view-all">
              View all <Icon name="arrowRight" size={16} />
            </Link>
          )}
        </div>
        {albums.isPending && <Loading />}
        {albums.isError && <ErrorState error={albums.error} onRetry={() => void albums.refetch()} />}
        {albums.data?.length === 0 && (
          <EmptyState title="No albums yet" icon="albums">
            <p>Import a folder to create your first album, or start with an empty one.</p>
            <div className="button-row">
              <button type="button" className="btn btn-primary" onClick={() => open('import-folder')}>
                <Icon name="folder" /> Import Folder
              </button>
              <button type="button" className="btn" onClick={() => open('new-album')}>
                <Icon name="plus" /> New Album
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
            <Link to="/photos" className="view-all">
              View all <Icon name="arrowRight" size={16} />
            </Link>
          </div>
          <PhotoGrid photos={recent.data.items} hrefFor={(id) => `/photos/${id}`} />
        </section>
      )}
    </>
  );
}
