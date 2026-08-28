import type { Collection } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiCard } from '@/features/catalog/ApiCard';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { fetchPrivateOrNull } from '@/lib/server-api';

export async function generateMetadata(
  props: PageProps<'/collections/[id]'>,
): Promise<Metadata> {
  const { id } = await props.params;
  const result = await fetchPrivateOrNull<Collection>(`/v1/collections/${id}`);

  return {
    title: result?.data.name ?? 'Collection',
    // Private collections must never be indexed even if the link leaks.
    robots: result?.data.isPublic ? undefined : { index: false, follow: false },
  };
}

export const dynamic = 'force-dynamic';

export default async function CollectionDetailPage(props: PageProps<'/collections/[id]'>) {
  const { id } = await props.params;
  const result = await fetchPrivateOrNull<Collection>(`/v1/collections/${id}`);

  // The API returns 404 for a private collection the viewer does not own, so
  // this covers both "missing" and "not yours" without leaking the difference.
  if (!result) notFound();

  const collection = result.data;
  const items = collection.items ?? [];

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <p style={{ marginBottom: 'var(--space-4)', fontSize: 'var(--text-sm)' }}>
        <Link href="/collections" style={{ color: 'var(--text-subtle)' }}>
          ← Collections
        </Link>
      </p>

      <header style={{ marginBottom: 'var(--space-6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
            {collection.name}
          </h1>
          <Badge tone={collection.isPublic ? 'info' : 'neutral'} size="md">
            <Icon name={collection.isPublic ? 'globe' : 'lock'} size={11} />
            {collection.isPublic ? 'Public' : 'Private'}
          </Badge>
        </div>

        {collection.description ? (
          <p style={{ marginTop: 'var(--space-3)', color: 'var(--text-muted)', maxWidth: '68ch' }}>
            {collection.description}
          </p>
        ) : null}

        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
          {items.length} {items.length === 1 ? 'API' : 'APIs'}
        </p>
      </header>

      {items.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          This collection is empty. Add APIs to it from any API&apos;s detail page.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          {items.map((api, index) => (
            <ApiCard key={api.id} api={api} staggerIndex={index} />
          ))}
        </div>
      )}
    </div>
  );
}
