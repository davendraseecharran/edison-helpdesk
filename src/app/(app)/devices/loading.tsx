import {
  LoadingRegion,
  SkeletonFilterBar,
  SkeletonPageHeader,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * The device list: header with export and add actions, a panel with search,
 * three selects and the holder control, then rows of asset tag, model,
 * status, holder, location and age.
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
