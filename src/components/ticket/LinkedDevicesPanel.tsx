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
 * The search is `DevicePicker`, the same type-ahead the inventory uses: a
 * server action rather than a list handed to the browser, because the
 * inventory is 7,500 machines and shipping it to every ticket page would be
 * both slow and a copy of school data sitting in a client bundle. Each linked
 * machine links to its own page.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { deviceLabel } from '@/lib/domain/types';
import { linkDeviceAction, unlinkDeviceAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { DevicePicker } from '@/components/devices/DevicePicker';
import { Button } from '@/components/ui/Button';

export function LinkedDevicesPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const mayLink = canContribute(ticket, actor);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = pendingKey !== null;
  const count = detail.linkedDevices.length;
  const searchInputId = `link-device-${ticket.id}`;

  const onLink = useCallback(
    async (deviceId: string) => {
      setError(null);
      const result = await run(`link-device:${ticket.id}`, () =>
        linkDeviceAction(ticket.id, deviceId),
      );
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'That device could not be linked.');
    },
    [run, ticket.id],
  );

  // Keyed by DEVICE, not by ticket: one key for the whole list spins every
  // row's button at once, which reads as "all of them are being removed".
  const unlinkKey = (deviceId: string) => `unlink-device:${ticket.id}:${deviceId}`;

  async function onUnlink(deviceId: string) {
    setError(null);
    const result = await run(unlinkKey(deviceId), () =>
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
                  <Link href={`/devices/${device.id}`} className="person-name mono">
                    {deviceLabel(device)}
                  </Link>
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
                      loading={pendingKey === unlinkKey(device.id)}
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
          <DevicePicker
            id={searchInputId}
            autoFocus
            disabled={busy}
            error={error}
            onSelect={(device) => void onLink(device.id)}
            excludeIds={[...linkedIds]}
            excludeNote="already linked"
          />
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
