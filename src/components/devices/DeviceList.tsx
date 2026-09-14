'use client';

/**
 * The inventory list.
 *
 * Filters and pagination live in the URL and are applied by the database
 * (`app_list_devices`, SECURITY INVOKER) against the rows RLS allows. Rows
 * can be ticked, on the table or on the phone cards, and a bar for the
 * selection appears with the four things a technician does to a batch:
 * hand them to somebody, change their status, move them, take them back.
 * Each goes through `app_bulk_update_devices`, which applies nothing at all
 * when any device refuses and names that device in its message.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import { bulkUpdateDevicesAction } from '@/lib/data/device-actions';
import type { BulkDevicePatch } from '@/lib/data/device-bulk';
import type { DeviceFacets, DevicesPage, HolderFilter } from '@/lib/data/devices';
import { countLabel } from '@/lib/domain/records';
import {
  DEVICE_STATUS_LABELS,
  DEVICE_STATUSES,
  deviceLabel,
  type DeviceSummary,
} from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { DeviceStatusBadge } from '@/components/Badges';
import { EmptyState, Field, TimeAgo } from '@/components/Primitives';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AssignDeviceDialog } from './AssignDeviceDialog';
import { ChangeStatusDialog } from './ChangeStatusDialog';
import { MoveDeviceDialog } from './MoveDeviceDialog';
import { ReturnDeviceDialog } from './ReturnDeviceDialog';

type HolderChoice = 'all' | HolderFilter;

const HOLDER_OPTIONS: { value: HolderChoice; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'student', label: 'Students' },
  { value: 'staff', label: 'Staff' },
  { value: 'none', label: 'In stock' },
];

type BulkDialog = 'assign' | 'status' | 'move' | 'return' | null;

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

export function DeviceList({ page, facets }: { page: DevicesPage; facets: DeviceFacets }) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();

  const current = useMemo(
    () => ({
      query: searchParams.get('query') ?? '',
      type: searchParams.get('type') ?? 'all',
      status: searchParams.get('status') ?? 'all',
      location: searchParams.get('location') ?? 'all',
      holder: (searchParams.get('holder') ?? 'all') as HolderChoice,
    }),
    [searchParams],
  );

  const filtersActive =
    current.query.trim() !== '' ||
    current.type !== 'all' ||
    current.status !== 'all' ||
    current.location !== 'all' ||
    current.holder !== 'all';

  function updateParams(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === '' || value === 'all') next.delete(name);
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
    const ids = [...selected];
    const result = await run(BULK_KEY, () => bulkUpdateDevicesAction(ids, patch));
    if (result.ok) setTicked(new Set());
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
          <Link href={`/devices/${device.id}`} className="dir-tag">
            {deviceLabel(device)}
          </Link>
          {device.serialNumber && device.assetTag ? (
            <span className="dir-serial mono">{device.serialNumber}</span>
          ) : device.deviceId && (device.assetTag || device.serialNumber) ? (
            <span className="dir-serial mono">{device.deviceId}</span>
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
          <span className="dir-name">{device.model ?? <span className="dir-quiet">Unknown model</span>}</span>
          <span className="dir-sub">{device.type}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      cell: (device) => <DeviceStatusBadge status={device.status} />,
    },
    {
      key: 'holder',
      header: 'Holder',
      width: 200,
      cell: (device) =>
        device.holderId && device.holderName ? (
          <Link href={`/people/${device.holderId}`}>{device.holderName}</Link>
        ) : (
          <span className="dir-quiet">{device.status === 'in_stock' ? 'In stock' : 'Nobody'}</span>
        ),
    },
    {
      key: 'location',
      header: 'Location',
      hideOnPhone: true,
      width: 160,
      cell: (device) => device.location ?? <span className="dir-quiet">Not recorded</span>,
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
              placeholder="Asset tag, serial, device ID or model"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') updateParams({ query });
              }}
            />
          </Field>
          <Field label="Type" htmlFor="devices-type">
            <select
              id="devices-type"
              value={current.type}
              onChange={(event) => updateParams({ type: event.target.value })}
            >
              <option value="all">Any type</option>
              {facets.types.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status" htmlFor="devices-status">
            <select
              id="devices-status"
              value={current.status}
              onChange={(event) => updateParams({ status: event.target.value })}
            >
              <option value="all">Any status</option>
              {DEVICE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {DEVICE_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location" htmlFor="devices-location">
            <select
              id="devices-location"
              value={current.location}
              onChange={(event) => updateParams({ location: event.target.value })}
            >
              <option value="all">Anywhere</option>
              {facets.locations.map((location) => (
                <option key={location} value={location}>
                  {location}
                </option>
              ))}
            </select>
          </Field>
          <div className="field field-segmented">
            <span className="field-label">Holder</span>
            <SegmentedControl
              label="Holder"
              value={current.holder}
              options={HOLDER_OPTIONS}
              onChange={(value) => updateParams({ holder: value })}
            />
          </div>
        </div>
      </FilterBar>

      {devices.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="No devices match these filters"
            action={<ButtonLink href={pathname}>Clear filters</ButtonLink>}
          >
            Try fewer characters of the tag or serial, or clear a filter.
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
            Import the inventory or add a device.
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
            cardMeta={(device) => `${device.model ?? 'Unknown model'}, ${device.type}`}
          />

          {selected.size > 0 ? (
            <div className="bulk-bar" role="region" aria-label="Selected devices">
              <span className="bulk-bar-count" aria-live="polite">
                {selected.size} selected
              </span>
              <div className="bulk-bar-actions">
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('assign')}>
                  Assign to person
                </Button>
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('status')}>
                  Change status
                </Button>
                <Button size="sm" disabled={bulkPending} onClick={() => setDialog('move')}>
                  Move to location
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

          <Pagination page={page.page} pageCount={pageCount} hrefFor={hrefForPage} label="Inventory pages" />
        </>
      )}

      <AssignDeviceDialog
        open={dialog === 'assign'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        allowNote={false}
        pending={bulkPending}
        onSubmit={({ person }) => bulk({ personId: person.id })}
      />
      <ChangeStatusDialog
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        pending={bulkPending}
        onSubmit={({ status, reason }) => bulk({ status, reason })}
      />
      <MoveDeviceDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        locations={facets.locations}
        pending={bulkPending}
        onSubmit={(location) => bulk({ location })}
      />
      <ReturnDeviceDialog
        open={dialog === 'return'}
        onClose={() => setDialog(null)}
        subject={subject}
        count={selected.size}
        allowNote={false}
        pending={bulkPending}
        onSubmit={({ status }) => bulk({ return: true, status })}
      />
    </section>
  );
}
