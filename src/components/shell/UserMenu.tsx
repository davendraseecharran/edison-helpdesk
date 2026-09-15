'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Monitor, Moon, Settings, Sun } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { rolesLabel } from '@/lib/auth/roles';
import { Avatar } from '@/components/Primitives';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Sheet } from '@/components/ui/Sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shadcn/popover';
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
          <p className="account-role">{rolesLabel(actor.roles)}</p>
        </div>
      </div>
      <Link href="/settings" className="menu-item" onClick={onNavigate}>
        <Icon icon={Settings} size={16} weight="medium" />
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
 * On phones it is a bottom sheet, because a panel pinned to the top-right
 * corner of a phone is the one place a thumb cannot reach. Everywhere else it
 * is a Radix popover under the avatar: it keeps focus, hands it back to the
 * avatar on the way out, closes on Escape or a press outside, and carries
 * `data-keyboard-owner` so the shell's shortcuts stay out of its way rather
 * than opening the palette on top of it.
 */
export function UserMenu() {
  const { actor } = useRuntime();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const trigger = (
    <button
      type="button"
      className="user-trigger"
      aria-label={`Account menu for ${actor.displayName}`}
      onClick={phone ? () => setOpen(true) : undefined}
    >
      <Avatar name={actor.displayName} />
    </button>
  );

  if (phone) {
    return (
      <>
        {trigger}
        <Sheet side="bottom" title="Account" open={open} onClose={close} hideTitle>
          <AccountPanel onNavigate={close} />
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent aria-label="Account">
        <AccountPanel onNavigate={close} />
      </PopoverContent>
    </Popover>
  );
}
