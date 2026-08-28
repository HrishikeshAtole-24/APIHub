'use client';

import type { ApiFacets } from '@apihub/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { formatCompact } from '@/lib/format';

import styles from './FilterSidebar.module.css';

interface FilterSidebarProps {
  facets: ApiFacets | null;
  /** Total results for the current filter set, shown on the mobile trigger. */
  total: number;
}

/**
 * Faceted filters.
 *
 * All state lives in the URL (report 10.1: "use URL search parameters as
 * shareable search state"). That makes every filtered view linkable and
 * bookmarkable, makes the back button behave, and means the server render is
 * always the source of truth — no client store to fall out of sync.
 */
export function FilterSidebar({ facets, total }: FilterSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);

  /** Write a parameter and reset to page 1 — page 3 of the old result set is meaningless. */
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());

      if (value === null || value === '') params.delete(key);
      else params.set(key, value);

      params.delete('page');

      const query = params.toString();
      // `scroll: false` keeps the viewport still: jumping to the top on every
      // checkbox click loses the user's place in a long filter list.
      router.push((query ? `${pathname}?${query}` : pathname) as never, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const toggleBoolean = useCallback(
    (key: string) => {
      setParam(key, searchParams.get(key) === 'true' ? null : 'true');
    },
    [searchParams, setParam],
  );

  const toggleValue = useCallback(
    (key: string, value: string) => {
      setParam(key, searchParams.get(key) === value ? null : value);
    },
    [searchParams, setParam],
  );

  const clearAll = useCallback(() => {
    const params = new URLSearchParams();
    // Preserve the text query; clearing filters should not clear the search.
    const query = searchParams.get('q');
    if (query) params.set('q', query);

    const next = params.toString();
    router.push((next ? `${pathname}?${next}` : pathname) as never, { scroll: false });
  }, [pathname, router, searchParams]);

  const activeCount = useMemo(() => {
    let count = 0;
    for (const key of ['free', 'https', 'cors', 'auth', 'category', 'status']) {
      if (searchParams.get(key)) count += 1;
    }
    return count;
  }, [searchParams]);

  const featureCount = (value: string) =>
    facets?.features.find((bucket) => bucket.value === value)?.count;

  const content = (
    <>
      {activeCount > 0 ? (
        <div className={styles['group']}>
          <Button variant="secondary" size="sm" fullWidth onClick={clearAll}>
            <Icon name="x" size={13} />
            Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
          </Button>
        </div>
      ) : null}

      <div className={styles['group']}>
        <div className={styles['groupTitle']}>Features</div>
        <div className={styles['options']}>
          <FilterOption
            label="Free to use"
            count={featureCount('free')}
            checked={searchParams.get('free') === 'true'}
            onChange={() => toggleBoolean('free')}
          />
          <FilterOption
            label="HTTPS"
            count={featureCount('https')}
            checked={searchParams.get('https') === 'true'}
            onChange={() => toggleBoolean('https')}
          />
          <FilterOption
            label="CORS enabled"
            count={featureCount('cors')}
            checked={searchParams.get('cors') === 'true'}
            onChange={() => toggleBoolean('cors')}
          />
        </div>
      </div>

      <div className={styles['group']}>
        <div className={styles['groupTitle']}>Authentication</div>
        <div className={styles['options']}>
          {(facets?.auth ?? []).slice(0, 6).map((bucket) => (
            <FilterOption
              key={bucket.value}
              label={bucket.label}
              count={bucket.count}
              checked={searchParams.get('auth') === bucket.value}
              radio
              onChange={() => toggleValue('auth', bucket.value)}
            />
          ))}
        </div>
      </div>

      <div className={styles['group']}>
        <div className={styles['groupTitle']}>Status</div>
        <div className={styles['options']}>
          {(facets?.health ?? []).map((bucket) => (
            <FilterOption
              key={bucket.value}
              label={bucket.label}
              count={bucket.count}
              checked={searchParams.get('status') === bucket.value}
              radio
              onChange={() => toggleValue('status', bucket.value)}
            />
          ))}
        </div>
      </div>

      <div className={styles['group']}>
        <div className={styles['groupTitle']}>Category</div>
        <div className={`${styles['options']} ${styles['scrollList']}`}>
          {(facets?.categories ?? []).map((bucket) => (
            <FilterOption
              key={bucket.value}
              label={bucket.label}
              count={bucket.count}
              checked={searchParams.get('category') === bucket.value}
              radio
              onChange={() => toggleValue('category', bucket.value)}
            />
          ))}
        </div>
      </div>
    </>
  );

  return (
    <>
      <aside className={styles['sidebar']} aria-label="Filters">
        {content}
      </aside>

      <div className={styles['mobileBar']}>
        <Button variant="secondary" size="sm" onClick={() => setSheetOpen(true)}>
          <Icon name="filter" size={14} />
          Filters
          {activeCount > 0 ? <span className={styles['activeCount']}>{activeCount}</span> : null}
        </Button>
      </div>

      {sheetOpen ? (
        <>
          <div
            className={styles['sheetBackdrop']}
            onClick={() => setSheetOpen(false)}
            aria-hidden="true"
          />
          <div className={styles['sheetOpen']} role="dialog" aria-label="Filters">
            <div className={styles['sheetHandle']} aria-hidden="true" />
            {content}
            <Button fullWidth onClick={() => setSheetOpen(false)} className={styles['clearAll']}>
              Show {formatCompact(total)} results
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

function FilterOption({
  label,
  count,
  checked,
  radio,
  onChange,
}: {
  label: string;
  count?: number;
  checked: boolean;
  radio?: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={[styles['option'], checked ? styles['optionActive'] : ''].join(' ')}
    >
      {/*
        A real input keeps native keyboard behaviour and screen-reader
        semantics; the styled span is purely visual.
      */}
      <input
        type="checkbox"
        className={styles['nativeInput']}
        checked={checked}
        onChange={onChange}
      />
      <span className={[styles['check'], radio ? styles['radio'] : ''].join(' ')} aria-hidden="true">
        <Icon name="check" size={11} strokeWidth={3} />
      </span>
      <span className={`${styles['optionLabel']} truncate`}>{label}</span>
      {count !== undefined ? (
        <span className={styles['count']}>{formatCompact(count)}</span>
      ) : null}
    </label>
  );
}
