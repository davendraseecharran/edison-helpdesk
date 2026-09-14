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
 *
 * Four selects, because that is what every one of those routes shows —
 * status, priority, channel, category. All tickets adds a fifth (owner); a
 * skeleton one short of the page it stands in for is a smaller jump than one
 * too long on the four routes that do not have it.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading">
      <SkeletonPageHeader />
      <section className="panel">
        <SkeletonFilterBar selects={4} />
        <SkeletonRows rows={8} facts={3} />
      </section>
    </LoadingRegion>
  );
}
