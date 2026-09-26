import { Link } from 'react-router';
import { thumbnailUrl } from '../../api/photos';
import type { PhotoSummary } from '../../api/types';

interface Props {
  photos: PhotoSummary[];
  /** Link target for a photo, carrying the list context for previous/next. */
  hrefFor: (id: string) => string;
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
}

export function PhotoGrid({ photos, hrefFor, selected, onToggle }: Props) {
  return (
    <ul className="photo-grid">
      {photos.map((p) => {
        const isSelected = selected?.has(p.id) ?? false;
        return (
          <li key={p.id} className={isSelected ? 'photo-card is-selected' : 'photo-card'}>
            <Link to={hrefFor(p.id)} className="photo-link">
              <img src={thumbnailUrl(p.id)} alt={p.filename} loading="lazy" />
            </Link>
            {onToggle && (
              <label className="photo-check">
                <input type="checkbox" checked={isSelected} onChange={() => onToggle(p.id)} />
                <span className="visually-hidden">Select {p.filename}</span>
              </label>
            )}
          </li>
        );
      })}
    </ul>
  );
}
