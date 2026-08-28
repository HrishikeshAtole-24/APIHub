import styles from './Skeleton.module.css';

interface SkeletonProps {
  width?: string;
  height?: string;
  circle?: boolean;
  className?: string;
}

export function Skeleton({ width, height, circle, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={[styles['skeleton'], circle ? styles['circle'] : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      style={{ width, ...(height ? { ['--skeleton-height' as string]: height } : {}) }}
    />
  );
}

/** A block of fake text lines, with the last line short like real prose. */
export function SkeletonText({ lines = 3, width = '100%' }: { lines?: number; width?: string }) {
  return (
    <span aria-hidden="true" style={{ display: 'block', width }}>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          className={`${styles['skeleton']} ${styles['text']}`}
          style={{ width: index === lines - 1 ? '62%' : '100%' }}
        />
      ))}
    </span>
  );
}

/** Placeholder grid matching the API card layout. */
export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className={styles['grid']} aria-label="Loading results" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={`${styles['skeleton']} ${styles['card']}`} />
      ))}
    </div>
  );
}
