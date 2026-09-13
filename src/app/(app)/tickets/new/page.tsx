'use client';

/**
 * Intake form for both roles.
 *
 * Admin: any channel, any owner or the Open Queue, and a backdatable
 * submission date. Technician: walk-in only, owner fixed to themselves,
 * dated today. Requesters and inventory lookups are live server actions, so
 * this page keeps only the selected ids and the fields needed for the ticket.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type CatalogEntry,
  type InventoryDevice,
  loadAssignedDevices,
  loadDeviceCatalog,
  searchRequesters,
} from '@/lib/data/inventory-actions';
import {
  type IntakeChannel,
  type Priority,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
} from '@/lib/domain/types';
import { canChooseChannelAndOwner } from '@/lib/domain/permissions';
import { createTicketAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { SearchSelect } from '@/components/SearchSelect';
import { Field, PageHeader } from '@/components/Primitives';

type RequesterMode = 'existing' | 'unknown';
type RequesterKind = 'staff' | 'student';

interface RequesterResult {
  id: string;
  displayName: string;
  externalId: string | null;
}

interface DeviceDraft {
  key: number;
  inventoryDeviceId?: string;
  deviceType: string;
  deviceTypeQuery: string;
  manufacturer: string;
  manufacturerQuery: string;
  model: string;
  modelQuery: string;
  osVersion: string;
  serialNumber: string;
  assetTag: string;
}

function emptyDevice(key: number): DeviceDraft {
  return {
    key,
    deviceType: '',
    deviceTypeQuery: '',
    manufacturer: '',
    manufacturerQuery: '',
    model: '',
    modelQuery: '',
    osVersion: '',
    serialNumber: '',
    assetTag: '',
  };
}

function requesterLabel(requester: RequesterResult): string {
  return requester.externalId
    ? `${requester.displayName} — ${requester.externalId}`
    : requester.displayName;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function isCompleteDevice(device: DeviceDraft): boolean {
  return Boolean(
    device.deviceType.trim() &&
      device.manufacturer.trim() &&
      device.model.trim() &&
      device.serialNumber.trim(),
  );
}

export default function NewTicketPage() {
  const { directory, today, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const isAdminIntake = canChooseChannelAndOwner(actor);

  const [title, setTitle] = useState('');
  const [issue, setIssue] = useState('');
  const [channel, setChannel] = useState<IntakeChannel>('walk_in');
  const [priority, setPriority] = useState<Priority>('normal');
  const [submittedOn, setSubmittedOn] = useState(today);
  const [requesterMode, setRequesterMode] = useState<RequesterMode>('existing');
  const [requesterKind, setRequesterKind] = useState<RequesterKind>('staff');
  const [requesterQuery, setRequesterQuery] = useState('');
  const [requesterResults, setRequesterResults] = useState<RequesterResult[]>([]);
  const [selectedRequester, setSelectedRequester] = useState<RequesterResult | null>(null);
  const [requesterLoading, setRequesterLoading] = useState(false);
  const [requesterLookupError, setRequesterLookupError] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [ownerId, setOwnerId] = useState<string>('');
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const [devices, setDevices] = useState<DeviceDraft[]>([]);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [assignedDevices, setAssignedDevices] = useState<InventoryDevice[]>([]);
  const [assignedLoading, setAssignedLoading] = useState(false);
  const [assignedError, setAssignedError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field?: string; error: string } | null>(null);

  const requesterSearchSequence = useRef(0);
  const assignedDeviceSequence = useRef(0);
  const nextDeviceKey = useRef(1);

  const activeAccounts = useMemo(
    () => directory.filter((account) => account.status === 'active'),
    [directory],
  );
  const collaboratorChoices = useMemo(
    () =>
      activeAccounts.filter(
        (account) => account.id !== (isAdminIntake ? ownerId : actor.id),
      ),
    [activeAccounts, isAdminIntake, ownerId, actor.id],
  );
  const catalogDeviceTypes = useMemo(
    () => uniqueSorted(catalogEntries.map((entry) => entry.deviceType)),
    [catalogEntries],
  );
  const manufacturersByType = useMemo(() => {
    const values = new Map<string, string[]>();
    for (const entry of catalogEntries) {
      const existing = values.get(entry.deviceType) ?? [];
      if (!existing.includes(entry.manufacturer)) existing.push(entry.manufacturer);
      values.set(entry.deviceType, existing);
    }
    for (const [key, entries] of values) values.set(key, uniqueSorted(entries));
    return values;
  }, [catalogEntries]);
  const modelsByTypeAndManufacturer = useMemo(() => {
    const values = new Map<string, string[]>();
    for (const entry of catalogEntries) {
      const key = `${entry.deviceType}\u0000${entry.manufacturer}`;
      const existing = values.get(key) ?? [];
      if (!existing.includes(entry.model)) existing.push(entry.model);
      values.set(key, existing);
    }
    for (const [key, entries] of values) values.set(key, uniqueSorted(entries));
    return values;
  }, [catalogEntries]);

  const submitting = pendingKey === 'create-ticket';
  const hasIncompleteDevice = devices.some((device) => !isCompleteDevice(device));
  const requesterSearchPrompt =
    requesterKind === 'staff' ? 'Search staff name' : 'Search name or OSIS';

  function errorFor(field: string): string | null {
    return fieldError?.field === field ? fieldError.error : null;
  }

  function clearAssignedDevices() {
    assignedDeviceSequence.current += 1;
    setAssignedDevices([]);
    setAssignedLoading(false);
    setAssignedError(null);
  }

  function clearRequesterSelection() {
    setSelectedRequester(null);
    setDevices((current) => current.filter((device) => !device.inventoryDeviceId));
    clearAssignedDevices();
  }

  function handleRequesterModeChange(mode: RequesterMode) {
    setRequesterMode(mode);
    setRequesterKind('staff');
    setRequesterQuery('');
    setRequesterResults([]);
    setRequesterLookupError(null);
    setRequesterLoading(false);
    clearRequesterSelection();
  }

  function handleRequesterKindChange(kind: RequesterKind) {
    setRequesterKind(kind);
    setRequesterQuery('');
    setRequesterResults([]);
    setRequesterLookupError(null);
    setRequesterLoading(false);
    clearRequesterSelection();
  }

  function handleRequesterQueryChange(query: string) {
    setRequesterQuery(query);
    setRequesterResults([]);
    setRequesterLookupError(null);
    setRequesterLoading(false);
    clearRequesterSelection();
  }

  function handleRequesterSelect(requester: RequesterResult) {
    setSelectedRequester(requester);
    setRequesterQuery(requesterLabel(requester));
    setRequesterResults([]);
    setRequesterLookupError(null);
    setRequesterLoading(false);

    const sequence = ++assignedDeviceSequence.current;
    setAssignedDevices([]);
    setAssignedError(null);
    setAssignedLoading(true);
    loadAssignedDevices(requester.id)
      .then((loaded) => {
        if (sequence !== assignedDeviceSequence.current) return;
        setAssignedDevices(loaded);
      })
      .catch((error: unknown) => {
        if (sequence !== assignedDeviceSequence.current) return;
        setAssignedError(errorMessage(error, 'Assigned devices could not be loaded.'));
      })
      .finally(() => {
        if (sequence === assignedDeviceSequence.current) setAssignedLoading(false);
      });
  }

  function handleCatalogQueryChange(
    key: number,
    field: 'deviceType' | 'manufacturer' | 'model',
    query: string,
  ) {
    setDevices((current) =>
      current.map((device) => {
        if (device.key !== key) return device;
        if (field === 'deviceType') {
          return {
            ...device,
            deviceTypeQuery: query,
            deviceType: query === device.deviceType ? device.deviceType : '',
            manufacturer: '',
            manufacturerQuery: '',
            model: '',
            modelQuery: '',
          };
        }
        if (field === 'manufacturer') {
          return {
            ...device,
            manufacturerQuery: query,
            manufacturer: query === device.manufacturer ? device.manufacturer : '',
            model: '',
            modelQuery: '',
          };
        }
        return {
          ...device,
          modelQuery: query,
          model: query === device.model ? device.model : '',
        };
      }),
    );
  }

  function handleCatalogSelect(
    key: number,
    field: 'deviceType' | 'manufacturer' | 'model',
    value: string,
  ) {
    if (field === 'deviceType') {
      updateDevice(key, {
        deviceType: value,
        deviceTypeQuery: value,
        manufacturer: '',
        manufacturerQuery: '',
        model: '',
        modelQuery: '',
      });
    } else if (field === 'manufacturer') {
      updateDevice(key, {
        manufacturer: value,
        manufacturerQuery: value,
        model: '',
        modelQuery: '',
      });
    } else {
      updateDevice(key, { model: value, modelQuery: value });
    }
  }

  function addDevice() {
    const key = nextDeviceKey.current++;
    setDevices((current) => [...current, emptyDevice(key)]);
  }

  function addAssignedDevice(inventoryDevice: InventoryDevice) {
    const key = nextDeviceKey.current++;
    setDevices((current) => {
      if (current.some((device) => device.inventoryDeviceId === inventoryDevice.id)) {
        return current;
      }
      return [
        ...current,
        {
          key,
          inventoryDeviceId: inventoryDevice.id,
          deviceType: inventoryDevice.deviceType,
          deviceTypeQuery: inventoryDevice.deviceType,
          manufacturer: inventoryDevice.manufacturer,
          manufacturerQuery: inventoryDevice.manufacturer,
          model: inventoryDevice.model,
          modelQuery: inventoryDevice.model,
          osVersion: inventoryDevice.osVersion ?? '',
          serialNumber: inventoryDevice.serialNumber ?? '',
          assetTag: inventoryDevice.assetTag ?? '',
        },
      ];
    });
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

  useEffect(() => {
    let current = true;
    loadDeviceCatalog()
      .then((entries) => {
        if (current) setCatalogEntries(entries);
      })
      .catch((error: unknown) => {
        if (current) setCatalogError(errorMessage(error, 'The device catalog could not be loaded.'));
      })
      .finally(() => {
        if (current) setCatalogLoading(false);
      });

    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const sequence = ++requesterSearchSequence.current;
    const query = requesterQuery.trim();

    if (
      requesterMode !== 'existing' ||
      selectedRequester !== null ||
      query.length < 2
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setRequesterLoading(true);
      searchRequesters(requesterKind, query)
        .then((results) => {
          if (sequence !== requesterSearchSequence.current) return;
          setRequesterResults(results);
        })
        .catch((error: unknown) => {
          if (sequence !== requesterSearchSequence.current) return;
          setRequesterLookupError(errorMessage(error, 'Requesters could not be loaded.'));
        })
        .finally(() => {
          if (sequence === requesterSearchSequence.current) setRequesterLoading(false);
        });
    }, 280);

    return () => window.clearTimeout(timer);
  }, [requesterKind, requesterMode, requesterQuery, selectedRequester]);

  async function onSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setFieldError(null);

    if (!title.trim()) {
      setFieldError({ field: 'title', error: 'Describe the issue in a short title.' });
      return;
    }
    if (requesterMode === 'existing' && !selectedRequester) {
      setFieldError({ field: 'requester', error: 'Select a requester or choose Unknown requester.' });
      return;
    }
    if (hasIncompleteDevice) {
      setFieldError({
        field: 'devices',
        error: 'Complete the type, manufacturer, model, and serial number for each device.',
      });
      return;
    }

    const result = await run('create-ticket', () =>
      createTicketAction({
        title,
        issue,
        // A technician's intake is always a self-assigned walk-in dated today.
        // The database rejects any other combination rather than correcting it.
        channel: isAdminIntake ? channel : 'walk_in',
        priority,
        submittedOn: isAdminIntake ? submittedOn : null,
        requesterId: requesterMode === 'existing' ? selectedRequester?.id ?? null : null,
        requesterName: null,
        requesterKind: requesterMode === 'existing' ? requesterKind : null,
        requesterDescriptor: null,
        requesterUnknown: requesterMode === 'unknown',
        location,
        ownerId: isAdminIntake ? ownerId || null : null,
        collaboratorIds,
        devices: devices.map((device) => ({
          ...(device.inventoryDeviceId ? { inventoryDeviceId: device.inventoryDeviceId } : {}),
          deviceType: device.deviceType.trim(),
          manufacturer: device.manufacturer.trim(),
          model: device.model.trim(),
          osVersion: device.osVersion.trim(),
          serialNumber: device.serialNumber.trim(),
          assetTag: device.assetTag.trim(),
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
    <>
      <PageHeader
        title={isAdminIntake ? 'Record a request' : 'Record a walk-in'}
        description={
          isAdminIntake
            ? 'Quick entry for phone, email and walk-in requests. Leave the owner on Open Queue to let a technician claim it.'
            : 'Walk-ins you handle yourself. The channel is fixed to Walk-in and you are recorded as the primary owner.'
        }
      />

      <form className="intake-form" onSubmit={onSubmit} noValidate>
        <div className="card">
          <div className="card-header">
            <h2>Request</h2>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <Field label="Requester" htmlFor="requester-mode" error={errorFor('requester')}>
                <select
                  id="requester-mode"
                  value={requesterMode}
                  onChange={(event) =>
                    handleRequesterModeChange(event.target.value as RequesterMode)
                  }
                >
                  <option value="existing">Existing requester</option>
                  <option value="unknown">Unknown requester</option>
                </select>
              </Field>

              {requesterMode === 'existing' ? (
                <Field label="Requester type" htmlFor="requester-kind">
                  <select
                    id="requester-kind"
                    value={requesterKind}
                    onChange={(event) =>
                      handleRequesterKindChange(event.target.value as RequesterKind)
                    }
                  >
                    <option value="staff">Staff</option>
                    <option value="student">Student</option>
                  </select>
                </Field>
              ) : null}

              {requesterMode === 'existing' ? (
                <Field
                  label={requesterSearchPrompt}
                  htmlFor="requester-search"
                  className="form-grid-full"
                  error={requesterLookupError}
                  hint={
                    selectedRequester
                      ? `Selected: ${requesterLabel(selectedRequester)}`
                      : 'Type at least two characters to search.'
                  }
                >
                  <SearchSelect<RequesterResult>
                    id="requester-search"
                    value={selectedRequester}
                    query={requesterQuery}
                    options={requesterResults}
                    getOptionKey={(requester) => requester.id}
                    getOptionLabel={requesterLabel}
                    onQueryChange={handleRequesterQueryChange}
                    onSelect={handleRequesterSelect}
                    placeholder={requesterSearchPrompt}
                    loading={requesterLoading}
                    emptyText={
                      requesterQuery.trim().length < 2
                        ? 'Enter at least two characters.'
                        : 'No matching requester.'
                    }
                  />
                </Field>
              ) : (
                <p className="notice form-grid-full">
                  No requester record will be attached to this ticket.
                </p>
              )}

              <Field
                label="Location"
                htmlFor="location"
                optional
                hint="Leave blank if unknown."
              >
                <input
                  id="location"
                  type="text"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="Room 212"
                />
              </Field>

              <Field
                label="Issue"
                htmlFor="title"
                error={errorFor('title')}
                hint="A short description of what needs attention."
              >
                <input
                  id="title"
                  type="text"
                  value={title}
                  required
                  maxLength={120}
                  aria-invalid={errorFor('title') ? 'true' : undefined}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Projector in Room 212 will not display"
                />
              </Field>

              <Field
                label="Notes"
                htmlFor="issue"
                optional
                className="form-grid-full"
                error={errorFor('issue')}
                hint="Additional detail from the requester, if useful."
              >
                <textarea
                  id="issue"
                  value={issue}
                  maxLength={6000}
                  aria-invalid={errorFor('issue') ? 'true' : undefined}
                  onChange={(event) => setIssue(event.target.value)}
                  rows={4}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Intake and routing</h2>
          </div>
          <div className="card-body">
            <div className="form-grid">
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
                <Field
                  label="Channel"
                  htmlFor="channel-fixed"
                  hint="Technician intake is walk-in only."
                >
                  <input id="channel-fixed" type="text" value="Walk-in" readOnly disabled />
                </Field>
              )}

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
                  label="Primary owner"
                  htmlFor="owner"
                  error={errorFor('ownerId')}
                  hint="Leave on Open Queue so any technician can claim it."
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
                    <option value="">Open Queue — unassigned</option>
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
                  label="Primary owner"
                  htmlFor="owner-fixed"
                  hint="A technician's walk-in is always assigned to themselves."
                >
                  <input
                    id="owner-fixed"
                    type="text"
                    value={actor.displayName}
                    readOnly
                    disabled
                  />
                </Field>
              )}

              <fieldset className="form-grid-full">
                <legend>Collaborators (optional)</legend>
                {collaboratorChoices.length === 0 ? (
                  <p className="small subtle">No other active accounts are available.</p>
                ) : (
                  <div className="stack-sm">
                    {collaboratorChoices.map((account) => (
                      <label key={account.id} className="checkbox-row small">
                        <input
                          type="checkbox"
                          checked={collaboratorIds.includes(account.id)}
                          onChange={() => toggleCollaborator(account.id)}
                        />
                        <span>
                          {account.displayName}{' '}
                          <span className="subtle">{account.email}</span>
                        </span>
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
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Devices (optional)</h2>
            <button type="button" className="btn btn-sm" onClick={addDevice} disabled={submitting}>
              Add device
            </button>
          </div>
          <div className="card-body">
            {catalogLoading ? <p className="small subtle">Loading device catalog…</p> : null}
            {catalogError ? (
              <p className="flash flash-error" role="alert">
                {catalogError}
              </p>
            ) : null}

            {selectedRequester ? (
              <div className="intake-assigned-devices">
                <h3>Assigned to {selectedRequester.displayName}</h3>
                {assignedLoading ? (
                  <p className="small subtle">Loading assigned devices…</p>
                ) : assignedError ? (
                  <p className="field-error" role="alert">
                    {assignedError}
                  </p>
                ) : assignedDevices.length === 0 ? (
                  <p className="small subtle">No assigned inventory devices were found.</p>
                ) : (
                  <div className="stack-sm">
                    {assignedDevices.map((inventoryDevice) => {
                      const ready = Boolean(inventoryDevice.deviceType.trim() && inventoryDevice.manufacturer.trim() && inventoryDevice.model.trim() && inventoryDevice.serialNumber?.trim());
                      const added = devices.some(
                        (device) => device.inventoryDeviceId === inventoryDevice.id,
                      );
                      return (
                        <div className="intake-assigned-device" key={inventoryDevice.id}>
                          <div className="intake-assigned-device-main">
                            <strong>
                              {inventoryDevice.deviceType} · {inventoryDevice.manufacturer}{' '}
                              {inventoryDevice.model}
                            </strong>
                            <span className="small subtle">
                              Serial: {inventoryDevice.serialNumber ?? 'not recorded'}
                              {inventoryDevice.assetTag
                                ? ` · Asset: ${inventoryDevice.assetTag}`
                                : ''}
                            </span>
                            {!ready ? <span className="small field-error">Required device details are missing from inventory.</span> : null}
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={added || submitting || !ready}
                            onClick={() => addAssignedDevice(inventoryDevice)}
                          >
                            {added ? 'Added' : 'Add'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {devices.length === 0 ? (
              <p className="small muted intake-device-empty">
                Device details are optional. Add a device from the inventory catalog when one is
                part of the request.
              </p>
            ) : (
              <div className="stack intake-device-drafts">
                {devices.map((device, index) => {
                  const manufacturers = manufacturersByType.get(device.deviceType) ?? [];
                  const models =
                    modelsByTypeAndManufacturer.get(
                      `${device.deviceType}\u0000${device.manufacturer}`,
                    ) ?? [];
                  const complete = isCompleteDevice(device);
                  return (
                    <fieldset
                      key={device.key}
                      className={complete ? undefined : 'intake-device-incomplete'}
                    >
                      <legend>Device {index + 1}</legend>
                      {device.inventoryDeviceId ? <p className="small subtle">Inventory device — these details come from its inventory record.</p> : null}
                      <div className="form-grid">
                        <Field
                          label="Device type"
                          htmlFor={`device-type-${device.key}`}
                          error={errorFor('deviceType')}
                        >
                          <SearchSelect<string>
                            id={`device-type-${device.key}`}
                            value={device.deviceType || null}
                            query={device.deviceTypeQuery}
                            options={catalogDeviceTypes}
                            getOptionKey={(value) => value}
                            getOptionLabel={(value) => value}
                            onQueryChange={(query) =>
                              handleCatalogQueryChange(device.key, 'deviceType', query)
                            }
                            onSelect={(value) =>
                              handleCatalogSelect(device.key, 'deviceType', value)
                            }
                            placeholder="Search device type"
                            disabled={catalogLoading || submitting || Boolean(device.inventoryDeviceId)}
                            emptyText={catalogError ? 'Catalog unavailable.' : 'No matching type.'}
                          />
                        </Field>
                        <Field
                          label="Manufacturer"
                          htmlFor={`device-manufacturer-${device.key}`}
                          error={errorFor('manufacturer')}
                        >
                          <SearchSelect<string>
                            id={`device-manufacturer-${device.key}`}
                            value={device.manufacturer || null}
                            query={device.manufacturerQuery}
                            options={manufacturers}
                            getOptionKey={(value) => value}
                            getOptionLabel={(value) => value}
                            onQueryChange={(query) =>
                              handleCatalogQueryChange(device.key, 'manufacturer', query)
                            }
                            onSelect={(value) =>
                              handleCatalogSelect(device.key, 'manufacturer', value)
                            }
                            placeholder={
                              device.deviceType ? 'Search manufacturer' : 'Choose a type first'
                            }
                            disabled={!device.deviceType || catalogLoading || submitting || Boolean(device.inventoryDeviceId)}
                            emptyText="No matching manufacturer."
                          />
                        </Field>
                        <Field
                          label="Model"
                          htmlFor={`device-model-${device.key}`}
                          error={errorFor('model')}
                        >
                          <SearchSelect<string>
                            id={`device-model-${device.key}`}
                            value={device.model || null}
                            query={device.modelQuery}
                            options={models}
                            getOptionKey={(value) => value}
                            getOptionLabel={(value) => value}
                            onQueryChange={(query) =>
                              handleCatalogQueryChange(device.key, 'model', query)
                            }
                            onSelect={(value) => handleCatalogSelect(device.key, 'model', value)}
                            placeholder={
                              device.manufacturer ? 'Search model' : 'Choose a manufacturer first'
                            }
                            disabled={!device.manufacturer || catalogLoading || submitting || Boolean(device.inventoryDeviceId)}
                            emptyText="No matching model."
                          />
                        </Field>
                        <Field
                          label="Serial number"
                          htmlFor={`device-serial-${device.key}`}
                          error={errorFor('serialNumber')}
                          hint="Required when recording a device at intake."
                        >
                          <input
                            id={`device-serial-${device.key}`}
                            type="text"
                            value={device.serialNumber}
                            readOnly={Boolean(device.inventoryDeviceId)}
                            required
                            onChange={(event) =>
                              updateDevice(device.key, { serialNumber: event.target.value })
                            }
                          />
                        </Field>
                        <Field
                          label="Asset tag"
                          htmlFor={`device-asset-${device.key}`}
                          optional
                        >
                          <input
                            id={`device-asset-${device.key}`}
                            type="text"
                            value={device.assetTag}
                            readOnly={Boolean(device.inventoryDeviceId)}
                            onChange={(event) =>
                              updateDevice(device.key, { assetTag: event.target.value })
                            }
                          />
                        </Field>
                        <Field
                          label="OS version"
                          htmlFor={`device-os-${device.key}`}
                          optional
                        >
                          <input
                            id={`device-os-${device.key}`}
                            type="text"
                            value={device.osVersion}
                            readOnly={Boolean(device.inventoryDeviceId)}
                            onChange={(event) =>
                              updateDevice(device.key, { osVersion: event.target.value })
                            }
                          />
                        </Field>
                        <div className="form-grid-full intake-device-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => removeDevice(device.key)}
                            disabled={submitting}
                          >
                            Remove device {index + 1}
                          </button>
                        </div>
                      </div>
                    </fieldset>
                  );
                })}
              </div>
            )}

            {hasIncompleteDevice ? (
              <p className="small subtle intake-device-incomplete-note">
                Complete the type, manufacturer, model, and serial number before creating the
                ticket.
              </p>
            ) : null}
            {errorFor('devices') ? (
              <p className="field-error" role="alert">
                {errorFor('devices')}
              </p>
            ) : null}
          </div>
        </div>

        {fieldError && !fieldError.field ? (
          <p className="flash flash-error" role="alert" style={{ marginTop: 16 }}>
            {fieldError.error}
          </p>
        ) : null}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || hasIncompleteDevice}
          >
            {submitting ? 'Saving…' : 'Create ticket'}
          </button>
          <button type="button" className="btn" onClick={() => router.back()} disabled={submitting}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
