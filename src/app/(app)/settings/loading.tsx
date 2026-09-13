import { LoadingRegion, Skeleton, SkeletonPageHeader } from '@/components/ui/Skeleton';
import '@/styles/settings.css';

/**
 * Settings: the page header, then the four sections in the order the screen
 * has them — profile, appearance, assistant, notifications — each a heading,
 * a line of description and a card of that many rows.
 *
 * It borrows the real classes, so the placeholder occupies the space the
 * content will and nothing moves when the page streams in.
 */
const SECTION_ROWS = [2, 1, 4, 1];

export default function Loading() {
  return (
    <LoadingRegion label="Loading settings">
      <div className="settings">
        <SkeletonPageHeader />
        <div className="settings-sections">
          {SECTION_ROWS.map((rows, section) => (
            <section key={section} className="settings-section" aria-hidden="true">
              <div className="settings-section-head skeleton-header-text">
                <Skeleton width={132} height={20} />
                <Skeleton width="min(440px, 85%)" />
              </div>
              <div className="settings-card">
                {Array.from({ length: rows }, (_, row) => (
                  <div key={row} className="setting-row">
                    <div className="setting-row-text">
                      <Skeleton width={144} height={14} />
                      <Skeleton width="min(300px, 70%)" />
                    </div>
                    <div className="setting-row-control">
                      <Skeleton width={96} height={28} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
