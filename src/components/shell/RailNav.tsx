'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChartColumn,
  CircleCheck,
  ClipboardList,
  Handshake,
  Inbox,
  Laptop,
  Layers,
  Shield,
  Users,
} from 'lucide-react';
import { Icon, type LucideIcon } from '../ui/Icon';
import type { QueueCounts } from '../../lib/data/tickets';

export type NavRole = 'admin' | 'technician';
export type NavGroup = 'Work' | 'Directory' | 'Insights' | 'Admin';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Live count shown in a pill; absent for pages without a natural count. */
  count?: number;
}

/** Rail order. Groups never interleave. */
export const NAV_GROUPS: NavGroup[] = ['Work', 'Directory', 'Insights', 'Admin'];

/**
 * The primary navigation for a role, in rail order.
 *
 * Pure so the composition can be tested without rendering: technicians get
 * Work, Directory and Insights; admins also get the Admin group, whose "All
 * tickets" carries the total across every account.
 */
export function navItems(role: NavRole, counts: QueueCounts): NavItem[] {
  const items: NavItem[] = [
    { href: '/queue', label: 'Queue', icon: Inbox, group: 'Work', count: counts.openQueue },
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
    { href: '/resolved', label: 'Resolved', icon: CircleCheck, group: 'Work', count: counts.closed },
    { href: '/people', label: 'People', icon: Users, group: 'Directory' },
    { href: '/devices', label: 'Devices', icon: Laptop, group: 'Directory' },
    { href: '/insights', label: 'Insights', icon: ChartColumn, group: 'Insights' },
  ];
  if (role === 'admin') {
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

export function CountPill({ count }: { count: number }) {
  return (
    <span className={count > 0 ? 'count-pill' : 'count-pill count-pill-quiet'}>{count}</span>
  );
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
                      <Icon icon={item.icon} size={18} />
                      <span className="rail-text">{item.label}</span>
                      {typeof item.count === 'number' ? <CountPill count={item.count} /> : null}
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
