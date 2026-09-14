import { Skeleton } from '@/components/ui/Skeleton';
import '@/styles/scan.css';

/**
 * The shape of the scanner while the account and the session are checked.
 *
 * A skeleton rather than a spinner, and the camera's own rectangle rather
 * than a generic bar: what arrives next is a viewfinder, and the page should
 * not move when it does.
 */
export default function Loading() {
  return (
    <div className="scan-phone" aria-busy="true">
      <header className="scan-phone-head">
        <Skeleton width="60%" height={24} />
      </header>
      <div className="scan-phone-view">
        <Skeleton className="scan-phone-view-skeleton" />
      </div>
      <div className="scan-phone-panel">
        <Skeleton width="70%" />
        <Skeleton height={44} />
        <Skeleton width="40%" />
      </div>
    </div>
  );
}
