import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';

/** The check: the heading, the scan field, and the space the card takes. */
export default function Loading() {
  return (
    <LoadingRegion label="Loading the device check">
      <div className="wf-run dc">
        <Skeleton width={120} height={16} />
        <Skeleton width={220} height={32} />
        <div className="dc-stage">
          <Skeleton height={112} />
          <Skeleton height={280} />
        </div>
      </div>
    </LoadingRegion>
  );
}
