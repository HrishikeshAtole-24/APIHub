'use client';

import { useEffect, useState } from 'react';

import { Icon } from '@/components/ui/Icon';
import { applyTheme, readStoredTheme, type Theme } from '@/lib/theme';

import styles from './Header.module.css';

const ORDER: Theme[] = ['system', 'light', 'dark'];

const LABEL: Record<Theme, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

const ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const;

/**
 * Three-state theme toggle: system -> light -> dark.
 *
 * "System" is a real option rather than an implicit default, because a user
 * who switches their OS to light at sunset expects the app to follow.
 *
 * Renders a placeholder until mounted: the stored preference lives in
 * localStorage, which the server cannot read, so rendering the real icon
 * during SSR would produce a hydration mismatch.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readStoredTheme());
    setMounted(true);
  }, []);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme;
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      type="button"
      className={styles['iconButton']}
      onClick={cycle}
      title={mounted ? LABEL[theme] : 'Theme'}
      aria-label={mounted ? `${LABEL[theme]}. Click to change.` : 'Change theme'}
    >
      {mounted ? <Icon name={ICON[theme]} size={16} /> : <Icon name="monitor" size={16} />}
    </button>
  );
}
