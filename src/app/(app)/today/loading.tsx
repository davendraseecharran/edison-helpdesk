import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';
import '@/styles/today.css';

/**
 * Today's skeleton, shaped like Today.
 *
 * Parity is the whole point: the greeting is one line at the display size with
 * a shorter one under it, the list is a bordered card of 56px rows with a
 * title, a quiet second line and an action at the end, and the three standing
 * numbers sit under it. The swap when the real screen streams in moves
 * nothing.
 *
 * It carries no `today-stage` classes, so the entrance belongs to the content
 * rather than to the placeholder: the animation has to run once, on the thing
 * a reader actually reads.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading today">
      <div className="today" aria-hidden="true">
        <div className="today-greet">
          <Skeleton width={320} height={36} />
          <Skeleton width="min(460px, 80%)" height={18} />
        </div>

        <div className="today-needs">
          <div className="today-needs-head">
            <Skeleton width={96} height={16} />
          </div>
          <ul className="today-list">
            {Array.from({ length: 4 }, (_, row) => (
              <li key={row}>
                <div className="today-row">
                  <span className="today-row-main">
                    <Skeleton width={row % 2 === 0 ? 'min(320px, 64%)' : 'min(240px, 52%)'} height={15} />
                    <Skeleton width="min(200px, 44%)" height={12} />
                  </span>
                  <span className="today-row-age">
                    <Skeleton width={28} height={13} />
                  </span>
                  <span className="today-row-action">
                    <Skeleton width={72} height={30} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="today-stats">
          {Array.from({ length: 3 }, (_, tile) => (
            <div key={tile} className="today-stat">
              <Skeleton width={40} height={26} />
              <Skeleton width={104} height={13} />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
