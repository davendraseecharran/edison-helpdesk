'use client';

/**
 * Application chrome for authenticated users.
 *
 * The M1 demo banner, identity switcher and "Reset demo data" control are gone:
 * this shell only ever renders for a verified, active account, and the only
 * identity control is a real sign-out.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { Avatar, Flash } from '@/components/Primitives';
import { SignOutButton } from '@/components/auth/SignOutButton';
import type { QueueCounts } from '@/lib/data/tickets';

interface NavItem {
  href: string;
  label: string;
  count?: number;
}

export function AppShell({ counts, children }: { counts: QueueCounts; children: ReactNode }) {
  const { actor } = useRuntime();
  const pathname = usePathname();
  const admin = actor.role === 'admin';

  const workItems: NavItem[] = [
    { href: '/queue', label: 'Open Queue', count: counts.openQueue },
    { href: '/my-tickets', label: 'My Tickets', count: counts.myTickets },
    { href: '/collaborating', label: 'Collaborating', count: counts.collaborating },
    { href: '/resolved', label: 'Resolved', count: counts.closed },
  ];

  const adminItems: NavItem[] = [
    { href: '/all-tickets', label: 'All Tickets', count: counts.all },
    { href: '/admin', label: 'Administration' },
  ];

  function navLink(item: NavItem) {
    const current = pathname === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        className="nav-link"
        aria-current={current ? 'page' : undefined}
      >
        <span>{item.label}</span>
        {typeof item.count === 'number' ? <span className="nav-count">{item.count}</span> : null}
      </Link>
    );
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="topbar">
        <Link href="/queue" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ED
          </span>
          <span>Edison Helpdesk</span>
        </Link>
        <div className="topbar-actions">
          <Link href="/tickets/new" className="btn btn-primary btn-sm">
            New ticket
          </Link>
          <span className="actor-chip">
            <Avatar name={actor.displayName} />
            <span className="actor-chip-text">
              <span className="actor-chip-name">{actor.displayName}</span>
              <span className="actor-chip-role">{admin ? 'Administrator' : 'Technician'}</span>
            </span>
          </span>
          <SignOutButton />
        </div>
      </header>

      <div className="shell-body">
        <nav className="sidebar" aria-label="Primary">
          <div className="nav-group">
            <p className="nav-label">Work</p>
            {workItems.map(navLink)}
          </div>
          {admin ? (
            <div className="nav-group">
              <p className="nav-label">Admin</p>
              {adminItems.map(navLink)}
            </div>
          ) : null}
        </nav>

        <main className="main" id="main-content">
          <Flash />
          {children}
        </main>
      </div>
    </div>
  );
}
