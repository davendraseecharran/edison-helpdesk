'use client';

/**
 * What to do with the machine you just scanned.
 *
 * A scan used to end on the device's page, which is right when the question is
 * "what is this machine". It is the wrong answer to the question a NetRider
 * actually has with a cart in front of them: they are checking twenty
 * Chromebooks back in, and a page load per machine is nineteen page loads
 * nobody wanted.
 *
 * So the scan puts a card in the corner instead, naming the machine and
 * offering the three things anybody does next. Return happens right there —
 * the common one, and the one that makes scan, tap, scan, tap a rhythm. Assign
 * and Open go to the page, because assigning needs a person and opening is the
 * whole point of opening.
 *
 * The next scan replaces the card. It is a thing in your hand, not a log.
 *
 * Built on `routeScannedCode`, which is the one place that decides what a
 * scanned code means, so the palette's camera button and the paired phone
 * cannot drift apart.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Laptop, X } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useReducedMotion } from '@/components/ui/media';
import { returnDeviceAction } from '@/lib/data/device-actions';
import { devicePath } from '@/lib/scan/route';
import { say } from '@/lib/voice/moments';
import '@/styles/scan-card.css';
import '@/styles/voice.css';

/** Dispatched on `window` when a scan resolved to exactly one machine. */
export const SCANNED_DEVICE_EVENT = 'edison:scanned-device';

export interface ScannedDevice {
  id: string;
  label: string;
}

export function announceScannedDevice(device: ScannedDevice): void {
  window.dispatchEvent(new CustomEvent(SCANNED_DEVICE_EVENT, { detail: device }));
}

/** Reads the event's payload defensively; it crosses a window boundary. */
export function readScannedDevice(event: Event): ScannedDevice | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== 'object') return null;
  const { id, label } = detail as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return null;
  return { id, label: typeof label === 'string' && label !== '' ? label : id };
}

export function ScannedDeviceCard() {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const reduced = useReducedMotion();
  const [device, setDevice] = useState<ScannedDevice | null>(null);
  /** The machine that was just put back, for the line that marks it. */
  const [returned, setReturned] = useState<string | null>(null);

  useEffect(() => {
    function onScanned(event: Event) {
      const next = readScannedDevice(event);
      if (next === null) return;
      setReturned(null);
      setDevice(next);
    }
    window.addEventListener(SCANNED_DEVICE_EVENT, onScanned);
    return () => window.removeEventListener(SCANNED_DEVICE_EVENT, onScanned);
  }, []);

  const close = useCallback(() => {
    setDevice(null);
    setReturned(null);
  }, []);

  const returnIt = useCallback(async () => {
    if (!device) return;
    const result = await run(`return:${device.id}`, () => returnDeviceAction(device.id));
    if (!result.ok) return;
    // A device back on the shelf is one of the few moments worth naming, and
    // the card is where it happened.
    setReturned(say('device.returned', { subject: device.label }));
  }, [device, run]);

  if (!device) return null;

  const busy = pendingKey !== null;

  return (
    <div className="scan-card" role="status">
      <div className="scan-card-head">
        <Icon icon={Laptop} size={16} className="scan-card-glyph" />
        <span className="scan-card-label mono">{device.label}</span>
        <button type="button" className="scan-card-close" aria-label="Dismiss" onClick={close}>
          <Icon icon={X} size={14} />
        </button>
      </div>

      {returned ? (
        <p className={reduced ? 'scan-card-done' : 'scan-card-done voice-mark'}>{returned}</p>
      ) : (
        <div className="scan-card-actions">
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            loading={pendingKey === `return:${device.id}`}
            onClick={() => void returnIt()}
          >
            Return
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              close();
              router.push(`${devicePath(device.id)}?do=assign`);
            }}
          >
            Assign
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              close();
              router.push(devicePath(device.id));
            }}
          >
            Open
          </Button>
        </div>
      )}
    </div>
  );
}
