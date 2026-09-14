'use client';

/**
 * Intake form for both roles.
 *
 * Admin: any channel, any owner or the queue, and a backdatable submission
 * date. Technician: walk-in only, owner fixed to themselves, dated today — the
 * controls for the other options are not rendered, and `createTicket` rejects
 * them anyway rather than silently correcting a forged value.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import {
  type IntakeChannel,
  type Priority,
  type Requester,
  type TicketCategory,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
} from '@/lib/domain/types';
import { canChooseChannelAndOwner } from '@/lib/domain/permissions';
import { createTicketAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { ChosenPerson, PersonPicker, type PersonSearchResult } from '@/components/people/PersonPicker';
import { Field, PageHeader } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

const DEVICE_TYPE_SUGGESTIONS = [
  'Laptop',
  'Chromebook',
  'Desktop',
  'Tablet',
  'Projector',
  'Interactive panel',
  'Printer',
  'Phone',
  'Network equipment',
];

type RequesterMode = 'existing' | 'new' | 'unknown';

const REQUESTER_MODES: { value: RequesterMode; label: string }[] = [
  { value: 'existing', label: 'Known' },
  { value: 'new', label: 'New' },
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

export default function NewTicketPage() {
  const { directory, requesters, today, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const isAdminIntake = canChooseChannelAndOwner(actor);

  const [title, setTitle] = useState('');
  const [issue, setIssue] = useState('');
  const [channel, setChannel] = useState<IntakeChannel>('walk_in');
  const [priority, setPriority] = useState<Priority>('normal');
  const [submittedOn, setSubmittedOn] = useState(today);
  const [category, setCategory] = useState<TicketCategory>('other');
  const [requesterMode, setRequesterMode] = useState<RequesterMode>('existing');
  const [requesterId, setRequesterId] = useState('');
  const [person, setPerson] = useState<PersonSearchResult | null>(null);
  const [requesterName, setRequesterName] = useState('');
  const [requesterKind, setRequesterKind] = useState<Requester['kind']>('staff');
  const [requesterDescriptor, setRequesterDescriptor] = useState('');
  const [location, setLocation] = useState('');
  const [isRemote, setIsRemote] = useState(false);
  const [ownerId, setOwnerId] = useState<string>('');
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const [devices, setDevices] = useState<DeviceDraft[]>([]);
  const [nextDeviceKey, setNextDeviceKey] = useState(1);
  const [fieldError, setFieldError] = useState<{ field?: string; error: string } | null>(null);

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
  const sortedRequesters = useMemo(
    () => [...requesters].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [requesters],
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

    const result = await run('create-ticket', () =>
      createTicketAction({
        title,
        issue,
        // A technician's intake is always a self-assigned walk-in dated today.
        // The database rejects any other combination rather than correcting it.
        channel: isAdminIntake ? channel : 'walk_in',
        priority,
        submittedOn: isAdminIntake ? submittedOn : null,
        category,
        // A directory person wins when one is chosen; the legacy requester row
        // is the fallback for somebody who is not on the roster.
        personId: requesterMode === 'existing' && person ? person.id : null,
        requesterId:
          requesterMode === 'existing' && !person && requesterId ? requesterId : null,
        requesterName: requesterMode === 'new' ? requesterName : null,
        requesterKind: requesterMode === 'new' ? requesterKind : null,
        requesterDescriptor: requesterMode === 'new' ? requesterDescriptor : null,
        requesterUnknown: requesterMode === 'unknown',
        location,
        isRemote,
        ownerId: isAdminIntake ? (ownerId || null) : null,
        collaboratorIds,
        devices: devices.map((device) => ({
          deviceType: device.deviceType,
          model: device.model,
          osVersion: device.osVersion,
          serialNumber: device.serialNumber,
          assetTag: device.assetTag,
          identifiersNotApplicable: device.identifiersNotApplicable,
        })),
      }),
    );

    if (result.ok && result.id) {
      router.push(`/tickets/${result.id}`);
      return;
    }
    if (!result.ok) {
      // The database returns one message per rejected field; show it inline.
      setFieldError({ error: result.error ?? 'The ticket could not be created.' });
    }
  }

  return (
    <div className="intake">
      <PageHeader
        title="New ticket"
        description={
          isAdminIntake
            ? 'Quick entry for phone, email and walk-in requests. Leave the owner on the queue to let a technician claim it.'
            : 'Walk-ins you handle yourself. The channel is fixed to walk-in and you are recorded as the owner.'
        }
      />

      <form onSubmit={onSubmit} noValidate className="panel">
        <IntakeSection
          id="who"
          title="Who is asking"
          help="Pick a known requester, add a new one, or record the request as unidentified."
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
                  <>
                    {/* The directory type-ahead the device screens use: grouped
                        results, keyboard walkable, announced as a combobox. */}
                    <PersonPicker
                      id="person-query"
                      label="Search the directory"
                      hint="Search by name, OSIS, staff ID or email address."
                      placeholder="Whitfield"
                      onSelect={(result) => {
                        setPerson(result);
                        // A directory person and a legacy requester row are two
                        // answers to one question; choosing one clears the
                        // other rather than sending both.
                        setRequesterId('');
                      }}
                    />

                    {/* Everybody recorded before the directory existed, and
                        everybody who is not on the roster: a parent, a vendor,
                        a visiting coach. They stay pickable. */}
                    <Field
                      label="Previous requesters"
                      htmlFor="requester-id"
                      optional
                      hint="Somebody recorded before, who may not be in the directory."
                    >
                      <select
                        id="requester-id"
                        value={requesterId}
                        onChange={(event) => setRequesterId(event.target.value)}
                      >
                        <option value="">Choose a requester</option>
                        {sortedRequesters.map((requester) => (
                          <option key={requester.id} value={requester.id}>
                            {requester.displayName}
                            {requester.descriptor ? ` (${requester.descriptor})` : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}
              </div>
            ) : null}

            {requesterMode === 'new' ? (
              <>
                <Field label="Name" htmlFor="requester-name">
                  <input
                    id="requester-name"
                    type="text"
                    value={requesterName}
                    onChange={(event) => setRequesterName(event.target.value)}
                    placeholder="Ms. Calloway"
                  />
                </Field>
                <Field label="Type" htmlFor="requester-kind">
                  <select
                    id="requester-kind"
                    value={requesterKind}
                    onChange={(event) =>
                      setRequesterKind(event.target.value as Requester['kind'])
                    }
                  >
                    <option value="staff">Staff</option>
                    <option value="student">Student</option>
                    <option value="role">Role or desk</option>
                    <option value="unknown">Unspecified</option>
                  </select>
                </Field>
                <Field
                  label="Department or detail"
                  htmlFor="requester-descriptor"
                  optional
                  className="form-grid-full"
                  hint="Only what a technician needs to do the job."
                >
                  <input
                    id="requester-descriptor"
                    type="text"
                    value={requesterDescriptor}
                    onChange={(event) => setRequesterDescriptor(event.target.value)}
                    placeholder="Grade 6 ELA"
                  />
                </Field>
              </>
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
              <select
                id="category"
                value={category}
                onChange={(event) => setCategory(event.target.value as TicketCategory)}
              >
                {TICKET_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {TICKET_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
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
            </Field>
          </div>
        </IntakeSection>

        <IntakeSection id="where" title="Where" help="The room or area, or mark it remote.">
          <div className="form-grid">
            <Field label="Location" htmlFor="location" optional hint="Leave blank if unknown.">
              <input
                id="location"
                type="text"
                value={location}
                disabled={isRemote}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Room 212"
              />
            </Field>
            <div className="field">
              <span className="field-label">Remote</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={isRemote}
                  onChange={(event) => setIsRemote(event.target.checked)}
                />
                <span className="check-text">No physical location, handled remotely</span>
              </label>
            </div>
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
                    <Field label="Manufacturer and model" htmlFor={`device-model-${device.key}`} optional>
                      <input
                        id={`device-model-${device.key}`}
                        type="text"
                        value={device.model ?? ''}
                        onChange={(event) => updateDevice(device.key, { model: event.target.value })}
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
                      <Button variant="ghost" size="sm" onClick={() => removeDevice(device.key)}>
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
              {DEVICE_TYPE_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </div>
        </IntakeSection>

        <IntakeSection
          id="priority"
          title="Priority and date"
          help="How urgent it is, how it came in, when, and who owns it."
        >
          <div className="form-grid">
            <Field label="Priority" htmlFor="priority">
              <select
                id="priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
              >
                {(Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>

            {isAdminIntake ? (
              <Field label="Channel" htmlFor="channel" error={errorFor('channel')}>
                <select
                  id="channel"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value as IntakeChannel)}
                >
                  {(Object.keys(CHANNEL_LABELS) as IntakeChannel[]).map((value) => (
                    <option key={value} value={value}>
                      {CHANNEL_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Channel" htmlFor="channel-fixed" hint="Technician intake is walk-in only.">
                <input id="channel-fixed" type="text" value="Walk-in" readOnly disabled />
              </Field>
            )}

            {isAdminIntake ? (
              <Field
                label="Submission date"
                htmlFor="submitted-on"
                error={errorFor('submittedOn')}
                hint="Defaults to today. Backdating keeps the real creation timestamp."
              >
                <input
                  id="submitted-on"
                  type="date"
                  value={submittedOn}
                  max={today}
                  aria-invalid={errorFor('submittedOn') ? 'true' : undefined}
                  onChange={(event) => setSubmittedOn(event.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="Submission date"
                htmlFor="submitted-on-fixed"
                hint="Walk-ins are dated today."
              >
                <input id="submitted-on-fixed" type="date" value={today} readOnly disabled />
              </Field>
            )}

            {isAdminIntake ? (
              <Field
                label="Owner"
                htmlFor="owner"
                error={errorFor('ownerId')}
                hint="Leave on the queue so any technician can claim it."
              >
                <select
                  id="owner"
                  value={ownerId}
                  onChange={(event) => {
                    setOwnerId(event.target.value);
                    setCollaboratorIds((current) =>
                      current.filter((id) => id !== event.target.value),
                    );
                  }}
                >
                  <option value="">Queue, unassigned</option>
                  {activeAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName}
                      {account.role === 'admin' ? ' (administrator)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field
                label="Owner"
                htmlFor="owner-fixed"
                hint="A technician's walk-in is always assigned to themselves."
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

        {fieldError && !fieldError.field ? (
          <p className="flash flash-error intake-error" role="alert">
            {fieldError.error}
          </p>
        ) : null}

        <div className="intake-actions">
          <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
            Create ticket
          </Button>
          <Button onClick={() => router.back()} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
