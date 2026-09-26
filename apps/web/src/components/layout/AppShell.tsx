import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { CreateAlbumDialog } from '../dialogs/AlbumDialogs';
import { ImportFolderDialog, ImportPhotosDialog } from '../dialogs/ImportDialogs';
import { ImportProgressPanel } from '../progress/ImportProgressPanel';
import { SearchBar } from '../search/SearchBar';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/photos', label: 'All Photos', end: true },
  { to: '/albums', label: 'Albums', end: false },
  { to: '/settings', label: 'Settings', end: true },
];

export type ShellDialog = 'import-photos' | 'import-folder' | 'new-album' | null;

export function AppShell() {
  const [dialog, setDialog] = useState<ShellDialog>(null);
  const close = () => setDialog(null);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">Album</span>
          <span className="brand-tag">Your photos, your place</span>
        </div>
        <nav aria-label="Main">
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <SearchBar />
          <div className="topbar-actions">
            <button type="button" className="btn" onClick={() => setDialog('import-photos')}>
              Import Photos
            </button>
            <button type="button" className="btn" onClick={() => setDialog('import-folder')}>
              Import Folder
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setDialog('new-album')}>
              New Album
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
