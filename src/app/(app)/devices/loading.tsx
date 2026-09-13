import {
  LoadingRegion,
  SkeletonFilterBar,
  SkeletonPageHeader,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * The device list: header with an add action, a panel with search and three
 * filters, then rows of asset tag, model and three facts. Ready for the
 * devices route; harmless until it exists.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading devices">
      <SkeletonPageHeader action />
      <section className="panel">
        <SkeletonFilterBar selects={3} />
        <SkeletonRows rows={8} facts={3} />
      </section>
    </LoadingRegion>
  );
}
