import { useState } from 'react';
import { createAlbum, removeFromAlbum } from '../../api/albums';
import { addToAlbum, deletePhoto, movePhoto, setManualCaption } from '../../api/photos';
import type { AlbumRef, PhotoDetail } from '../../api/types';
import { useRefreshLibrary } from '../../app/providers';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Dialog } from '../common/Dialog';
import { FormError } from '../common/states';
import { AlbumPicker, type AlbumChoice } from './AlbumPicker';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function resolveChoice(choice: AlbumChoice): Promise<string> {
  return choice.kind === 'existing' ? choice.albumId : (await createAlbum(choice.name)).id;
}

function PickerForm({
  submitLabel,
  disabled,
  onSubmit,
  onClose,
  children,
}: {
  submitLabel: string;
  disabled?: Map<string, string>;
  onSubmit: (albumId: string) => Promise<unknown>;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const [choice, setChoice] = useState<AlbumChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = choice !== null && (choice.kind === 'existing' || choice.name.trim() !== '');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!choice) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit(await resolveChoice(choice));
          onClose();
        } catch (err) {
          setError(err);
          setBusy(false);
        }
      }}
    >
      {children}
      <AlbumPicker value={choice} onChange={setChoice} {...(disabled ? { disabled } : {})} />
      <FormError error={error} />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
          {busy ? 'Working…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Adds another membership; existing ones stay. `alreadyIn` marks albums that contain every photo. */
export function AddToAlbumDialog({ photoIds, alreadyIn = [], onClose }: { photoIds: string[]; alreadyIn?: AlbumRef[]; onClose: () => void }) {
  const refresh = useRefreshLibrary();
  return (
    <Dialog title={photoIds.length === 1 ? 'Add to album' : `Add ${plural(photoIds.length, 'photo')} to album`} onClose={onClose} wide>
      <PickerForm
        submitLabel="Add"
        disabled={new Map(alreadyIn.map((a) => [a.id, 'Already here']))}
        onClose={onClose}
        onSubmit={async (albumId) => {
          for (const id of photoIds) await addToAlbum(id, albumId);
          refresh();
        }}
      >
        <p className="dialog-note">The photo stays in its current albums.</p>
      </PickerForm>
    </Dialog>
  );
}

/** Moves the membership in `from` to another album. Other memberships are untouched. */
export function MovePhotoDialog({ photoIds, from, onClose, onMoved }: { photoIds: string[]; from: AlbumRef; onClose: () => void; onMoved?: () => void }) {
  const refresh = useRefreshLibrary();
  return (
    <Dialog title={photoIds.length === 1 ? 'Move to album' : `Move ${plural(photoIds.length, 'photo')}`} onClose={onClose} wide>
      <PickerForm
        submitLabel="Move"
        disabled={new Map([[from.id, 'Current album']])}
        onClose={onClose}
        onSubmit={async (albumId) => {
          for (const id of photoIds) await movePhoto(id, from.id, albumId);
          refresh();
          onMoved?.();
        }}
      >
        <p className="dialog-note">
          Moves out of <strong>{from.name}</strong>. Other albums that contain the photo are not changed.
        </p>
      </PickerForm>
    </Dialog>
  );
}

export function RemoveFromAlbumDialog({ photoIds, album, onClose, onDone }: { photoIds: string[]; album: AlbumRef; onClose: () => void; onDone?: () => void }) {
  const refresh = useRefreshLibrary();
  return (
    <ConfirmDialog
      title={`Remove from “${album.name}”?`}
      confirmLabel="Remove"
      onClose={onClose}
      onConfirm={async () => {
        for (const id of photoIds) await removeFromAlbum(album.id, id);
        refresh();
        onDone?.();
      }}
    >
      <p>
        {photoIds.length === 1 ? 'The photo' : plural(photoIds.length, 'photo')} will be removed from this album only. A photo that is in no other
        album leaves your library.
      </p>
    </ConfirmDialog>
  );
}

export function DeletePhotoDialog({ photoIds, onClose, onDone }: { photoIds: string[]; onClose: () => void; onDone?: () => void }) {
  const refresh = useRefreshLibrary();
  return (
    <ConfirmDialog
      title={photoIds.length === 1 ? 'Delete photo from library?' : `Delete ${plural(photoIds.length, 'photo')} from library?`}
      confirmLabel="Delete from library"
      danger
      onClose={onClose}
      onConfirm={async () => {
        for (const id of photoIds) await deletePhoto(id);
        refresh();
        onDone?.();
      }}
    >
      <p>This removes the photo from every album and from Album's storage.</p>
    </ConfirmDialog>
  );
}

export function EditDescriptionDialog({ photo, onClose }: { photo: PhotoDetail; onClose: () => void }) {
  const refresh = useRefreshLibrary();
  const [text, setText] = useState(photo.description?.effective ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ai = photo.description?.ai ?? null;
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await setManualCaption(photo.id, value);
      refresh();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Edit description" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(text);
        }}
      >
        <label className="field">
          <span>Description</span>
          <textarea autoFocus rows={5} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="dialog-note">Your text is kept when AI descriptions are generated again.</p>
        {ai && photo.description?.manual && (
          <p className="dialog-note">
            AI description: <em>{ai}</em>
          </p>
        )}
        <FormError error={error} />
        <div className="dialog-actions">
          {photo.description?.manual && (
            <button type="button" className="btn" disabled={busy} onClick={() => void save(null)}>
              {ai ? 'Reset to AI description' : 'Clear description'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
