/**
 * Display formatting.
 *
 * Centralised so the same value never renders two different ways in two
 * places, and so locale handling is decided once.
 */

/** 1204 -> "1.2k". Keeps stat tiles from wrapping. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1000) return String(value);

  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

/** 0.9987 -> "99.87%". Uptime needs more precision than a whole percent. */
export function formatUptime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const percent = value * 100;
  // Below 99.9% two decimals are noise; above it they are the whole point.
  return `${percent >= 99.9 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Relative time ("3 minutes ago").
 *
 * Uses Intl.RelativeTimeFormat so the phrasing is correct without a date
 * library. Falls through units largest-first.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);

  if (absolute < 45) return 'just now';

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];

  for (const [unit, seconds] of units) {
    if (absolute >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds, 'second');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** Strip the scheme and any trailing slash, for compact URL display. */
export function displayUrl(url: string | null | undefined, maxLength = 44): string {
  if (!url) return '—';

  const cleaned = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/** Colour token for a rating, so 4.8 and 2.1 do not look equally good. */
export function ratingTone(rating: number | null): 'up' | 'degraded' | 'down' | 'neutral' {
  if (rating === null) return 'neutral';
  if (rating >= 4) return 'up';
  if (rating >= 3) return 'degraded';
  return 'down';
}
