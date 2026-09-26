import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

/** Header search. Inside an album, the search starts scoped to that album. */
export function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = location.pathname === '/search';
  const [text, setText] = useState(onSearchPage ? (params.get('q') ?? '') : '');

  useEffect(() => {
    if (onSearchPage) setText(params.get('q') ?? '');
  }, [onSearchPage, params]);

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
        const albumMatch = /^\/albums\/([^/]+)$/.exec(location.pathname);
        if (albumMatch) next.set('albums', albumMatch[1]!);
        void navigate(`/search?${next.toString()}`);
      }}
    >
      <label className="visually-hidden" htmlFor="global-search">
        Search photos
      </label>
      <input id="global-search" type="search" placeholder="Search photos by words or description…" value={text} onChange={(e) => setText(e.target.value)} />
    </form>
  );
}
