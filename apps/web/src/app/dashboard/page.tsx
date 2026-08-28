import type { ApiSummary, Collection } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ApiCard } from '@/features/catalog/ApiCard';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { getSession } from '@/lib/session';
import { fetchPrivateOrNull } from '@/lib/server-api';
import { formatRelativeTime } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

// Personalised: must never be cached or statically rendered.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getSession();

  // Guard on the server rather than in a client effect, so an unauthenticated
  // visitor never receives the page shell at all.
  if (!session.user) redirect('/login?next=/dashboard');

  const [favoritesResult, collectionsResult] = await Promise.all([
    fetchPrivateOrNull<ApiSummary[]>('/v1/me/favorites'),
    fetchPrivateOrNull<Collection[]>('/v1/me/collections'),
  ]);

  const favorites = favoritesResult?.data ?? [];
  const collections = collectionsResult?.data ?? [];

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-8)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Welcome back, {session.user.name.split(' ')[0]}
        </h1>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
          Member since {formatRelativeTime(session.user.createdAt)}
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-10)',
        }}
      >
        <Card padded>
          <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 600 }}>{favorites.length}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Saved APIs
          </div>
        </Card>
        <Card padded>
          <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 600 }}>{collections.length}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Collections</div>
        </Card>
        <Card padded>
          <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 600 }}>
            {favorites.filter((api) => api.health.status === 'up').length}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Saved &amp; operational
          </div>
        </Card>
        <Card padded>
          <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 600 }}>
            {favorites.filter((api) => api.health.status === 'down').length}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Saved &amp; down
          </div>
        </Card>
      </div>

      <section style={{ marginBottom: 'var(--space-10)' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 'var(--space-4)',
          }}
        >
          <h2 style={{ fontSize: 'var(--text-xl)' }}>Your favorites</h2>
          {favorites.length > 0 ? (
            <Link href="/favorites" style={{ color: 'var(--accent-400)', fontSize: 'var(--text-sm)' }}>
              View all →
            </Link>
          ) : null}
        </div>

        {favorites.length === 0 ? (
          <Card>
            <CardBody>
              <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)' }}>
                You have not saved any APIs yet. Tap the heart on any API to keep it here.
              </p>
              <ButtonLink href="/explore" variant="secondary">
                Browse the catalogue
              </ButtonLink>
            </CardBody>
          </Card>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            {favorites.slice(0, 6).map((api, index) => (
              <ApiCard key={api.id} api={api} staggerIndex={index} isFavorited />
            ))}
          </div>
        )}
      </section>

      <section>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 'var(--space-4)',
          }}
        >
          <h2 style={{ fontSize: 'var(--text-xl)' }}>Collections</h2>
          <Link href="/collections" style={{ color: 'var(--accent-400)', fontSize: 'var(--text-sm)' }}>
            Manage →
          </Link>
        </div>

        {collections.length === 0 ? (
          <Card>
            <CardBody>
              <p style={{ color: 'var(--text-muted)' }}>
                Collections group APIs by project — &ldquo;my ecommerce stack&rdquo;, &ldquo;weather
                sources&rdquo;. Create one from the collections page.
              </p>
            </CardBody>
          </Card>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            {collections.map((collection) => (
              <Card key={collection.id} interactive>
                <CardHeader
                  title={collection.name}
                  subtitle={`${collection.itemCount} ${collection.itemCount === 1 ? 'API' : 'APIs'}`}
                  action={
                    collection.isPublic ? <Icon name="globe" size={14} /> : <Icon name="lock" size={14} />
                  }
                />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
