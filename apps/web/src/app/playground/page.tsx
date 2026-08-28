import type { Metadata } from 'next';

import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { Playground } from '@/features/playground/Playground';

export const metadata: Metadata = {
  title: 'API Playground',
  description:
    'Build and send HTTP requests to any public API from your browser, with a hardened server-side proxy that blocks private networks.',
};

export default async function PlaygroundPage(props: PageProps<'/playground'>) {
  const params = await props.searchParams;

  const url = typeof params['url'] === 'string' ? params['url'] : '';
  const apiId = typeof params['apiId'] === 'string' ? params['apiId'] : undefined;

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Playground
        </h1>
        <p
          style={{
            marginTop: 'var(--space-2)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-md)',
            maxWidth: '72ch',
          }}
        >
          Send a real request and read the real response. Requests are executed server-side through
          a guard that resolves and validates every target address, so internal networks and cloud
          metadata endpoints are unreachable.
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Badge tone="up" size="md" dot>
            SSRF protected
          </Badge>
          <Badge tone="info" size="md">
            <Icon name="clock" size={11} /> 10s timeout
          </Badge>
          <Badge tone="info" size="md">
            <Icon name="download" size={11} /> 2 MB response cap
          </Badge>
          <Badge tone="neutral" size="md">
            <Icon name="shield" size={11} /> Credentials never stored
          </Badge>
        </div>
      </header>

      <Playground initialUrl={url} {...(apiId ? { apiId } : {})} />
    </div>
  );
}
