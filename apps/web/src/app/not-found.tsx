import Link from 'next/link';

import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

/**
 * 404 page.
 *
 * Offers a route forward rather than a dead end: most 404s here are a mistyped
 * or renamed API slug, so search is the useful next action.
 */
export default function NotFound() {
  return (
    <div
      className="container"
      style={{
        paddingBlock: 'var(--space-24)',
        textAlign: 'center',
        maxWidth: 520,
      }}
    >
      <span
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 56,
          height: 56,
          margin: '0 auto var(--space-5)',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border)',
          color: 'var(--text-subtle)',
        }}
      >
        <Icon name="help-circle" size={26} />
      </span>

      <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
        Page not found
      </h1>
      <p
        style={{
          marginTop: 'var(--space-3)',
          marginBottom: 'var(--space-8)',
          color: 'var(--text-muted)',
          lineHeight: 'var(--leading-relaxed)',
        }}
      >
        That page does not exist. If you were looking for a specific API, it may have been renamed
        or retired from the catalogue — searching is usually the fastest way back.
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
        <ButtonLink href="/explore">
          <Icon name="search" size={15} />
          Search the catalogue
        </ButtonLink>
        <ButtonLink href="/" variant="secondary">
          Go home
        </ButtonLink>
      </div>

      <p style={{ marginTop: 'var(--space-8)', fontSize: 'var(--text-sm)' }}>
        <Link href="/health" style={{ color: 'var(--accent-400)' }}>
          Check the status board
        </Link>
      </p>
    </div>
  );
}
