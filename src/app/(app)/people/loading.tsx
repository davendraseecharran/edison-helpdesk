import {
  LoadingRegion,
  SkeletonFilterBar,
  SkeletonPageHeader,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * The people list: header with an add action, a panel with search and two
 * filters, then rows of name, kind and department. Ready for the people
 * route; harmless until it exists.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading people">
      <SkeletonPageHeader action />
      <section className="panel">
        <SkeletonFilterBar selects={2} />
        <SkeletonRows rows={8} facts={2} />
      </section>
    </LoadingRegion>
  );
}
