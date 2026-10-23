import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useMatch } from 'react-router';
import { getAlbum } from '../../api/albums';
import { Icon, Logo, type IconName } from '../common/Icon';
import { CreateAlbumDialog } from '../dialogs/AlbumDialogs';
import { ImportFolderDialog, ImportPhotosDialog } from '../dialogs/ImportDialogs';
import { ImportProgressPanel } from '../progress/ImportProgressPanel';
import { SearchBar } from '../search/SearchBar';

const NAV: { to: string; label: string; icon: IconName; end: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/photos', label: 'All Photos', icon: 'photos', end: true },
  { to: '/albums', label: 'Albums', icon: 'albums', end: false },
];

export type ShellDialog = 'import-photos' | 'import-folder' | 'new-album' | null;

/** The open album, shown under "Albums" like the concept screens. */
function CurrentAlbum() {
  const match = useMatch('/albums/:id');
  const id = match?.params.id;
  const album = useQuery({ queryKey: ['album', id], queryFn: () => getAlbum(id!), enabled: !!id });
  if (!album.data) return null;
  return (
    <li>
      <NavLink to={`/albums/${album.data.id}`} className="nav-sub" end>
        {album.data.name}
      </NavLink>
    </li>
  );
}

export function AppShell() {
  const [dialog, setDialog] = useState<ShellDialog>(null);
  const close = () => setDialog(null);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="Album home">
          <Logo />
          <span>
            <span className="brand-name">Album</span>
            <span className="brand-tag">Your photos, your place</span>
          </span>
        </NavLink>
        <nav aria-label="Main">
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  <Icon name={item.icon} size={20} />
                  {item.label}
                </NavLink>
              </li>
            ))}
            <CurrentAlbum />
          </ul>
          <hr />
          <ul>
            <li>
              <NavLink to="/settings">
                <Icon name="settings" size={20} />
                Settings
              </NavLink>
            </li>
          </ul>
        </nav>
        <div className="sidebar-note">
          <Icon name="leaf" size={22} />
          <p className="sidebar-note-title">A calmer place for your memories.</p>
          <p>All your photos, safely on your computer.</p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <SearchBar />
          <div className="topbar-actions">
            <button type="button" className="btn btn-soft" onClick={() => setDialog('import-photos')}>
              <Icon name="upload" /> Import Photos
            </button>
            <button type="button" className="btn btn-soft" onClick={() => setDialog('import-folder')}>
              <Icon name="folder" /> Import Folder
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setDialog('new-album')}>
              <Icon name="plus" /> New Album
            </button>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet context={{ openShellDialog: setDialog }} />
        </main>
      </div>
      <ImportProgressPanel />
      {dialog === 'import-photos' && <ImportPhotosDialog onClose={close} />}
      {dialog === 'import-folder' && <ImportFolderDialog onClose={close} />}
      {dialog === 'new-album' && <CreateAlbumDialog onClose={close} />}
    </div>
  );
}
