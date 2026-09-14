import { LoadingRegion, Skeleton, SkeletonPageHeader } from '@/components/ui/Skeleton';
import '@/styles/notifications.css';

/**
 * Notifications: the header, the filter row, then a group heading and rows.
 *
 * It borrows the real classes, so the placeholder occupies the space the
 * content will and nothing moves when the page streams in.
 */
const GROUPS = [
  { title: 44, rows: 3 },
  { title: 56, rows: 5 },
];

export default function Loading() {
  return (
    <LoadingRegion label="Loading notifications">
      <SkeletonPageHeader />
      <div className="notifications-screen" aria-hidden="true">
        <div className="notifications-toolbar">
          <Skeleton width={132} height={30} />
          <div className="notifications-toolbar-end">
            <Skeleton width={96} height={14} />
            <Skeleton width={124} height={30} />
          </div>
        </div>
        <div className="notifications-groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="notification-group">
              <Skeleton width={group.title} height={14} />
              <div className="notification-rows">
                {Array.from({ length: group.rows }, (_, row) => (
                  <div key={row} className="notification notification-placeholder">
                    <Skeleton width={20} height={20} circle />
                    <span className="notification-text">
                      <Skeleton width={row % 2 === 0 ? 'min(320px, 62%)' : 'min(260px, 48%)'} />
                      <Skeleton width="min(200px, 38%)" height={10} />
                    </span>
                    <Skeleton width={32} height={12} />
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
