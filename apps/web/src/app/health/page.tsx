import type { HealthBoard } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { Badge, StatusPill } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { Sparkline } from '@/features/health/UptimeChart';
import { fetchPublicSafe } from '@/lib/server-api';
import { formatLatency, formatNumber, formatRelativeTime, formatUptime } from '@/lib/format';

import styles from './health.module.css';

export const metadata: Metadata = {
  title: 'Status board',
  description:
    'Live uptime, latency and reliability for every monitored public API in the APIHub catalogue.',
};

// Short revalidation: this page's entire value is being current.
export const revalidate = 60;

const FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'down', label: 'Down' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'up', label: 'Operational' },
  { value: 'unknown', label: 'Not checked' },
] as const;

async function Board({ status }: { status?: string }) {
  const result = await fetchPublicSafe<HealthBoard>('/v1/health/board', {
    query: { limit: 80, status },
    revalidateSeconds: 60,
  });

  if (!result) {
    return (
      <p style={{ color: 'var(--text-subtle)' }}>
        The monitoring API is unavailable right now.
      </p>
    );
  }

  const { entries, summary } = result.data;

  return (
    <>
      <div className={styles['summary']}>
        <div className={`${styles['summaryCard']} ${styles['summaryUp']}`}>
          <div className={styles['summaryValue']}>{formatNumber(summary.up)}</div>
          <div className={styles['summaryLabel']}>Operational</div>
        </div>
        <div className={`${styles['summaryCard']} ${styles['summaryDegraded']}`}>
          <div className={styles['summaryValue']}>{formatNumber(summary.degraded)}</div>
          <div className={styles['summaryLabel']}>Degraded</div>
        </div>
        <div className={`${styles['summaryCard']} ${styles['summaryDown']}`}>
          <div className={styles['summaryValue']}>{formatNumber(summary.down)}</div>
          <div className={styles['summaryLabel']}>Down</div>
        </div>
        <div className={`${styles['summaryCard']} ${styles['summaryUnknown']}`}>
          <div className={styles['summaryValue']}>{formatNumber(summary.unknown)}</div>
          <div className={styles['summaryLabel']}>Not yet checked</div>
        </div>
        <div className={styles['summaryCard']}>
          <div className={styles['summaryValue']}>{formatLatency(summary.avgLatencyMs)}</div>
          <div className={styles['summaryLabel']}>Average latency</div>
        </div>
      </div>

      <div className={styles['filterRow']}>
        {FILTERS.map((filter) => (
          <ButtonLink
            key={filter.label}
            href={filter.value ? `/health?status=${filter.value}` : '/health'}
            variant={status === filter.value ? 'primary' : 'secondary'}
            size="sm"
          >
            {filter.label}
          </ButtonLink>
        ))}
      </div>

      <div className={styles['board']}>
        <div className={`${styles['row']} ${styles['headerRow']}`}>
          <span>API</span>
          <span className={styles['hideSmall']}>Latency trend</span>
          <span className={styles['hideSmall']}>Latency</span>
          <span className={styles['hideSmall']}>Uptime 30d</span>
          <span>Status</span>
        </div>

        {entries.length === 0 ? (
          <div className={styles['row']}>
            <span className={styles['cellMuted']}>No APIs in this state.</span>
          </div>
        ) : (
          entries.map((entry) => (
            <Link
              key={entry.apiId}
              href={`/apis/${entry.slug}`}
              className={`${styles['row']} ${styles['rowLink']}`}
            >
              <span className={styles['name']}>
                <span className={`${styles['nameText']} truncate`}>{entry.name}</span>
              </span>

              <span className={`${styles['sparkCell']} ${styles['hideSmall']}`}>
                {entry.sparkline.length > 1 ? (
                  <Sparkline values={entry.sparkline} />
                ) : (
                  <span className={styles['cellMuted']}>—</span>
                )}
              </span>

              <span className={`${styles['cell']} ${styles['hideSmall']}`}>
                {formatLatency(entry.latencyMs)}
              </span>

              <span className={`${styles['cell']} ${styles['hideSmall']}`}>
                {formatUptime(entry.uptime30d)}
              </span>

              <span>
                <StatusPill status={entry.status} compact />
              </span>
            </Link>
          ))
        )}
      </div>

      <div className={styles['legend']}>
        <span className={styles['legendItem']}>
          <span className={styles['legendDot']} style={{ background: 'var(--up-500)' }} />
          Operational — responding normally
        </span>
        <span className={styles['legendItem']}>
          <span className={styles['legendDot']} style={{ background: 'var(--degraded-500)' }} />
          Degraded — slow or rate limiting
        </span>
        <span className={styles['legendItem']}>
          <span className={styles['legendDot']} style={{ background: 'var(--down-500)' }} />
          Down — unreachable or erroring
        </span>
      </div>
    </>
  );
}

export default async function HealthPage(props: PageProps<'/health'>) {
  const params = await props.searchParams;
  const status = typeof params['status'] === 'string' ? params['status'] : undefined;

  return (
    <div className={`container-wide ${styles['page']}`}>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Status board
        </h1>
        <p
          style={{
            marginTop: 'var(--space-2)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-md)',
            maxWidth: '70ch',
          }}
        >
          Background workers probe monitored endpoints on a priority schedule — popular and
          currently-failing APIs are re-checked sooner. Each result runs through a state machine, so
          a single network blip does not flip an API to &ldquo;down&rdquo;.
        </p>

        <p
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-subtle)',
          }}
        >
          <Icon name="refresh" size={12} /> Refreshed {formatRelativeTime(new Date().toISOString())}
          {' · '}
          <Badge tone="neutral">updates every 60s</Badge>
        </p>
      </header>

      <Suspense fallback={<Skeleton height="420px" />}>
        <Board {...(status ? { status } : {})} />
      </Suspense>
    </div>
  );
}
