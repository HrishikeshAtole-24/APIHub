import type { ApiDetail, HealthReport, ReviewSummary } from '@apihub/contracts';
import { AUTH_TYPE_LABELS } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { Badge, StatusPill } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { FavoriteButton } from '@/features/catalog/FavoriteButton';
import { UptimeChart } from '@/features/health/UptimeChart';
import { CodeTabs } from '@/features/playground/CodeTabs';
import { fetchPublicOrNull, fetchPublicSafe } from '@/lib/server-api';
import {
  displayUrl,
  formatCompact,
  formatLatency,
  formatRelativeTime,
  formatUptime,
} from '@/lib/format';

import styles from './detail.module.css';

export const revalidate = 300;

/**
 * Per-page metadata for SEO (report 6: "Server-rendered catalogue pages,
 * metadata and sitemap for public API pages").
 */
export async function generateMetadata(props: PageProps<'/apis/[slug]'>): Promise<Metadata> {
  const { slug } = await props.params;
  const result = await fetchPublicOrNull<ApiDetail>(`/v1/apis/${slug}`);

  if (!result) return { title: 'API not found' };

  const api = result.data;
  const description = api.description || `${api.name} API details, health and integration code.`;

  return {
    title: api.name,
    description,
    alternates: { canonical: `/apis/${api.slug}` },
    openGraph: { title: `${api.name} · APIHub`, description, type: 'article' },
  };
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={styles['metric']}>
      <div className={styles['metricLabel']}>{label}</div>
      <div className={styles['metricValue']}>{value}</div>
      {hint ? <div className={styles['metricHint']}>{hint}</div> : null}
    </div>
  );
}

/** Health panel streams separately: it is the slowest query on the page. */
async function HealthPanel({ apiId }: { apiId: string }) {
  const result = await fetchPublicSafe<HealthReport>(`/v1/apis/${apiId}/health`, {
    query: { days: 30 },
    revalidateSeconds: 120,
  });

  if (!result) return null;
  const report = result.data;

  return (
    <Card>
      <CardHeader
        title="Health & reliability"
        subtitle={`Last checked ${formatRelativeTime(report.current.lastCheckedAt)}`}
        bordered
      />
      <CardBody>
        <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
          <StatusPill
            status={report.current.status}
            latencyMs={report.current.latencyMs}
            live
          />
          {report.current.httpStatus ? (
            <Badge tone="neutral" mono>
              HTTP {report.current.httpStatus}
            </Badge>
          ) : null}
        </div>

        <div className={styles['metrics']} style={{ marginTop: 0 }}>
          <Metric
            label="Reliability"
            value={report.reliability.score > 0 ? `${report.reliability.score.toFixed(0)}` : '—'}
            hint="out of 100"
          />
          <Metric label="Uptime 30d" value={formatUptime(report.reliability.uptime30d)} />
          <Metric
            label="Latency"
            value={formatLatency(report.current.latencyMs)}
            hint="last probe"
          />
        </div>

        {report.history.length > 0 ? (
          <div style={{ marginTop: 'var(--space-6)' }}>
            <UptimeChart history={report.history} />
          </div>
        ) : (
          <p
            style={{
              marginTop: 'var(--space-5)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-subtle)',
            }}
          >
            Not enough history yet. Uptime builds up as the monitor collects observations.
          </p>
        )}

        {report.incidents.length > 0 ? (
          <div style={{ marginTop: 'var(--space-6)' }}>
            <h4
              style={{
                fontSize: 'var(--text-sm)',
                marginBottom: 'var(--space-3)',
                color: 'var(--text-muted)',
              }}
            >
              Recent incidents
            </h4>
            {report.incidents.slice(0, 4).map((incident) => (
              <div
                key={incident.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) 0',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  {incident.errorCode ?? incident.status}
                </span>
                <span style={{ color: 'var(--text-subtle)' }}>
                  {formatRelativeTime(incident.startedAt)}
                  {incident.resolvedAt ? ' · resolved' : ' · ongoing'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default async function ApiDetailPage(props: PageProps<'/apis/[slug]'>) {
  const { slug } = await props.params;
  const result = await fetchPublicOrNull<ApiDetail>(`/v1/apis/${slug}`);

  // A missing API is a real 404, not an error: it must return the right status
  // for crawlers and for the browser's history.
  if (!result) notFound();

  const api = result.data;
  const isFavorited = Boolean(result.meta['isFavorited']);
  const reviewSummary = result.meta['reviewSummary'] as ReviewSummary | undefined;

  const primaryAuth = api.authSchemes[0];
  const testUrl = api.baseUrl ?? api.docsUrl ?? '';

  return (
    <div className={`container ${styles['page']}`}>
      <nav className={styles['breadcrumb']} aria-label="Breadcrumb">
        <Link href="/explore">Explore</Link>
        <Icon name="chevron-right" size={12} />
        {api.categories[0] ? (
          <>
            <Link href={`/explore?category=${api.categories[0].slug}`}>
              {api.categories[0].name}
            </Link>
            <Icon name="chevron-right" size={12} />
          </>
        ) : null}
        <span style={{ color: 'var(--text-muted)' }}>{api.name}</span>
      </nav>

      <header className={styles['header']}>
        <span className={styles['avatar']} aria-hidden="true">
          {api.name.charAt(0).toUpperCase()}
        </span>

        <div className={styles['headText']}>
          <h1 className={styles['title']}>{api.name}</h1>
          {api.provider ? <div className={styles['provider']}>{api.provider}</div> : null}

          <p className={styles['description']}>
            {api.longDescription || api.description || 'No description available.'}
          </p>

          <div className={styles['badgeRow']}>
            <StatusPill status={api.health.status} latencyMs={api.health.latencyMs} live />
            {api.isFree ? <Badge tone="up" size="md">Free to use</Badge> : null}
            <Badge tone={api.authType === 'none' ? 'accent' : 'neutral'} size="md">
              {AUTH_TYPE_LABELS[api.authType]}
            </Badge>
            {api.httpsSupported ? <Badge tone="info" size="md">HTTPS</Badge> : null}
            {api.corsStatus === 'yes' ? <Badge tone="info" size="md">CORS</Badge> : null}
            {api.categories.map((category) => (
              <Badge key={category.id} tone="neutral" size="md">
                {category.name}
              </Badge>
            ))}
          </div>
        </div>

        <div className={styles['headActions']}>
          <ButtonLink href={`/playground?url=${encodeURIComponent(testUrl)}&apiId=${api.id}`}>
            <Icon name="play" size={15} />
            Try it
          </ButtonLink>

          {api.docsUrl ? (
            <a href={api.docsUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="secondary">
                <Icon name="book-open" size={15} />
                Docs
                <Icon name="external-link" size={12} />
              </Button>
            </a>
          ) : null}

          <FavoriteButton apiId={api.id} initialFavorited={isFavorited} showLabel />
        </div>
      </header>

      <div className={styles['metrics']}>
        <Metric
          label="Reliability"
          value={
            api.health.reliabilityScore !== null ? api.health.reliabilityScore.toFixed(0) : '—'
          }
          hint="out of 100"
        />
        <Metric label="Uptime 30d" value={formatUptime(api.health.uptime30d)} />
        <Metric label="Latency" value={formatLatency(api.health.latencyMs)} />
        <Metric
          label="Rating"
          value={api.averageRating !== null ? api.averageRating.toFixed(1) : '—'}
          hint={`${reviewSummary?.count ?? api.reviewCount} reviews`}
        />
        <Metric label="Saved by" value={formatCompact(api.favoriteCount)} hint="developers" />
        <Metric
          label="Popularity"
          value={api.popularityScore.toFixed(0)}
          hint="out of 100"
        />
      </div>

      <div className={styles['layout']}>
        <div>
          <Suspense
            fallback={
              <Card>
                <CardBody>
                  <Skeleton height="180px" />
                </CardBody>
              </Card>
            }
          >
            <HealthPanel apiId={api.slug} />
          </Suspense>

          {api.endpoints.length > 0 ? (
            <section className={styles['section']}>
              <h2 className={styles['sectionTitle']}>
                <Icon name="server" size={17} />
                Endpoints
              </h2>
              <Card>
                {api.endpoints.map((endpoint) => (
                  <div key={endpoint.id} className={styles['endpoint']}>
                    <span
                      className={`${styles['method']} ${styles[`method${endpoint.method}`] ?? ''}`}
                    >
                      {endpoint.method}
                    </span>
                    <span className={`${styles['endpointPath']} truncate`}>{endpoint.path}</span>
                  </div>
                ))}
              </Card>
            </section>
          ) : null}

          <section className={styles['section']}>
            <h2 className={styles['sectionTitle']}>
              <Icon name="code" size={17} />
              Integration code
            </h2>
            <CodeTabs url={testUrl} apiId={api.id} authType={api.authType} />
          </section>
        </div>

        <aside className={styles['aside']}>
          <Card>
            <CardHeader title="Details" bordered />
            <CardBody tight>
              <div className={styles['infoList']}>
                <div className={styles['infoRow']}>
                  <span className={styles['infoLabel']}>Authentication</span>
                  <span className={styles['infoValue']}>{AUTH_TYPE_LABELS[api.authType]}</span>
                </div>
                <div className={styles['infoRow']}>
                  <span className={styles['infoLabel']}>HTTPS</span>
                  <span className={styles['infoValue']}>
                    {api.httpsSupported ? 'Supported' : 'Not supported'}
                  </span>
                </div>
                <div className={styles['infoRow']}>
                  <span className={styles['infoLabel']}>CORS</span>
                  <span className={styles['infoValue']}>
                    {api.corsStatus === 'yes'
                      ? 'Enabled'
                      : api.corsStatus === 'no'
                        ? 'Not enabled'
                        : 'Unknown'}
                  </span>
                </div>
                {api.docsUrl ? (
                  <div className={styles['infoRow']}>
                    <span className={styles['infoLabel']}>Documentation</span>
                    <span className={`${styles['infoValue']} truncate`}>
                      <a href={api.docsUrl} target="_blank" rel="noopener noreferrer">
                        {displayUrl(api.docsUrl, 26)}
                      </a>
                    </span>
                  </div>
                ) : null}
                {primaryAuth?.signupUrl ? (
                  <div className={styles['infoRow']}>
                    <span className={styles['infoLabel']}>Get a key</span>
                    <span className={`${styles['infoValue']} truncate`}>
                      <a href={primaryAuth.signupUrl} target="_blank" rel="noopener noreferrer">
                        Sign up
                      </a>
                    </span>
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>

          {api.alternatives.length > 0 ? (
            <Card>
              <CardHeader title="Alternatives" subtitle="Similar APIs in this category" bordered />
              <CardBody tight>
                <div className={styles['altList']}>
                  {api.alternatives.map((alternative) => (
                    <Link
                      key={alternative.id}
                      href={`/apis/${alternative.slug}`}
                      className={styles['alt']}
                    >
                      <div className={styles['altName']}>{alternative.name}</div>
                      <div className={`${styles['altDesc']} clamp`}>{alternative.description}</div>
                    </Link>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Provenance" bordered />
            <CardBody>
              {/*
                Every record is traceable to its source (report 16.1). Showing
                it is both an honesty measure and an MIT licence obligation.
              */}
              <p className={styles['provenance']}>
                Imported from <strong>{api.provenance.sourceName}</strong>
                {api.provenance.license ? ` (${api.provenance.license})` : ''}
                {api.provenance.importedAt
                  ? `, ${formatRelativeTime(api.provenance.importedAt)}`
                  : ''}
                .
                {api.provenance.sourceUrl ? (
                  <>
                    {' '}
                    <a href={api.provenance.sourceUrl} target="_blank" rel="noopener noreferrer">
                      View source
                    </a>
                  </>
                ) : null}
              </p>
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
