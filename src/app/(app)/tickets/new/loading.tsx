import { LoadingRegion, Skeleton, SkeletonField, SkeletonPageHeader } from '@/components/ui/Skeleton';

const SECTIONS = [
  { fields: 1, full: true },
  { fields: 2, full: true },
  { fields: 2, full: false },
  { fields: 1, full: true },
  { fields: 4, full: false },
];

/**
 * The intake form: page header, then one panel of five titled sections with
 * their fields, and the action row, matching `tickets/new/page.tsx`. On
 * phones the action row is pinned above the tabs, as the real one is.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading form">
      <div className="intake" aria-hidden="true">
        <SkeletonPageHeader />
        <div className="panel">
          {SECTIONS.map((section, index) => (
            <section key={index} className="intake-section">
              <div className="intake-section-text skeleton-header-text">
                <Skeleton width={128} height={16} />
                <Skeleton width="min(240px, 90%)" height={10} />
              </div>
              <div className="intake-section-fields">
                <div className="form-grid">
                  {Array.from({ length: section.fields }, (_, field) => (
                    <SkeletonField key={field} full={section.full} />
                  ))}
                </div>
              </div>
            </section>
          ))}
          <div className="intake-actions">
            <Skeleton width={128} height={36} />
            <Skeleton width={88} height={36} />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
