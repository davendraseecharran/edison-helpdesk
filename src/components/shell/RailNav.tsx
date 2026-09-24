'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChartColumn,
  CircleCheck,
  CalendarCheck,
  ClipboardList,
  ClipboardPen,
  Handshake,
  Inbox,
  Laptop,
  Layers,
  Shield,
  Users,
  UsersRound,
  Workflow,
} from 'lucide-react';
import { Icon, type LucideIcon } from '../ui/Icon';
import { canWorkTickets, isAdmin, type AccountRole } from '../../lib/auth/roles';
import type { QueueCounts } from '../../lib/data/tickets';

export type NavGroup = 'Work' | 'Directory' | 'Admin';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Live count shown in a pill; absent for pages without a natural count. */
  count?: number;
  /**
   * The count is work waiting for somebody, not a tally of your own. Only
   * these are set in the accent.
   */
  callToAction?: boolean;
}

/** Rail order. Groups never interleave. */
const NAV_GROUPS: NavGroup[] = ['Work', 'Directory', 'Admin'];

/**
 * The primary navigation for a role set, in rail order.
 *
 * Pure so the composition can be tested without rendering. NetRiders get Work
 * and Directory; admins also get the Admin group, whose "All tickets" carries
 * the total across every account. Work begins with Today, which is where
 * signing in lands.
 *
 * A skills officer who is neither gets the directory and nothing else — no
 * Work group and no ticket route anywhere in the rail. That is not the
 * security boundary (the database refuses them every ticket, and the routes
 * redirect); it is what keeps the rail honest about the work this person can
 * actually do.
 *
 * There used to be a second group here — Students, Staff and Master inventory,
 * pointing at a separate set of screens over the same tables. Two ways into one
 * roster is one too many: People has the students/staff tabs and Devices is the
 * inventory, both on `requesters` and `inventory_devices`, and both are in
 * Directory where somebody would look for them.
 */
export function navItems(roles: readonly AccountRole[], counts: QueueCounts): NavItem[] {
  const items: NavItem[] = [];

  if (canWorkTickets(roles)) {
    items.push(
      // Today is first because it is where signing in lands and because it is
      // the only item that answers "what now" rather than "what exists". It
      // carries no count: its whole job is to say how much there is.
      { href: '/today', label: 'Today', icon: CalendarCheck, group: 'Work' },
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
      // The repetitive device jobs as a scan loop: loading a cart, handing
      // out, collecting, auditing a room. Inventory writes, so ticket workers.
      { href: '/workflows', label: 'Workflows', icon: Workflow, group: 'Work' },
      // The counting: every ticket worker reads it, and the honours on it are
      // theirs. It carries no count because it is not a list of anything.
      { href: '/analytics', label: 'Analytics', icon: ChartColumn, group: 'Work' },
    );
  }

  // Both are the owner's live tables: People has the students and staff tabs
  // over `requesters`, Devices is the whole inventory. A skills officer reads
  // the inventory too — editing a machine is already refused to them by the
  // screen and by the database, so hiding the list only hid the answer.
  //
  // Groups sits between them because it is the directory read sideways: the
  // same people, in the lists the chapter and the desk actually work from.
  // Every role gets it — a roster is not ticket work and not administration,
  // and the account most likely to keep one is the skills officer's.
  items.push(
    { href: '/people', label: 'People', icon: Users, group: 'Directory' },
    { href: '/groups', label: 'Groups', icon: UsersRound, group: 'Directory' },
    // Forms follow the rosters: a sign-up or a check-in is chapter business
    // too, and every role builds and reads them.
    { href: '/forms', label: 'Forms', icon: ClipboardPen, group: 'Directory' },
    { href: '/devices', label: 'Devices', icon: Laptop, group: 'Directory' },
  );

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
 * The accent is reserved for a count that is a call to action — the open
 * queue, where somebody is waiting and nobody has claimed them yet. Every
 * other count is a quantity of your own work and is set quiet: five lit pills
 * down one rail stop being a signal and start being a highlighter, and they
 * cost the one accented thing on the screen its meaning.
 */
export function CountPill({ count, callToAction }: { count: number; callToAction?: boolean }) {
  const lit = callToAction && count > 0;
  return <span className={lit ? 'count-pill' : 'count-pill count-pill-quiet'}>{count}</span>;
}

/**
 * The left rail. Full width with labels from 1024px, icons only with a
 * tooltip between 720 and 1024, and absent below that where `BottomTabs`
 * takes over. The current page gets a marker on the rail's edge and
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
