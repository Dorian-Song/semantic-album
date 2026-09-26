import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { thumbnailUrl } from '../../api/photos';
import type { Album } from '../../api/types';
import { DeleteAlbumDialog, RenameAlbumDialog } from '../dialogs/AlbumDialogs';

export function AlbumCard({ album }: { album: Album }) {
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const open = (d: 'rename' | 'delete') => {
    menu.current?.removeAttribute('open');
    setDialog(d);
  };
  return (
    <li className="album-card">
      <Link to={`/albums/${album.id}`} className="album-cover">
        {album.coverPhotoId ? <img src={thumbnailUrl(album.coverPhotoId)} alt="" loading="lazy" /> : <span className="cover-empty" aria-hidden />}
      </Link>
      <div className="album-meta">
        <div>
          <Link to={`/albums/${album.id}`} className="album-name">
            {album.name}
          </Link>
          <p className="muted">
            {album.photoCount} photo{album.photoCount === 1 ? '' : 's'}
          </p>
        </div>
        <details className="menu" ref={menu}>
          <summary aria-label={`Actions for ${album.name}`}>⋮</summary>
          <div className="menu-list" role="menu">
            <button type="button" role="menuitem" onClick={() => open('rename')}>
              Rename
            </button>
            <button type="button" role="menuitem" className="danger" onClick={() => open('delete')}>
              Delete
            </button>
          </div>
        </details>
      </div>
      {dialog === 'rename' && <RenameAlbumDialog album={album} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteAlbumDialog album={album} onClose={() => setDialog(null)} />}
    </li>
  );
}

export function AlbumGrid({ albums }: { albums: Album[] }) {
  return (
    <ul className="album-grid">
      {albums.map((a) => (
        <AlbumCard key={a.id} album={a} />
      ))}
    </ul>
  );
}
