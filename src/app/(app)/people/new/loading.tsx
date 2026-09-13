import { LoadingRegion, SkeletonField, SkeletonPageHeader } from '@/components/ui/Skeleton';

/** The add-person form: a header, then a panel of fields two to a row. */
export default function Loading() {
  return (
    <LoadingRegion label="Loading form">
      <div className="record-form-page">
        <SkeletonPageHeader />
        <section className="panel" aria-hidden="true">
          <div className="panel-body form">
            <SkeletonField />
            <div className="form-grid">
              {Array.from({ length: 8 }, (_, index) => (
                <SkeletonField key={index} full />
              ))}
            </div>
          </div>
        </section>
      </div>
    </LoadingRegion>
  );
}
