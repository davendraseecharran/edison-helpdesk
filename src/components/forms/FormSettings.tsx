'use client';

/**
 * What a form does besides ask questions: when it takes answers, how many,
 * from whom, and what a matched answer does to a roster.
 *
 * One card of rows, like Settings, and one Save: these are decided together
 * ("the trip roster, closing Friday, 40 places") and a half-saved set of them
 * would be a form that opened to the wrong people.
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import {
  deleteFormAction,
  groupEventsAction,
  saveFormSettingsAction,
} from '@/lib/data/form-actions';
import { FORM_CAP_MAX, type EventChoice, type FormAudience } from '@/lib/domain/forms';
import { formatDateKey } from '@/lib/format';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/shadcn/switch';
import '@/styles/settings.css';
import '@/styles/forms.css';

export interface FormSettingsData {
  id: string;
  title: string;
  isOpen: boolean;
  closesAt: string | null;
  responseCap: number | null;
  audience: FormAudience;
  groupId: string | null;
  eventId: string | null;
  shared: boolean;
  canOwn: boolean;
  responseCount: number;
}

/** An instant as the value a `datetime-local` field takes, in this browser's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function FormSettings({
  form,
  groups,
  initialEvents,
}: {
  form: FormSettingsData;
  groups: Array<{ id: string; name: string }>;
  initialEvents: EventChoice[];
}) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(form.isOpen);
  const [closesAt, setClosesAt] = useState(toLocalInput(form.closesAt));
  const [cap, setCap] = useState(form.responseCap === null ? '' : String(form.responseCap));
  const [audience, setAudience] = useState<FormAudience>(form.audience);
  const [groupId, setGroupId] = useState(form.groupId ?? '');
  const [eventId, setEventId] = useState(form.eventId ?? '');
  const [events, setEvents] = useState<EventChoice[]>(initialEvents);
  const [shared, setShared] = useState(form.shared);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const saving = pendingKey === 'form:settings';

  async function chooseGroup(next: string) {
    setGroupId(next);
    setEventId('');
    setEvents([]);
    if (next !== '') setEvents(await groupEventsAction(next));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedCap = cap.trim();
    const capValue = trimmedCap === '' ? null : Number(trimmedCap);
    if (capValue !== null && (!Number.isInteger(capValue) || capValue < 1 || capValue > FORM_CAP_MAX)) {
      setError(`A response limit is a whole number from 1 to ${FORM_CAP_MAX.toLocaleString('en-US')}.`);
      return;
    }
    let closes: string | null = null;
    if (closesAt !== '') {
      const parsed = new Date(closesAt);
      if (Number.isNaN(parsed.getTime())) {
        setError('Choose a real closing date and time.');
        return;
      }
      closes = parsed.toISOString();
    }
    setError(null);
    const result = await run(
      'form:settings',
      () =>
        saveFormSettingsAction(form.id, {
          isOpen,
          closesAt: closes,
          responseCap: capValue,
          audience,
          groupId: groupId || null,
          eventId: eventId || null,
          shared,
        }),
      { inlineError: true },
    );
    if (!result.ok) setError(result.error ?? 'That did not save. Nothing changed.');
  }

  const eventOptions = [
    { value: '', label: groupId === '' ? 'Choose a group first' : 'No event' },
    ...events.map((entry) => ({ value: entry.id, label: `${entry.name}, ${formatDateKey(entry.heldOn)}` })),
  ];

  return (
    <form className="settings form-settings" onSubmit={submit} noValidate>
      <div className="settings-sections">
        <section className="settings-section" aria-labelledby="fs-taking">
          <div className="settings-section-head">
            <h2 className="settings-section-title" id="fs-taking">
              Taking responses
            </h2>
            <p className="settings-section-note">
              A closed form shows its link as closed. A form past its closing time or its limit
              closes by itself.
            </p>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-row-text">
                <label className="setting-row-label" htmlFor="fs-open">
                  Accepting responses
                </label>
                <span className="setting-row-hint">Turn it off to close the form now.</span>
              </div>
              <Switch id="fs-open" checked={isOpen} onCheckedChange={setIsOpen} />
            </div>
            <div className="setting-row">
              <div className="setting-row-text">
                <label className="setting-row-label" htmlFor="fs-closes">
                  Closes at
                </label>
                <span className="setting-row-hint">Leave it empty to keep the form open until you close it.</span>
              </div>
              <div className="fs-control">
                <input
                  id="fs-closes"
                  type="datetime-local"
                  className="fs-datetime"
                  value={closesAt}
                  onChange={(event) => setClosesAt(event.target.value)}
                />
                {closesAt !== '' ? (
                  <Button size="sm" variant="ghost" onClick={() => setClosesAt('')}>
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row-text">
                <label className="setting-row-label" htmlFor="fs-cap">
                  Response limit
                </label>
                <span className="setting-row-hint">
                  For a trip with a set number of places. Somebody correcting their answers does not
                  take a second place.
                </span>
              </div>
              <input
                id="fs-cap"
                type="text"
                inputMode="numeric"
                className="fs-cap"
                placeholder="No limit"
                value={cap}
                maxLength={5}
                onChange={(event) => setCap(event.target.value.replace(/[^\d]/g, ''))}
              />
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="fs-who">
          <div className="settings-section-head">
            <h2 className="settings-section-title" id="fs-who">
              Who can answer
            </h2>
            <p className="settings-section-note">
              People in the directory confirm their school email and OSIS or staff ID, both on the
              same record, and see their details filled in. Anyone with the link answers without
              saying who they are, and their answers are not matched to anybody.
            </p>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <SegmentedControl<FormAudience>
                label="Who can answer"
                value={audience}
                onChange={setAudience}
                options={[
                  { value: 'directory', label: 'People in the directory' },
                  { value: 'anyone', label: 'Anyone with the link' },
                ]}
              />
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="fs-roster">
          <div className="settings-section-head">
            <h2 className="settings-section-title" id="fs-roster">
              Roster and attendance
            </h2>
            <p className="settings-section-note">
              When somebody from the directory answers, they are added to the group, and marked
              present at the event if you choose one. Deleting a response later leaves the roster
              as it is.
            </p>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-row-text">
                <label className="setting-row-label" htmlFor="fs-group">
                  Add to group
                </label>
                <span className="setting-row-hint">The trip roster this sign-up fills.</span>
              </div>
              <Select
                id="fs-group"
                className="fs-select"
                value={groupId}
                onChange={(next) => void chooseGroup(next)}
                options={[{ value: '', label: 'No group' }, ...groups.map((group) => ({ value: group.id, label: group.name }))]}
              />
            </div>
            <div className="setting-row">
              <div className="setting-row-text">
                <label className="setting-row-label" htmlFor="fs-event">
                  Mark present at
                </label>
                <span className="setting-row-hint">For a check-in form. One of the group&rsquo;s events.</span>
              </div>
              <Select
                id="fs-event"
                className="fs-select"
                value={eventId}
                onChange={setEventId}
                options={eventOptions}
                disabled={groupId === ''}
              />
            </div>
            {audience === 'anyone' && groupId !== '' ? (
              <p className="setting-row setting-row-hint">
                Anyone-with-the-link answers are not matched to a person, so they fill the group only
                when taken at the kiosk.
              </p>
            ) : null}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="fs-share">
          <div className="settings-section-head">
            <h2 className="settings-section-title" id="fs-share">
              Who on the desk sees it
            </h2>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-row-text">
                <label className="setting-row-label" htmlFor="fs-shared">
                  Shared with the desk
                </label>
                <span className="setting-row-hint">
                  {form.canOwn
                    ? 'Everybody with an account can see and edit it and read its responses. Off, only you and administrators can.'
                    : 'Only the person who made this form can change this.'}
                </span>
              </div>
              <Switch id="fs-shared" checked={shared} onCheckedChange={setShared} disabled={!form.canOwn} />
            </div>
          </div>
        </section>

        <div className="fs-save">
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" loading={saving}>
            Save settings
          </Button>
        </div>

        {form.canOwn ? (
          <section className="settings-section" aria-labelledby="fs-delete">
            <div className="settings-section-head">
              <h2 className="settings-section-title" id="fs-delete">
                Delete this form
              </h2>
              <p className="settings-section-note">
                The form and its {form.responseCount} {form.responseCount === 1 ? 'response' : 'responses'} go.
                The people it added to a group stay there.
              </p>
            </div>
            <div>
              <Button variant="danger" icon={Trash2} onClick={() => setConfirmingDelete(true)}>
                Delete form
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={`Delete ${form.title}?`}
        description="The link stops working and every response goes with the form. This cannot be undone."
        footer={
          <>
            <Button onClick={() => setConfirmingDelete(false)} disabled={pendingKey !== null}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pendingKey === 'form:delete'}
              onClick={() =>
                void run('form:delete', () => deleteFormAction(form.id)).then((result) => {
                  if (result.ok) router.replace('/forms');
                })
              }
            >
              Delete form
            </Button>
          </>
        }
      >
        <p className="muted">
          {form.responseCount === 0
            ? 'Nobody has answered it yet.'
            : `${form.responseCount} ${form.responseCount === 1 ? 'response goes' : 'responses go'} with it.`}
        </p>
      </Dialog>
    </form>
  );
}
