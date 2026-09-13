import { LoadingRegion, Skeleton, SkeletonPageHeader, SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Administration: page header, the tab row, then a panel of account rows
 * with name, role, state and actions, as `AdministrationScreen` lays it out.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading administration">
      <SkeletonPageHeader action />
      <nav className="tabs" aria-hidden="true">
        {[72, 56, 88].map((width, index) => (
          <span key={index} className="tab">
            <Skeleton width={width} />
          </span>
        ))}
      </nav>
      <section className="panel">
        <SkeletonRows rows={6} facts={3} />
      </section>
    </LoadingRegion>
  );
}
