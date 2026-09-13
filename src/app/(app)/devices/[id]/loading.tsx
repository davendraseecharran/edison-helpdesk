import {
  LoadingRegion,
  Skeleton,
  SkeletonFacts,
  SkeletonPanel,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * A device: asset tag, model and meta in the head, then the holder and the
 * loan history on the left and the identifiers on the right, on the 2fr/1fr
 * grid.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading device">
      <div className="ticket" aria-hidden="true">
        <header className="ticket-head">
          <div className="ticket-head-text skeleton-header-text">
            <Skeleton width={96} height={12} />
            <Skeleton width="min(420px, 80%)" height={26} />
            <div className="skeleton-meta">
              <Skeleton width={80} height={20} className="skeleton-pill" />
              <Skeleton width={128} />
            </div>
          </div>
        </header>

        <div className="ticket-grid">
          <div className="ticket-column">
            <SkeletonPanel title={56} lines={2} />
            <SkeletonPanel title={136}>
              <SkeletonRows rows={4} facts={2} />
            </SkeletonPanel>
          </div>
          <div className="ticket-column">
            <SkeletonPanel title={104}>
              <SkeletonFacts count={9} />
            </SkeletonPanel>
            <SkeletonPanel title={64} lines={2} />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
