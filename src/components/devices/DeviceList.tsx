'use client';

/**
 * The inventory list.
 *
 * The search term and the page live in the URL and are applied by
 * `app_list_inventory` against the district's 4,278 machines: one search over
 * every field of a machine and its holder, which is the whole of the owner's
 * filter surface. Rows can be ticked, on the table or on the phone cards, and
 * a bar for the selection carries the four things somebody does to a batch:
 * restatus them, move them, hand them out, take them back.
 *
 * Status and location are a patch — one statement over a list of ids, through
 * `app_bulk_update_inventory`, which snapshots every machine it changes.
 * Assign and return are not: each writes a holder, a status and an
 * `inventory_events` row together, and the version check that stops two people
 * assigning the same machine is per machine. So those walk the selection one
 * at a time and report what actually happened. A cart of thirty going out to a
 * class is the reason they are here at all.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import {
  bulkAssignDevicesAction,
  bulkReturnDevicesAction,
  bulkUpdateDevicesAction,
} from '@/lib/data/device-actions';
import type { BulkDevicePatch } from '@/lib/data/device-bulk';
import type { DeviceFacets, DevicesPage } from '@/lib/data/devices';
import { countLabel } from '@/lib/domain/records';
import { deviceLabel, type DeviceSummary } from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { DeviceStatusBadge } from '@/components/Badges';
import { EmptyState, Field, TimeAgo } from '@/components/Primitives';
import { Button, ButtonLink } from '@/components/ui/Button';
import { deviceTypeLabel } from '@/lib/domain/device-types';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { AssignDeviceDialog } from './AssignDeviceDialog';
import { ChangeStatusDialog } from './ChangeStatusDialog';
import { MoveDeviceDialog } from './MoveDeviceDialog';
import { ReturnDeviceDialog } from './ReturnDeviceDialog';

type BulkDialog = 'status' | 'move' | 'assign' | 'return' | null;

const SEARCH_DEBOUNCE_MS = 250;
const BULK_KEY = 'bulk-devices';

/**
 * One row's checkbox. Declared here, not inside the list, so React keeps the
 * same element across renders: a component declared in the parent's body is a
 * new type every render, which remounts the box and drops keyboard focus on
 * every tick.
 */
function RowCheck({
  device,
  checked,
  onToggle,
}: {
  device: DeviceSummary;
  checked: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <label className="row-check">
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Select ${deviceLabel(device)}`}
        onChange={(event) => onToggle(device.id, event.target.checked)}
      />
    </label>
  );
}

export function DeviceList({
  page,
  statuses,
  facets,
}: {
  page: DevicesPage;
  statuses: string[];
  /** The types and locations the inventory actually holds. */
  facets: DeviceFacets;
}) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();

  const current = useMemo(
    () => ({
      query: searchParams.get('query') ?? '',
      requester: searchParams.get('requester') ?? '',
      status: searchParams.get('status') ?? '',
      type: searchParams.get('type') ?? '',
      location: searchParams.get('location') ?? '',
    }),
    [searchParams],
  );

  const filtersActive =
    current.query.trim() !== '' ||
    current.requester !== '' ||
    current.status !== '' ||
    current.type !== '' ||
    current.location !== '';

  function updateParams(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    next.delete('page');
    const query = next.toString();
    startNavigation(() => router.replace(query ? `${pathname}?${query}` : pathname));
  }

  const [query, setQuery] = useState(current.query);
  // The URL's value the box was last set from. When it changes underneath
  // (Clear filters, the back button), the box follows during render, which is
  // React's way of deriving state from a prop without an extra effect pass.
  const [seen, setSeen] = useState(current.query);
  if (seen !== current.query) {
    setSeen(current.query);
    setQuery(current.query);
  }
  useEffect(() => {
    if (query === current.query) return;
    const timer = setTimeout(() => updateParams({ query }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // updateParams reads the latest params itself; re-running on every
    // params change would restart the pause mid-word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, current.query]);

  function hrefForPage(target: number): string {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    const params = next.toString();
    return params ? `${pathname}?${params}` : pathname;
  }

  const { devices, total, pageCount } = page;

  // The locations already in use on this page, offered as suggestions so a
  // cart keeps one spelling. There is no facet RPC over 4,278 machines, and a
  // page of fifty is where an operator's next move usually is.
  const locations = useMemo(
    () => [...new Set(devices.map((device) => device.location).filter(Boolean))].sort(),
    [devices],
  );

  // Ticked ids. Only the ones on the current page count: a filter or a page
  // change cannot leave a hidden row in the selection, and the ids fall out of
  // the set the next time it is rebuilt.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const selected = useMemo(() => {
    const onPage = new Set(devices.map((device) => device.id));
    return new Set([...ticked].filter((id) => onPage.has(id)));
  }, [ticked, devices]);

  const [dialog, setDialog] = useState<BulkDialog>(null);
  const allOnPage = devices.length > 0 && devices.every((device) => selected.has(device.id));
  const someOnPage = devices.some((device) => selected.has(device.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someOnPage && !allOnPage;
  }, [someOnPage, allOnPage]);

  function toggle(id: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setTicked(on ? new Set(devices.map((device) => device.id)) : new Set());
  }

  async function bulk(patch: BulkDevicePatch): Promise<ActionResult> {
    return runOverSelection((ids) => bulkUpdateDevicesAction(ids, patch));
  }

  /*
   * The selection is read once, before the call: a refresh half way through
   * would otherwise change what "selected" means under the action. It is
   * cleared only on success, so a failure leaves the rows ticked and the
   * person can try again without picking thirty machines a second time.
   */
  async function runOverSelection(
    call: (ids: string[]) => Promise<ActionResult>,
  ): Promise<ActionResult> {
    const ids = [...selected];
    const result = await run(BULK_KEY, () => call(ids));
    if (result.ok) {
      setTicked(new Set());
      router.refresh();
    }
    return result;
  }

  const bulkPending = pendingKey === BULK_KEY;
  const subject = countLabel(selected.size, 'device');
  const busy = navigating;

  const columns: Column<DeviceSummary>[] = [
    {
      key: 'select',
      header: (
        <label className="row-check">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allOnPage}
            aria-label="Select every device on this page"
            onChange={(event) => toggleAll(event.target.checked)}
          />
        </label>
      ),
      hideOnPhone: true,
      width: 40,
      cell: (device) => (
        <RowCheck device={device} checked={selected.has(device.id)} onToggle={toggle} />
      ),
    },
    {
      key: 'tag',
      header: 'Asset tag',
      mono: true,
      hideOnPhone: true,
      width: 180,
      cell: (device) => (
        <div className="dir-cell-title">
          <Link href={`/devices/${device.id}`} className="dir-tag row-link">
            {deviceLabel(device)}
          </Link>
          {device.serialNumber && device.assetTag ? (
            <span className="dir-serial mono">{device.serialNumber}</span>
          ) : device.assetTag || device.serialNumber ? (
            <span className="dir-serial mono">{device.externalId}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      hideOnPhone: true,
      cell: (device) => (
        <div className="dir-cell-title">
          <span className="dir-name">
            {device.model || <span className="dir-quiet">Unknown model</span>}
          </span>
          <span className="dir-sub">
            {[device.manufacturer, deviceTypeLabel(device.deviceType)].filter(Boolean).join(', ')}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 140,
      cell: (device) => <DeviceStatusBadge status={device.status} />,
    },
    {
      key: 'holder',
      header: 'Holder',
      width: 200,
      cell: (device) =>
        device.assignedRequesterId && device.assignedName ? (
          <Link href={`/people/${device.assignedRequesterId}`}>{device.assignedName}</Link>
        ) : (
          <span className="dir-quiet">Nobody</span>
        ),
    },
    {
      key: 'location',
      header: 'Location',
      hideOnPhone: true,
      width: 160,
      cell: (device) => device.location || <span className="dir-quiet">Not recorded</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      hideOnPhone: true,
      width: 96,
      cell: (device) => (
        <span className="dir-age">
          <TimeAgo iso={device.updatedAt} mode="age" />
        </span>
      ),
    },
  ];

  return (
    <section className="panel directory" data-busy={busy || undefined} aria-busy={busy || undefined}>
      <FilterBar
        label="Inventory filters"
        active={filtersActive}
        clearHref={pathname}
        summary={busy ? 'Loading' : countLabel(total, 'device')}
      >
        <div className="dir-filters">
          <Field label="Search" htmlFor="devices-search" className="field-search">
            <input
              id="devices-search"
              type="search"
              name="query"
              autoComplete="off"
              placeholder="Asset tag, serial, model, room or holder"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') updateParams({ query });
              }}
            />
          </Field>

          {/*
            * Exact, where the search box is not. "repair" typed into the box
            * also matches a note, a model name and a room; the columns are how
            * somebody asks for every Chromebook in repair and means it.
            *
            * Each control is offered only when the inventory has something to
            * put in it — a filter with one option is a control that cannot
            * change anything.
            */}
          <Field label="Status" htmlFor="devices-status">
            <Select
              id="devices-status"
              value={current.status}
              onChange={(value) => updateParams({ status: value })}
              options={[
                { value: '', label: 'Any status' },
                ...statuses.map((status) => ({ value: status, label: status })),
              ]}
            />
          </Field>

          {facets.types.length > 1 ? (
            <Field label="Type" htmlFor="devices-type">
              <Select
                id="devices-type"
                value={current.type}
                onChange={(value) => updateParams({ type: value })}
                options={[
                  { value: '', label: 'Any type' },
                  ...facets.types.map((type) => ({ value: type, label: type })),
                ]}
              />
            </Field>
          ) : null}

          {facets.locations.length > 1 ? (
            <Field label="Location" htmlFor="devices-location">
              <Select
                id="devices-location"
                value={current.location}
                onChange={(value) => updateParams({ location: value })}
                options={[
                  { value: '', label: 'Any location' },
                  ...facets.locations.map((location) => ({ value: location, label: location })),
                ]}
              />
            </Field>
          ) : null}
        </div>
      </FilterBar>

      {current.requester ? (
        <p className="panel-note">
          Showing one person&apos;s devices. <Link href={pathname}>Show the whole inventory</Link>.
        </p>
      ) : null}

      {devices.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="No devices match this search"
            action={<ButtonLink href={pathname}>Clear the search</ButtonLink>}
          >
            Try fewer characters of the tag or serial. The search reads every field of a machine
            and of whoever is holding it.
          </EmptyState>
        ) : (
          <EmptyState
            title="No devices yet"
            action={
              <ButtonLink href="/devices/new" icon={Plus} variant="primary">
                Add a device
              </ButtonLink>
            }
          >
            The inventory is empty. Add a machine, or ask an administrator to load it.
          </EmptyState>
        )
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={devices}
            rowKey={(device) => device.id}
            caption="Devices in the inventory"
            settle
            cardTitle={(device) => (
              <span className="dir-card-title">
                <RowCheck device={device} checked={selected.has(device.id)} onToggle={toggle} />
                <Link href={`/devices/${device.id}`} className="mono">
                  {deviceLabel(device)}
                </Link>
              </span>
            )}
            cardMeta={(device) =>
              [device.model || 'Unknown model', deviceTypeLabel(device.deviceType)]
                .filter(Boolean)
                .join(', ')
            }
          />

          {selected.size > 0 ? (
            <div className="bulk-bar" role="region" aria-label="Selected devices">
              <span className="bulk-bar-count" aria-live="polite">
                {selected.size} selected
              </span>
              <div className="bulk-bar-actions">
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('status')}>
                  Change status
                </Button>
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('move')}>
                  Move to location
                </Button>
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('assign')}>
                  Assign to
                </Button>
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('return')}>
                  Return
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="bulk-bar-clear"
                disabled={bulkPending}
                onClick={() => setTicked(new Set())}
              >
                Clear
              </Button>
            </div>
          ) : null}

          <Pagination
            page={page.page}
            pageCount={pageCount}
            hrefFor={hrefForPage}
            label="Inventory pages"
          />
        </>
      )}

      <ChangeStatusDialog
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        subject={subject}
        statuses={statuses}
        pending={bulkPending}
        onSubmit={({ status }) => bulk({ status })}
      />
      <MoveDeviceDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        locations={locations}
        pending={bulkPending}
        onSubmit={(location) => bulk({ location })}
      />
      {/* The note is offered only for a single machine: a handover's note is
          about that machine and that person, and the same sentence copied onto
          thirty histories is noise in all thirty. */}
      <AssignDeviceDialog
        open={dialog === 'assign'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        pending={bulkPending}
        onSubmit={({ person, note }) =>
          runOverSelection((ids) => bulkAssignDevicesAction(ids, person.id, note))
        }
      />
      <ReturnDeviceDialog
        open={dialog === 'return'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        statuses={statuses}
        pending={bulkPending}
        onSubmit={({ status, note }) =>
          runOverSelection((ids) => bulkReturnDevicesAction(ids, status, note))
        }
      />
    </section>
  );
}
