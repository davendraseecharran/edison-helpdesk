import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';

/** A run: the heading, then the step card or the scan console. */
export default function Loading() {
  return (
    <LoadingRegion label="Loading the workflow">
      <div className="wf-run">
        <Skeleton width={120} height={16} />
        <Skeleton width={220} height={32} />
        <Skeleton height={180} />
      </div>
    </LoadingRegion>
  );
}
