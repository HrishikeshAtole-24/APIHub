import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';

/**
 * Route-level loading state.
 *
 * Mirrors the shape of a typical page (heading, subtitle, card grid) so the
 * transition into real content does not shift the layout.
 */
export default function Loading() {
  return (
    <div className="container-wide" style={{ paddingBlock: 'var(--space-8) var(--space-16)' }}>
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <Skeleton width="240px" height="2rem" />
        <div style={{ height: 'var(--space-3)' }} />
        <Skeleton width="420px" height="1rem" />
      </div>
      <SkeletonCards count={9} />
    </div>
  );
}
