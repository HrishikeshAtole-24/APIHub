import type { Collection } from '@apihub/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CollectionsManager } from '@/features/collections/CollectionsManager';
import { getSession } from '@/lib/session';
import { fetchPrivateOrNull } from '@/lib/server-api';

export const metadata: Metadata = {
  title: 'Collections',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function CollectionsPage() {
  const session = await getSession();
  if (!session.user) redirect('/login?next=/collections');

  const result = await fetchPrivateOrNull<Collection[]>('/v1/me/collections');

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Collections
        </h1>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)', maxWidth: '62ch' }}>
          Group APIs by project so the stack for each thing you build stays together — and share it
          with a link when it is useful to someone else.
        </p>
      </header>

      <CollectionsManager initial={result?.data ?? []} />
    </div>
  );
}
