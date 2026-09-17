'use client';

/**
 * Appearance: the one visual choice there is.
 *
 * The control is the same one the account menu offers and shares its state, so
 * changing the theme here moves it there and the other way round. The choice
 * applies the instant it is made and is saved to the account rather than to the
 * browser, so it follows the reader to the next machine they sign in from.
 */

import { Monitor, Moon, Sun } from 'lucide-react';
import { useThemeChoice } from '@/components/shell/ThemeProvider';
import type { ThemePreference } from '@/components/shell/theme-script';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { GMAIL_MODES, type GmailMode } from '@/lib/domain/preferences';
import { SettingRow, SettingsSection, useSavePreference } from './parts';

/** Dark first: it is what the application ships with. */
const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

const GMAIL_OPTIONS: { value: GmailMode; label: string }[] = [
  { value: 'to', label: 'To' },
  { value: 'cc', label: 'CC' },
  { value: 'bcc', label: 'BCC' },
];

export function AppearanceSection({ gmailMode = 'to' }: { gmailMode?: GmailMode }) {
  const { theme, choose } = useThemeChoice();
  const { save } = useSavePreference();

  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      description="How the helpdesk looks, on every device you sign in from."
    >
      <SettingRow
        label="Theme"
        hint="System follows the setting on this computer."
      >
        <SegmentedControl label="Theme" value={theme} options={THEME_OPTIONS} onChange={choose} />
      </SettingRow>
      <SettingRow
        label="Gmail links"
        hint="Where a list of people lands when you open it in Gmail. To writes to them; CC and BCC copy them."
      >
        <SegmentedControl
          label="Gmail links"
          value={GMAIL_MODES.includes(gmailMode) ? gmailMode : 'to'}
          options={GMAIL_OPTIONS}
          onChange={(next) => void save('gmail-mode', { gmailMode: next }, 'Gmail links saved.')}
        />
      </SettingRow>
    </SettingsSection>
  );
}
