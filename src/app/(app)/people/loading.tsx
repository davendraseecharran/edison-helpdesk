import {
  LoadingRegion,
  SkeletonFilterBar,
  SkeletonPageHeader,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * The people list: header with an add action, a panel with search, the kind
 * control and two selects, then rows of name, id, placement and two counts.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading people">
      <SkeletonPageHeader action />
      <section className="panel">
        <SkeletonFilterBar selects={3} />
        <SkeletonRows rows={8} facts={3} />
      </section>
    </LoadingRegion>
  );
}
