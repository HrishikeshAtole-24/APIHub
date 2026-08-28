import type { HealthStatus } from '@apihub/contracts';
import type { ReactNode } from 'react';

import styles from './Badge.module.css';
import pillStyles from './StatusPill.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'up' | 'degraded' | 'down' | 'info';

interface BadgeProps {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
  mono?: boolean;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  mono,
  dot,
  children,
  className,
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={[
        styles['badge'],
        styles[tone],
        size === 'md' ? styles['md'] : '',
        mono ? styles['mono'] : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? <span className={styles['dot']} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Health status maps to a tone. One place, so it can never disagree. */
export const STATUS_TONE: Record<HealthStatus, BadgeTone> = {
  up: 'up',
  degraded: 'degraded',
  down: 'down',
  unknown: 'neutral',
};

export const STATUS_LABEL: Record<HealthStatus, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Not checked',
};

interface StatusPillProps {
  status: HealthStatus;
  latencyMs?: number | null;
  /** Animate the dot to signal a live board. */
  live?: boolean;
  compact?: boolean;
}

/**
 * Health status indicator.
 *
 * Status is communicated by colour AND text, never colour alone — roughly 1 in
 * 12 men has a colour-vision deficiency, and red/green is the worst pairing to
 * rely on.
 */
export function StatusPill({ status, latencyMs, live, compact }: StatusPillProps) {
  const tone = STATUS_TONE[status];

  if (compact) {
    return (
      <Badge tone={tone} dot>
        {STATUS_LABEL[status]}
      </Badge>
    );
  }

  return (
    <span
      className={[pillStyles['pill'], styles[tone]].join(' ')}
      title={`${STATUS_LABEL[status]}${latencyMs ? ` — ${latencyMs}ms` : ''}`}
    >
      <span
        className={[styles['dot'], live && status === 'up' ? styles['pulse'] : ''].join(' ')}
        aria-hidden="true"
      />
      <span className={pillStyles['label']}>{STATUS_LABEL[status]}</span>
      {latencyMs !== null && latencyMs !== undefined ? (
        <span className={pillStyles['latency']}>{latencyMs}ms</span>
      ) : null}
    </span>
  );
}
