import { useState } from 'react';
import { createAlbum, deleteAlbum, renameAlbum } from '../../api/albums';
import type { Album } from '../../api/types';
import { useRefreshLibrary } from '../../app/providers';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Dialog } from '../common/Dialog';
import { FormError } from '../common/states';

function NameForm({ initial, submitLabel, onSubmit, onClose }: { initial: string; submitLabel: string; onSubmit: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit(name);
          onClose();
        } catch (err) {
          setError(err);
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>Album name</span>
        <input autoFocus required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <FormError error={error} />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function CreateAlbumDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (album: Album) => void }) {
  const refresh = useRefreshLibrary();
  return (
    <Dialog title="New album" onClose={onClose}>
      <NameForm
        initial=""
        submitLabel="Create album"
        onClose={onClose}
        onSubmit={async (name) => {
          const album = await createAlbum(name);
          refresh();
          onCreated?.(album);
        }}
      />
    </Dialog>
  );
}

export function RenameAlbumDialog({ album, onClose }: { album: Album; onClose: () => void }) {
  const refresh = useRefreshLibrary();
  return (
    <Dialog title="Rename album" onClose={onClose}>
      <NameForm
        initial={album.name}
        submitLabel="Rename"
        onClose={onClose}
        onSubmit={async (name) => {
          await renameAlbum(album.id, name);
          refresh();
        }}
      />
    </Dialog>
  );
}

export function DeleteAlbumDialog({ album, onClose, onDeleted }: { album: Album; onClose: () => void; onDeleted?: () => void }) {
  const refresh = useRefreshLibrary();
  return (
    <ConfirmDialog
      title={`Delete “${album.name}”?`}
      confirmLabel="Delete album"
      danger
      onClose={onClose}
      onConfirm={async () => {
        await deleteAlbum(album.id);
        refresh();
        onDeleted?.();
      }}
    >
      <p>Photos that are also in other albums stay there. Photos that are only in this album are removed from your library.</p>
    </ConfirmDialog>
  );
}
