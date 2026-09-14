'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRuntime } from '@/components/AppRuntime';
import { EmptyState, Field, PageHeader } from '@/components/Primitives';
import { SearchSelect } from '@/components/SearchSelect';
import {
  searchRequesters,
  type CatalogEntry,
} from '@/lib/data/inventory-actions';
import {
  getManagedDevice,
  getPerson,
  listManagedDevices,
  listPeople,
  loadManagementOptions,
  saveManagedDevice,
  savePerson,
} from '@/lib/data/inventory-management-actions';
import type {
  DeviceInput,
  InventoryPage,
  InventorySaveResult,
  ManagedDevice,
  PersonInput,
  PersonKind,
  PersonRecord,
} from '@/lib/inventory/types';
import { formatDateTime } from '@/lib/format';

export type InventorySection = 'students' | 'staff' | 'devices';

type PersonDraft = PersonInput & {
  id: string | null;
  version: number | null;
};

type DeviceDraft = DeviceInput & {
  id: string | null;
  externalId: string;
  version: number | null;
};

interface RequesterOption {
  id: string;
  displayName: string;
  externalId: string | null;
}

type InventoryListPage =
  | InventoryPage<PersonRecord>
  | InventoryPage<ManagedDevice>;

const PAGE_SIZE = 50;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function personKindLabel(kind: PersonKind): string {
  return kind === 'student' ? 'Student' : 'Staff';
}

function sectionTitle(section: InventorySection): string {
  if (section === 'students') return 'Students';
  if (section === 'staff') return 'Staff';
  return 'Master Inventory';
}

function sectionDescription(section: InventorySection): string {
  if (section === 'students') {
    return 'Search student directory records, update contact details, and review assigned devices.';
  }
  if (section === 'staff') {
    return 'Search staff directory records, update school details, and review assigned devices.';
  }
  return 'Search the master device inventory, update records, and assign devices to a directory person.';
}

function requesterLabel(requester: RequesterOption): string {
  return requester.externalId
    ? `${requester.displayName} — ${requester.externalId}`
    : requester.displayName;
}

function staffExternalId(email: string): string {
  return email.trim().split('@', 1)[0]?.toLowerCase() ?? '';
}

function blankPerson(kind: PersonKind): PersonDraft {
  return {
    id: null,
    version: null,
    kind,
    externalId: '',
    displayName: '',
    firstName: '',
    lastName: '',
    email: '',
    schoolDbn: '',
    department: '',
    staffRole: '',
    classOf: '',
    officialClass: '',
    studentStatus: 'current',
    guardianName: '',
    guardianPhone: '',
    homePhone: '',
    address: '',
    notes: '',
  };
}

function personDraftFromRecord(record: PersonRecord): PersonDraft {
  return {
    id: record.id,
    version: record.version,
    kind: record.kind,
    externalId: record.externalId,
    displayName: record.displayName,
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    schoolDbn: record.schoolDbn,
    department: record.department,
    staffRole: record.staffRole,
    classOf: record.classOf,
    officialClass: record.officialClass,
    studentStatus: record.studentStatus,
    guardianName: record.guardianName,
    guardianPhone: record.guardianPhone,
    homePhone: record.homePhone,
    address: record.address,
    notes: record.notes,
  };
}

function personInputFromDraft(draft: PersonDraft): PersonInput {
  return {
    kind: draft.kind,
    externalId:
      draft.kind === 'staff'
        ? draft.email.trim()
          ? staffExternalId(draft.email)
          : draft.externalId.trim()
        : draft.externalId.trim(),
    displayName: draft.displayName.trim(),
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    email: draft.email.trim(),
    schoolDbn: draft.schoolDbn.trim(),
    department: draft.department.trim(),
    staffRole: draft.staffRole.trim(),
    classOf: draft.classOf.trim(),
    officialClass: draft.officialClass.trim(),
    studentStatus: draft.studentStatus,
    guardianName: draft.guardianName.trim(),
    guardianPhone: draft.guardianPhone.trim(),
    homePhone: draft.homePhone.trim(),
    address: draft.address.trim(),
    notes: draft.notes.trim(),
  };
}

function blankDevice(): DeviceDraft {
  return {
    id: null,
    version: null,
    externalId: '',
    deviceType: '',
    manufacturer: '',
    model: '',
    osVersion: '',
    serialNumber: '',
    assetTag: '',
    status: 'active',
    location: '',
    notes: '',
    assignedRequesterId: null,
  };
}

function deviceDraftFromRecord(record: ManagedDevice): DeviceDraft {
  return {
    id: record.id,
    version: record.version,
    externalId: record.externalId,
    deviceType: record.deviceType,
    manufacturer: record.manufacturer,
    model: record.model,
    osVersion: record.osVersion,
    serialNumber: record.serialNumber,
    assetTag: record.assetTag,
    status: record.status,
    location: record.location,
    notes: record.notes,
    assignedRequesterId: record.assignedRequesterId,
  };
}

function deviceInputFromDraft(draft: DeviceDraft): DeviceInput {
  return {
    deviceType: draft.deviceType.trim(),
    manufacturer: draft.manufacturer.trim(),
    model: draft.model.trim(),
    osVersion: draft.osVersion.trim(),
    serialNumber: draft.serialNumber.trim(),
    assetTag: draft.assetTag.trim(),
    status: draft.status.trim(),
    location: draft.location.trim(),
    notes: draft.notes.trim(),
    assignedRequesterId: draft.assignedRequesterId,
  };
}

function saveActionResult(result: InventorySaveResult, successMessage: string) {
  return {
    ok: result.ok,
    id: result.id,
    error: result.error,
    message: result.ok ? successMessage : undefined,
  };
}

function Pagination({
  page,
  label,
  disabled,
  onChange,
}: {
  page: InventoryPage<unknown>;
  label: string;
  disabled?: boolean;
  onChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(page.total / Math.max(page.pageSize, PAGE_SIZE)));
  if (pageCount <= 1) return null;

  return (
    <nav className="inventory-pagination" aria-label={`${label} pages`}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled || page.page <= 1}
        onClick={() => onChange(page.page - 1)}
      >
        Previous
      </button>
      <span className="small subtle">
        Page {page.page} of {pageCount}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled || page.page >= pageCount}
        onClick={() => onChange(page.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

export function InventoryManager({ section }: { section: InventorySection }) {
  const { pendingKey, run } = useRuntime();
  const personSection = section !== 'devices';
  const personKind: PersonKind | null =
    section === 'students' ? 'student' : section === 'staff' ? 'staff' : null;
  const busy = pendingKey !== null;

  const [listQuery, setListQuery] = useState('');
  const [listPageNumber, setListPageNumber] = useState(1);
  const [listPage, setListPage] = useState<InventoryListPage | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [personDraft, setPersonDraft] = useState<PersonDraft | null>(null);
  const [deviceDraft, setDeviceDraft] = useState<DeviceDraft | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  const [personAssignedPage, setPersonAssignedPage] =
    useState<InventoryPage<ManagedDevice> | null>(null);
  const [personAssignedLoading, setPersonAssignedLoading] = useState(false);
  const [personAssignedError, setPersonAssignedError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [staffDepartments, setStaffDepartments] = useState<string[]>([]);
  const [staffRoles, setStaffRoles] = useState<string[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [assignmentMode, setAssignmentMode] = useState<'unassigned' | PersonKind>('unassigned');
  const [assignmentQuery, setAssignmentQuery] = useState('');
  const [assignmentSelected, setAssignmentSelected] = useState<RequesterOption | null>(null);
  const [assignmentResults, setAssignmentResults] = useState<RequesterOption[]>([]);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [assignmentCurrentName, setAssignmentCurrentName] = useState<string | null>(null);

  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const assignedSequence = useRef(0);
  const optionsSequence = useRef(0);
  const assignmentSearchSequence = useRef(0);

  const catalogTypes = useMemo(
    () => uniqueSorted(catalog.map((entry) => entry.deviceType)),
    [catalog],
  );
  const catalogManufacturers = uniqueSorted(
    catalog
      .filter((entry) => !deviceDraft?.deviceType || entry.deviceType === deviceDraft.deviceType)
      .map((entry) => entry.manufacturer),
  );
  const catalogModels = uniqueSorted(
    catalog
      .filter(
        (entry) =>
          (!deviceDraft?.deviceType || entry.deviceType === deviceDraft.deviceType) &&
          (!deviceDraft?.manufacturer || entry.manufacturer === deviceDraft.manufacturer),
      )
      .map((entry) => entry.model),
  );
  const statusOptions = [...new Set([deviceDraft?.status ?? '', ...statuses])].sort((a, b) =>
    a.localeCompare(b),
  );

  useEffect(() => {
    let active = true;
    const sequence = ++optionsSequence.current;
    loadManagementOptions()
      .then((options) => {
        if (!active || sequence !== optionsSequence.current) return;
        setCatalog(options.catalog);
        setStatuses(options.statuses);
        setStaffDepartments(options.staffDepartments);
        setStaffRoles(options.staffRoles);
        setOptionsError(null);
      })
      .catch((error: unknown) => {
        if (!active || sequence !== optionsSequence.current) return;
        setOptionsError(errorMessage(error, 'Inventory options could not be loaded.'));
      })
      .finally(() => {
        if (active && sequence === optionsSequence.current) setOptionsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const sequence = ++listSequence.current;
    const timer = window.setTimeout(() => {
      if (!active || sequence !== listSequence.current) return;
      setListLoading(true);
      const request: Promise<InventoryListPage> = section === 'devices'
        ? listManagedDevices(listQuery.trim(), listPageNumber)
        : listPeople(section === 'students' ? 'student' : 'staff', listQuery.trim(), listPageNumber);

      request
        .then((result) => {
          if (!active || sequence !== listSequence.current) return;
          setListPage(result);
          setListError(null);
          const lastPage = Math.max(1, Math.ceil(result.total / Math.max(result.pageSize, PAGE_SIZE)));
          if (listPageNumber > lastPage) setListPageNumber(lastPage);
        })
        .catch((error: unknown) => {
          if (!active || sequence !== listSequence.current) return;
          setListError(errorMessage(error, 'Inventory records could not be loaded.'));
        })
        .finally(() => {
          if (active && sequence === listSequence.current) setListLoading(false);
        });
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [listPageNumber, listQuery, listRefreshKey, section]);

  useEffect(() => {
    if (
      section !== 'devices' ||
      assignmentMode === 'unassigned' ||
      assignmentSelected !== null ||
      assignmentQuery.trim().length < 2
    ) {
      return;
    }

    let active = true;
    const sequence = ++assignmentSearchSequence.current;
    const query = assignmentQuery.trim();
    const timer = window.setTimeout(() => {
      if (!active || sequence !== assignmentSearchSequence.current) return;
      setAssignmentLoading(true);
      searchRequesters(assignmentMode, query)
        .then((results) => {
          if (!active || sequence !== assignmentSearchSequence.current) return;
          setAssignmentResults(results);
          setAssignmentError(null);
        })
        .catch((error: unknown) => {
          if (!active || sequence !== assignmentSearchSequence.current) return;
          setAssignmentError(errorMessage(error, 'Directory search could not be completed.'));
        })
        .finally(() => {
          if (active && sequence === assignmentSearchSequence.current) setAssignmentLoading(false);
        });
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assignmentMode, assignmentQuery, assignmentSelected, section]);

  function refreshList() {
    setListError(null);
    setListLoading(true);
    setListRefreshKey((current) => current + 1);
  }

  function clearAssignmentLookup() {
    assignmentSearchSequence.current += 1;
    setAssignmentQuery('');
    setAssignmentSelected(null);
    setAssignmentResults([]);
    setAssignmentLoading(false);
    setAssignmentError(null);
    setAssignmentCurrentName(null);
  }

  function resetEditorState() {
    detailSequence.current += 1;
    assignedSequence.current += 1;
    clearAssignmentLookup();
    setSelectedId(null);
    setPersonDraft(null);
    setDeviceDraft(null);
    setDetailLoading(false);
    setDetailError(null);
    setEditorError(null);
    setPersonAssignedPage(null);
    setPersonAssignedLoading(false);
    setPersonAssignedError(null);
  }

  function beginAddPerson() {
    if (!personKind) return;
    resetEditorState();
    setPersonDraft(blankPerson(personKind));
  }

  function beginAddDevice() {
    resetEditorState();
    setDeviceDraft(blankDevice());
  }

  function loadPersonAssignedPage(personId: string, pageNumber: number) {
    const sequence = ++assignedSequence.current;
    setPersonAssignedLoading(true);
    setPersonAssignedError(null);
    listManagedDevices('', pageNumber, personId)
      .then((result) => {
        if (sequence !== assignedSequence.current) return;
        setPersonAssignedPage(result);
      })
      .catch((error: unknown) => {
        if (sequence !== assignedSequence.current) return;
        setPersonAssignedError(errorMessage(error, 'Assigned devices could not be loaded.'));
      })
      .finally(() => {
        if (sequence === assignedSequence.current) setPersonAssignedLoading(false);
      });
  }

  function selectPerson(personId: string, assignedPage = 1) {
    const sequence = ++detailSequence.current;
    assignedSequence.current += 1;
    setSelectedId(personId);
    setPersonDraft(null);
    setDeviceDraft(null);
    setDetailLoading(true);
    setDetailError(null);
    setEditorError(null);
    setPersonAssignedPage(null);
    setPersonAssignedLoading(true);
    setPersonAssignedError(null);

    getPerson(personId)
      .then((record) => {
        if (sequence !== detailSequence.current) return;
        setPersonDraft(personDraftFromRecord(record));
      })
      .catch((error: unknown) => {
        if (sequence !== detailSequence.current) return;
        setDetailError(errorMessage(error, 'The person record could not be loaded.'));
      })
      .finally(() => {
        if (sequence === detailSequence.current) setDetailLoading(false);
      });

    listManagedDevices('', assignedPage, personId)
      .then((result) => {
        if (sequence !== detailSequence.current) return;
        setPersonAssignedPage(result);
      })
      .catch((error: unknown) => {
        if (sequence !== detailSequence.current) return;
        setPersonAssignedError(errorMessage(error, 'Assigned devices could not be loaded.'));
      })
      .finally(() => {
        if (sequence === detailSequence.current) setPersonAssignedLoading(false);
      });
  }

  function selectDevice(deviceId: string) {
    const sequence = ++detailSequence.current;
    assignedSequence.current += 1;
    clearAssignmentLookup();
    setSelectedId(deviceId);
    setPersonDraft(null);
    setDeviceDraft(null);
    setDetailLoading(true);
    setDetailError(null);
    setEditorError(null);
    setPersonAssignedPage(null);
    setPersonAssignedLoading(false);
    setPersonAssignedError(null);

    getManagedDevice(deviceId)
      .then((record) => {
        if (sequence !== detailSequence.current) return;
        setDeviceDraft(deviceDraftFromRecord(record));
        setAssignmentMode(record.assignedKind ?? 'unassigned');
        setAssignmentCurrentName(record.assignedName);
        if (record.assignedRequesterId && record.assignedKind) {
          const requester = {
            id: record.assignedRequesterId,
            displayName: record.assignedName ?? 'Current assignee',
            externalId: null,
          };
          setAssignmentSelected(requester);
          setAssignmentQuery(requesterLabel(requester));
        }
      })
      .catch((error: unknown) => {
        if (sequence !== detailSequence.current) return;
        setDetailError(errorMessage(error, 'The device record could not be loaded.'));
      })
      .finally(() => {
        if (sequence === detailSequence.current) setDetailLoading(false);
      });
  }

  function updatePerson(patch: Partial<PersonDraft>) {
    setPersonDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateDevice(patch: Partial<DeviceDraft>) {
    setDeviceDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function handleAssignmentModeChange(mode: 'unassigned' | PersonKind) {
    assignmentSearchSequence.current += 1;
    setAssignmentMode(mode);
    setAssignmentQuery('');
    setAssignmentSelected(null);
    setAssignmentResults([]);
    setAssignmentLoading(false);
    setAssignmentError(null);
    setAssignmentCurrentName(null);
    updateDevice({ assignedRequesterId: null });
  }

  function handleAssignmentQueryChange(query: string) {
    assignmentSearchSequence.current += 1;
    setAssignmentQuery(query);
    setAssignmentSelected(null);
    setAssignmentResults([]);
    setAssignmentLoading(false);
    setAssignmentError(null);
    setAssignmentCurrentName(null);
    updateDevice({ assignedRequesterId: null });
  }

  function handleAssignmentSelect(requester: RequesterOption) {
    setAssignmentSelected(requester);
    setAssignmentQuery(requesterLabel(requester));
    setAssignmentResults([]);
    setAssignmentError(null);
    setAssignmentLoading(false);
    setAssignmentCurrentName(requester.displayName);
    updateDevice({ assignedRequesterId: requester.id });
  }

  async function onSavePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!personDraft) return;
    setEditorError(null);
    const input = personInputFromDraft(personDraft);

    if (!input.displayName) {
      setEditorError('Display name is required.');
      return;
    }
    if (input.kind === 'staff' && !input.email) {
      setEditorError('Staff email is required.');
      return;
    }
    if (input.kind === 'student' && !/^[0-9]+$/.test(input.externalId)) {
      setEditorError('OSIS must contain digits only.');
      return;
    }
    if (input.kind === 'student' && input.classOf && !/^[0-9]{4}$/.test(input.classOf)) {
      setEditorError('Class of must be a four-digit year.');
      return;
    }

    const result = await run(`inventory-person:${personDraft.id ?? 'new'}`, async () => {
      const saved = await savePerson(personDraft.id, personDraft.version, input);
      return saveActionResult(saved, `${personKindLabel(input.kind)} record saved.`);
    });

    if (!result.ok) {
      setEditorError(result.error ?? 'The person record could not be saved.');
      return;
    }

    if (input.kind === 'staff') {
      setStaffDepartments((current) => uniqueSorted([...current, input.department]));
      setStaffRoles((current) => uniqueSorted([...current, input.staffRole]));
    }
    refreshList();
    const savedId = result.id ?? personDraft.id;
    if (savedId) selectPerson(savedId, 1);
  }

  async function onSaveDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deviceDraft) return;
    setEditorError(null);
    const input = deviceInputFromDraft(deviceDraft);

    if (!input.deviceType || !input.manufacturer || !input.model || !input.serialNumber) {
      setEditorError('Device type, manufacturer, model, and serial number are required.');
      return;
    }
    if (assignmentMode !== 'unassigned' && !input.assignedRequesterId) {
      setEditorError('Select an assignee or choose Unassigned.');
      return;
    }

    const result = await run(`inventory-device:${deviceDraft.id ?? 'new'}`, async () => {
      const saved = await saveManagedDevice(deviceDraft.id, deviceDraft.version, input);
      return saveActionResult(saved, 'Device record saved.');
    });

    if (!result.ok) {
      setEditorError(result.error ?? 'The device record could not be saved.');
      return;
    }

    refreshList();
    const savedId = result.id ?? deviceDraft.id;
    if (savedId) selectDevice(savedId);
  }

  const editor = personSection ? personDraft : deviceDraft;
  const pageLabel = sectionTitle(section);
  const addLabel = personSection
    ? `Add ${personKindLabel(personKind ?? 'student').toLowerCase()}`
    : 'Add device';

  return (
    <>
      <PageHeader
        title={pageLabel}
        description={sectionDescription(section)}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={personSection ? beginAddPerson : beginAddDevice}
          >
            {addLabel}
          </button>
        }
      />

      <div className="inventory-manager">
        <section className="card inventory-list-card" aria-busy={listLoading || undefined}>
          <div className="toolbar inventory-toolbar">
            <Field
              label="Search"
              htmlFor={`inventory-${section}-search`}
              className="field-search"
              hint={
                personSection
                  ? 'Search by name, ID, or email.'
                  : 'Search by external ID, model, serial, or asset tag.'
              }
            >
              <input
                id={`inventory-${section}-search`}
                type="search"
                value={listQuery}
                placeholder={personSection ? 'Name, ID, or email' : 'ID, model, serial, or asset'}
                onChange={(event) => {
                  setListQuery(event.target.value);
                  setListPageNumber(1);
                  setListError(null);
                  setListLoading(true);
                }}
              />
            </Field>
            <span className="result-count">
              {listPage ? `${listPage.total.toLocaleString()} ${listPage.total === 1 ? 'record' : 'records'}` : 'Loading records…'}
            </span>
          </div>

          {listError ? (
            <p className="flash flash-error inventory-inline-error" role="alert">
              {listError}
            </p>
          ) : null}

          {!listPage && listLoading ? (
            <div className="inventory-loading" aria-live="polite">
              Loading records…
            </div>
          ) : listPage ? (
            personSection ? (
              <PersonTable
                page={listPage as InventoryPage<PersonRecord>}
                selectedId={selectedId}
                onSelect={selectPerson}
              />
            ) : (
              <DeviceTable
                page={listPage as InventoryPage<ManagedDevice>}
                selectedId={selectedId}
                onSelect={selectDevice}
              />
            )
          ) : null}

          {listPage && !listError ? (
            <Pagination
              page={listPage}
              label={pageLabel}
              disabled={listLoading || busy}
              onChange={(nextPage) => {
                setListPageNumber(nextPage);
                setListError(null);
                setListLoading(true);
              }}
            />
          ) : null}
        </section>

        <section className="card inventory-editor-card" aria-live="polite">
          {!editor && detailLoading ? (
            <div className="inventory-loading">Loading record…</div>
          ) : !editor && detailError ? (
            <div className="inventory-detail-error">
              <p className="flash flash-error" role="alert">
                {detailError}
              </p>
              <button type="button" className="btn" onClick={resetEditorState} disabled={busy}>
                Close
              </button>
            </div>
          ) : !editor ? (
            <EmptyState
              title={`Select a ${personSection ? 'person' : 'device'}`}
              action={
                <button
                  type="button"
                  className="btn"
                  onClick={personSection ? beginAddPerson : beginAddDevice}
                  disabled={busy}
                >
                  {addLabel}
                </button>
              }
            >
              Choose a row to review or edit its details.
            </EmptyState>
          ) : personSection && personDraft ? (
            <PersonEditor
              draft={personDraft}
              busy={busy}
              error={editorError ?? detailError}
              optionsError={optionsError}
              staffDepartments={staffDepartments}
              staffRoles={staffRoles}
              onChange={updatePerson}
              onSave={onSavePerson}
              onClose={resetEditorState}
              assignedPage={personAssignedPage}
              assignedLoading={personAssignedLoading}
              assignedError={personAssignedError}
              onAssignedPageChange={(pageNumber) => {
                if (personDraft.id) loadPersonAssignedPage(personDraft.id, pageNumber);
              }}
            />
          ) : !personSection && deviceDraft ? (
            <DeviceEditor
              draft={deviceDraft}
              busy={busy}
              error={editorError ?? detailError}
              optionsLoading={optionsLoading}
              optionsError={optionsError}
              catalogTypes={catalogTypes}
              catalogManufacturers={catalogManufacturers}
              catalogModels={catalogModels}
              statusOptions={statusOptions}
              assignmentMode={assignmentMode}
              assignmentQuery={assignmentQuery}
              assignmentSelected={assignmentSelected}
              assignmentResults={assignmentResults}
              assignmentLoading={assignmentLoading}
              assignmentError={assignmentError}
              assignmentCurrentName={assignmentCurrentName}
              onChange={updateDevice}
              onAssignmentModeChange={handleAssignmentModeChange}
              onAssignmentQueryChange={handleAssignmentQueryChange}
              onAssignmentSelect={handleAssignmentSelect}
              onSave={onSaveDevice}
              onClose={resetEditorState}
            />
          ) : null}
        </section>
      </div>
    </>
  );
}

function PersonTable({
  page,
  selectedId,
  onSelect,
}: {
  page: InventoryPage<PersonRecord>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (page.rows.length === 0) {
    return (
      <EmptyState title="No matching people">
        Try a different search, or add a new directory record.
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table className="tickets inventory-table">
        <caption className="sr-only">Directory people</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">External ID</th>
            <th scope="col">Email</th>
            <th scope="col">Assigned devices</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((person) => (
            <tr key={person.id} className={selectedId === person.id ? 'inventory-row-selected' : undefined}>
              <td className="cell-title" data-label="Name">
                <button
                  type="button"
                  className="inventory-row-select"
                  onClick={() => onSelect(person.id)}
                >
                  {person.displayName}
                </button>
                <span className="cell-sub">{personKindLabel(person.kind)}</span>
              </td>
              <td data-label="External ID" className="mono">
                {person.externalId || <span className="subtle">—</span>}
              </td>
              <td data-label="Email">
                {person.email || <span className="subtle">—</span>}
              </td>
              <td data-label="Assigned devices">
                {person.deviceCount === 0 ? <span className="subtle">None</span> : person.deviceCount}
              </td>
              <td data-label="Updated" className="small">
                {formatDateTime(person.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeviceTable({
  page,
  selectedId,
  onSelect,
}: {
  page: InventoryPage<ManagedDevice>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (page.rows.length === 0) {
    return (
      <EmptyState title="No matching devices">
        Try a different search, or add a new inventory device.
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table className="tickets inventory-table">
        <caption className="sr-only">Master inventory devices</caption>
        <thead>
          <tr>
            <th scope="col">External ID</th>
            <th scope="col">Device</th>
            <th scope="col">Serial</th>
            <th scope="col">Status</th>
            <th scope="col">Assigned to</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((device) => (
            <tr key={device.id} className={selectedId === device.id ? 'inventory-row-selected' : undefined}>
              <td data-label="External ID" className="cell-title">
                <button
                  type="button"
                  className="inventory-row-select mono"
                  onClick={() => onSelect(device.id)}
                >
                  {device.externalId}
                </button>
              </td>
              <td data-label="Device">
                <strong>{device.deviceType}</strong>
                <span className="cell-sub">
                  {device.manufacturer} {device.model}
                </span>
              </td>
              <td data-label="Serial" className="mono">
                {device.serialNumber || <span className="subtle">—</span>}
              </td>
              <td data-label="Status">
                <span className="badge badge-neutral">{device.status || 'No status'}</span>
              </td>
              <td data-label="Assigned to">
                {device.assignedName ?? <span className="subtle">Unassigned</span>}
              </td>
              <td data-label="Updated" className="small">
                {formatDateTime(device.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonEditor({
  draft,
  busy,
  error,
  optionsError,
  staffDepartments,
  staffRoles,
  onChange,
  onSave,
  onClose,
  assignedPage,
  assignedLoading,
  assignedError,
  onAssignedPageChange,
}: {
  draft: PersonDraft;
  busy: boolean;
  error: string | null;
  optionsError: string | null;
  staffDepartments: string[];
  staffRoles: string[];
  onChange: (patch: Partial<PersonDraft>) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  assignedPage: InventoryPage<ManagedDevice> | null;
  assignedLoading: boolean;
  assignedError: string | null;
  onAssignedPageChange: (page: number) => void;
}) {
  const student = draft.kind === 'student';
  const staff = draft.kind === 'staff';
  const displayedStaffId = draft.email.trim() ? staffExternalId(draft.email) : draft.externalId;
  const departmentOptions = uniqueSorted([...staffDepartments, draft.department]);
  const roleOptions = uniqueSorted([...staffRoles, draft.staffRole]);
  const departmentDatalistId = 'staff-directory-departments';
  const roleDatalistId = 'staff-directory-roles';

  return (
    <>
      <div className="inventory-editor-header">
        <div>
          <h2>{draft.id ? `Edit ${personKindLabel(draft.kind).toLowerCase()}` : `Add ${personKindLabel(draft.kind).toLowerCase()}`}</h2>
          <span className="badge badge-role">{personKindLabel(draft.kind)}</span>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>

      {error ? (
        <p className="flash flash-error inventory-editor-error" role="alert">
          {error}
        </p>
      ) : null}
      {optionsError ? (
        <p className="notice notice-warning inventory-editor-note">
          {optionsError}
        </p>
      ) : null}

      <form className="inventory-editor-form" onSubmit={onSave}>
        <div className="form-grid">
          <Field label="Display name" htmlFor="person-display-name" hint="Required.">
            <input
              id="person-display-name"
              type="text"
              required
              value={draft.displayName}
              disabled={busy}
              onChange={(event) => onChange({ displayName: event.target.value })}
            />
          </Field>
          <Field label="First name" htmlFor="person-first-name" optional>
            <input
              id="person-first-name"
              type="text"
              value={draft.firstName}
              disabled={busy}
              onChange={(event) => onChange({ firstName: event.target.value })}
            />
          </Field>
          <Field label="Last name" htmlFor="person-last-name" optional>
            <input
              id="person-last-name"
              type="text"
              value={draft.lastName}
              disabled={busy}
              onChange={(event) => onChange({ lastName: event.target.value })}
            />
          </Field>
          <Field
            label={student ? 'OSIS' : 'Staff ID'}
            htmlFor="person-external-id"
            optional={!student}
            hint={
              student
                ? 'Digits only; leading zeros are preserved.'
                : 'Read-only: lower-case email text before the @ sign.'
            }
          >
            <input
              id="person-external-id"
              type="text"
              inputMode={student ? 'numeric' : undefined}
              pattern={student ? '[0-9]+' : undefined}
              required={student}
              readOnly={staff}
              value={staff ? displayedStaffId : draft.externalId}
              disabled={busy}
              onChange={(event) => onChange({ externalId: event.target.value })}
            />
          </Field>
          <Field
            label="Email"
            htmlFor="person-email"
            optional={student}
            hint={staff ? 'Required for staff records.' : 'Optional; enter a valid address when present.'}
          >
            <input
              id="person-email"
              type="email"
              required={staff}
              value={draft.email}
              disabled={busy}
              onChange={(event) => {
                const email = event.target.value;
                onChange({
                  email,
                  ...(staff && email.trim() ? { externalId: staffExternalId(email) } : {}),
                });
              }}
            />
          </Field>

          {student ? (
            <>
              <Field label="Class of" htmlFor="person-class-of" optional hint="Four-digit year.">
                <input
                  id="person-class-of"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  value={draft.classOf}
                  disabled={busy}
                  onChange={(event) => {
                    if (!/^\d*$/.test(event.target.value)) return;
                    onChange({ classOf: event.target.value });
                  }}
                />
              </Field>
              <Field label="Official class" htmlFor="person-official-class" optional>
                <input
                  id="person-official-class"
                  type="text"
                  value={draft.officialClass}
                  disabled={busy}
                  onChange={(event) => onChange({ officialClass: event.target.value })}
                />
              </Field>
              <Field label="Enrollment status" htmlFor="person-student-status">
                <select
                  id="person-student-status"
                  value={draft.studentStatus}
                  disabled={busy}
                  onChange={(event) =>
                    onChange({
                      studentStatus: event.target.value as PersonDraft['studentStatus'],
                    })
                  }
                >
                  <option value="current">Current</option>
                  <option value="graduated">Graduated</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="Parent / guardian name" htmlFor="person-guardian-name" optional>
                <input
                  id="person-guardian-name"
                  type="text"
                  value={draft.guardianName}
                  disabled={busy}
                  onChange={(event) => onChange({ guardianName: event.target.value })}
                />
              </Field>
              <Field label="Parent / guardian phone" htmlFor="person-guardian-phone" optional>
                <input
                  id="person-guardian-phone"
                  type="tel"
                  value={draft.guardianPhone}
                  disabled={busy}
                  onChange={(event) => onChange({ guardianPhone: event.target.value })}
                />
              </Field>
              <Field label="Home phone" htmlFor="person-home-phone" optional>
                <input
                  id="person-home-phone"
                  type="tel"
                  value={draft.homePhone}
                  disabled={busy}
                  onChange={(event) => onChange({ homePhone: event.target.value })}
                />
              </Field>
              <Field label="Address" htmlFor="person-address" optional className="form-grid-full">
                <textarea
                  id="person-address"
                  value={draft.address}
                  disabled={busy}
                  onChange={(event) => onChange({ address: event.target.value })}
                  rows={2}
                />
              </Field>
            </>
          ) : null}

          {staff ? (
            <>
              <Field label="School DBN" htmlFor="person-school-dbn" optional>
                <input
                  id="person-school-dbn"
                  type="text"
                  value={draft.schoolDbn}
                  disabled={busy}
                  onChange={(event) => onChange({ schoolDbn: event.target.value })}
                />
              </Field>
              <Field label="Department" htmlFor="person-department" optional hint="New values are allowed.">
                <input
                  id="person-department"
                  type="text"
                  list={departmentDatalistId}
                  value={draft.department}
                  disabled={busy}
                  onChange={(event) => onChange({ department: event.target.value })}
                />
                <datalist id={departmentDatalistId}>
                  {departmentOptions.map((value) => <option key={value} value={value} />)}
                </datalist>
              </Field>
              <Field label="Staff role" htmlFor="person-staff-role" optional hint="New values are allowed.">
                <input
                  id="person-staff-role"
                  type="text"
                  list={roleDatalistId}
                  value={draft.staffRole}
                  disabled={busy}
                  onChange={(event) => onChange({ staffRole: event.target.value })}
                />
                <datalist id={roleDatalistId}>
                  {roleOptions.map((value) => <option key={value} value={value} />)}
                </datalist>
              </Field>
            </>
          ) : null}
              <Field label="Notes" htmlFor="person-notes" optional className="form-grid-full">
                <textarea
                  id="person-notes"
                  value={draft.notes}
                  disabled={busy}
                  onChange={(event) => onChange({ notes: event.target.value })}
                  rows={3}
                />
              </Field>
        </div>

        <div className="inventory-form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add record'}
          </button>
        </div>
      </form>

      {draft.id ? (
        <section className="inventory-assigned-detail">
          <div className="inventory-subheading">
            <h3>Assigned devices</h3>
            {assignedLoading ? <span className="small subtle">Loading…</span> : null}
          </div>
          {assignedError ? (
            <p className="field-error" role="alert">
              {assignedError}
            </p>
          ) : assignedPage && assignedPage.rows.length > 0 ? (
            <div className="stack-sm">
              {assignedPage.rows.map((device) => (
                <div className="inventory-assigned-row" key={device.id}>
                  <strong>{device.deviceType}</strong>
                  <span className="small subtle">
                    {device.manufacturer} {device.model} · {device.serialNumber || 'No serial'}
                  </span>
                </div>
              ))}
            </div>
          ) : assignedPage ? (
            <p className="small subtle">No assigned devices.</p>
          ) : null}
          {assignedPage ? (
            <Pagination
              page={assignedPage}
              label="Assigned device"
              disabled={assignedLoading || busy}
              onChange={onAssignedPageChange}
            />
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function DeviceEditor({
  draft,
  busy,
  error,
  optionsLoading,
  optionsError,
  catalogTypes,
  catalogManufacturers,
  catalogModels,
  statusOptions,
  assignmentMode,
  assignmentQuery,
  assignmentSelected,
  assignmentResults,
  assignmentLoading,
  assignmentError,
  assignmentCurrentName,
  onChange,
  onAssignmentModeChange,
  onAssignmentQueryChange,
  onAssignmentSelect,
  onSave,
  onClose,
}: {
  draft: DeviceDraft;
  busy: boolean;
  error: string | null;
  optionsLoading: boolean;
  optionsError: string | null;
  catalogTypes: string[];
  catalogManufacturers: string[];
  catalogModels: string[];
  statusOptions: string[];
  assignmentMode: 'unassigned' | PersonKind;
  assignmentQuery: string;
  assignmentSelected: RequesterOption | null;
  assignmentResults: RequesterOption[];
  assignmentLoading: boolean;
  assignmentError: string | null;
  assignmentCurrentName: string | null;
  onChange: (patch: Partial<DeviceDraft>) => void;
  onAssignmentModeChange: (mode: 'unassigned' | PersonKind) => void;
  onAssignmentQueryChange: (query: string) => void;
  onAssignmentSelect: (requester: RequesterOption) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const datalistId = 'inventory-catalog-types';
  const manufacturerDatalistId = 'inventory-catalog-manufacturers';
  const modelDatalistId = 'inventory-catalog-models';

  return (
    <>
      <div className="inventory-editor-header">
        <div>
          <h2>{draft.id ? 'Edit device' : 'Add device'}</h2>
          <span className="badge badge-role">Master inventory</span>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>

      {error ? (
        <p className="flash flash-error inventory-editor-error" role="alert">
          {error}
        </p>
      ) : null}
      {optionsError ? (
        <p className="notice notice-warning inventory-editor-note">
          {optionsError} You can still enter new catalog values manually.
        </p>
      ) : optionsLoading ? (
        <p className="small subtle inventory-editor-note">Loading catalog suggestions…</p>
      ) : null}

      <form className="inventory-editor-form" onSubmit={onSave}>
        <div className="form-grid">
          <Field
            label="External ID"
            htmlFor="device-external-id"
            optional={!draft.id}
            hint={draft.id ? 'Generated inventory identifier.' : 'Generated when the record is saved.'}
          >
            <input
              id="device-external-id"
              type="text"
              value={draft.externalId}
              placeholder={draft.id ? undefined : 'Assigned on save'}
              readOnly
              disabled={busy}
            />
          </Field>
          <Field label="Status" htmlFor="device-status" optional>
            <select
              id="device-status"
              value={draft.status}
              disabled={busy}
              onChange={(event) => onChange({ status: event.target.value })}
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status || 'No status'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Device type" htmlFor="device-type" hint="Required; new values are allowed.">
            <input
              id="device-type"
              type="text"
              list={datalistId}
              required
              value={draft.deviceType}
              disabled={busy}
              onChange={(event) => onChange({ deviceType: event.target.value })}
            />
            <datalist id={datalistId}>
              {catalogTypes.map((value) => <option key={value} value={value} />)}
            </datalist>
          </Field>
          <Field label="Manufacturer" htmlFor="device-manufacturer" hint="Required; new values are allowed.">
            <input
              id="device-manufacturer"
              type="text"
              list={manufacturerDatalistId}
              required
              value={draft.manufacturer}
              disabled={busy}
              onChange={(event) => onChange({ manufacturer: event.target.value })}
            />
            <datalist id={manufacturerDatalistId}>
              {catalogManufacturers.map((value) => <option key={value} value={value} />)}
            </datalist>
          </Field>
          <Field label="Model" htmlFor="device-model" hint="Required; new values are allowed.">
            <input
              id="device-model"
              type="text"
              list={modelDatalistId}
              required
              value={draft.model}
              disabled={busy}
              onChange={(event) => onChange({ model: event.target.value })}
            />
            <datalist id={modelDatalistId}>
              {catalogModels.map((value) => <option key={value} value={value} />)}
            </datalist>
          </Field>
          <Field label="Serial number" htmlFor="device-serial" hint="Required.">
            <input
              id="device-serial"
              type="text"
              required
              value={draft.serialNumber}
              disabled={busy}
              onChange={(event) => onChange({ serialNumber: event.target.value })}
            />
          </Field>
          <Field label="Asset tag" htmlFor="device-asset-tag" optional>
            <input
              id="device-asset-tag"
              type="text"
              value={draft.assetTag}
              disabled={busy}
              onChange={(event) => onChange({ assetTag: event.target.value })}
            />
          </Field>
          <Field label="OS version" htmlFor="device-os-version" optional>
            <input
              id="device-os-version"
              type="text"
              value={draft.osVersion}
              disabled={busy}
              onChange={(event) => onChange({ osVersion: event.target.value })}
            />
          </Field>
          <Field label="Location" htmlFor="device-location" optional>
            <input
              id="device-location"
              type="text"
              value={draft.location}
              disabled={busy}
              onChange={(event) => onChange({ location: event.target.value })}
            />
          </Field>

          <Field label="Assignment" htmlFor="device-assignment-kind" className="form-grid-full">
            <select
              id="device-assignment-kind"
              value={assignmentMode}
              disabled={busy}
              onChange={(event) =>
                onAssignmentModeChange(event.target.value as 'unassigned' | PersonKind)
              }
            >
              <option value="unassigned">Unassigned</option>
              <option value="staff">Staff</option>
              <option value="student">Student</option>
            </select>
            {assignmentMode !== 'unassigned' ? (
              <div className="inventory-assignment-search">
                <SearchSelect<RequesterOption>
                  id="device-assignment-search"
                  value={assignmentSelected}
                  query={assignmentQuery}
                  options={assignmentResults}
                  getOptionKey={(requester) => requester.id}
                  getOptionLabel={requesterLabel}
                  onQueryChange={onAssignmentQueryChange}
                  onSelect={onAssignmentSelect}
                  placeholder={
                    assignmentMode === 'staff' ? 'Search staff name' : 'Search name or OSIS'
                  }
                  loading={assignmentLoading}
                  disabled={busy}
                  emptyText={
                    assignmentQuery.trim().length < 2
                      ? 'Enter at least two characters.'
                      : 'No matching requester.'
                  }
                />
              </div>
            ) : null}
            {assignmentCurrentName ? (
              <span className="field-hint">Current assignee: {assignmentCurrentName}</span>
            ) : null}
            {assignmentError ? (
              <span className="field-error" role="alert">
                {assignmentError}
              </span>
            ) : null}
          </Field>
          <Field label="Notes" htmlFor="device-notes" optional className="form-grid-full">
            <textarea
              id="device-notes"
              value={draft.notes}
              disabled={busy}
              onChange={(event) => onChange({ notes: event.target.value })}
              rows={3}
            />
          </Field>
        </div>

        <div className="inventory-form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add device'}
          </button>
        </div>
      </form>
    </>
  );
}
