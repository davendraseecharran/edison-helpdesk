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
 *
 * Two of them are typed rather than chosen, and they are the only settings on
 * this screen with a Save button other than the display name — for the same
 * reason: saving on every keystroke would write a row per letter. The shared
 * note is also the one thing here that is not private. Every active account
 * reads it and every active account may change it, which is deliberate: the
 * rules of the house are written by whoever is at the desk when they change,
 * not filed as an administrator's setting.
 */

import { useId, useState, type ReactNode } from 'react';
import { Plug } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { AiConnectionView, SharedAssistantNotes } from '@/lib/data/preferences';
import { updateSharedAssistantNotesAction } from '@/lib/data/preferences-actions';
import {
  ASSISTANT_NOTES_MAX,
  REASONING_CHOICES,
  REASONING_LABELS,
  type ReasoningEffort,
} from '@/lib/domain/preferences';
import { PreferenceSwitch, SettingRow, SettingsSection, useSavePreference } from './parts';

const REASONING_OPTIONS = REASONING_CHOICES.map((value) => ({
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

/**
 * One notes box, with the Save button that commits it.
 *
 * `stored` is what the database has. The box shows what is being typed; the
 * button is off until the two differ, and a save that lands makes the typed
 * value the new baseline in the trimmed form the database actually keeps, so
 * the button does not stay lit over trailing whitespace nobody stored.
 *
 * The remaining count appears only near the limit. A counter that is on from
 * the first character is noise on a box somebody will type two lines into; a
 * box that silently stops taking letters is worse.
 */
function NotesRow({
  label,
  hint,
  placeholder,
  stored,
  saving,
  onSave,
  foot,
}: {
  label: string;
  hint: string;
  placeholder: string;
  stored: string;
  saving: boolean;
  onSave: (value: string) => Promise<boolean>;
  foot?: ReactNode;
}) {
  const [value, setValue] = useState(stored);
  const [baseline, setBaseline] = useState(stored);
  const fieldId = useId();
  const hintId = useId();

  const changed = value.trim() !== baseline.trim();
  const remaining = ASSISTANT_NOTES_MAX - value.length;

  async function submit() {
    if (!changed || saving) return;
    const next = value.trim();
    const ok = await onSave(next);
    if (ok) {
      setValue(next);
      setBaseline(next);
    }
  }

  return (
    <form
      className="setting-note"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="setting-row-text">
        <label className="setting-row-label" htmlFor={fieldId}>
          {label}
        </label>
        <span className="setting-row-hint" id={hintId}>
          {hint}
        </span>
      </div>
      <textarea
        id={fieldId}
        value={value}
        rows={3}
        maxLength={ASSISTANT_NOTES_MAX}
        aria-describedby={hintId}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="setting-note-foot">
        <Button type="submit" variant="secondary" size="sm" loading={saving} disabled={!changed}>
          Save
        </Button>
        {remaining <= 80 ? (
          <span className="setting-note-aside" aria-live="polite">
            {remaining === 1 ? '1 character left' : `${remaining} characters left`}
          </span>
        ) : null}
        {foot ? <span className="setting-note-aside">{foot}</span> : null}
      </div>
    </form>
  );
}

export function AiSection({
  connection,
  reasoning,
  confirmChanges,
  speakReplies,
  notes,
  sharedNotes,
}: {
  connection: AiConnectionView;
  reasoning: ReasoningEffort;
  confirmChanges: boolean;
  speakReplies: boolean;
  notes: string;
  sharedNotes: SharedAssistantNotes;
}) {
  const { pendingKey, run } = useRuntime();
  const { savingKey, save } = useSavePreference();
  const [effort, setEffort] = useState<ReasoningEffort>(reasoning);
  const saving = savingKey === 'ai-reasoning';

  const plan = planLabel(connection.planType);
  const status = connection.connected
    ? `Connected as ${connection.accountEmail ?? 'a ChatGPT account'}${plan ? ` — ${plan}` : ''}`
    : 'Not connected';

  // Chosen at once and put back if the save is refused, the same way the
  // switches below behave.
  async function chooseEffort(next: ReasoningEffort) {
    if (saving || next === effort) return;
    setEffort(next);
    const saved = await save('ai-reasoning', { aiReasoning: next }, 'Reasoning effort saved.');
    if (!saved) setEffort(reasoning);
  }

  // The personal note goes through the ordinary preferences save; the shared
  // one has an RPC of its own, because it is not this account's row.
  async function saveNotes(value: string): Promise<boolean> {
    return save('assistant-notes', { assistantNotes: value }, 'Notes saved.');
  }

  async function saveSharedNotes(value: string): Promise<boolean> {
    const result = await run('shared-assistant-notes', async () => {
      const outcome = await updateSharedAssistantNotesAction(value);
      return outcome.ok ? { ok: true, message: 'Shared notes saved.' } : outcome;
    });
    return result.ok;
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
        <Button variant="secondary" icon={Plug} onClick={openAssistantConnection}>
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

      <NotesRow
        label="Notes for the assistant"
        hint="What the assistant should know about how you work. Shown only to your own assistant."
        placeholder="How you work, in a line or two"
        stored={notes}
        saving={savingKey === 'assistant-notes'}
        onSave={saveNotes}
      />

      <NotesRow
        label="Shared notes"
        hint="Everyone on the team can read and edit this. Keep it short: what the desk is, room names, the rules of the house."
        placeholder="What the desk is, room names, the rules of the house"
        stored={sharedNotes.body}
        saving={pendingKey === 'shared-assistant-notes'}
        onSave={saveSharedNotes}
        foot={
          sharedNotes.updatedByName && sharedNotes.updatedAt ? (
            <>
              Last edited by {sharedNotes.updatedByName},{' '}
              <TimeAgo iso={sharedNotes.updatedAt} />
            </>
          ) : (
            'Nobody has written these yet.'
          )
        }
      />

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
