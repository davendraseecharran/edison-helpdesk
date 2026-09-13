'use client';

/**
 * The inventory machines a ticket names.
 *
 * Deliberately separate from "Devices observed" below it, because the two
 * record different things. An observation is what a technician saw and wrote
 * down, and has to keep working for a laptop that is not in the inventory at
 * all. A link is a claim that a specific inventory record is involved, which is
 * what makes the machine's own page show this ticket.
 *
 * The search is a server action rather than a list handed to the browser: the
 * inventory is 7,500 machines, and shipping it to every ticket page would be
 * both slow and a copy of school data sitting in a client bundle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { linkDeviceAction, unlinkDeviceAction } from '@/lib/data/actions';
import { searchDevicesAction, type DeviceSearchResult } from '@/lib/data/device-actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';

/** Long enough that a technician has stopped typing, short enough to feel live. */
const DEBOUNCE_MS = 200;

function deviceLabel(device: {
  assetTag: string | null;
  serialNumber: string | null;
  deviceId: string | null;
}): string {
  // The same order app_device_label uses in the database, so a machine reads the
  // same way here as it does in the history this panel writes.
  return device.assetTag ?? device.serialNumber ?? device.deviceId ?? 'Unlabelled device';
}

export function LinkedDevicesPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const mayLink = canContribute(ticket, actor);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DeviceSearchResult[]>([]);
  /** The term `results` belongs to. Anything else on screen is stale. */
  const [searched, setSearched] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Only the newest search may write to state: a slow early request must not
  // overwrite the results of the one the operator is actually waiting for.
  const searchId = useRef(0);

  const busy = pendingKey !== null;
  const count = detail.linkedDevices.length;
  const searchInputId = `link-device-${ticket.id}`;

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) return;
    const id = searchId.current + 1;
    searchId.current = id;
    const timer = setTimeout(() => {
      void searchDevicesAction(term).then((found) => {
        if (searchId.current !== id) return;
        setResults(found);
        setSearched(term);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Derived rather than stored, so nothing has to be cleared: a term the
  // results do not belong to shows nothing, which is what "still typing" means.
  const term = query.trim();
  const shown = searched === term && term.length >= 2 ? results : [];

  const onLink = useCallback(
    async (deviceId: string) => {
      setError(null);
      const result = await run(`link-device:${ticket.id}`, () =>
        linkDeviceAction(ticket.id, deviceId),
      );
      if (result.ok) {
        setQuery('');
        setResults([]);
        setSearched('');
        setOpen(false);
      } else {
        setError(result.error ?? 'That device could not be linked.');
      }
    },
    [run, ticket.id],
  );

  async function onUnlink(deviceId: string) {
    setError(null);
    const result = await run(`unlink-device:${ticket.id}`, () =>
      unlinkDeviceAction(ticket.id, deviceId),
    );
    if (!result.ok) setError(result.error ?? 'That device could not be unlinked.');
  }

  const linkedIds = new Set(detail.linkedDevices.map((device) => device.id));

  return (
    <section className="panel" aria-labelledby={`linked-devices-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`linked-devices-heading-${ticket.id}`}>
          Linked devices
        </h2>
        <div className="panel-head-end">
          <span className="panel-aside">
            {count} {count === 1 ? 'device' : 'devices'}
          </span>
          {mayLink ? (
            <Button
              size="sm"
              icon={open ? undefined : Plus}
              aria-expanded={open}
              aria-controls={open ? searchInputId : undefined}
              onClick={() => {
                setOpen((value) => !value);
                setError(null);
              }}
            >
              {open ? 'Cancel' : 'Link device'}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="panel-body stack-sm">
        {count === 0 ? (
          <p className="panel-empty">
            No devices from the inventory are linked. A room-wide fault may legitimately have
            none.
          </p>
        ) : (
          <ul className="linked-devices">
            {detail.linkedDevices.map((device) => (
              <li className="linked-device" key={device.id}>
                <span className="person-text">
                  <span className="person-name mono">{deviceLabel(device)}</span>
                  <span className="person-meta">
                    {device.type}
                    {device.model ? `, ${device.model}` : ''} — linked by{' '}
                    {nameOf(directory, device.linkedById)}, <TimeAgo iso={device.linkedAt} />
                  </span>
                </span>
                {mayLink ? (
                  <span className="person-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      loading={pendingKey === `unlink-device:${ticket.id}`}
                      onClick={() => void onUnlink(device.id)}
                    >
                      Unlink
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {open && mayLink ? (
          <div className="picker">
            <Field
              label="Find a device"
              htmlFor={searchInputId}
              error={error}
              hint="Search by asset tag, serial number or model."
            >
              <input
                id={searchInputId}
                type="search"
                autoComplete="off"
                value={query}
                aria-invalid={error ? 'true' : undefined}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="DOE-LN1221779"
              />
            </Field>
            <p className="picker-status" role="status">
              {term.length < 2
                ? 'Type at least two characters.'
                : searched !== term
                  ? 'Searching…'
                  : `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}`}
            </p>
            {shown.length > 0 ? (
              <ul className="picker-results">
                {shown.map((device) => {
                  const already = linkedIds.has(device.id);
                  return (
                    <li key={device.id}>
                      <button
                        type="button"
                        className="picker-option"
                        disabled={already || busy}
                        aria-disabled={already ? 'true' : undefined}
                        onClick={() => void onLink(device.id)}
                      >
                        <span className="picker-option-name mono">{device.label}</span>
                        <span className="picker-option-meta">
                          {device.type}
                          {device.model ? `, ${device.model}` : ''}
                          {device.holderName ? ` — held by ${device.holderName}` : ''}
                          {already ? ' — already linked' : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}

        {error && !open ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
