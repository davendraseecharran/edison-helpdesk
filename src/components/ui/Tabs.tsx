'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface TabItem {
  href: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  /** Accessible name for the set, for example "Administration sections". */
  label: string;
}

function pathOf(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * Link tabs for the sections of one page.
 *
 * Each tab is a real link so it works with the URL, the back button and
 * middle-click. The current one is marked with `aria-current="page"` and a
 * brass underline; counts sit in a quiet pill after the label.
 */
export function Tabs({ items, label }: TabsProps) {
  const pathname = usePathname();
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => {
        const current = pathname === pathOf(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className="tab"
            aria-current={current ? 'page' : undefined}
          >
            <span>{item.label}</span>
            {typeof item.count === 'number' ? (
              <span className="count-pill count-pill-quiet">{item.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
