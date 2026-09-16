'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Liquid } from 'liquid-gooey';
import { Ellipsis, MessageCircle, Plus, Search, Settings, X } from 'lucide-react';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { AiMark } from '@/components/ai/AiMark';
import { Icon, type LucideIcon } from '@/components/ui/Icon';
import { IconSwap } from '@/components/ui/Motion';
import { Sheet } from '@/components/ui/Sheet';
import { useEscape, useOutsidePress } from '@/components/ui/focus';
import { useReducedMotion, useTokenValue } from '@/components/ui/media';
import { CountPill, isCurrentPath, type NavItem } from './RailNav';
import { openAssistant } from './TopBar';

/**
 * Items with a tab of their own; the rest live in the More sheet.
 *
 * In preference order. A NetRider gets the first three; an account without the
 * Work group falls through to the directory pages it does have, so the row is
 * never three empty slots.
 */
const TAB_PREFERENCE = ['/today', '/queue', '/my-tickets', '/people', '/devices'];

/**
 * Shorter names for the ones that do not fit a fifth of a phone's width.
 * Everything else uses the rail's own label.
 */
const PHONE_LABELS: Record<string, string> = {
  '/my-tickets': 'Mine',
};

function phoneLabel(item: NavItem): string {
  return PHONE_LABELS[item.href] ?? item.label;
}

/** The three hrefs this account's rail can actually fill, in rail order. */
function primaryTabs(items: NavItem[]): NavItem[] {
  const chosen: NavItem[] = [];
  for (const href of TAB_PREFERENCE) {
    const item = items.find((entry) => entry.href === href);
    if (item) chosen.push(item);
    if (chosen.length === 3) break;
  }
  return chosen;
}

function Tab({
  item,
  label,
  current,
}: {
  item: NavItem | undefined;
  label: string;
  current: boolean;
}) {
  if (!item) return <span className="bottom-tab" aria-hidden="true" />;
  return (
    <Link
      href={item.href}
      className="bottom-tab"
      aria-current={current ? 'page' : undefined}
      aria-label={typeof item.count === 'number' ? `${label}, ${item.count}` : undefined}
    >
      <span className="bottom-tab-icon">
        <Icon icon={item.icon} size={22} weight="medium" />
        {typeof item.count === 'number' && item.count > 0 ? (
          <span
            className={
              item.callToAction ? 'bottom-tab-count' : 'bottom-tab-count bottom-tab-count-quiet'
            }
            aria-hidden="true"
          >
            {item.count > 99 ? '99+' : item.count}
          </span>
        ) : null}
      </span>
      <span className="bottom-tab-label">{label}</span>
    </Link>
  );
}

interface ClusterAction {
  key: string;
  label: string;
  icon: LucideIcon;
  /*
   * A drawing that is not an icon. The assistant's action carries the orb,
   * which is its face everywhere else in the product; `icon` stays as the
   * fallback and as the type's default so nothing else has to change.
   */
  glyph?: ReactNode;
  href?: string;
  onSelect?: () => void;
}

/**
 * The lookup cluster: an accented core that opens into Search, New ticket and
 * Ask. The satellites are liquid-gooey items sharing one surface-coloured
 * silhouette, so they pour out from under the core and merge back into it.
 */
function GooeyCluster({
  open,
  onToggle,
  actions,
  onSelect,
}: {
  open: boolean;
  onToggle: () => void;
  actions: ClusterAction[];
  onSelect: () => void;
}) {
  // The library draws its shadow on the merged silhouette from box-shadow
  // syntax, so it needs the token's resolved value rather than `var()`.
  const shadow = useTokenValue('--shadow-2');

  const positions = [
    { x: -76, y: -64 },
    { x: 0, y: -92 },
    { x: 76, y: -64 },
  ];

  return (
    <div className="fab" data-open={open ? 'true' : 'false'}>
      <Liquid
        blur={6}
        contrast={18}
        fill="var(--surface)"
        shadow={shadow}
        filterPadding={40}
        className="fab-liquid"
      >
        <Liquid.Item className="fab-item fab-item-core" transition="snappy">
          <button
            type="button"
            className="fab-core"
            aria-label={open ? 'Close lookup' : 'Lookup'}
            aria-expanded={open}
            aria-haspopup="true"
            onClick={onToggle}
          >
            <IconSwap token={open ? 'close' : 'open'}>
              <Icon icon={open ? X : Search} size={24} weight="medium" />
            </IconSwap>
          </button>
        </Liquid.Item>
        {actions.map((action, index) => {
          const at = open ? positions[index] : { x: 0, y: 0 };
          const content = action.glyph ?? <Icon icon={action.icon} size={20} weight="medium" />;
          return (
            <Liquid.Item
              key={action.key}
              className="fab-item fab-item-satellite"
              x={at.x}
              y={at.y}
              transition="bouncy"
              delay={index * 40}
            >
              {action.href ? (
                <Link
                  href={action.href}
                  className="fab-satellite"
                  aria-label={action.label}
                  tabIndex={open ? 0 : -1}
                  aria-hidden={!open}
                  onClick={onSelect}
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  className="fab-satellite"
                  aria-label={action.label}
                  tabIndex={open ? 0 : -1}
                  aria-hidden={!open}
                  onClick={() => {
                    onSelect();
                    action.onSelect?.();
                  }}
                >
                  {content}
                </button>
              )}
            </Liquid.Item>
          );
        })}
      </Liquid>
      {actions.map((action, index) => (
        <span
          key={action.key}
          className="fab-label"
          aria-hidden="true"
          style={{
            left: `calc(50% + ${positions[index].x}px)`,
            bottom: `${-positions[index].y + 48 + 28}px`,
          }}
        >
          {action.label}
        </span>
      ))}
    </div>
  );
}

/** Under reduced motion: the same three actions as ordinary buttons. */
function PlainCluster({
  open,
  onToggle,
  actions,
  onSelect,
}: {
  open: boolean;
  onToggle: () => void;
  actions: ClusterAction[];
  onSelect: () => void;
}) {
  return (
    <div className="fab fab-plain" data-open={open ? 'true' : 'false'}>
      {open ? (
        <div className="fab-plain-panel">
          {actions.map((action) =>
            action.href ? (
              <Link key={action.key} href={action.href} className="menu-item" onClick={onSelect}>
                {action.glyph ?? <Icon icon={action.icon} size={16} weight="medium" />}
                <span>{action.label}</span>
              </Link>
            ) : (
              <button
                key={action.key}
                type="button"
                className="menu-item"
                onClick={() => {
                  onSelect();
                  action.onSelect?.();
                }}
              >
                {action.glyph ?? <Icon icon={action.icon} size={16} weight="medium" />}
                <span>{action.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="fab-core fab-core-plain"
        aria-label={open ? 'Close lookup' : 'Lookup'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={onToggle}
      >
        <IconSwap token={open ? 'close' : 'open'}>
          <Icon icon={open ? X : Search} size={24} weight="medium" />
        </IconSwap>
      </button>
    </div>
  );
}

/**
 * Phone navigation: two tabs, the lookup cluster, a third tab and More.
 *
 * Fixed to the bottom edge and padded for the home indicator. The More sheet
 * holds every other rail item plus Settings and Sign out, so nothing the
 * desktop rail offers is out of reach on a phone. Which three tabs are shown
 * depends on what this account's rail holds: a skills officer has no queue, so
 * their row is the directory rather than three blanks.
 */
export function BottomTabs({
  items,
  onOpenLookup,
  canCreateTickets = true,
}: {
  items: NavItem[];
  onOpenLookup: () => void;
  /** False for an account that does not work tickets, which hides intake. */
  canCreateTickets?: boolean;
}) {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [clusterOpen, setClusterOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);
  const clusterRefs = useMemo(() => [clusterRef], []);

  const closeCluster = useCallback(() => setClusterOpen(false), []);
  useEscape(clusterOpen, closeCluster);
  useOutsidePress(clusterOpen, clusterRefs, closeCluster);

  const tabs = primaryTabs(items);
  const tabHrefs = tabs.map((item) => item.href);
  const rest = items.filter((item) => !tabHrefs.includes(item.href));

  const actions: ClusterAction[] = [
    { key: 'search', label: 'Search', icon: Search, onSelect: onOpenLookup },
    ...(canCreateTickets
      ? [{ key: 'new', label: 'New ticket', icon: Plus, href: '/tickets/new' } as ClusterAction]
      : []),
    {
      key: 'ask',
      label: 'Ask',
      icon: MessageCircle,
      glyph: <AiMark size={20} />,
      onSelect: openAssistant,
    },
  ];

  const cluster: ReactNode = reduced ? (
    <PlainCluster
      open={clusterOpen}
      onToggle={() => setClusterOpen((value) => !value)}
      actions={actions}
      onSelect={closeCluster}
    />
  ) : (
    <GooeyCluster
      open={clusterOpen}
      onToggle={() => setClusterOpen((value) => !value)}
      actions={actions}
      onSelect={closeCluster}
    />
  );

  return (
    <>
      <nav className="bottom-tabs" aria-label="Primary">
        <Tab
          item={tabs[0]}
          label={tabs[0] ? phoneLabel(tabs[0]) : ''}
          current={isCurrentPath(pathname, tabs[0]?.href ?? '')}
        />
        <Tab
          item={tabs[1]}
          label={tabs[1] ? phoneLabel(tabs[1]) : ''}
          current={isCurrentPath(pathname, tabs[1]?.href ?? '')}
        />
        <div className="bottom-tab bottom-tab-cluster" ref={clusterRef}>
          {cluster}
          <span className="bottom-tab-label" aria-hidden="true">
            Lookup
          </span>
        </div>
        <Tab
          item={tabs[2]}
          label={tabs[2] ? phoneLabel(tabs[2]) : ''}
          current={isCurrentPath(pathname, tabs[2]?.href ?? '')}
        />
        <button
          type="button"
          className="bottom-tab"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <span className="bottom-tab-icon">
            <Icon icon={Ellipsis} size={22} weight="medium" />
          </span>
          <span className="bottom-tab-label">More</span>
        </button>
      </nav>

      <Sheet side="bottom" title="More" open={moreOpen} onClose={() => setMoreOpen(false)}>
        <ul className="sheet-nav">
          {rest.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="menu-item"
                aria-current={isCurrentPath(pathname, item.href) ? 'page' : undefined}
                onClick={() => setMoreOpen(false)}
              >
                <Icon icon={item.icon} size={18} weight="medium" />
                <span>{item.label}</span>
                {typeof item.count === 'number' ? (
                  <CountPill count={item.count} callToAction={item.callToAction} />
                ) : null}
              </Link>
            </li>
          ))}
          {/* No "Scan with your phone" here: that action pairs a phone to a
              desktop, and this IS the phone. Its camera scans from Lookup. */}
          <li>
            <Link href="/settings" className="menu-item" onClick={() => setMoreOpen(false)}>
              <Icon icon={Settings} size={18} weight="medium" />
              <span>Settings</span>
            </Link>
          </li>
        </ul>
        <div className="sheet-nav-foot">
          <SignOutButton />
        </div>
      </Sheet>
    </>
  );
}
