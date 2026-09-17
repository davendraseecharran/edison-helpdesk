'use client';

/**
 * The whole due-back list: every machine Today shows the head of.
 *
 * Same rows as Today, same two actions, laid out as a table because a page
 * is for working down a list rather than glancing at one. Returning a
 * machine takes it off the list on the next server read, which `run()`
 * asks for after every action, so the row goes without the page reloading.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { markDeviceAvailableAction, returnDeviceAction } from '@/lib/data/device-actions';
import { ageLabel } from '@/lib/format';
import { DUE_LABELS, deviceCode, deviceTitle, type DueDevice } from '@/lib/domain/today';
import { AVAILABLE_STATUS } from '@/lib/domain/types';

export function DueBackList({
  devices,
  /** The request clock, so the first paint's ages match the server's. */
  now,
}: {
  devices: DueDevice[];
  now: number;
}) {
  const { run } = useRuntime();
  const [pending, setPending] = useState<string | null>(null);
  const at = new Date(now);

  const returnDevice = useCallback(
    async (device: DueDevice) => {
      setPending(device.id);
      try {
        await run(`return:${device.id}`, () =>
          device.holderName
            ? returnDeviceAction(device.id, AVAILABLE_STATUS, null, device.version)
            : // Nobody holds it, so there is nobody to take it back from; what it
              // needs is its status put right. The same split Today makes.
              markDeviceAvailableAction(device.id, device.version, AVAILABLE_STATUS),
        );
      } finally {
        setPending(null);
      }
    },
    [run],
  );

  const columns: Column<DueDevice>[] = [
    {
      key: 'device',
      header: 'Device',
      hideOnPhone: true,
      cell: (device) => (
        <div className="dir-cell-title">
          <Link href={`/devices/${device.id}`} className="dir-name row-link">
            {deviceTitle(device)}
          </Link>
          <span className="dir-sub mono">{deviceCode(device)}</span>
        </div>
      ),
    },
    {
      key: 'holder',
      header: 'Holder',
      cell: (device) => device.holderName ?? <span className="dir-quiet">Nobody</span>,
    },
    {
      key: 'reason',
      header: 'Why',
      cell: (device) => DUE_LABELS[device.reason],
    },
    {
      key: 'since',
      header: 'Since',
      align: 'right',
      width: 96,
      cell: (device) => ageLabel(device.since, at),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      width: 140,
      cell: (device) => (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending !== null}
          loading={pending === device.id}
          onClick={() => void returnDevice(device)}
        >
          {device.holderName ? 'Return' : 'Mark available'}
        </Button>
      ),
    },
  ];

  return (
    <section className="panel directory">
      <DataTable
        columns={columns}
        rows={devices}
        rowKey={(device) => device.id}
        cardTitle={(device) => (
          <Link href={`/devices/${device.id}`} className="dir-name row-link">
            {deviceTitle(device)}
          </Link>
        )}
        cardMeta={(device) => deviceCode(device)}
        caption="Machines due back, oldest first"
        settle
      />
    </section>
  );
}
