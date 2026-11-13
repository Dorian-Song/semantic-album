import { useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'album.theme';

/** The theme index.html applied before the first paint: a saved choice, else the system preference. */
function current(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Light or dark, remembered in this browser only. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(current);
  const setTheme = (t: Theme) => {
    if (t === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // storage unavailable: the choice lasts until the page is reloaded
    }
    setThemeState(t);
  };
  return [theme, setTheme];
}
