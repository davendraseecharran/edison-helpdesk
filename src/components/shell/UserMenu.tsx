'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Monitor, Moon, Settings, Sun } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Avatar } from '@/components/Primitives';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Sheet } from '@/components/ui/Sheet';
import { useEscape, useFocusTrap, useOutsidePress } from '@/components/ui/focus';
import { usePhone } from '@/components/ui/media';
import { useThemeChoice } from './ThemeProvider';
import type { ThemePreference } from './theme-script';

/** Dark first: it is what the application ships with. */
const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

function AccountPanel({ onNavigate }: { onNavigate: () => void }) {
  const { actor } = useRuntime();
  const { theme, choose } = useThemeChoice();
  return (
    <div className="account">
      <div className="account-identity">
        <Avatar name={actor.displayName} size="md" />
        <div className="account-identity-text">
          <p className="account-name">{actor.displayName}</p>
          <p className="account-role">{actor.role === 'admin' ? 'Administrator' : 'Technician'}</p>
        </div>
      </div>
      <Link href="/settings" className="menu-item" onClick={onNavigate}>
        <Icon icon={Settings} size={16} />
        <span>Settings</span>
      </Link>
      <div className="account-theme">
        <p className="account-label">Theme</p>
        <SegmentedControl
          label="Theme"
          size="sm"
          value={theme}
          options={THEME_OPTIONS}
          onChange={choose}
        />
      </div>
      <div className="account-foot">
        <SignOutButton />
      </div>
    </div>
  );
}

/**
 * The avatar in the top bar and what opens from it: who is signed in, their
 * role, Settings, the theme choice and Sign out.
 *
 * On phones it is a bottom sheet; otherwise a small panel under the avatar
 * that keeps focus until Escape, a press outside, or a choice dismisses it.
 */
export function UserMenu() {
  const { actor } = useRuntime();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);

  const close = useCallback(() => setOpen(false), []);
  const popoverOpen = open && !phone;

  useFocusTrap(panelRef, popoverOpen);
  useEscape(popoverOpen, close);
  useOutsidePress(popoverOpen, refs, close);

  return (
    <span className="menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="user-trigger"
        aria-label={`Account menu for ${actor.displayName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverOpen ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar name={actor.displayName} />
      </button>

      {popoverOpen ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Account"
          className="popover popover-end"
          tabIndex={-1}
        >
          <AccountPanel onNavigate={close} />
        </div>
      ) : null}

      {phone ? (
        <Sheet side="bottom" title="Account" open={open} onClose={close} hideTitle>
          <AccountPanel onNavigate={close} />
        </Sheet>
      ) : null}
    </span>
  );
}
