import { LoadingRegion, Skeleton, SkeletonPageHeader } from '@/components/ui/Skeleton';
import { ThinkingMark } from '@/components/ui/ThinkingMark';
import '@/styles/analytics.css';

/**
 * Analytics while the period is counted.
 *
 * The one route whose wait is work rather than a fetch: a term's tickets are
 * read and counted before anything can be drawn. So it gets the application
 * thinking in its own mark (`ThinkingMark`, the spiral: something being
 * made) and one line saying what, above the page's real shape — the header,
 * the one lead sentence and the six figure cards — so nothing moves when the
 * page lands. The group's list skeleton stood here before, which promised a
 * table this page does not have.
 *
 * A period chosen on the page does not come here: that navigation is a
 * transition, which keeps the figures on screen while the next ones are
 * counted, and they roll to their new values when they land.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Counting the period">
      <SkeletonPageHeader action />
      <p className="analytics-lead thinking-line analytics-thinking">
        <ThinkingMark state="working" size={28} holdMs={200} />
        <span>Counting the period…</span>
      </p>
      <div className="stat-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="stat-card">
            <Skeleton width={96} height={12} />
            <Skeleton width={56} height={26} />
            <Skeleton width="80%" height={10} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
