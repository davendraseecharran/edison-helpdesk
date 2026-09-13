'use client';

/**
 * Assistant: the ChatGPT account this helpdesk account is linked to, and how
 * the assistant behaves when it is used.
 *
 * The connection itself is made in the assistant panel, not here: linking runs
 * a device-code flow with a code to enter and a page to visit, which belongs in
 * the panel that then starts talking. This section says whether there is a
 * connection and opens that panel at the right place; the panel is what
 * finishes the job.
 *
 * The preferences below are saved whether or not an account is linked. Somebody
 * setting a machine up can choose how the assistant should behave before they
 * connect it, and the settings are already right when they do.
 */

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { AiConnectionView } from '@/lib/data/preferences';
import {
  REASONING_EFFORTS,
  REASONING_LABELS,
  type ReasoningEffort,
} from '@/lib/domain/preferences';
import { PreferenceSwitch, SettingRow, SettingsSection, useSavePreference } from './parts';

const REASONING_OPTIONS = REASONING_EFFORTS.map((value) => ({
  value,
  label: REASONING_LABELS[value],
}));

/** "plus" as ChatGPT writes it, "Plus" as a person reads it. */
function planLabel(plan: string | null): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Asks the assistant panel to open on its connection step.
 *
 * A custom event rather than a call, because the panel lives in the shell and
 * mounts itself: this section says what should happen and stays out of how.
 */
function openAssistantConnection(): void {
  window.dispatchEvent(
    new CustomEvent('edison:open-assistant', { detail: { section: 'connect' } }),
  );
}

export function AiSection({
  connection,
  reasoning,
  confirmChanges,
  speakReplies,
}: {
  connection: AiConnectionView;
  reasoning: ReasoningEffort;
  confirmChanges: boolean;
  speakReplies: boolean;
}) {
  const { busy, save } = useSavePreference();
  const [effort, setEffort] = useState<ReasoningEffort>(reasoning);

  const plan = planLabel(connection.planType);
  const status = connection.connected
    ? `Connected as ${connection.accountEmail ?? 'a ChatGPT account'}${plan ? ` — ${plan}` : ''}`
    : 'Not connected';

  // Chosen at once and put back if the save is refused, the same way the
  // switches below behave.
  async function chooseEffort(next: ReasoningEffort) {
    if (busy || next === effort) return;
    setEffort(next);
    const saved = await save('ai-reasoning', { aiReasoning: next }, 'Reasoning effort saved.');
    if (!saved) setEffort(reasoning);
  }

  return (
    <SettingsSection
      title="Assistant"
      description="The assistant works through your own ChatGPT account, and acts as you."
    >
      <SettingRow
        label="ChatGPT account"
        hint={
          <span className="connection-status" data-connected={connection.connected}>
            <span className="status-dot" aria-hidden="true" />
            {status}
          </span>
        }
      >
        <Button variant="secondary" icon={Sparkles} onClick={openAssistantConnection}>
          {connection.connected ? 'Disconnect' : 'Connect ChatGPT'}
        </Button>
      </SettingRow>

      <SettingRow label="Reasoning effort" hint="How long the assistant thinks before it answers.">
        <SegmentedControl
          label="Reasoning effort"
          value={effort}
          options={REASONING_OPTIONS}
          onChange={(next) => void chooseEffort(next)}
        />
      </SettingRow>

      <PreferenceSwitch
        field="aiConfirmChanges"
        checked={confirmChanges}
        label="Ask before making changes"
        hint="With this off the assistant makes the change and tells you what it did."
        message="Confirmation setting saved."
      />

      <PreferenceSwitch
        field="aiSpeakReplies"
        checked={speakReplies}
        label="Speak replies aloud"
        hint="Reads the assistant's answers out on this device."
        message="Speech setting saved."
      />
    </SettingsSection>
  );
}
