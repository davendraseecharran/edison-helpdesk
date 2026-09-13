import {
  LoadingRegion,
  Skeleton,
  SkeletonFacts,
  SkeletonPanel,
  SkeletonTimeline,
} from '@/components/ui/Skeleton';

/**
 * Ticket detail: the head (number, title, meta), then the 2fr/1fr grid with
 * the issue, notes, device and activity panels on the left and details,
 * ownership, progress and time on the right, exactly as `tickets/[id]/page.tsx`
 * lays them out.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading ticket">
      <div className="ticket" aria-hidden="true">
        <header className="ticket-head">
          <div className="ticket-head-text skeleton-header-text">
            <Skeleton width={72} height={12} />
            <Skeleton width="min(560px, 85%)" height={26} />
            <div className="skeleton-meta">
              <Skeleton width={72} height={20} className="skeleton-pill" />
              <Skeleton width={64} height={20} className="skeleton-pill" />
              <Skeleton width={128} />
              <Skeleton width={112} />
            </div>
          </div>
        </header>

        <div className="ticket-grid">
          <div className="ticket-column">
            <SkeletonPanel title={128} lines={4} />
            <SkeletonPanel title={56} lines={2} />
            <SkeletonPanel title={72}>
              <SkeletonFacts count={3} />
            </SkeletonPanel>
            <SkeletonPanel title={64}>
              <SkeletonTimeline items={3} />
            </SkeletonPanel>
          </div>

          <div className="ticket-column">
            <SkeletonPanel title={64}>
              <SkeletonFacts count={5} />
            </SkeletonPanel>
            <SkeletonPanel title={88} lines={2} />
            <SkeletonPanel title={80} lines={2} />
            <SkeletonPanel title={40} lines={1} />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
