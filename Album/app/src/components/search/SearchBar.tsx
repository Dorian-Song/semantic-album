import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { getImageQuery, looksLikeImage, setImageQuery } from '../../hooks/imageQuery';
import { Icon } from '../common/Icon';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Header search. Inside an album, the search starts scoped to that album. ⌘K / Ctrl+K focuses it. An image
 * (chosen, dropped on the bar, or pasted into it) searches for similar photos instead of the typed words.
 */
export function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const onSearchPage = location.pathname === '/search';
  const [text, setText] = useState(onSearchPage ? (params.get('q') ?? '') : '');
  const [image, setImage] = useState<File | null>(() => (onSearchPage ? getImageQuery(params.get('image')) : null));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (onSearchPage) setText(params.get('q') ?? '');
  }, [onSearchPage, params]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const attach = (file: File | undefined) => {
    if (!file) return;
    if (!looksLikeImage(file)) {
      setNotice('This file format is not supported. Choose an image.');
      return;
    }
    setNotice(null);
    setImage(file);
    input.current?.focus();
  };

  const albumMatch = /^\/albums\/([^/]+)$/.exec(location.pathname);
  return (
    <form
      role="search"
      className="search-bar"
      onSubmit={(e) => {
        e.preventDefault();
        const next = new URLSearchParams(onSearchPage ? params : undefined);
        if (albumMatch) next.set('albums', albumMatch[1]!);
        if (image) {
          next.delete('q');
          next.delete('mode');
          next.set('image', setImageQuery(image));
        } else {
          const q = text.trim();
          if (!q) return;
          next.delete('image');
          next.set('q', q);
        }
        void navigate(`/search?${next.toString()}`);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        attach(e.dataTransfer.files[0]);
      }}
    >
      <Icon name="search" size={20} className="search-icon" />
      <label className="visually-hidden" htmlFor="global-search">
        Search photos
      </label>
      <input
        id="global-search"
        ref={input}
        type="search"
        placeholder={image ? 'Press Enter to find photos like this image' : albumMatch ? 'Search photos in this album…' : 'Search photos by words or description…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const file = e.clipboardData.files[0];
          if (!file) return; // plain text pastes as usual
          e.preventDefault();
          attach(file);
        }}
      />
      <button type="button" className="search-image-btn" title="Search by image" aria-label="Search by image" onClick={() => picker.current?.click()}>
        <Icon name="image" size={18} />
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          attach(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <kbd aria-hidden="true">{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
      {(image || notice) && (
        <div className="search-attachment" role="status">
          {image ? (
            <span className="search-attachment-name">
              <Icon name="image" size={14} /> {image.name || 'Pasted image'}
              <button type="button" aria-label="Remove image" onClick={() => setImage(null)}>
                <Icon name="x" size={14} />
              </button>
            </span>
          ) : (
            <span className="form-error">{notice}</span>
          )}
        </div>
      )}
    </form>
  );
}
