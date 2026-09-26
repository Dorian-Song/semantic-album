import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { suggestAlbumName } from '../../api/albums';
import { startFolderImport } from '../../api/imports';
import { useRefreshLibrary } from '../../app/providers';
import { imageFiles, rootFolderName, startBrowserImport } from '../../hooks/uploads';
import { Dialog } from '../common/Dialog';
import { FormError } from '../common/states';
import { AlbumPicker, type AlbumChoice } from './AlbumPicker';

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
        <div className="button-row">
          <button type="button" className="btn" onClick={() => filesRef.current?.click()}>
            Choose photos
          </button>
          <button type="button" className="btn" onClick={() => folderRef.current?.click()}>
            Choose a folder
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

/** Import a folder on the machine running the backend, by path. */
export function ImportFolderDialog({ onClose }: { onClose: () => void }) {
  const refresh = useRefreshLibrary();
  const qc = useQueryClient();
  const [path, setPath] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [choice, setChoice] = useState<AlbumChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(basename(path.trim())), 300);
    return () => clearTimeout(t);
  }, [path]);
  const suggestion = useQuery({ queryKey: ['albumNameSuggestion', debounced], queryFn: () => suggestAlbumName(debounced), enabled: debounced !== '' });

  const existingId = choice?.kind === 'existing' ? choice.albumId : null;
  const ready = path.trim().startsWith('/') && (mode === 'new' || existingId !== null);

  return (
    <Dialog title="Import folder" onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await startFolderImport(path.trim(), mode === 'existing' ? existingId! : undefined);
            void qc.invalidateQueries({ queryKey: ['jobs'] });
            refresh();
            onClose();
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Folder path</span>
          <input autoFocus required placeholder="/home/you/Pictures/Holiday" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
        </label>
        <p className="dialog-note">
          A folder on the computer running Album. Subfolders are included. You can delete or move the folder afterwards; Album keeps its own copies.
        </p>
        <fieldset className="album-picker">
          <legend className="dialog-subheading">Import into</legend>
          <label className="album-option">
            <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
            New album
            <span className="muted">{debounced ? `“${suggestion.data ?? debounced}”` : 'named after the folder'}</span>
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
            Import
          </button>
        </div>
      </form>
    </Dialog>
  );
}

