'use client';

import type { Suggestion } from '@apihub/contracts';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from '@/components/ui/Icon';
import { api } from '@/lib/api-client';
import { useDebouncedValue } from '@/lib/hooks';

import styles from './CommandPalette.module.css';

interface PaletteItem {
  id: string;
  title: string;
  hint: string | null;
  icon: IconName;
  href: string;
  section: string;
}

const QUICK_ACTIONS: PaletteItem[] = [
  { id: 'a-explore', title: 'Explore all APIs', hint: 'Browse and filter', icon: 'layers', href: '/explore', section: 'Actions' },
  { id: 'a-playground', title: 'Open the playground', hint: 'Test any endpoint', icon: 'play', href: '/playground', section: 'Actions' },
  { id: 'a-health', title: 'Status board', hint: 'Live uptime', icon: 'activity', href: '/health', section: 'Actions' },
  { id: 'a-assistant', title: 'Ask the assistant', hint: 'Describe your project', icon: 'sparkles', href: '/assistant', section: 'Actions' },
  { id: 'a-compare', title: 'Compare APIs', hint: 'Side by side', icon: 'git-compare', href: '/compare', section: 'Actions' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced so typing does not fire a request per keystroke.
  const debouncedQuery = useDebouncedValue(query, 160);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSuggestions([]);
      setActiveIndex(0);
      return;
    }
    // Autofocus on open; the palette exists to be typed into.
    inputRef.current?.focus();
  }, [open]);

  // Lock body scroll while the overlay is up.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open || debouncedQuery.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    api
      .get<Suggestion[]>('/v1/suggest', { query: { q: debouncedQuery, limit: 8 } })
      .then((result) => {
        // Guard against an out-of-order response overwriting newer results.
        if (!cancelled) setSuggestions(result.data);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, open]);

  const items = useMemo<PaletteItem[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return QUICK_ACTIONS;

    const mapped: PaletteItem[] = suggestions.map((suggestion, index) => ({
      id: `s-${index}-${suggestion.text}`,
      title: suggestion.text,
      hint: suggestion.hint,
      icon: suggestion.type === 'category' ? 'folder' : 'server',
      href:
        suggestion.type === 'category'
          ? `/explore?category=${suggestion.slug ?? ''}`
          : `/apis/${suggestion.slug ?? ''}`,
      section: suggestion.type === 'category' ? 'Categories' : 'APIs',
    }));

    // Always offer full-text search as the last resort, so a query that
    // matches no name is never a dead end.
    mapped.push({
      id: 'search-all',
      title: `Search for "${trimmed}"`,
      hint: 'Full-text search',
      icon: 'search',
      href: `/explore?q=${encodeURIComponent(trimmed)}`,
      section: 'Search',
    });

    return mapped;
  }, [query, suggestions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length]);

  const select = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      onClose();
      router.push(item.href as never);
    },
    [onClose, router],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        event.preventDefault();
        // Wraps, so holding Down cycles rather than sticking at the end.
        setActiveIndex((index) => (index + 1) % Math.max(1, items.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + items.length) % Math.max(1, items.length));
        break;
      case 'Enter':
        event.preventDefault();
        select(items[activeIndex]);
        break;
      default:
        break;
    }
  };

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  let lastSection: string | null = null;

  return (
    <div
      className={styles['overlay']}
      onMouseDown={(event) => {
        // Close only on a click that both starts and ends on the backdrop.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles['dialog']}
        role="dialog"
        aria-modal="true"
        aria-label="Search APIHub"
        onKeyDown={onKeyDown}
      >
        <div className={styles['inputRow']}>
          <Icon name="search" size={18} className={styles['searchIcon']} />
          <input
            ref={inputRef}
            className={styles['input']}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search APIs, categories or actions…"
            autoComplete="off"
            spellCheck={false}
            aria-label="Search"
            aria-autocomplete="list"
          />
          {loading ? <span className={styles['spinner']} aria-hidden="true" /> : null}
        </div>

        <div className={styles['results']} ref={listRef} role="listbox">
          {items.length === 0 ? (
            <p className={styles['empty']}>No matches. Try a different term.</p>
          ) : (
            items.map((item, index) => {
              const showSection = item.section !== lastSection;
              lastSection = item.section;

              return (
                <div key={item.id}>
                  {showSection ? <div className={styles['sectionLabel']}>{item.section}</div> : null}

                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    className={[
                      styles['item'],
                      index === activeIndex ? styles['itemActive'] : '',
                    ].join(' ')}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => select(item)}
                  >
                    <span className={styles['itemIcon']}>
                      <Icon name={item.icon} size={15} />
                    </span>

                    <span className={styles['itemBody']}>
                      <span className={`${styles['itemTitle']} truncate`}>{item.title}</span>
                      {item.hint ? <span className={styles['itemHint']}>{item.hint}</span> : null}
                    </span>

                    <span className={styles['itemEnter']}>↵</span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className={styles['footer']}>
          <span className={styles['hint']}>
            <kbd className={styles['key']}>↑</kbd>
            <kbd className={styles['key']}>↓</kbd> navigate
          </span>
          <span className={styles['hint']}>
            <kbd className={styles['key']}>↵</kbd> open
          </span>
          <span className={styles['hint']}>
            <kbd className={styles['key']}>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
