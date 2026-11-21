import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { listHostFolder } from '../../api/imports';
import { Dialog } from '../common/Dialog';
import { Icon } from '../common/Icon';
import { ErrorState, Loading } from '../common/states';

/** "/a/b" → "/", "/a", "/a/b", so each part of the path can be opened directly. */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))];
}

/** The parent of an absolute path, for going up when the folder itself could not be listed. */
function parentOf(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return null;
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

function imageNote(count: number): string {
  if (count === 0) return 'No supported images directly in this folder. Images in its subfolders are imported too.';
  return `${count} supported image${count === 1 ? '' : 's'} directly in this folder. Images in its subfolders are imported too.`;
}

/**
 * Browses folders on the machine running the backend, one level at a time, and returns the chosen absolute path.
 * Without `start` it opens at the user's home folder.
 */
export function FolderBrowserDialog({ start, onChoose, onClose }: { start?: string | undefined; onChoose: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState<string | undefined>(start);
  const listing = useQuery({
    queryKey: ['hostFolder', path ?? '~'],
    queryFn: ({ signal }) => listHostFolder(path, signal),
    retry: false,
    staleTime: 0,
  });
  const data = listing.data;
  const here = data?.path ?? path;
  const parent = data ? data.parent : here ? parentOf(here) : null;
  const atHome = data !== undefined && data.path === data.home;

  // After moving, focus lands on the folder we came from (going up) or on the first subfolder.
  const panelRef = useRef<HTMLDivElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const focusAfterLoad = useRef<string | null | undefined>(null);
  const go = (next: string | undefined, focusPath: string | null = null) => {
    focusAfterLoad.current = focusPath;
    // The clicked button may disappear with the old listing; keep focus inside the dialog meanwhile.
    panelRef.current?.focus();
    setPath(next);
  };
  useEffect(() => {
    if (!data || focusAfterLoad.current === undefined) return;
    const want = focusAfterLoad.current;
    focusAfterLoad.current = undefined;
    const rows = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button[data-path]') ?? [])];
    (rows.find((b) => b.dataset.path === want) ?? rows[0] ?? chooseRef.current)?.focus();
  }, [data]);

  return (
    <Dialog title="Choose a folder" onClose={onClose} wide>
      <div className="folder-browser">
        <div className="folder-browser-bar">
          <button type="button" className="btn btn-small btn-ghost" disabled={!parent} onClick={() => parent && go(parent, here ?? null)}>
            <Icon name="arrowUp" size={16} /> Up
          </button>
          <button type="button" className="btn btn-small btn-ghost" disabled={atHome} onClick={() => go(undefined)}>
            <Icon name="home" size={16} /> Home
          </button>
        </div>
        {here && (
          <nav className="folder-crumbs" aria-label="Current folder">
            <ol>
              {crumbs(here).map((c, i, all) => (
                <li key={c.path}>
                  {i > 0 && <Icon name="chevronRight" size={14} />}
                  {i === all.length - 1 ? (
                    <span aria-current="location">{c.name}</span>
                  ) : (
                    <button type="button" className="link-btn" onClick={() => go(c.path, all[i + 1]?.path ?? null)} aria-label={i === 0 ? 'Root folder' : undefined}>
                      {c.name}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="folder-browser-list" ref={panelRef} tabIndex={-1} aria-label="Subfolders" aria-busy={listing.isFetching}>
          {listing.isPending ? (
            <Loading label="Opening folder…" />
          ) : listing.isError ? (
            <ErrorState error={listing.error} onRetry={() => void listing.refetch()} />
          ) : listing.data.folders.length === 0 ? (
            <p className="folder-browser-empty">No subfolders here.</p>
          ) : (
            <ul>
              {listing.data.folders.map((f) => (
                <li key={f.path}>
                  <button type="button" className="folder-row" data-path={f.path} onClick={() => go(f.path)}>
                    <Icon name="folder" />
                    <span className="folder-row-name">{f.name}</span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="dialog-note" aria-live="polite">
          {data ? imageNote(data.imageFiles) : ' '}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" ref={chooseRef} className="btn btn-primary" disabled={!data || listing.isFetching} onClick={() => data && onChoose(data.path)}>
            Choose this folder
          </button>
        </div>
      </div>
    </Dialog>
  );
}
