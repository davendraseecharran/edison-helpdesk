'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  Briefcase,
  ChartColumn,
  CircleCheck,
  ClipboardList,
  GraduationCap,
  Handshake,
  Inbox,
  Laptop,
  Layers,
  Shield,
  Users,
} from 'lucide-react';
import { Icon, type LucideIcon } from '../ui/Icon';
import { canWorkTickets, isAdmin, type AccountRole } from '../../lib/auth/roles';
import type { QueueCounts } from '../../lib/data/tickets';

export type NavGroup = 'Work' | 'Directory' | 'Inventory' | 'Insights' | 'Admin';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Live count shown in a pill; absent for pages without a natural count. */
  count?: number;
  /**
   * The count is work waiting for somebody, not a tally of your own. Only
   * these are set in brass.
   */
  callToAction?: boolean;
}

/** Rail order. Groups never interleave. */
export const NAV_GROUPS: NavGroup[] = ['Work', 'Directory', 'Inventory', 'Insights', 'Admin'];

/**
 * The primary navigation for a role set, in rail order.
 *
 * Pure so the composition can be tested without rendering. NetRiders get Work,
 * Directory, Inventory and Insights; admins also get the Admin group, whose
 * "All tickets" carries the total across every account.
 *
 * A skills officer who is neither gets the directory and the inventory and
 * nothing else — no Work group, no Insights, and no ticket route anywhere in
 * the rail. That is not the security boundary (the database refuses them every
 * ticket, and the routes redirect); it is what keeps the rail honest about the
 * work this person can actually do.
 *
 * The Inventory group is the owner's live directory and device inventory
 * (`requesters` / `inventory_devices`), which every active account may search.
 * It sits beside Directory rather than inside it because the M5
 * `people`/`devices` pages read a different set of tables; the two are merged
 * in a later task.
 */
export function navItems(roles: readonly AccountRole[], counts: QueueCounts): NavItem[] {
  const items: NavItem[] = [];

  if (canWorkTickets(roles)) {
    items.push(
      {
        href: '/queue',
        label: 'Queue',
        icon: Inbox,
        group: 'Work',
        count: counts.openQueue,
        callToAction: true,
      },
      {
        href: '/my-tickets',
        label: 'My tickets',
        icon: ClipboardList,
        group: 'Work',
        count: counts.myTickets,
      },
      {
        href: '/collaborating',
        label: 'Collaborating',
        icon: Handshake,
        group: 'Work',
        count: counts.collaborating,
      },
      {
        href: '/resolved',
        label: 'Resolved',
        icon: CircleCheck,
        group: 'Work',
        count: counts.closed,
      },
    );
  }

  items.push({ href: '/people', label: 'People', icon: Users, group: 'Directory' });
  // The M5 device pages can edit a machine, so they belong to the people who
  // work tickets. A skills officer reads the master inventory instead.
  if (canWorkTickets(roles)) {
    items.push({ href: '/devices', label: 'Devices', icon: Laptop, group: 'Directory' });
  }

  items.push(
    { href: '/inventory/students', label: 'Students', icon: GraduationCap, group: 'Inventory' },
    { href: '/inventory/staff', label: 'Staff', icon: Briefcase, group: 'Inventory' },
    { href: '/inventory/devices', label: 'Master inventory', icon: Boxes, group: 'Inventory' },
  );

  if (canWorkTickets(roles)) {
    items.push({ href: '/insights', label: 'Insights', icon: ChartColumn, group: 'Insights' });
  }

  if (isAdmin(roles)) {
    items.push(
      { href: '/all-tickets', label: 'All tickets', icon: Layers, group: 'Admin', count: counts.all },
      { href: '/admin', label: 'Administration', icon: Shield, group: 'Admin' },
    );
  }
  return items;
}

/** Whether `pathname` is the item's page or a page beneath it. */
export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * A live count beside a navigation item.
 *
 * Brass is reserved for a count that is a call to action — the open queue,
 * where somebody is waiting and nobody has claimed them yet. Every other count
 * is a quantity of your own work and is set quiet: five brass pills down one
 * rail stop being a signal and start being a highlighter, and they cost the
 * one brass thing on the screen its meaning.
 */
export function CountPill({ count, callToAction }: { count: number; callToAction?: boolean }) {
  const lit = callToAction && count > 0;
  return <span className={lit ? 'count-pill' : 'count-pill count-pill-quiet'}>{count}</span>;
}

/**
 * The left rail. Full width with labels from 1024px, icons only with a
 * tooltip between 720 and 1024, and absent below that where `BottomTabs`
 * takes over. The current page gets a brass marker on the rail's edge and
 * `aria-current="page"`.
 */
export function RailNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const groups = NAV_GROUPS.map((name) => ({
    name,
    items: items.filter((item) => item.group === name),
  })).filter((group) => group.items.length > 0);

  return (
    <nav className="rail" aria-label="Primary">
      {groups.map((group) => {
        // A heading that only repeats its single item's name is noise.
        const heading = group.items.length === 1 && group.items[0].label === group.name ? null : group.name;
        return (
          <div key={group.name} className="rail-group">
            {heading ? <p className="rail-heading">{heading}</p> : null}
            <ul className="rail-list">
              {group.items.map((item) => {
                const current = isCurrentPath(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="rail-link"
                      aria-current={current ? 'page' : undefined}
                      title={item.label}
                    >
                      <Icon icon={item.icon} size={18} weight="medium" />
                      <span className="rail-text">{item.label}</span>
                      {typeof item.count === 'number' ? (
                        <CountPill count={item.count} callToAction={item.callToAction} />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
