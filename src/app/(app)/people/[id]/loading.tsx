import {
  LoadingRegion,
  Skeleton,
  SkeletonFacts,
  SkeletonPanel,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * A person: avatar, name and identifiers in the head, then devices, tickets
 * and history on the left and details and notes on the right, on the same
 * 2fr/1fr grid as a ticket.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading person">
      <div className="ticket" aria-hidden="true">
        <header className="ticket-head">
          <div className="skeleton-profile">
            <Skeleton width={48} height={48} circle />
            <div className="skeleton-header-text">
              <Skeleton width={220} height={24} />
              <Skeleton width={160} />
            </div>
          </div>
        </header>

        <div className="ticket-grid">
          <div className="ticket-column">
            <SkeletonPanel title={72} lines={2} />
            <SkeletonPanel title={64}>
              <SkeletonRows rows={4} facts={2} />
            </SkeletonPanel>
          </div>
          <div className="ticket-column">
            <SkeletonPanel title={64}>
              <SkeletonFacts count={5} />
            </SkeletonPanel>
            <SkeletonPanel title={72} lines={2} />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
