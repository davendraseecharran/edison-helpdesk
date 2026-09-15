import {
  LoadingRegion,
  Skeleton,
  SkeletonPageHeader,
  SkeletonPanel,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * Administration: the page header (no action), the tab row, then the access
 * screen's stack: the access requests panel, the accounts table, invites and
 * password accounts, as `AccessScreen` lays them out.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading administration">
      <SkeletonPageHeader />
      <nav className="tabs" aria-hidden="true">
        {[120, 64, 60].map((width, index) => (
          <span key={index} className="tab">
            <Skeleton width={width} />
          </span>
        ))}
      </nav>
      <div className="stack" aria-hidden="true">
        <SkeletonPanel title={112} flush>
          <SkeletonRows rows={2} facts={2} />
        </SkeletonPanel>
        <SkeletonPanel title={72} flush>
          <SkeletonRows rows={6} facts={3} />
        </SkeletonPanel>
        <SkeletonPanel title={56} lines={2} />
        <SkeletonPanel title={136} lines={2} />
      </div>
    </LoadingRegion>
  );
}
