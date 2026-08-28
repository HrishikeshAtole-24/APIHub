/** Theme preference, shared by the toggle and the pre-paint script. */

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'apihub-theme';

/** Read the stored preference. Returns 'system' when nothing is stored. */
export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Apply a theme.
 *
 * 'system' REMOVES the attribute rather than writing a value, so the
 * `prefers-color-scheme` media query in tokens.css takes over and the page
 * keeps following the OS if the user changes it later.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;

  if (theme === 'system') {
    root.removeAttribute('data-theme');
    try {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // Storage unavailable; the choice simply will not persist.
    }
    return;
  }

  root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore.
  }
}

/** The theme actually in effect right now, resolving 'system'. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
