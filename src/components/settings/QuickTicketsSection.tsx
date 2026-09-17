'use client';

/**
 * Quick tickets: the calls that repeat all day, one tap each.
 *
 * Three of every ten walk-ins at this desk are the same three calls, and until
 * now each one was typed out again every time. A quick ticket is the part of
 * one of those calls that never changes — the title, the sentence, the
 * category, the priority, sometimes the room — written down once by whoever is
 * at the desk when it changes.
 *
 * It is the second thing on this screen that is not private to the reader, and
 * for the same reason the shared assistant notes are not: the three calls are
 * the school's, not one NetRider's, and a list each person had to write for
 * themselves would be written by one of them and by nobody else. So any ticket
 * worker may add, edit, reorder and delete any row, and the database enforces
 * exactly that — the section is only rendered for somebody who works tickets
 * because offering a form that ends in a refusal is worse than offering
 * nothing.
 *
 * Ordering has buttons rather than a drag. A drag is the right gesture for a
 * long list somebody is arranging; this one is at most twelve rows, moved once
 * a term, and a button works with a keyboard, a screen reader and a finger
 * without any of the three being a special case.
 */

import { useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import {
  deleteTicketPresetAction,
  moveTicketPresetAction,
  saveTicketPresetAction,
} from '@/lib/data/ticket-preset-actions';
import {
  orderPresets,
  presetError,
  PRESET_ISSUE_MAX,
  PRESET_LOCATION_MAX,
  PRESET_NAME_MAX,
  PRESET_TITLE_MAX,
  TICKET_PRESET_CAP,
  type TicketPreset,
} from '@/lib/domain/ticket-presets';
import { refreshTicketPresets } from '@/lib/presets/store';
import { PRIORITY_LABELS, type Priority } from '@/lib/domain/types';
import { SettingsSection } from './parts';

/** What the form holds while it is being typed. Strings, because a field is text. */
interface PresetDraft {
  name: string;
  title: string;
  issue: string;
  category: string;
  priority: string;
  location: string;
}

const EMPTY_DRAFT: PresetDraft = {
  name: '',
  title: '',
  issue: '',
  category: 'other',
  priority: 'normal',
  location: '',
};

const PRIORITY_OPTIONS = (Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => ({
  value,
  label: PRIORITY_LABELS[value],
}));

function draftOf(preset: TicketPreset): PresetDraft {
  return {
    name: preset.name,
    title: preset.title,
    issue: preset.issue,
    category: preset.category,
    priority: preset.priority,
    location: preset.location,
  };
}

/**
 * One quick ticket, written or corrected.
 *
 * The same form for both, because the fields are the same and a screen with an
 * "add" form and a separate "edit" form is a screen with two places for the
 * same mistake to be fixed. What is refused is shown at the foot of the form
 * rather than as a toast: it is about what was typed, and the toast would leave
 * five seconds later while the fields stayed as they are.
 */
function PresetForm({
  preset,
  categoryLabels,
  onSave,
  onCancel,
}: {
  preset: TicketPreset | null;
  categoryLabels: Record<string, string>;
  onSave: (draft: PresetDraft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { pendingKey } = useRuntime();
  const [draft, setDraft] = useState<PresetDraft>(preset ? draftOf(preset) : EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const titleId = useId();
  const categoryId = useId();
  const priorityId = useId();
  const issueId = useId();
  const locationId = useId();

  const saving = pendingKey === `preset-save:${preset?.id ?? 'new'}`;
  const categoryOptions = Object.entries(categoryLabels).map(([value, label]) => ({
    value,
    label,
  }));

  function set(patch: Partial<PresetDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  }

  async function submit(): Promise<void> {
    if (saving) return;
    const invalid = presetError({
      name: draft.name,
      title: draft.title,
      issue: draft.issue,
      category: draft.category as TicketPreset['category'],
      priority: draft.priority as Priority,
      location: draft.location,
    });
    if (invalid) {
      setError(invalid);
      return;
    }
    const saved = await onSave(draft);
    if (!saved) setError('That did not go through. Nothing changed. Try again.');
  }

  return (
    <form
      className="preset-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="form-grid preset-fields">
        <Field label="Name" htmlFor={nameId} hint="What the menu row says.">
          <input
            id={nameId}
            type="text"
            value={draft.name}
            maxLength={PRESET_NAME_MAX}
            autoFocus
            placeholder="Projector"
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>
        <Field label="Title" htmlFor={titleId} hint="What the ticket's title starts as.">
          <input
            id={titleId}
            type="text"
            value={draft.title}
            maxLength={PRESET_TITLE_MAX}
            placeholder="Projector will not display"
            onChange={(event) => set({ title: event.target.value })}
          />
        </Field>
        <Field label="Category" htmlFor={categoryId}>
          <Select
            id={categoryId}
            value={draft.category}
            options={categoryOptions}
            onChange={(value) => set({ category: value })}
          />
        </Field>
        <Field label="Priority" htmlFor={priorityId}>
          <Select
            id={priorityId}
            value={draft.priority}
            options={PRIORITY_OPTIONS}
            onChange={(value) => set({ priority: value })}
          />
        </Field>
        <Field
          label="Issue"
          htmlFor={issueId}
          optional
          className="form-grid-full"
          hint="The sentence this call always starts from."
        >
          <textarea
            id={issueId}
            rows={3}
            value={draft.issue}
            maxLength={PRESET_ISSUE_MAX}
            onChange={(event) => set({ issue: event.target.value })}
          />
        </Field>
        <Field label="Location" htmlFor={locationId} optional hint="Leave blank if it varies.">
          <input
            id={locationId}
            type="text"
            value={draft.location}
            maxLength={PRESET_LOCATION_MAX}
            placeholder="Room 212"
            onChange={(event) => set({ location: event.target.value })}
          />
        </Field>
      </div>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {preset ? 'Save' : 'Add quick ticket'}
        </Button>
        <Button size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One row at rest: what it is called, what it files, and what can be done to it. */
function PresetRow({
  preset,
  categoryLabels,
  first,
  last,
  busy,
  moving,
  onMove,
  onEdit,
  onDelete,
}: {
  preset: TicketPreset;
  categoryLabels: Record<string, string>;
  first: boolean;
  last: boolean;
  busy: boolean;
  moving: boolean;
  onMove: (direction: 'up' | 'down') => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const category = categoryLabels[preset.category] ?? preset.category;
  const priority = PRIORITY_LABELS[preset.priority].toLowerCase();

  return (
    <div className="setting-row preset-row">
      <div className="setting-row-text">
        <span className="setting-row-label">{preset.name}</span>
        <span className="setting-row-hint">{preset.title}</span>
        <span className="preset-meta">
          {category}, {priority} priority
        </span>
      </div>
      <div className="setting-row-control preset-actions">
        <Button
          variant="ghost"
          size="sm"
          icon={ChevronUp}
          aria-label={`Move ${preset.name} up`}
          disabled={first || busy}
          loading={moving}
          onClick={() => onMove('up')}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={ChevronDown}
          aria-label={`Move ${preset.name} down`}
          disabled={last || busy}
          onClick={() => onMove('down')}
        />
        <Button size="sm" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
        {/*
          * Quiet, because there is one of these on every row and a column of
          * red outlines reads as a screen of warnings rather than a list. The
          * tone arrives under the pointer; the dialog it opens carries the
          * destructive button.
          */}
        <Button
          variant="ghost"
          size="sm"
          className="btn-danger-quiet"
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

export function QuickTicketsSection({
  presets,
  categoryLabels,
}: {
  presets: TicketPreset[];
  /** The vocabulary as `app_category_labels()` gives it, so the select offers exactly what saves. */
  categoryLabels: Record<string, string>;
}) {
  const { pendingKey, run } = useRuntime();
  const ordered = useMemo(() => orderPresets(presets), [presets]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<TicketPreset | null>(null);

  const busy = pendingKey !== null;
  const full = ordered.length >= TICKET_PRESET_CAP;

  /**
   * Every write refreshes the browser's own copy as well as the server's: the
   * top bar's menu and the palette read from a cache that no server render
   * reaches, and a preset added here should be in the menu without a reload.
   */
  async function save(id: string | null, draft: PresetDraft): Promise<boolean> {
    const result = await run(
      `preset-save:${id ?? 'new'}`,
      () => saveTicketPresetAction({ id, ...draft }),
      { inlineError: true },
    );
    if (result.ok) refreshTicketPresets();
    return result.ok;
  }

  async function move(id: string, direction: 'up' | 'down'): Promise<void> {
    const result = await run(`preset-move:${id}`, () => moveTicketPresetAction(id, direction));
    if (result.ok) refreshTicketPresets();
  }

  async function remove(preset: TicketPreset): Promise<void> {
    const result = await run(`preset-delete:${preset.id}`, () =>
      deleteTicketPresetAction(preset.id),
    );
    if (result.ok) {
      refreshTicketPresets();
      setDeleting(null);
    }
  }

  return (
    <SettingsSection
      id="quick-tickets"
      title="Quick tickets"
      description="The calls that repeat all day, one tap each. Shared by the whole desk."
    >
      {ordered.length === 0 && !adding ? (
        <p className="setting-note-aside preset-empty">
          Nothing here yet. Write down a call you take every week.
        </p>
      ) : null}

      {ordered.map((preset, index) =>
        editing === preset.id ? (
          <PresetForm
            key={preset.id}
            preset={preset}
            categoryLabels={categoryLabels}
            onCancel={() => setEditing(null)}
            onSave={async (draft) => {
              const saved = await save(preset.id, draft);
              if (saved) setEditing(null);
              return saved;
            }}
          />
        ) : (
          <PresetRow
            key={preset.id}
            preset={preset}
            categoryLabels={categoryLabels}
            first={index === 0}
            last={index === ordered.length - 1}
            busy={busy}
            moving={pendingKey === `preset-move:${preset.id}`}
            onMove={(direction) => void move(preset.id, direction)}
            onEdit={() => {
              setAdding(false);
              setEditing(preset.id);
            }}
            onDelete={() => setDeleting(preset)}
          />
        ),
      )}

      {adding ? (
        <PresetForm
          preset={null}
          categoryLabels={categoryLabels}
          onCancel={() => setAdding(false)}
          onSave={async (draft) => {
            const saved = await save(null, draft);
            if (saved) setAdding(false);
            return saved;
          }}
        />
      ) : (
        <div className="setting-row preset-add">
          <div className="setting-row-text">
            <span className="setting-row-label">Add a quick ticket</span>
            <span className="setting-row-hint">
              {full
                ? 'Twelve is the limit. Delete one to make room.'
                : 'A name, a title, and what the call usually is.'}
            </span>
          </div>
          <div className="setting-row-control">
            <Button
              size="sm"
              icon={Plus}
              disabled={busy || full}
              onClick={() => {
                setEditing(null);
                setAdding(true);
              }}
            >
              Add quick ticket
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this quick ticket?"
        description={
          deleting
            ? `${deleting.name} goes from the menu and from the palette for everybody at the desk. Tickets already filed from it are untouched.`
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={deleting !== null && pendingKey === `preset-delete:${deleting.id}`}
              onClick={() => {
                if (deleting) void remove(deleting);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="muted">Anybody at the desk can write it again.</p>
      </Dialog>
    </SettingsSection>
  );
}
