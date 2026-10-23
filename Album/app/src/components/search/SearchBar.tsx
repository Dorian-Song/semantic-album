import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Icon } from '../common/Icon';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Header search. Inside an album, the search starts scoped to that album. ⌘K / Ctrl+K focuses it. */
export function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const onSearchPage = location.pathname === '/search';
  const [text, setText] = useState(onSearchPage ? (params.get('q') ?? '') : '');

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

  const albumMatch = /^\/albums\/([^/]+)$/.exec(location.pathname);
  return (
    <form
      role="search"
      className="search-bar"
      onSubmit={(e) => {
        e.preventDefault();
        const q = text.trim();
        if (!q) return;
        const next = new URLSearchParams(onSearchPage ? params : undefined);
        next.set('q', q);
        if (albumMatch) next.set('albums', albumMatch[1]!);
        void navigate(`/search?${next.toString()}`);
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
        placeholder={albumMatch ? 'Search photos in this album…' : 'Search photos by words or description…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <kbd aria-hidden="true">{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
    </form>
  );
}
