// Light / dark theme: a class on <html> (set before first paint by index.html) plus a saved choice.
import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'codelens.theme';
const EVENT = 'codelens:theme';

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

/** The current theme, re-rendering when it changes. */
export function useTheme(): Theme {
  const [theme, set] = useState<Theme>(currentTheme);
  useEffect(() => {
    const on = () => set(currentTheme());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return theme;
}
