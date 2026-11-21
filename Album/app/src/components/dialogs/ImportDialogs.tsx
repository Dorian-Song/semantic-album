import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { suggestAlbumName } from '../../api/albums';
import { startFolderImport } from '../../api/imports';
import { useRefreshLibrary } from '../../app/providers';
import { imageFiles, rootFolderName, startBrowserImport } from '../../hooks/uploads';
import { Dialog } from '../common/Dialog';
import { Icon } from '../common/Icon';
import { Callout, FormError } from '../common/states';
import { AlbumPicker, type AlbumChoice } from './AlbumPicker';
import { FolderBrowserDialog } from './FolderBrowserDialog';
import { chooseFolderClassic } from '../../hooks/legacyFolderBrowser';

export const IMAGE_ACCEPT = 'image/*,.heic,.heif,.hif,.avif';

/** Hidden <input type=file>; `folder` turns it into a directory picker. */
export function FileInput({ folder, onFiles, inputRef }: { folder?: boolean; onFiles: (files: File[]) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  useEffect(() => {
    if (folder) inputRef.current?.setAttribute('webkitdirectory', '');
  }, [folder, inputRef]);
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      hidden
      {...(folder ? {} : { accept: IMAGE_ACCEPT })}
      onChange={(e) => {
        onFiles([...(e.target.files ?? [])]);
        e.target.value = '';
      }}
    />
  );
}

/** Import files chosen in the browser, into a fixed album or a chosen/new one. */
export function ImportPhotosDialog({ album, onClose }: { album?: { id: string; name: string }; onClose: () => void }) {
  const refresh = useRefreshLibrary();
  const qc = useQueryClient();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [choice, setChoice] = useState<AlbumChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pick = (all: File[]) => {
    const images = imageFiles(all);
    setFiles(images);
    setIgnored(all.length - images.length);
    const root = rootFolderName(images);
    if (!album && root) setChoice({ kind: 'new', name: root });
  };
  const target = album ? { albumId: album.id } : choice?.kind === 'existing' ? { albumId: choice.albumId } : choice?.kind === 'new' && choice.name.trim() ? { newAlbumName: choice.name } : null;

  return (
    <Dialog title={album ? `Import photos to “${album.name}”` : 'Import photos'} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!target || files.length === 0) return;
          setBusy(true);
          setError(null);
          try {
            await startBrowserImport(target, files, refresh);
            void qc.invalidateQueries({ queryKey: ['jobs'] });
            refresh();
            onClose();
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        <div className="pick-grid">
          <button type="button" className="pick" onClick={() => filesRef.current?.click()}>
            <Icon name="photos" size={26} />
            <strong>Choose photos</strong>
            <span className="muted small">JPEG, PNG, HEIC, AVIF, WebP…</span>
          </button>
          <button type="button" className="pick" onClick={() => folderRef.current?.click()}>
            <Icon name="folder" size={26} />
            <strong>Choose a folder</strong>
            <span className="muted small">Includes subfolders</span>
          </button>
          <FileInput inputRef={filesRef} onFiles={pick} />
          <FileInput inputRef={folderRef} folder onFiles={pick} />
        </div>
        <p className="dialog-note" aria-live="polite">
          {files.length === 0 ? 'No photos selected yet.' : `${files.length} photo${files.length === 1 ? '' : 's'} selected.`}
          {ignored > 0 && ` ${ignored} other file${ignored === 1 ? '' : 's'} will be ignored.`}
        </p>
        {!album && (
          <>
            <h3 className="dialog-subheading">Add to</h3>
            <AlbumPicker value={choice} onChange={setChoice} newNameDefault={rootFolderName(files) ?? ''} />
          </>
        )}
        <p className="dialog-note">Album keeps its own copy of each photo. Photos already in the album are skipped.</p>
        <FormError error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !target || files.length === 0}>
            Import
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/** A path that wraps after a slash rather than inside a folder name. */
function PathText({ path }: { path: string }) {
  return path.split('/').map((part, i) => (
    <Fragment key={i}>
      {i > 0 && (
        <>
          /<wbr />
        </>
      )}
      {part}
    </Fragment>
  ));
}

/** Import a folder on the machine running the backend, by path. */
export function ImportFolderDialog({ onClose }: { onClose: () => void }) {
  const refresh = useRefreshLibrary();
  const qc = useQueryClient();
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [choice, setChoice] = useState<AlbumChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pathLabelId = useId();
  const browseRef = useRef<HTMLButtonElement>(null);
  // autoFocus fires before Dialog calls showModal(), which then focuses its Close button; focus Browse… afterwards instead.
  useEffect(() => browseRef.current?.focus(), []);
  const folderName = basename(path);
  const suggestion = useQuery({ queryKey: ['albumNameSuggestion', folderName], queryFn: () => suggestAlbumName(folderName), enabled: folderName !== '' });

  const existingId = choice?.kind === 'existing' ? choice.albumId : null;
  const ready = path !== '' && (mode === 'new' || existingId !== null);

  // The browser is a sibling of the import dialog, not a child: React passes events such as
  // a dialog's Escape (cancel) up the component tree, which would close both dialogs at once.
  return (
    <>
      <Dialog title="Import folder" onClose={onClose} wide>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await startFolderImport(path, mode === 'existing' ? existingId! : undefined);
              void qc.invalidateQueries({ queryKey: ['jobs'] });
              refresh();
              onClose();
            } catch (err) {
              setError(err);
              setBusy(false);
            }
          }}
        >
          <div className="folder-card folder-pick">
            <span className="folder-icon">
              <Icon name="folder" size={30} />
            </span>
            <div className="folder-chosen">
              <span className="field-label" id={pathLabelId}>
                Folder
              </span>
              <p className={path ? 'folder-path' : 'folder-path muted'} aria-labelledby={pathLabelId} aria-live="polite">
                {path ? <PathText path={path} /> : 'No folder chosen yet'}
              </p>
            </div>
            <button type="button" ref={browseRef} className="btn" onClick={() => setBrowsing(true)}>
              <Icon name="folder" size={16} /> {path ? 'Change…' : 'Browse…'}
            </button>
          </div>
          <p className="dialog-note">Album imports JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC/HEIF and AVIF, recognised by their content. Other files are skipped. Subfolders are included.</p>
          <p className="dialog-note small">
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                try {
                  const chosen = await chooseFolderClassic(path || undefined);
                  if (chosen) setPath(chosen);
                } catch (err) {
                  setError(err);
                }
              }}
            >
              Use the classic folder browser
            </button>{' '}
            (hand-written version, for comparison)
          </p>
          {mode === 'new' && folderName && suggestion.data && suggestion.data !== folderName && (
            <Callout title={`An album named “${folderName}” already exists.`}>
              <p>The new album will be called “{suggestion.data}”. You can rename it later.</p>
            </Callout>
          )}
          <fieldset className="album-picker">
            <legend className="dialog-subheading">Import into</legend>
            <label className="album-option">
              <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
              New album
              <span className="muted">{folderName ? `“${suggestion.data ?? folderName}”` : 'named after the folder'}</span>
            </label>
            <label className="album-option">
              <input type="radio" name="mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              An existing album
            </label>
          </fieldset>
          {mode === 'existing' && <AlbumPicker value={choice} onChange={setChoice} allowNew={false} />}
          <FormError error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
              <Icon name="folder" /> {mode === 'new' ? 'Import as New Album' : 'Import'}
            </button>
          </div>
        </form>
      </Dialog>
      {browsing && (
        <FolderBrowserDialog
          start={path || undefined}
          onClose={() => setBrowsing(false)}
          onChoose={(chosen) => {
            setPath(chosen);
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}

