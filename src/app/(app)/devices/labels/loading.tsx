import { LoadingRegion, Skeleton, SkeletonPageHeader, SkeletonPanel } from '@/components/ui/Skeleton';
import '@/styles/labels.css';

/** The label printer: the header and its Print action, the controls, and the paper. */
export default function Loading() {
  return (
    <LoadingRegion label="Loading the label printer">
      <SkeletonPageHeader action />
      <div className="lp-grid">
        <div className="lp-controls">
          <SkeletonPanel title={96} lines={4} />
          <SkeletonPanel title={64} lines={5} />
        </div>
        <div className="lp-preview">
          <Skeleton width={220} height={16} />
          <Skeleton height={520} />
        </div>
      </div>
    </LoadingRegion>
  );
}
