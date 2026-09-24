import { LoadingRegion, Skeleton, SkeletonPageHeader } from '@/components/ui/Skeleton';

/** The hub: header, five tiles, the saved runs and the recent ones. */
export default function Loading() {
  return (
    <LoadingRegion label="Loading workflows">
      <SkeletonPageHeader />
      <div className="wf-tiles">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} height={96} />
        ))}
      </div>
    </LoadingRegion>
  );
}
