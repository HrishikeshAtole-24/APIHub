import type { Category } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { fetchPublicSafe } from '@/lib/server-api';
import { formatNumber } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Categories',
  description: 'Browse public APIs by category — weather, finance, geocoding, development and more.',
};

export const revalidate = 3600;

export default async function CategoriesPage() {
  const result = await fetchPublicSafe<Category[]>('/v1/categories', { revalidateSeconds: 3600 });
  const categories = result?.data ?? [];

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-8)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Categories
        </h1>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)', maxWidth: '64ch' }}>
          {formatNumber(categories.length)} categories, derived from the upstream catalogue and
          normalised into stable slugs so links keep working as the source changes.
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {categories.map((category, index) => (
          <Link key={category.id} href={`/explore?category=${category.slug}`}>
            <Card
              interactive
              padded
              className="stagger"
              // Inline custom property drives the staggered entrance.
              {...{ style: { ['--stagger-index' as string]: index } }}
            >
              <span
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 'var(--radius-md)',
                  background: 'color-mix(in srgb, var(--accent-500) 14%, transparent)',
                  color: 'var(--accent-400)',
                  marginBottom: 'var(--space-3)',
                }}
              >
                <Icon name="folder" size={17} />
              </span>

              <div style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>{category.name}</div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-subtle)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatNumber(category.apiCount)} APIs
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
