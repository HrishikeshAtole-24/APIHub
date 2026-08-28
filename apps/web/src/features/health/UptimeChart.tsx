import type { HealthDaily } from '@apihub/contracts';

import { formatUptime } from '@/lib/format';

import styles from './UptimeChart.module.css';

/**
 * Daily uptime bars.
 *
 * Bar HEIGHT encodes uptime and COLOUR encodes the band, so the shape is
 * readable without relying on colour alone. Days with no observations render
 * as a flat neutral stub rather than being omitted, which would silently
 * compress the timeline and misrepresent history.
 */
export function UptimeChart({ history }: { history: HealthDaily[] }) {
  if (history.length === 0) return null;

  const overall =
    history.reduce((sum, day) => sum + day.uptime * day.totalChecks, 0) /
    Math.max(1, history.reduce((sum, day) => sum + day.totalChecks, 0));

  const bandFor = (day: HealthDaily): string => {
    if (day.totalChecks === 0) return styles['none'] as string;
    if (day.uptime >= 0.99) return styles['up'] as string;
    if (day.uptime >= 0.9) return styles['degraded'] as string;
    return styles['down'] as string;
  };

  const first = history[0];
  const last = history[history.length - 1];

  return (
    <div className={styles['wrap']}>
      <div className={styles['head']}>
        <span>Daily uptime</span>
        <span>{formatUptime(overall)} over {history.length} days</span>
      </div>

      <div className={styles['bars']} role="img" aria-label={`Uptime ${formatUptime(overall)}`}>
        {history.map((day) => (
          <div
            key={day.date}
            className={`${styles['bar']} ${bandFor(day)}`}
            // A minimum height keeps a 0% day visible rather than invisible.
            style={{ height: `${day.totalChecks === 0 ? 12 : 12 + day.uptime * 88}%` }}
            title={`${day.date}: ${
              day.totalChecks === 0
                ? 'no checks'
                : `${formatUptime(day.uptime)} (${day.successfulChecks}/${day.totalChecks})`
            }`}
          />
        ))}
      </div>

      <div className={styles['axis']}>
        <span>{first?.date}</span>
        <span>{last?.date}</span>
      </div>
    </div>
  );
}

/**
 * Compact latency sparkline.
 *
 * Rendered as inline SVG with no charting library: a polyline over normalised
 * points is a few lines of maths and avoids shipping a dependency for a 26px
 * graphic that appears dozens of times on the status board.
 */
export function Sparkline({ values, width = 90 }: { values: number[]; width?: number }) {
  if (values.length < 2) return null;

  const height = 26;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    // Invert: SVG y grows downward, but a higher latency should sit higher.
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${width},${height} L 0,${height} Z`;

  return (
    <svg
      className={styles['sparkline']}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Latency trend, ${Math.round(min)} to ${Math.round(max)} milliseconds`}
    >
      <path d={area} className={styles['sparkArea']} />
      <path d={line} className={styles['sparkPath']} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
