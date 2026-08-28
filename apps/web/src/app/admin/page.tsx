import type { IngestionRun, OpsMetrics } from '@apihub/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { getSession } from '@/lib/session';
import { fetchPrivateOrNull } from '@/lib/server-api';
import { formatNumber, formatRelativeTime } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) 0',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--text-sm)',
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

export default async function AdminPage() {
  const session = await getSession();

  if (!session.user) redirect('/login?next=/admin');
  // Authorization is enforced by the API too; this is a UX guard, not the
  // security boundary.
  if (session.user.role !== 'admin') redirect('/dashboard');

  const [metricsResult, ingestionResult] = await Promise.all([
    fetchPrivateOrNull<OpsMetrics>('/v1/admin/health'),
    fetchPrivateOrNull<IngestionRun[]>('/v1/admin/ingestion', { query: { limit: 8 } }),
  ]);

  const metrics = metricsResult?.data;
  const runs = ingestionResult?.data ?? [];

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-8)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Operations
        </h1>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
          Runtime health, queue depth and ingestion history.
        </p>
      </header>

      {!metrics ? (
        <p style={{ color: 'var(--text-muted)' }}>Operational metrics are unavailable.</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'var(--space-4)',
            marginBottom: 'var(--space-8)',
          }}
        >
          <Card>
            <CardHeader title="Runtime" bordered />
            <CardBody tight>
              <StatRow
                label="Uptime"
                value={`${Math.floor(metrics.uptimeSeconds / 60)}m ${Math.round(metrics.uptimeSeconds % 60)}s`}
              />
              <StatRow label="Heap used" value={`${metrics.memory.heapUsedMb} MB`} />
              <StatRow label="RSS" value={`${metrics.memory.rssMb} MB`} />
              <StatRow label="Event-loop lag" value={`${metrics.eventLoopLagMs} ms`} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Dependencies" bordered />
            <CardBody tight>
              <StatRow label="Database driver" value={metrics.drivers.database} />
              <StatRow
                label="Database latency"
                value={metrics.database.latencyMs !== null ? `${metrics.database.latencyMs} ms` : '—'}
              />
              <StatRow label="Cache" value={metrics.drivers.cache} />
              <StatRow
                label="Cache hit rate"
                value={
                  metrics.cache.hitRate !== null
                    ? `${(metrics.cache.hitRate * 100).toFixed(1)}%`
                    : '—'
                }
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="HTTP" bordered />
            <CardBody tight>
              <StatRow label="Requests" value={formatNumber(metrics.http.total)} />
              <StatRow label="Errors" value={formatNumber(metrics.http.errors)} />
              <StatRow
                label="p50 latency"
                value={metrics.http.p50Ms !== null ? `${metrics.http.p50Ms} ms` : '—'}
              />
              <StatRow
                label="p95 latency"
                value={metrics.http.p95Ms !== null ? `${metrics.http.p95Ms} ms` : '—'}
              />
            </CardBody>
          </Card>
        </div>
      )}

      {metrics && metrics.queues.length > 0 ? (
        <Card>
          <CardHeader title="Queues" subtitle="Background job pipeline" bordered />
          <CardBody tight>
            {metrics.queues.map((queue) => (
              <div
                key={queue.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.6fr repeat(5, 1fr)',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) 0',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 'var(--text-sm)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                  {queue.name}
                </span>
                <span>{queue.waiting} waiting</span>
                <span>{queue.active} active</span>
                <span>{queue.completed} done</span>
                <span style={{ color: queue.failed > 0 ? 'var(--down-400)' : undefined }}>
                  {queue.failed} failed
                </span>
                <span>{queue.delayed} delayed</span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <section style={{ marginTop: 'var(--space-8)' }}>
        <h2 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          Ingestion history
        </h2>

        {runs.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No ingestion runs recorded yet.</p>
        ) : (
          <Card>
            <CardBody tight>
              {runs.map((run) => (
                <div
                  key={run.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    padding: 'var(--space-3) 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 'var(--text-sm)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Badge
                    tone={
                      run.status === 'succeeded'
                        ? 'up'
                        : run.status === 'failed'
                          ? 'down'
                          : run.status === 'partial'
                            ? 'degraded'
                            : 'neutral'
                    }
                    dot
                  >
                    {run.status}
                  </Badge>

                  <span style={{ color: 'var(--text-muted)' }}>{run.sourceName}</span>

                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                    {formatNumber(run.recordsCreated)} created · {formatNumber(run.recordsUpdated)}{' '}
                    updated
                    {run.recordsFailed > 0 ? ` · ${formatNumber(run.recordsFailed)} failed` : ''}
                  </span>

                  <span style={{ marginLeft: 'auto', color: 'var(--text-subtle)' }}>
                    <Icon name="clock" size={12} /> {formatRelativeTime(run.startedAt)}
                    {run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
