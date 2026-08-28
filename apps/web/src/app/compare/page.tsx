import type { CompareResult } from '@apihub/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, StatusPill } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { fetchPublicSafe } from '@/lib/server-api';
import { formatLatency } from '@/lib/format';

import styles from './compare.module.css';

export const metadata: Metadata = {
  title: 'Compare APIs',
  description:
    'Compare public APIs side by side on authentication, HTTPS, CORS, latency and uptime.',
};

export const dynamic = 'force-dynamic';

/** Render one comparison cell according to its declared kind. */
function CellValue({
  kind,
  value,
  isBest,
}: {
  kind: string;
  value: string | number | boolean | null;
  isBest: boolean;
}) {
  if (kind === 'boolean') {
    return value ? (
      <span className={styles['yes']}>
        <Icon name="check" size={15} strokeWidth={2.5} />
      </span>
    ) : (
      <span className={styles['no']}>
        <Icon name="minus" size={15} />
      </span>
    );
  }

  if (value === null || value === undefined) return <span className={styles['muted']}>—</span>;

  const rendered =
    kind === 'latency'
      ? formatLatency(Number(value))
      : kind === 'score' && typeof value === 'number'
        ? value.toFixed(value < 10 ? 1 : 0)
        : kind === 'rating' && typeof value === 'number'
          ? `${value.toFixed(1)} / 5`
          : String(value);

  return <span className={isBest ? styles['best'] : undefined}>{rendered}</span>;
}

export default async function ComparePage(props: PageProps<'/compare'>) {
  const params = await props.searchParams;
  const slugs = typeof params['slugs'] === 'string' ? params['slugs'] : '';

  if (!slugs || slugs.split(',').filter(Boolean).length < 2) {
    return (
      <div className="container" style={{ paddingBlock: 'var(--space-16)' }}>
        <div className={styles['empty']}>
          <span className={styles['emptyIcon']}>
            <Icon name="git-compare" size={22} />
          </span>
          <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-2)' }}>
            Compare two or more APIs
          </h1>
          <p
            style={{
              color: 'var(--text-muted)',
              maxWidth: '48ch',
              margin: '0 auto var(--space-6)',
            }}
          >
            Pick APIs from the catalogue to see them side by side on authentication, transport
            security, CORS, live latency, uptime and community rating.
          </p>
          <ButtonLink href="/explore">Browse the catalogue</ButtonLink>
        </div>
      </div>
    );
  }

  const result = await fetchPublicSafe<CompareResult>('/v1/compare', { query: { slugs } });

  if (!result) {
    return (
      <div className="container" style={{ paddingBlock: 'var(--space-16)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Could not load that comparison.</p>
      </div>
    );
  }

  const { apis, rows, verdict } = result.data;
  const winner = verdict.winnerIndex !== null ? apis[verdict.winnerIndex] : undefined;

  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          Comparison
        </h1>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
          {apis.map((entry) => entry.name).join(' vs ')}
        </p>
      </header>

      <div className="scroll-x">
        <table className={styles['table']}>
          <thead>
            <tr>
              <th className={styles['rowLabel']}>Dimension</th>
              {apis.map((entry, index) => (
                <th
                  key={entry.id}
                  className={index === verdict.winnerIndex ? styles['winner'] : undefined}
                >
                  <Link href={`/apis/${entry.slug}`} className={styles['apiName']}>
                    {entry.name}
                  </Link>
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <StatusPill status={entry.health.status} compact />
                  </div>
                  {index === verdict.winnerIndex ? (
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <Badge tone="accent">Best overall</Badge>
                    </div>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className={styles['rowLabel']}>{row.label}</td>
                {row.values.map((value, index) => (
                  <td
                    key={index}
                    className={[
                      styles['cell'],
                      index === verdict.winnerIndex ? styles['winner'] : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <CellValue kind={row.kind} value={value} isBest={row.bestIndex === index} />
                  </td>
                ))}
              </tr>
            ))}

            <tr>
              <td className={styles['rowLabel']}>Overall score</td>
              {verdict.scores.map((score, index) => (
                <td
                  key={index}
                  className={[
                    styles['cell'],
                    index === verdict.winnerIndex ? styles['winner'] : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={index === verdict.winnerIndex ? styles['best'] : undefined}>
                    {(score * 100).toFixed(0)}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {winner ? (
        <div className={styles['verdict']}>
          <h2 className={styles['verdictTitle']}>
            <Icon name="check-circle" size={17} />
            {winner.name} scores highest
          </h2>
          <ul className={styles['verdictList']}>
            {verdict.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className={styles['verdictNote']}>
            The verdict is a weighted sum over the same normalised dimensions shown above — free
            tier, authentication effort, transport security, CORS, reliability, uptime, rating and
            documentation. It is arithmetic you can check, not an opinion.
          </p>
        </div>
      ) : null}

      <p style={{ marginTop: 'var(--space-6)', fontSize: 'var(--text-sm)' }}>
        <Link href="/explore" style={{ color: 'var(--accent-400)' }}>
          ← Back to the catalogue
        </Link>
      </p>
    </div>
  );
}
