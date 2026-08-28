import type { ApiFacets, ApiSummary, SearchHit } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { ApiCard } from '@/features/catalog/ApiCard';
import { FilterSidebar } from '@/features/catalog/FilterSidebar';
import { ExploreSearchBar } from '@/features/catalog/ExploreSearchBar';
import { ActiveChips } from '@/features/catalog/ActiveChips';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SkeletonCards } from '@/components/ui/Skeleton';
import { fetchPublicSafe, fetchPrivateOrNull } from '@/lib/server-api';
import { formatNumber } from '@/lib/format';

import styles from './explore.module.css';

export const metadata: Metadata = {
  title: 'Explore APIs',
  description:
    'Search and filter thousands of public APIs by category, authentication, HTTPS, CORS and live health status.',
};

// Always fresh: the result set depends entirely on the query string.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** Read a single-valued search param, ignoring array duplicates. */
function param(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

interface ResultsProps {
  searchParams: SearchParams;
}

async function Results({ searchParams }: ResultsProps) {
  const query = param(searchParams, 'q')?.trim();
  const page = Number(param(searchParams, 'page') ?? 1);

  // Every filter is forwarded verbatim; the API validates them.
  const shared = {
    page,
    pageSize: 24,
    category: param(searchParams, 'category'),
    auth: param(searchParams, 'auth'),
    status: param(searchParams, 'status'),
    free: param(searchParams, 'free'),
    https: param(searchParams, 'https'),
    cors: param(searchParams, 'cors'),
    sort: param(searchParams, 'sort'),
  };

  /*
   * Two different endpoints back this page.
   *
   * With a query, /v1/search runs the ranking pipeline and returns scored hits
   * with highlights. Without one, /v1/apis is a plain indexed list — running
   * the ranker over an unfiltered catalogue would be wasted work.
   */
  const listResult = query
    ? await fetchPublicSafe<SearchHit[]>('/v1/search', { query: { ...shared, q: query } })
    : await fetchPublicSafe<ApiSummary[]>('/v1/apis', { query: shared });

  if (!listResult) {
    return (
      <div className={styles['empty']}>
        <span className={styles['emptyIcon']}>
          <Icon name="alert-circle" size={22} />
        </span>
        <h2 className={styles['emptyTitle']}>The catalogue is unavailable</h2>
        <p className={styles['emptyText']}>
          We could not reach the APIHub API. It may still be starting up — try again in a moment.
        </p>
      </div>
    );
  }

  const total = listResult.meta.total ?? 0;
  const totalPages = listResult.meta.totalPages ?? 1;
  const didYouMean = listResult.meta['didYouMean'] as string | null | undefined;
  const tookMs = listResult.meta['tookMs'] as number | undefined;

  // Normalise both response shapes into one list the grid can render.
  const items: { api: ApiSummary; score?: number; highlights?: SearchHit['highlights'] }[] = query
    ? (listResult.data as SearchHit[]).map((hit) => ({
        api: hit.api,
        score: hit.score,
        highlights: hit.highlights,
      }))
    : (listResult.data as ApiSummary[]).map((api) => ({ api }));

  // Mark the user's favourites in one batched call rather than per card.
  const favoritesResult = await fetchPrivateOrNull<ApiSummary[]>('/v1/me/favorites');
  const favorited = new Set((favoritesResult?.data ?? []).map((api) => api.id));

  return (
    <>
      <div className={styles['toolbar']}>
        <p className={styles['resultCount']}>
          <strong>{formatNumber(total)}</strong> {total === 1 ? 'API' : 'APIs'}
          {query ? (
            <>
              {' '}
              matching <strong>&ldquo;{query}&rdquo;</strong>
            </>
          ) : null}
          {tookMs !== undefined ? (
            <span className={styles['searchMeta']}> · {tookMs}ms</span>
          ) : null}
        </p>
      </div>

      <ActiveChips />

      {didYouMean ? (
        <p className={styles['didYouMean']}>
          Did you mean{' '}
          <Link href={`/explore?q=${encodeURIComponent(didYouMean)}`}>{didYouMean}</Link>?
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className={styles['empty']}>
          <span className={styles['emptyIcon']}>
            <Icon name="search" size={22} />
          </span>
          <h2 className={styles['emptyTitle']}>No APIs match those filters</h2>
          <p className={styles['emptyText']}>
            Try removing a filter, broadening the search, or describing what you need in plain
            English and letting the assistant find it.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center' }}>
            <ButtonLink href="/explore" variant="secondary">
              Clear filters
            </ButtonLink>
            <ButtonLink href="/assistant">
              <Icon name="sparkles" size={15} />
              Ask the assistant
            </ButtonLink>
          </div>
        </div>
      ) : (
        <>
          <div className={styles['grid']}>
            {items.map((entry, index) => (
              <ApiCard
                key={entry.api.id}
                api={entry.api}
                staggerIndex={index}
                isFavorited={favorited.has(entry.api.id)}
                {...(entry.score !== undefined ? { score: entry.score } : {})}
                {...(entry.highlights ? { highlights: entry.highlights } : {})}
              />
            ))}
          </div>

          {totalPages > 1 ? (
            <Pagination page={page} totalPages={totalPages} searchParams={searchParams} />
          ) : null}
        </>
      )}
    </>
  );
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: SearchParams;
}) {
  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (typeof value === 'string' && key !== 'page') params.set(key, value);
    }
    if (targetPage > 1) params.set('page', String(targetPage));
    const query = params.toString();
    return (query ? `/explore?${query}` : '/explore') as never;
  };

  return (
    <nav className={styles['pagination']} aria-label="Pagination">
      <ButtonLink
        href={buildHref(page - 1)}
        variant="secondary"
        size="sm"
        {...(page <= 1 ? { 'aria-disabled': true, tabIndex: -1 } : {})}
      >
        <Icon name="chevron-left" size={14} />
        Previous
      </ButtonLink>

      <span className={styles['pageInfo']}>
        Page {page} of {formatNumber(totalPages)}
      </span>

      <ButtonLink
        href={buildHref(page + 1)}
        variant="secondary"
        size="sm"
        {...(page >= totalPages ? { 'aria-disabled': true, tabIndex: -1 } : {})}
      >
        Next
        <Icon name="chevron-right" size={14} />
      </ButtonLink>
    </nav>
  );
}

/** Facets are fetched separately so the sidebar can render before results. */
async function Sidebar({ searchParams }: ResultsProps) {
  const result = await fetchPublicSafe<ApiSummary[]>('/v1/apis', {
    query: {
      pageSize: 1,
      facets: 'true',
      category: param(searchParams, 'category'),
      free: param(searchParams, 'free'),
      https: param(searchParams, 'https'),
      cors: param(searchParams, 'cors'),
    },
  });

  const facets = (result?.meta['facets'] as ApiFacets | undefined) ?? null;
  return <FilterSidebar facets={facets} total={result?.meta.total ?? 0} />;
}

/**
 * `PageProps<'/explore'>` is generated by `next typegen` (run automatically by
 * dev and build) and is globally available, so params and searchParams are
 * typed from the route literal rather than hand-declared.
 */
export default async function ExplorePage(props: PageProps<'/explore'>) {
  const params = (await props.searchParams) as SearchParams;
  const query = param(params, 'q');

  return (
    <div className={`container-wide ${styles['page']}`}>
      <header className={styles['head']}>
        <h1 className={styles['title']}>{query ? 'Search results' : 'Explore APIs'}</h1>
        <p className={styles['subtitle']}>
          {query
            ? 'Ranked by relevance, reliability, popularity and how easy each API is to adopt.'
            : 'Filter the catalogue by capability, authentication and live health status.'}
        </p>
      </header>

      <ExploreSearchBar />

      <div className={styles['layout']}>
        <Suspense fallback={<div />}>
          <Sidebar searchParams={params} />
        </Suspense>

        <div>
          {/*
            Keyed on the serialised params so a filter change remounts the
            boundary and shows the skeleton, rather than leaving stale results
            on screen while the new ones load.
          */}
          <Suspense key={JSON.stringify(params)} fallback={<SkeletonCards count={9} />}>
            <Results searchParams={params} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
