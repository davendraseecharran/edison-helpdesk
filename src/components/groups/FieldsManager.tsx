'use client';

/**
 * The columns a group ticks off against its members.
 *
 * "Permission slip", "Dues", "Polo ordered" — six at most, because each one is
 * a column on the roster table and the roster has to fit a phone. The cap is
 * the database's; this screen shows what is left rather than letting somebody
 * type a seventh and be told no.
 *
 * Order is the two arrows. A checklist is read left to right in the order the
 * things happen, and dragging is not a gesture a roster kept on a phone can
 * rely on.
 */

import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { deleteGroupFieldAction, saveGroupFieldAction } from '@/lib/data/group-actions';
import type { GroupField } from '@/lib/data/groups';
import { GROUP_FIELD_LIMIT, GROUP_FIELD_NAME_MAX } from '@/lib/domain/groups';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export function FieldsManager({
  open,
  onClose,
  groupId,
  fields,
}: {
  open: boolean;
  onClose: () => void;
  groupId: string;
  fields: GroupField[];
}) {
  const { pendingKey, run } = useRuntime();
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = pendingKey !== null;
  const room = GROUP_FIELD_LIMIT - fields.length;

  async function add(form: FormEvent<HTMLFormElement>) {
    form.preventDefault();
    const name = adding.trim();
    if (name === '') {
      setError('Give the column a name.');
      return;
    }
    setError(null);
    const result = await run(
      'group:field:add',
      () => saveGroupFieldAction(groupId, { name, position: fields.length }),
      { inlineError: true },
    );
    if (result.ok) setAdding('');
    else setError(result.error ?? 'That did not go through. Nothing changed.');
  }

  async function rename(field: GroupField, name: string) {
    const next = name.trim();
    if (next === '' || next === field.name) return;
    const result = await run(
      `group:field:${field.id}`,
      () => saveGroupFieldAction(groupId, { id: field.id, name: next, position: field.position }),
      { inlineError: true },
    );
    if (!result.ok) setError(result.error ?? 'That name could not be saved.');
  }

  /**
   * Moving one column is moving two: the pair swaps positions, and both are
   * written, so the order on screen is the order stored rather than an
   * arrangement that survives only until the next read.
   */
  async function move(at: number, by: -1 | 1) {
    const other = at + by;
    if (other < 0 || other >= fields.length) return;
    const one = fields[at];
    const two = fields[other];
    await run(`group:field:${one.id}`, async () => {
      const first = await saveGroupFieldAction(groupId, {
        id: one.id,
        name: one.name,
        position: other,
      });
      if (!first.ok) return first;
      return saveGroupFieldAction(groupId, { id: two.id, name: two.name, position: at });
    });
  }

  async function remove(field: GroupField) {
    await run(`group:field:${field.id}`, () => deleteGroupFieldAction(field.id));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Checklist columns"
      description="Up to six things to tick off against each member."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {fields.length === 0 ? (
        <p className="muted">
          No columns yet. Add one and it becomes a tick box beside every member.
        </p>
      ) : (
        <ul className="field-rows">
          {fields.map((field, at) => (
            <li key={field.id} className="field-row">
              <input
                className="field-row-name"
                defaultValue={field.name}
                maxLength={GROUP_FIELD_NAME_MAX}
                aria-label={`Name of the ${field.name} column`}
                disabled={busy}
                onBlur={(box) => void rename(field, box.target.value)}
                onKeyDown={(box) => {
                  if (box.key === 'Enter') {
                    box.preventDefault();
                    box.currentTarget.blur();
                  }
                }}
              />
              <span className="field-row-count">
                {field.checkedCount > 0 ? `${field.checkedCount} ticked` : 'none ticked'}
              </span>
              <span className="field-row-actions">
                <Button
                  size="sm"
                  icon={ArrowUp}
                  aria-label={`Move ${field.name} up`}
                  disabled={busy || at === 0}
                  onClick={() => void move(at, -1)}
                />
                <Button
                  size="sm"
                  icon={ArrowDown}
                  aria-label={`Move ${field.name} down`}
                  disabled={busy || at === fields.length - 1}
                  onClick={() => void move(at, 1)}
                />
                <Button
                  size="sm"
                  icon={X}
                  aria-label={`Remove the ${field.name} column`}
                  title="Remove the column and every tick on it"
                  disabled={busy}
                  onClick={() => void remove(field)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <form className="form field-add" onSubmit={add} noValidate>
        <Field
          label="New column"
          htmlFor="group-field-name"
          hint={
            room > 0
              ? `${room} of ${GROUP_FIELD_LIMIT} left.`
              : 'Six is the limit. Remove one to add another.'
          }
          error={error}
        >
          <input
            id="group-field-name"
            value={adding}
            maxLength={GROUP_FIELD_NAME_MAX}
            autoComplete="off"
            placeholder="Permission slip"
            disabled={busy || room <= 0}
            onChange={(box) => setAdding(box.target.value)}
          />
        </Field>
        <Button
          type="submit"
          icon={Plus}
          loading={pendingKey === 'group:field:add'}
          disabled={busy || room <= 0}
        >
          Add column
        </Button>
      </form>
    </Dialog>
  );
}
