import {
  LoadingRegion,
  Skeleton,
  SkeletonPageHeader,
  SkeletonPanel,
  SkeletonRows,
} from '@/components/ui/Skeleton';
import '@/styles/insights.css';

const PLOT = [40, 72, 56, 96, 64, 120, 84, 104, 60, 88, 48, 76];
const BAR_ROWS = ['72%', '54%', '38%', '22%'];

/**
 * Insights while the aggregates are being counted: the header and its range
 * control, four figures, the wide chart, the three bar panels beside each
 * other, the technicians table, and the two panels that close the page —
 * Inventory, which holds a PAIR of charts, and Device types in tickets, which
 * holds one.
 *
 * It stands in for the real layout rather than for a generic page, so the
 * content that arrives lands where the placeholder was instead of pushing the
 * page around underneath somebody's eyes. That is also why it runs to the
 * bottom: a skeleton that stops early is a page that grows when it loads.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading insights">
      <div className="insights">
        <SkeletonPageHeader action />
        <div className="insights-tiles" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="skeleton-tile">
              <Skeleton width={88} height={10} />
              <Skeleton width={64} height={26} />
              <Skeleton width={120} height={10} />
            </div>
          ))}
        </div>
        <SkeletonPanel title={160}>
          <div className="skeleton-bars">
            {PLOT.map((height, index) => (
              <Skeleton key={index} height={height} />
            ))}
          </div>
        </SkeletonPanel>
        <div className="insights-grid">
          {['status', 'priority', 'category'].map((panel) => (
            <SkeletonPanel key={panel} title={116}>
              <div className="skeleton-rows">
                {BAR_ROWS.map((width) => (
                  <Skeleton key={width} width={width} height={12} />
                ))}
              </div>
            </SkeletonPanel>
          ))}
        </div>
        <SkeletonPanel title={104}>
          <SkeletonRows rows={4} facts={3} />
        </SkeletonPanel>
        <div className="insights-grid insights-grid-wide">
          {/* Inventory is TWO charts side by side under one panel ("By status"
              and "Most common types", in .insights-pair), so the skeleton is
              too. A single flat list here made the panel grow a heading and
              reflow the moment the counts arrived. */}
          <SkeletonPanel title={132}>
            <div className="insights-pair">
              {['status', 'types'].map((block) => (
                <div key={block} className="chart-block">
                  <Skeleton width={96} height={12} />
                  <div className="skeleton-rows">
                    {BAR_ROWS.map((width) => (
                      <Skeleton key={width} width={width} height={12} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SkeletonPanel>
          <SkeletonPanel title={132}>
            <div className="skeleton-rows">
              {BAR_ROWS.map((width) => (
                <Skeleton key={width} width={width} height={12} />
              ))}
            </div>
          </SkeletonPanel>
        </div>
      </div>
    </LoadingRegion>
  );
}
