import type { ApiSummary } from '@apihub/contracts';
import { AUTH_TYPE_LABELS } from '@apihub/contracts';
import Link from 'next/link';

import { Badge, STATUS_TONE } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { FavoriteButton } from '@/features/catalog/FavoriteButton';
import { formatCompact, formatLatency } from '@/lib/format';

import styles from './ApiCard.module.css';

interface ApiCardProps {
  api: ApiSummary;
  /** Index within a grid; drives the staggered entrance animation. */
  staggerIndex?: number;
  isFavorited?: boolean;
  /** Relevance score 0..1 from search; renders the score bar when present. */
  score?: number;
  /** Server-rendered <mark> fragments from the search endpoint. */
  highlights?: { name: string | null; description: string | null };
}

/**
 * API summary card.
 *
 * A Server Component by default — only the favourite button is interactive, so
 * only that ships JavaScript (report 10.1: "keep client JavaScript small").
 */
export function ApiCard({ api, staggerIndex, isFavorited, score, highlights }: ApiCardProps) {
  const initial = api.name.charAt(0).toUpperCase();

  return (
    <Card
      as="article"
      interactive
      className={`${styles['card']} stagger`}
      {...(staggerIndex !== undefined
        ? { style: { ['--stagger-index' as string]: staggerIndex } }
        : {})}
    >
      <div className={styles['head']}>
        <span className={styles['avatar']} aria-hidden="true">
          {initial}
        </span>

        <div className={styles['headText']}>
          <h3 className={styles['name']}>
            <Link href={`/apis/${api.slug}`} className={styles['nameLink']}>
              {/*
                Highlight fragments are produced by the API, which escapes the
                source text before inserting <mark>. Rendering them as HTML is
                therefore safe; the raw name is used whenever no highlight
                exists.
              */}
              {highlights?.name ? (
                <span dangerouslySetInnerHTML={{ __html: highlights.name }} />
              ) : (
                api.name
              )}
            </Link>
          </h3>
          {api.provider ? <div className={styles['provider']}>{api.provider}</div> : null}
        </div>

        <FavoriteButton
          apiId={api.id}
          initialFavorited={isFavorited ?? false}
          className={styles['favorite']}
          activeClassName={styles['favoriteActive']}
        />
      </div>

      <p className={`${styles['description']} clamp`}>
        {highlights?.description ? (
          <span dangerouslySetInnerHTML={{ __html: highlights.description }} />
        ) : (
          api.description || 'No description available.'
        )}
      </p>

      <div className={styles['meta']}>
        <Badge tone={STATUS_TONE[api.health.status]} dot>
          {api.health.status === 'up' && api.health.latencyMs
            ? formatLatency(api.health.latencyMs)
            : api.health.status === 'unknown'
              ? 'Not checked'
              : api.health.status}
        </Badge>

        {api.isFree ? <Badge tone="up">Free</Badge> : null}

        <Badge tone={api.authType === 'none' ? 'accent' : 'neutral'}>
          {AUTH_TYPE_LABELS[api.authType]}
        </Badge>

        {api.corsStatus === 'yes' ? <Badge tone="info">CORS</Badge> : null}
        {!api.httpsSupported ? <Badge tone="degraded">No HTTPS</Badge> : null}
      </div>

      {score !== undefined ? (
        <div className={styles['scoreBar']}>
          <span>match</span>
          <span className={styles['scoreTrack']}>
            <span
              className={styles['scoreFill']}
              style={{ width: `${Math.min(100, Math.round(score * 100))}%` }}
            />
          </span>
          <span>{Math.round(score * 100)}%</span>
        </div>
      ) : null}

      <div className={styles['footer']}>
        <span className={styles['stats']}>
          {api.averageRating !== null ? (
            <span className={styles['stat']} title={`${api.reviewCount} reviews`}>
              <Icon name="star" size={12} filled />
              {api.averageRating.toFixed(1)}
            </span>
          ) : null}

          {api.favoriteCount > 0 ? (
            <span className={styles['stat']}>
              <Icon name="heart" size={12} />
              {formatCompact(api.favoriteCount)}
            </span>
          ) : null}

          {api.categories[0] ? (
            <span className={styles['stat']}>
              <Icon name="folder" size={12} />
              {api.categories[0].name}
            </span>
          ) : null}
        </span>

        <span className={styles['stat']}>
          Open
          <Icon name="arrow-right" size={12} />
        </span>
      </div>
    </Card>
  );
}
