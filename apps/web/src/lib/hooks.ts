'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Debounce a value.
 *
 * Used for search-as-you-type: without it, every keystroke fires a request,
 * and responses can arrive out of order so an older result overwrites a newer
 * one.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Copy to clipboard with a transient "copied" acknowledgement.
 *
 * The Clipboard API requires a secure context and can be denied, so failure is
 * reported rather than silently swallowed.
 */
export function useCopyToClipboard(resetAfterMs = 1800): {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);

        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetAfterMs);
        return true;
      } catch {
        return false;
      }
    },
    [resetAfterMs],
  );

  return { copied, copy };
}

/**
 * Persist state in localStorage.
 *
 * Reads lazily on mount rather than during the first render: the server has no
 * localStorage, so reading it during render would produce a hydration
 * mismatch. Every access is guarded because storage throws in private modes.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) setValue(JSON.parse(stored) as T);
    } catch {
      // Keep the initial value.
    }
  }, [key]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or unavailable; state still updates in memory.
      }
    },
    [key],
  );

  return [value, update];
}

/** True once the component has mounted on the client. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** Run a callback when a click lands outside the referenced element. */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onOutside: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    const handler = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };

    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [ref, onOutside, enabled]);
}
