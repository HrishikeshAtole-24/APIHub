'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Icon } from '@/components/ui/Icon';

import styles from '@/app/explore/explore.module.css';

const SORT_OPTIONS = [
  { value: 'popularity', label: 'Most popular' },
  { value: 'reliability', label: 'Most reliable' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'newest', label: 'Recently added' },
  { value: 'name', label: 'Name (A–Z)' },
] as const;

/**
 * Search box and sort control for the explore page.
 *
 * Submits on Enter rather than on every keystroke: each change is a full
 * server navigation, so debounced live search would queue up renders and make
 * the back button unusable.
 */
export function ExploreSearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [value, setValue] = useState(searchParams.get('q') ?? '');

  // Keep the field in step when navigation changes the query (back button,
  // a "did you mean" link, a suggestion from the palette).
  useEffect(() => {
    setValue(searchParams.get('q') ?? '');
  }, [searchParams]);

  const navigate = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, next] of Object.entries(updates)) {
      if (next === null || next === '') params.delete(key);
      else params.set(key, next);
    }
    params.delete('page');

    const query = params.toString();
    router.push((query ? `${pathname}?${query}` : pathname) as never);
  };

  return (
    <div className={styles['searchRow']}>
      <form
        className={styles['searchField']}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ q: value.trim() || null });
        }}
      >
        <Icon name="search" size={16} className={styles['searchIcon']} />
        <input
          className={styles['searchInput']}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search by name, description or capability…"
          aria-label="Search APIs"
          autoComplete="off"
        />
      </form>

      <select
        className={styles['select']}
        value={searchParams.get('sort') ?? 'popularity'}
        onChange={(event) => navigate({ sort: event.target.value })}
        aria-label="Sort results"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
