import type { ApiSummary } from '@apihub/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ApiCard } from '@/features/catalog/ApiCard';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { getSession } from '@/lib/session';
import { fetchPrivateOrNull } from '@/lib/server-api';

export const metadata: Metadata = {
  title: 'Favorites',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function FavoritesPage() {
  const session = await getSession();
  if (!session.user) redirect('/login?next=/favorites');

  const result = await fetchPrivateOrNull<ApiSummary[]>('/v1/me/favorites');
  const favorites = result?.data ?? [];

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Favorites
        </h1>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
          {favorites.length} saved {favorites.length === 1 ? 'API' : 'APIs'}
        </p>
      </header>

      {favorites.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--space-20) var(--space-6)',
            border: '1px dashed var(--border-strong)',
            borderRadius: 'var(--radius-xl)',
          }}
        >
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 48,
              height: 48,
              margin: '0 auto var(--space-4)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--surface-sunken)',
              color: 'var(--text-subtle)',
            }}
          >
            <Icon name="heart" size={22} />
          </span>
          <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>
            Nothing saved yet
          </h2>
          <p
            style={{
              color: 'var(--text-muted)',
              maxWidth: '44ch',
              margin: '0 auto var(--space-6)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Tap the heart on any API to keep it here. Favorites show live health, so you can see at a
            glance whether anything you depend on is down.
          </p>
          <ButtonLink href="/explore">Browse the catalogue</ButtonLink>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          {favorites.map((api, index) => (
            <ApiCard key={api.id} api={api} staggerIndex={index} isFavorited />
          ))}
        </div>
      )}
    </div>
  );
}
