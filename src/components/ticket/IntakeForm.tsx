'use client';

/**
 * Intake form for both roles.
 *
 * Admin: any channel, any owner or the queue. NetRider: walk-in only, owner
 * fixed to themselves — the controls for the other options are not rendered,
 * and `app_create_ticket` rejects them anyway rather than silently correcting
 * a forged value.
 *
 * Both may say when it happened and that it is already finished. The opened
 * moment is a quiet "Opened: Now" above the button, because almost every
 * ticket is opened now and the fast path must not grow a field; pressing it
 * picks an earlier moment. "Already resolved" opens the solution and the
 * resolved moment, and the ticket is created finished, in one call, as the
 * work of whoever logs it.
 *
 * `preset` is a quick ticket the desk wrote down once: the part of one of the
 * three calls that repeat all day which is the same every time. It seeds the
 * five fields it can — title, issue, category, priority, location — and nothing
 * else. The requester and the channel are exactly the part that is new, so they
 * are left empty for the person standing there. Every seeded field is an
 * ordinary starting value: it can be typed over, and the form validates it the
 * same way it validates something typed from scratch.
 *
 * The page around this is a server component: it reads the preset under the
 * caller's own row policy, so a preset never reaches a browser that could not
 * have listed it, and an id that names nothing is simply the empty form.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import {
  type IntakeChannel,
  type Priority,
  type TicketCategory,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
} from '@/lib/domain/types';
import { canChooseChannelAndOwner } from '@/lib/domain/permissions';
import { DuplicateWarning } from '@/components/ticket/DuplicateWarning';
import {
  IntakeSuggestions,
  SuggestedCategory,
  SuggestedPriority,
  SuggestionTabHint,
} from '@/components/ticket/IntakeSuggestions';
import { MomentPicker } from '@/components/ticket/MomentPicker';
import { MoreDetails } from '@/components/ticket/MoreDetails';
import { PasteToDraft } from '@/components/ticket/PasteToDraft';
import { addNoteAction, createTicketAction } from '@/lib/data/actions';
import { relatedNote } from '@/lib/intake/duplicates';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { ChosenPerson, PersonPicker, type PersonSearchResult } from '@/components/people/PersonPicker';
import { DevicePicker, type DeviceSearchResult } from '@/components/devices/DevicePicker';
import { Field, PageHeader } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { deviceTypeOptions } from '@/lib/domain/device-types';
import type { TicketPresetDraft } from '@/lib/domain/ticket-presets';
import { momentForSubmit } from '@/lib/domain/ticket-moments';

/** The intake form has no catalogue to read, so it offers the vocabulary itself. */
const DEVICE_TYPE_OPTIONS = deviceTypeOptions();

/**
 * Two modes, not three.
 *
 * The directory is the district's own: 3,448 students and 261 staff, each with
 * a source identifier from the roster. A requester is somebody already in it,
 * or plainly nobody. Typing a third kind of person here would make a row with
 * no identifier beside 3,709 rows that have one, and app_create_ticket refuses
 * exactly that.
 */
type RequesterMode = 'existing' | 'unknown';

const REQUESTER_MODES: { value: RequesterMode; label: string }[] = [
  { value: 'existing', label: 'Known' },
  { value: 'unknown', label: 'Unknown' },
];

interface DeviceDraft {
  key: number;
  deviceType: string;
  model: string;
  osVersion: string;
  serialNumber: string;
  assetTag: string;
  identifiersNotApplicable: boolean;
}

function emptyDevice(key: number): DeviceDraft {
  return {
    key,
    deviceType: '',
    model: '',
    osVersion: '',
    serialNumber: '',
    assetTag: '',
    identifiersNotApplicable: false,
  };
}

function IntakeSection({
  id,
  title,
  help,
  children,
}: {
  id: string;
  title: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <section className="intake-section" aria-labelledby={`${id}-heading`}>
      <div className="intake-section-text">
        <h2 id={`${id}-heading`}>{title}</h2>
        <p>{help}</p>
      </div>
      <div className="intake-section-fields">{children}</div>
    </section>
  );
}

/**
 * What the page says it is for.
 *
 * A form that opens with five fields already filled in owes the reader a
 * sentence about why, and the preset's name is that sentence. The rest of the
 * line is unchanged: what an administrator may choose here, or what a
 * NetRider's walk-in always is.
 */
function intakeDescription(isAdminIntake: boolean, preset: TicketPresetDraft | null): string {
  const role = isAdminIntake
    ? 'Quick entry for phone, email and walk-in requests. Leave the owner on the queue to let a NetRider claim it.'
    : 'Walk-ins you handle yourself. The channel is fixed to walk-in and you are recorded as the owner.';
  if (!preset) return role;
  return `Started from the quick ticket ${preset.name}. Everything here can be changed. ${role}`;
}

export function IntakeForm({ preset = null }: { preset?: TicketPresetDraft | null }) {
  const { directory, notify, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const isAdminIntake = canChooseChannelAndOwner(actor);

  /*
   * The quick ticket's five fields, as starting values and nothing more. The
   * channel stays walk-in and the requester stays empty: those are the part of
   * the call that is not the same every time.
   */
  const [title, setTitle] = useState(preset?.title ?? '');
  const [issue, setIssue] = useState(preset?.issue ?? '');
  const [channel, setChannel] = useState<IntakeChannel>('walk_in');
  const [priority, setPriority] = useState<Priority>(preset?.priority ?? 'normal');
  /* When it happened. Null is now, which is almost always the answer. */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const [alreadyResolved, setAlreadyResolved] = useState(false);
  const [solution, setSolution] = useState('');
  const [resolvedAt, setResolvedAt] = useState<string | null>(null);
  const [category, setCategory] = useState<TicketCategory>(preset?.category ?? 'other');
  const [requesterMode, setRequesterMode] = useState<RequesterMode>('existing');
  const [person, setPerson] = useState<PersonSearchResult | null>(null);
  const [location, setLocation] = useState(preset?.location ?? '');
  const [linked, setLinked] = useState<DeviceSearchResult[]>([]);
  const [ownerId, setOwnerId] = useState<string>('');
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const [devices, setDevices] = useState<DeviceDraft[]>([]);
  const [nextDeviceKey, setNextDeviceKey] = useState(1);
  const [fieldError, setFieldError] = useState<{ field?: string; error: string } | null>(null);
  /*
   * Tickets the desk said were the same issue, by number.
   *
   * Collected while the title is being typed and written as notes the moment
   * this ticket exists, because before then there is no record to write them
   * on. Nothing is written if the form is abandoned, which is the right
   * outcome: a relation to a ticket that was never recorded is not a fact.
   */
  const [relatedNumbers, setRelatedNumbers] = useState<string[]>([]);

  function relateTo(number: string) {
    setRelatedNumbers((current) =>
      current.includes(number) ? current : [...current, number],
    );
  }


  const activeAccounts = useMemo(
    () => directory.filter((account) => account.status === 'active'),
    [directory],
  );
  const collaboratorChoices = useMemo(
    () =>
      activeAccounts.filter(
        (account) => account.id !== (isAdminIntake ? ownerId : actor?.id),
      ),
    [activeAccounts, isAdminIntake, ownerId, actor?.id],
  );
  const submitting = pendingKey === 'create-ticket';

  function errorFor(field: string): string | null {
    return fieldError?.field === field ? fieldError.error : null;
  }

  function addDevice() {
    setDevices((current) => [...current, emptyDevice(nextDeviceKey)]);
    setNextDeviceKey((key) => key + 1);
  }

  function updateDevice(key: number, patch: Partial<DeviceDraft>) {
    setDevices((current) =>
      current.map((device) => (device.key === key ? { ...device, ...patch } : device)),
    );
  }

  function removeDevice(key: number) {
    setDevices((current) => current.filter((device) => device.key !== key));
  }

  function toggleCollaborator(accountId: string) {
    setCollaboratorIds((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    );
  }

  async function onSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setFieldError(null);

    // The two checks worth making before the round trip, because the answer
    // belongs beside the field rather than in a banner under the form.
    if (alreadyResolved && solution.trim().length < 5) {
      setFieldError({ field: 'solution', error: 'Write what fixed it, in a few words at least.' });
      return;
    }
    if (
      alreadyResolved &&
      openedAt !== null &&
      resolvedAt !== null &&
      Date.parse(resolvedAt) < Date.parse(openedAt)
    ) {
      setFieldError({ field: 'resolvedAt', error: 'A ticket cannot be resolved before it was opened.' });
      return;
    }

    const now = Date.now();
    const result = await run('create-ticket', () =>
      createTicketAction({
        title,
        issue,
        // A NetRider's intake is always a self-assigned walk-in. The database
        // rejects any other combination rather than correcting it.
        channel: isAdminIntake ? channel : 'walk_in',
        priority,
        submittedOn: null,
        openedAt: momentForSubmit(openedAt, now),
        solution: alreadyResolved ? solution.trim() : null,
        resolvedAt: alreadyResolved ? momentForSubmit(resolvedAt, now) : null,
        category,
        requesterId: requesterMode === 'existing' && person ? person.id : null,
        requesterUnknown: requesterMode === 'unknown',
        location,
        // Resolved at intake, it is the work of whoever logs it.
        ownerId: isAdminIntake && !alreadyResolved ? (ownerId || null) : null,
        collaboratorIds,
        devices: devices.map((device) => ({
          deviceType: device.deviceType,
          model: device.model,
          osVersion: device.osVersion,
          serialNumber: device.serialNumber,
          assetTag: device.assetTag,
          identifiersNotApplicable: device.identifiersNotApplicable,
        })),
        deviceIds: linked.map((device) => device.id),
      }),
    );

    if (result.ok && result.id) {
      // The relations, now that there is something to relate. A note that does
      // not save is reported and the ticket still opens: it exists either way,
      // and sending the desk back to a form it has already submitted would ask
      // for the ticket twice.
      for (const number of relatedNumbers) {
        const note = await addNoteAction(result.id, relatedNote(number));
        if (!note.ok) notify('error', `${number} could not be linked. Add a note on the ticket.`);
      }
      router.push(`/tickets/${result.id}`);
      return;
    }
    if (!result.ok) {
      // The database returns one message per rejected field; the ones about
      // when and how it ended go beside their control.
      const error = result.error ?? 'The ticket could not be created.';
      setFieldError({ field: fieldOfError(error), error });
    }
  }
  /*
   * What is filled in behind "More details", named on the control that hides
   * it. Closing a section that holds a typed serial number must not be the same
   * as forgetting it: the values go with the ticket either way, so the toggle
   * says what it is holding.
   */
  const moreSummary =
    [
      location.trim() === '' ? null : location.trim(),
      linked.length === 0 ? null : `${linked.length} from the inventory`,
      devices.length === 0
        ? null
        : `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`,
      collaboratorIds.length === 0
        ? null
        : `${collaboratorIds.length} ${collaboratorIds.length === 1 ? 'collaborator' : 'collaborators'}`,
    ]
      .filter((part): part is string => part !== null)
      .join(', ') || undefined;

  return (
    <div className="intake">
      <PageHeader
        title="New ticket"
        description={intakeDescription(isAdminIntake, preset)}
      />

      {/* What the sentence already said, offered back. The provider holds the
          guesses; each chip is rendered under the select it would change. */}
      <IntakeSuggestions
        title={title}
        issue={issue}
        fieldId="issue"
        category={category}
        priority={priority}
        onCategory={setCategory}
        onPriority={setPriority}
      >
        <form onSubmit={onSubmit} noValidate className="panel">
          <IntakeSection
            id="who"
            title="Who is asking"
            help="Find them in the directory, or record the request as unidentified."
          >
            <div className="form-grid">
              <div className="field form-grid-full">
                <span className="field-label">Requester</span>
                <SegmentedControl
                  label="Requester"
                  value={requesterMode}
                  options={REQUESTER_MODES}
                  onChange={setRequesterMode}
                />
                {errorFor('requester') ? (
                  <span className="field-error" role="alert">
                    {errorFor('requester')}
                  </span>
                ) : null}
              </div>

              {requesterMode === 'existing' ? (
                <div className="form-grid-full picker">
                  {person ? (
                    <ChosenPerson person={person} onChange={() => setPerson(null)} />
                  ) : (
                    /* The directory type-ahead the device screens use: grouped
                       results, keyboard walkable, announced as a combobox. It
                       searches the district's own requesters, so the person it
                       finds is the person the ticket names. */
                    <PersonPicker
                      id="person-query"
                      label="Search the directory"
                      hint="Search by name, OSIS or staff ID."
                      placeholder="Whitfield"
                      onSelect={setPerson}
                    />
                  )}
                </div>
              ) : null}

              {requesterMode === 'unknown' ? (
                <p className="panel-note form-grid-full">
                  The ticket is recorded as coming from an unidentified requester.
                </p>
              ) : null}
            </div>
          </IntakeSection>

          <IntakeSection
            id="what"
            title="What is wrong"
            help="A short title for the queue, then the issue in the requester's own words."
          >
            <div className="form-grid">
              {/* Half the walk-ins arrive as forwarded mail. Reading it is one
                  press; retyping it into four fields is the most mechanical
                  thing anybody does at this desk. */}
              <div className="form-grid-full">
                <PasteToDraft
                  onApply={(draft) => {
                    if (draft.title) setTitle(draft.title);
                    if (draft.issue) setIssue(draft.issue);
                    if (draft.category) setCategory(draft.category);
                    if (draft.priority) setPriority(draft.priority);
                  }}
                />
              </div>
              <Field
                label="Title"
                htmlFor="title"
                error={errorFor('title')}
                className="form-grid-full"
              >
                <input
                  id="title"
                  type="text"
                  value={title}
                  aria-invalid={errorFor('title') ? 'true' : undefined}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Projector in Room 212 will not display"
                />
              </Field>
              <Field label="Category" htmlFor="category" hint="Used to filter the queue.">
                <Select
                  id="category"
                  value={category}
                  onChange={(value) => setCategory(value as TicketCategory)}
                  options={TICKET_CATEGORIES.map((value) => ({
                    value,
                    label: TICKET_CATEGORY_LABELS[value],
                  }))}
                />
                <SuggestedCategory />
              </Field>
              <Field
                label="Issue"
                htmlFor="issue"
                error={errorFor('issue')}
                className="form-grid-full"
              >
                <textarea
                  id="issue"
                  value={issue}
                  aria-invalid={errorFor('issue') ? 'true' : undefined}
                  onChange={(event) => setIssue(event.target.value)}
                  rows={4}
                />
                <SuggestionTabHint />
              </Field>
              <div className="form-grid-full">
                <DuplicateWarning
                  title={title}
                  location={location}
                  related={relatedNumbers}
                  onRelate={relateTo}
                />
              </div>
            </div>
          </IntakeSection>

          <IntakeSection
            id="priority"
            title="Priority and channel"
            help="How urgent it is, how it came in, and who owns it."
          >
            <div className="form-grid">
              <Field label="Priority" htmlFor="priority">
                <Select
                  id="priority"
                  value={priority}
                  onChange={(value) => setPriority(value as Priority)}
                  options={(Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => ({
                    value,
                    label: PRIORITY_LABELS[value],
                  }))}
                />
                <SuggestedPriority />
              </Field>

              {isAdminIntake ? (
                <Field label="Channel" htmlFor="channel" error={errorFor('channel')}>
                  <Select
                    id="channel"
                    value={channel}
                    onChange={(value) => setChannel(value as IntakeChannel)}
                    options={(Object.keys(CHANNEL_LABELS) as IntakeChannel[]).map((value) => ({
                      value,
                      label: CHANNEL_LABELS[value],
                    }))}
                  />
                </Field>
              ) : (
                <Field
                  label="Channel"
                  htmlFor="channel-fixed"
                  hint="NetRider intake is walk-in only."
                >
                  <input id="channel-fixed" type="text" value="Walk-in" readOnly disabled />
                </Field>
              )}

              {isAdminIntake ? (
                <Field
                  label="Owner"
                  htmlFor="owner"
                  error={errorFor('ownerId')}
                  hint={
                    alreadyResolved
                      ? 'Resolved at intake, so it is yours.'
                      : 'Leave on the queue so any NetRider can claim it.'
                  }
                >
                  <Select
                    id="owner"
                    disabled={alreadyResolved}
                    value={alreadyResolved ? (actor?.id ?? '') : ownerId}
                    onChange={(value) => {
                      setOwnerId(value);
                      setCollaboratorIds((current) => current.filter((id) => id !== value));
                    }}
                    options={[
                      { value: '', label: 'Queue, unassigned' },
                      ...activeAccounts.map((account) => ({
                        value: account.id,
                        label:
                          account.role === 'admin'
                            ? `${account.displayName} (administrator)`
                            : account.displayName,
                      })),
                    ]}
                  />
                </Field>
              ) : (
                <Field
                  label="Owner"
                  htmlFor="owner-fixed"
                  hint="A NetRider's walk-in is always assigned to themselves."
                >
                  <input
                    id="owner-fixed"
                    type="text"
                    value={actor?.displayName ?? ''}
                    readOnly
                    disabled
                  />
                </Field>
              )}
            </div>
          </IntakeSection>

          {/*
            Everything above is every ticket. Everything below is some tickets:
            the room, the machines, a serial, a date that is not today, a second
            pair of hands. A phone call is a title, a requester and a sentence,
            and it should not have to scroll past nine fields it will leave
            empty to reach the button.
          */}
          <MoreDetails accountId={actor?.id ?? 'anonymous'} summary={moreSummary}>
            <IntakeSection id="where" title="Where" help="The room or area the problem is in.">
              <div className="form-grid">
                <Field label="Location" htmlFor="location" optional hint="Leave blank if unknown.">
                  <input
                    id="location"
                    type="text"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="Room 212"
                  />
                </Field>
              </div>
            </IntakeSection>

            <IntakeSection
              id="linked"
              title="Inventory"
              help="Name the machines from the inventory this ticket is about, so the ticket shows in their history."
            >
              <div className="stack-sm">
                {linked.length === 0 ? (
                  <p className="panel-note">
                    No machine from the inventory is named yet. A room-wide fault may legitimately
                    have none.
                  </p>
                ) : (
                  <ul className="linked-devices">
                    {linked.map((device) => (
                      <li className="linked-device" key={device.id}>
                        <span className="person-text">
                          <span className="person-name mono">{device.label}</span>
                          <span className="person-meta">
                            {device.type}
                            {device.model ? `, ${device.model}` : ''}
                          </span>
                        </span>
                        <span className="person-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setLinked((current) =>
                                current.filter((one) => one.id !== device.id),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <DevicePicker
                  id="intake-link-device"
                  label="Find a machine"
                  scan
                  onSelect={(device) =>
                    setLinked((current) =>
                      current.some((one) => one.id === device.id) ? current : [...current, device],
                    )
                  }
                  excludeIds={linked.map((device) => device.id)}
                  excludeNote="already named"
                />
              </div>
            </IntakeSection>

            <IntakeSection
              id="device"
              title="Device"
              help="Optional. Record what you can see now; serials and asset tags can be filled in later."
            >
              <div className="stack-sm">
                {devices.length === 0 ? (
                  <p className="panel-note">
                    Device details can be added while working. A room-wide fault may have no device
                    at all.
                  </p>
                ) : (
                  devices.map((device, index) => (
                    <fieldset key={device.key} className="draft">
                      <legend>Device {index + 1}</legend>
                      <div className="form-grid">
                        <Field
                          label="Device type"
                          htmlFor={`device-type-${device.key}`}
                          error={errorFor('deviceType')}
                        >
                          <input
                            id={`device-type-${device.key}`}
                            type="text"
                            list="device-type-options"
                            value={device.deviceType}
                            onChange={(event) =>
                              updateDevice(device.key, { deviceType: event.target.value })
                            }
                            placeholder="Laptop"
                          />
                        </Field>
                        <Field
                          label="Manufacturer and model"
                          htmlFor={`device-model-${device.key}`}
                          optional
                        >
                          <input
                            id={`device-model-${device.key}`}
                            type="text"
                            value={device.model ?? ''}
                            onChange={(event) =>
                              updateDevice(device.key, { model: event.target.value })
                            }
                            placeholder="Dell Latitude 3440"
                          />
                        </Field>
                        <Field label="OS or firmware" htmlFor={`device-os-${device.key}`} optional>
                          <input
                            id={`device-os-${device.key}`}
                            type="text"
                            value={device.osVersion ?? ''}
                            onChange={(event) =>
                              updateDevice(device.key, { osVersion: event.target.value })
                            }
                            placeholder="Windows 11 23H2"
                          />
                        </Field>
                        <Field
                          label="Serial number"
                          htmlFor={`device-serial-${device.key}`}
                          optional
                          hint="Leave blank when unknown."
                        >
                          <input
                            id={`device-serial-${device.key}`}
                            type="text"
                            className="mono"
                            value={device.serialNumber ?? ''}
                            disabled={device.identifiersNotApplicable}
                            onChange={(event) =>
                              updateDevice(device.key, { serialNumber: event.target.value })
                            }
                          />
                        </Field>
                        <Field label="Asset tag" htmlFor={`device-asset-${device.key}`} optional>
                          <input
                            id={`device-asset-${device.key}`}
                            type="text"
                            className="mono"
                            value={device.assetTag ?? ''}
                            disabled={device.identifiersNotApplicable}
                            onChange={(event) =>
                              updateDevice(device.key, { assetTag: event.target.value })
                            }
                          />
                        </Field>
                        <div className="field">
                          <span className="field-label">Identifiers</span>
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={device.identifiersNotApplicable === true}
                              onChange={(event) =>
                                updateDevice(device.key, {
                                  identifiersNotApplicable: event.target.checked,
                                })
                              }
                            />
                            <span className="check-text">Serial and asset tag not applicable</span>
                          </label>
                        </div>
                        <div className="form-grid-full">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeDevice(device.key)}
                          >
                            Remove device {index + 1}
                          </Button>
                        </div>
                      </div>
                    </fieldset>
                  ))
                )}
                <div className="form-actions">
                  <Button size="sm" icon={Plus} onClick={addDevice}>
                    Add device
                  </Button>
                </div>
                <datalist id="device-type-options">
                  {DEVICE_TYPE_OPTIONS.map((suggestion) => (
                    <option key={suggestion} value={suggestion} />
                  ))}
                </datalist>
              </div>
            </IntakeSection>

            <IntakeSection
              id="when"
              title="Collaborators"
              help="Anyone else working on it."
            >
              <div className="form-grid">
                <fieldset className="field-group form-grid-full">
                  <legend>
                    Collaborators <span className="field-optional">optional</span>
                  </legend>
                  {collaboratorChoices.length === 0 ? (
                    <p className="panel-empty">No other active accounts are available.</p>
                  ) : (
                    <div className="check-list">
                      {collaboratorChoices.map((account) => (
                        <label key={account.id} className="check">
                          <input
                            type="checkbox"
                            checked={collaboratorIds.includes(account.id)}
                            onChange={() => toggleCollaborator(account.id)}
                          />
                          <span className="check-text">{account.displayName}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {errorFor('collaborators') ? (
                    <p className="field-error" role="alert">
                      {errorFor('collaborators')}
                    </p>
                  ) : null}
                </fieldset>
              </div>
            </IntakeSection>
          </MoreDetails>

          {/*
            When it happened, and whether it is already over. A quiet line
            that says "Now" costs the walk-in nothing; the rare ticket logged
            late presses it. Above the button rather than inside More details,
            because "this was yesterday" is decided while looking at Create.
          */}
          <div className="intake-when">
            <MomentPicker
              label="Opened"
              what="The opened time"
              value={openedAt}
              onChange={setOpenedAt}
              error={errorFor('openedAt')}
            />
            <label className="check intake-resolved-toggle">
              <input
                type="checkbox"
                checked={alreadyResolved}
                onChange={(event) => {
                  setAlreadyResolved(event.target.checked);
                  if (fieldError?.field === 'solution' || fieldError?.field === 'resolvedAt') {
                    setFieldError(null);
                  }
                }}
              />
              <span className="check-text">Already resolved</span>
            </label>
          </div>

          {alreadyResolved ? (
            <IntakeSection
              id="resolved"
              title="How it ended"
              help="What fixed it and when. The ticket is created resolved, as your work."
            >
              <div className="form-grid">
                <Field
                  label="Solution"
                  htmlFor="intake-solution"
                  error={errorFor('solution')}
                  className="form-grid-full"
                >
                  <textarea
                    id="intake-solution"
                    value={solution}
                    rows={3}
                    autoFocus
                    aria-invalid={errorFor('solution') ? 'true' : undefined}
                    onChange={(event) => setSolution(event.target.value)}
                    placeholder="Swapped the charger for a spare from the cart."
                  />
                </Field>
                <div className="form-grid-full">
                  <MomentPicker
                    label="Resolved"
                    what="The resolved time"
                    value={resolvedAt}
                    onChange={setResolvedAt}
                    notBefore={openedAt ? { iso: openedAt, what: 'it was opened' } : null}
                    error={errorFor('resolvedAt')}
                  />
                </div>
              </div>
            </IntakeSection>
          ) : null}

          {fieldError && !fieldError.field ? (
            <p className="flash flash-error intake-error" role="alert">
              {fieldError.error}
            </p>
          ) : null}

          <div className="intake-actions">
            <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
              {alreadyResolved ? 'Create resolved ticket' : 'Create ticket'}
            </Button>
            <Button onClick={() => router.back()} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </form>
      </IntakeSuggestions>
    </div>
  );
}

/**
 * Which control a refusal from the database belongs beside. The rest stay in
 * the banner under the form, which is where a message about the whole ticket
 * reads.
 */
function fieldOfError(message: string): string | undefined {
  if (message.startsWith('The opened time')) return 'openedAt';
  if (message.startsWith('The resolved time') || message.includes('resolved before it was opened')) {
    return 'resolvedAt';
  }
  if (message.includes('solution') || message.startsWith('Write what fixed it')) return 'solution';
  return undefined;
}
