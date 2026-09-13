import {
  LoadingRegion,
  Skeleton,
  SkeletonFilterBar,
  SkeletonPageHeader,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * The audit log: page header, the administration tabs, then a panel with six
 * filters over rows of when, who, what, record and summary, as `AuditLog`
 * lays it out. Without this the parent `/admin` skeleton would promise the
 * access screen and then deliver a table.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading the audit log">
      <SkeletonPageHeader />
      <nav className="tabs" aria-hidden="true">
        {[120, 64, 60].map((width, index) => (
          <span key={index} className="tab">
            <Skeleton width={width} />
          </span>
        ))}
      </nav>
      <section className="panel">
        <SkeletonFilterBar selects={6} />
        <SkeletonRows rows={8} facts={4} />
      </section>
    </LoadingRegion>
  );
}
