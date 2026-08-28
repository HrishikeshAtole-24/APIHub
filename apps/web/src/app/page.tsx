import type { ApiSummary, Category, PlatformStats } from '@apihub/contracts';
import Link from 'next/link';
import { Suspense } from 'react';

import { ApiCard } from '@/features/catalog/ApiCard';
import { HeroSearch } from '@/features/search/HeroSearch';
import { ButtonLink } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SkeletonCards } from '@/components/ui/Skeleton';
import { fetchPublicSafe } from '@/lib/server-api';
import { formatCompact } from '@/lib/format';

import styles from './page.module.css';

/**
 * Landing page.
 *
 * A Server Component (report 10.1): the content is public and identical for
 * everyone, so rendering it on the server gives real HTML to crawlers and a
 * fast first paint with no client-side data fetching.
 */

// Revalidate hourly; catalogue statistics change on an ingestion cycle.
export const revalidate = 3600;

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'search',
    title: 'Search that ranks, not just matches',
    text: 'PostgreSQL full-text search with weighted fields, then a scoring pass over relevance, reliability, popularity, free-tier and documentation. Every result shows why it ranked where it did.',
  },
  {
    icon: 'play',
    title: 'Test without leaving the page',
    text: 'Build a request, send it, read the response. Runs through a hardened proxy that validates every target against DNS and refuses private networks, so it can never be used to reach internal services.',
  },
  {
    icon: 'activity',
    title: 'Live health, not stale metadata',
    text: 'Background workers probe endpoints on a priority schedule, classify each result through a state machine, and roll observations into uptime history and a reliability score.',
  },
  {
    icon: 'git-compare',
    title: 'Compare on normalised dimensions',
    text: 'Auth model, HTTPS, CORS, latency, uptime and community rating side by side, with a deterministic verdict you can check rather than trust.',
  },
  {
    icon: 'code',
    title: 'Integration code in twelve languages',
    text: 'cURL, JavaScript, TypeScript, Python, Go, Java, C#, PHP, Ruby and Rust. Credentials are read from environment variables, never inlined into the snippet.',
  },
  {
    icon: 'sparkles',
    title: 'Recommendations you can audit',
    text: 'Describe your project in plain English. Every suggestion is grounded in catalogue fields and lists its caveats, so nothing is invented.',
  },
];

async function StatsRow() {
  const result = await fetchPublicSafe<PlatformStats>('/v1/stats', { revalidateSeconds: 300 });
  // Degrade rather than fail: the hero above is still useful without counts.
  if (!result) return null;

  const stats = result.data;
  const items = [
    { value: formatCompact(stats.totalApis), label: 'APIs catalogued' },
    { value: formatCompact(stats.freeApis), label: 'Free to use' },
    { value: formatCompact(stats.noAuthApis), label: 'Need no API key' },
    { value: formatCompact(stats.totalCategories), label: 'Categories' },
  ];

  return (
    <div className={styles['stats']}>
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`${styles['stat']} stagger`}
          style={{ ['--stagger-index' as string]: index }}
        >
          <div className={styles['statValue']}>{item.value}</div>
          <div className={styles['statLabel']}>{item.label}</div>
        </div>
      ))}
    </div>
  );
}

async function CategoryGrid() {
  const result = await fetchPublicSafe<Category[]>('/v1/categories', { revalidateSeconds: 3600 });
  if (!result) return <UnavailableNote label="categories" />;

  const categories = result.data;
  return (
    <div className={styles['categoryGrid']}>
      {categories.slice(0, 12).map((category, index) => (
        <Link
          key={category.id}
          href={`/explore?category=${category.slug}`}
          className={`${styles['category']} stagger`}
          style={{ ['--stagger-index' as string]: index }}
        >
          <span className={styles['categoryIcon']} aria-hidden="true">
            <Icon name="folder" size={17} />
          </span>
          <span>
            <span className={styles['categoryName']}>{category.name}</span>
            <br />
            <span className={styles['categoryCount']}>
              {formatCompact(category.apiCount)} APIs
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}

async function PopularApis() {
  const result = await fetchPublicSafe<ApiSummary[]>('/v1/apis', {
    query: { pageSize: 6, sort: 'popularity' },
    revalidateSeconds: 900,
  });
  if (!result) return <UnavailableNote label="APIs" />;

  const apis = result.data;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 'var(--space-4)',
      }}
    >
      {apis.map((api, index) => (
        <ApiCard key={api.id} api={api} staggerIndex={index} />
      ))}
    </div>
  );
}

/** Shown when a supplementary section could not load. */
function UnavailableNote({ label }: { label: string }) {
  return (
    <p style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
      Could not load {label} right now. The catalogue API may still be starting up.
    </p>
  );
}

export default function HomePage() {
  return (
    <>
      <section className={styles['hero']}>
        <div className={styles['heroGrid']} aria-hidden="true" />

        <div className={`container ${styles['heroInner']}`}>
          <span className={styles['eyebrow']}>
            <span className={styles['eyebrowDot']} aria-hidden="true" />
            Live health monitoring across the catalogue
          </span>

          <h1 className={styles['title']}>
            The developer&apos;s control center for{' '}
            <span className={styles['titleAccent']}>public APIs</span>
          </h1>

          <p className={styles['subtitle']}>
            Search thousands of public APIs, test them in your browser, compare them on normalised
            dimensions, and see which ones are actually up right now.
          </p>

          <div className={styles['searchWrap']}>
            <HeroSearch />
          </div>

          <div className={styles['heroActions']}>
            <ButtonLink href="/explore" size="lg">
              Explore the catalogue
              <Icon name="arrow-right" size={16} />
            </ButtonLink>
            <ButtonLink href="/playground" size="lg" variant="secondary">
              <Icon name="play" size={15} />
              Open playground
            </ButtonLink>
          </div>

          {/*
            Suspense keeps the hero visible immediately while the statistics
            query resolves, instead of blocking the whole page on it
            (report 10.1: streaming/loading states).
          */}
          <Suspense fallback={<div className={styles['stats']} aria-hidden="true" />}>
            <StatsRow />
          </Suspense>
        </div>
      </section>

      <section className={`container ${styles['section']}`}>
        <div className={styles['sectionHead']}>
          <div>
            <h2 className={styles['sectionTitle']}>Browse by category</h2>
            <p className={styles['sectionSubtitle']}>
              Every entry is normalised from the upstream catalogue and enriched with health,
              authentication and CORS metadata.
            </p>
          </div>
          <Link href="/categories" className="mono" style={{ color: 'var(--accent-400)' }}>
            All categories →
          </Link>
        </div>

        <Suspense fallback={<SkeletonCards count={12} />}>
          <CategoryGrid />
        </Suspense>
      </section>

      <section className={`container ${styles['section']}`}>
        <div className={styles['sectionHead']}>
          <div>
            <h2 className={styles['sectionTitle']}>Popular right now</h2>
            <p className={styles['sectionSubtitle']}>
              Ranked by a blend of usage, reliability and how easy each API is to start using.
            </p>
          </div>
          <Link href="/explore" className="mono" style={{ color: 'var(--accent-400)' }}>
            Explore all →
          </Link>
        </div>

        <Suspense fallback={<SkeletonCards count={6} />}>
          <PopularApis />
        </Suspense>
      </section>

      <section className={`container ${styles['section']}`}>
        <div className={styles['sectionHead']}>
          <div>
            <h2 className={styles['sectionTitle']}>Built like a real system</h2>
            <p className={styles['sectionSubtitle']}>
              Not a directory with a search box. Every feature below is backed by real
              infrastructure — indexes, queues, workers, caches and a security boundary.
            </p>
          </div>
        </div>

        <div className={styles['featureGrid']}>
          {FEATURES.map((feature, index) => (
            <article
              key={feature.title}
              className={`${styles['feature']} stagger`}
              style={{ ['--stagger-index' as string]: index }}
            >
              <span className={styles['featureIcon']} aria-hidden="true">
                <Icon name={feature.icon} size={19} />
              </span>
              <h3 className={styles['featureTitle']}>{feature.title}</h3>
              <p className={styles['featureText']}>{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container">
        <div className={styles['cta']}>
          <h2 className={styles['ctaTitle']}>Find the right API in under a minute</h2>
          <p className={styles['ctaText']}>
            Describe what you are building and get grounded recommendations with real reasons and
            honest caveats — or dive straight into the catalogue and filter it yourself.
          </p>
          <div className={styles['heroActions']}>
            <ButtonLink href="/assistant" size="lg">
              <Icon name="sparkles" size={16} />
              Ask the assistant
            </ButtonLink>
            <ButtonLink href="/explore" size="lg" variant="outline">
              Browse the catalogue
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
