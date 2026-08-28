'use client';

import { useEffect } from 'react';

import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

/**
 * Route error boundary.
 *
 * Shows a recoverable message and a retry, never a stack trace. `digest` is
 * Next's server-side error id: printing it lets a user quote something that
 * can be correlated with the server logs without exposing the error itself.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // In a real deployment this would go to the error tracker.
    console.error('Route error:', error);
  }, [error]);

  return (
    <div
      className="container"
      style={{ paddingBlock: 'var(--space-24)', textAlign: 'center', maxWidth: 520 }}
    >
      <span
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 56,
          height: 56,
          margin: '0 auto var(--space-5)',
          borderRadius: 'var(--radius-xl)',
          background: 'color-mix(in srgb, var(--down-500) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--down-500) 30%, transparent)',
          color: 'var(--down-400)',
        }}
      >
        <Icon name="alert-triangle" size={24} />
      </span>

      <h1 style={{ fontSize: 'var(--text-2xl)', letterSpacing: 'var(--tracking-tight)' }}>
        Something went wrong
      </h1>
      <p
        style={{
          marginTop: 'var(--space-3)',
          marginBottom: 'var(--space-8)',
          color: 'var(--text-muted)',
          lineHeight: 'var(--leading-relaxed)',
        }}
      >
        This page could not be loaded. The catalogue API may be restarting — retrying often works.
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
        <Button onClick={reset}>
          <Icon name="refresh" size={15} />
          Try again
        </Button>
        <ButtonLink href="/" variant="secondary">
          Go home
        </ButtonLink>
      </div>

      {error.digest ? (
        <p
          style={{
            marginTop: 'var(--space-8)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-subtle)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Reference: {error.digest}
        </p>
      ) : null}
    </div>
  );
}
