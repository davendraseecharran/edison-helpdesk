import {
  LoadingRegion,
  Skeleton,
  SkeletonPageHeader,
  SkeletonPanel,
} from '@/components/ui/Skeleton';

/**
 * Backups: page header, the administration tabs, then one panel holding a row
 * per table — a name and a note on the left, a row count and a download button
 * on the right, as `BackupsScreen` lays it out.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading backups">
      <SkeletonPageHeader />
      <nav className="tabs" aria-hidden="true">
        {[120, 64, 60].map((width, index) => (
          <span key={index} className="tab">
            <Skeleton width={width} />
          </span>
        ))}
      </nav>
      <SkeletonPanel title={64} flush>
        <ul className="backup-list" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <li key={index} className="backup-row">
              <div className="backup-text">
                <Skeleton width={140} />
                <Skeleton width="min(320px, 60vw)" />
              </div>
              <div className="backup-end">
                <Skeleton width={56} />
                <Skeleton width={132} height={32} />
              </div>
            </li>
          ))}
        </ul>
      </SkeletonPanel>
    </LoadingRegion>
  );
}
