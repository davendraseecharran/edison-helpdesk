import { LoadingRegion, Skeleton, SkeletonPageHeader, SkeletonPanel, SkeletonRows } from '@/components/ui/Skeleton';

const BARS = [40, 72, 56, 96, 64, 120, 84, 104, 60, 88, 48, 76];

/**
 * Insights: header, a row of four figures, then a chart panel beside a table
 * panel. Ready for the insights route; harmless until it exists.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading insights">
      <SkeletonPageHeader />
      <div className="skeleton-tiles" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="skeleton-tile">
            <Skeleton width={88} height={10} />
            <Skeleton width={64} height={26} />
            <Skeleton width={120} height={10} />
          </div>
        ))}
      </div>
      <div className="skeleton-two">
        <SkeletonPanel title={128}>
          <div className="skeleton-bars">
            {BARS.map((height, index) => (
              <Skeleton key={index} height={height} />
            ))}
          </div>
        </SkeletonPanel>
        <SkeletonPanel title={112}>
          <SkeletonRows rows={5} facts={1} />
        </SkeletonPanel>
      </div>
    </LoadingRegion>
  );
}
