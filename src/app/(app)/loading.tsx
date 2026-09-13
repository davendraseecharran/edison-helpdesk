import {
  LoadingRegion,
  SkeletonFilterBar,
  SkeletonPageHeader,
  SkeletonRows,
} from '@/components/ui/Skeleton';

/**
 * The fallback for every list route in the group: queue, my tickets,
 * collaborating, resolved, all tickets. Mirrors `TicketListView`: page header,
 * a panel with the filter bar, then table rows. The rail and top bar sit
 * outside the page and stay put; only this region shimmers.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading">
      <SkeletonPageHeader />
      <section className="panel">
        <SkeletonFilterBar selects={3} />
        <SkeletonRows rows={8} facts={3} />
      </section>
    </LoadingRegion>
  );
}
