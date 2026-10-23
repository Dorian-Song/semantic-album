import { useQuery } from '@tanstack/react-query';
import { listAlbums } from '../../api/albums';
import { Loading, ErrorState } from '../common/states';

export type AlbumChoice = { kind: 'existing'; albumId: string } | { kind: 'new'; name: string };

interface Props {
  value: AlbumChoice | null;
  onChange: (choice: AlbumChoice) => void;
  /** Albums that cannot be chosen, with the reason shown next to them. */
  disabled?: Map<string, string>;
  allowNew?: boolean;
  newNameDefault?: string;
}

/** Radio list of albums plus an optional "New album" entry. */
export function AlbumPicker({ value, onChange, disabled, allowNew = true, newNameDefault = '' }: Props) {
  const albums = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  if (albums.isPending) return <Loading />;
  if (albums.isError) return <ErrorState error={albums.error} onRetry={() => void albums.refetch()} />;
  const newName = value?.kind === 'new' ? value.name : newNameDefault;

  return (
    <fieldset className="album-picker">
      <legend className="visually-hidden">Album</legend>
      {allowNew && (
        <div className="album-option">
          <label>
            <input type="radio" name="album" checked={value?.kind === 'new'} onChange={() => onChange({ kind: 'new', name: newName })} />
            New album
          </label>
          {value?.kind === 'new' && (
            <input
              aria-label="New album name"
              className="inline-input"
              required
              maxLength={120}
              value={value.name}
              onChange={(e) => onChange({ kind: 'new', name: e.target.value })}
            />
          )}
        </div>
      )}
      {albums.data.map((a) => {
        const reason = disabled?.get(a.id);
        return (
          <label key={a.id} className={reason ? 'album-option is-disabled' : 'album-option'}>
            <input
              type="radio"
              name="album"
              disabled={!!reason}
              checked={value?.kind === 'existing' && value.albumId === a.id}
              onChange={() => onChange({ kind: 'existing', albumId: a.id })}
            />
            {a.name}
            <span className="muted">{reason ?? `${a.photoCount} photos`}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
