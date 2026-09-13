import { LoadingRegion, SkeletonField, SkeletonPageHeader, SkeletonPanel } from '@/components/ui/Skeleton';

/**
 * Settings: header, then three panels of a few fields each. Ready for the
 * settings route; harmless until it exists.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading settings">
      <SkeletonPageHeader />
      <div className="skeleton-sections">
        {[2, 3, 2].map((fields, index) => (
          <SkeletonPanel key={index} title={104}>
            <div className="form-grid">
              {Array.from({ length: fields }, (_, field) => (
                <SkeletonField key={field} />
              ))}
            </div>
          </SkeletonPanel>
        ))}
      </div>
    </LoadingRegion>
  );
}
