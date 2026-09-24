'use client';

/**
 * Check a device: scan it, and see who has it.
 *
 * The question a NetRider is asked most in a corridor — whose is this, is it
 * meant to be here, is there a ticket on it — answered in one scan with a
 * card: the holder with their OSIS or staff id, the status and location,
 * since when, the open tickets on it and the last three things that happened
 * to it. The things somebody does next are on the card, so a check that turns
 * into a return is one more press, not a trip to another page.
 *
 * Read-only by itself. It reuses the scan loop's inputs — the field a USB
 * scanner types into, the camera, a paired phone — but not its session:
 * nothing is changed by a scan here, so there is nothing to undo.
 *
 * Each scan replaces the card, which leaves upward as the new one rises into
 * its place (the screen's one moment); the checks before it stay below, one
 * line each, and a press brings one back.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Camera,
  ChevronLeft,
  CircleAlert,
  ExternalLink,
  MapPin,
  Plus,
  Printer,
  Smartphone,
  Ticket,
  UserRound,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { DeviceStatusBadge } from '@/components/Badges';
import { Avatar, TimeAgo } from '@/components/Primitives';
import { AssignDeviceDialog } from '@/components/devices/AssignDeviceDialog';
import { MoveDeviceDialog } from '@/components/devices/MoveDeviceDialog';
import { ReturnDeviceDialog } from '@/components/devices/ReturnDeviceDialog';
import { openLookup } from '@/components/shell/LookupBar';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { AnimatePresence, EASE_OUT, EASE_OUT_FAST, motion } from '@/components/ui/Motion';
import { useReducedMotion } from '@/components/ui/media';
import type { ActionResult } from '@/lib/data/actions';
import { checkDeviceAction, checkDeviceByIdAction } from '@/lib/data/device-check-actions';
import { assignDeviceAction, bulkUpdateDevicesAction, returnDeviceAction } from '@/lib/data/device-actions';
import {
  checkedGlance,
  checkedSubtitle,
  RECENT_CHECKS,
  SCANNED_CODE_EVENT,
  type CheckedDevice,
  type CheckResult,
} from '@/lib/domain/device-check';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { labelsHref } from '@/lib/labels/layout';
import {
  feedback,
  soundPreferenceSnapshot,
  subscribeSoundPreference,
  writeSoundPreference,
} from '@/lib/workflows/feedback';
import { PhonePairing } from './PhonePairing';
import { ScanInput, type ScanInputHandle } from './ScanInput';
import { WorkflowCamera } from './WorkflowCamera';
import { CHECK_ICON } from './icons';

interface Check {
  /** Unique per scan: the card's identity for the transition. */
  key: string;
  code: string;
  at: number;
  result: CheckResult | null;
}

type Dialog = 'assign' | 'return' | 'move' | null;

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `check-${counter}`;
}

function wallClock(): number {
  return Date.now();
}

export function DeviceCheck({
  initialCode,
  statuses,
  locations,
}: {
  initialCode: string;
  statuses: string[];
  locations: string[];
}) {
  const { pendingKey, run } = useRuntime();
  const reduced = useReducedMotion();
  const sound = useSyncExternalStore(subscribeSoundPreference, soundPreferenceSnapshot, () => true);
  const [current, setCurrent] = useState<Check | null>(null);
  const [recent, setRecent] = useState<Check[]>([]);
  const [camera, setCamera] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const input = useRef<ScanInputHandle>(null);
  const currentRef = useRef<Check | null>(null);
  const soundRef = useRef(sound);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  const show = useCallback((next: Check) => {
    const previous = currentRef.current;
    currentRef.current = next;
    setCurrent(next);
    if (previous && previous.result?.kind === 'device') {
      const shown = previous;
      setRecent((list) =>
        [shown, ...list.filter((one) => !sameDevice(one, shown))].slice(0, RECENT_CHECKS),
      );
    }
  }, []);

  const settle = useCallback((key: string, result: CheckResult) => {
    if (currentRef.current?.key !== key) return;
    const next = { ...currentRef.current, result };
    currentRef.current = next;
    setCurrent(next);
    feedback(result.kind === 'device' || result.kind === 'person' ? 'done' : 'error', soundRef.current);
  }, []);

  const check = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (code === '') return;
      const key = nextKey();
      show({ key, code, at: wallClock(), result: null });
      void checkDeviceAction(code).then(
        (result) => settle(key, result),
        () => settle(key, { kind: 'error', code, message: 'That did not reach the helpdesk. Scan it again.' }),
      );
    },
    [show, settle],
  );

  const checkId = useCallback(
    (id: string, label: string) => {
      const key = nextKey();
      show({ key, code: label, at: wallClock(), result: null });
      void checkDeviceByIdAction(id).then(
        (result) => settle(key, result),
        () => settle(key, { kind: 'error', code: label, message: 'That did not reach the helpdesk. Try again.' }),
      );
    },
    [show, settle],
  );

  /** The card again, fresh from the database, after something changed it. */
  const refresh = useCallback(async (id: string) => {
    const key = currentRef.current?.key;
    if (!key) return;
    try {
      const result = await checkDeviceByIdAction(id);
      if (currentRef.current?.key !== key) return;
      const next = { ...currentRef.current, result };
      currentRef.current = next;
      setCurrent(next);
    } catch {
      // The card keeps what it had; the change itself was reported by its toast.
    }
  }, []);

  // A code in the link (the corner card's "Check", the palette) is checked on arrival.
  // After the first paint, so the card rises in rather than being there.
  useEffect(() => {
    if (initialCode.trim() === '') return;
    const timer = window.setTimeout(() => check(initialCode), 0);
    return () => window.clearTimeout(timer);
  }, [initialCode, check]);

  // A scan from the top bar's paired phone comes here while this page is open.
  useEffect(() => {
    function onScanned(event: Event) {
      const code = (event as CustomEvent<unknown>).detail;
      if (typeof code !== 'string' || code.trim() === '') return;
      event.preventDefault();
      check(code);
    }
    window.addEventListener(SCANNED_CODE_EVENT, onScanned);
    return () => window.removeEventListener(SCANNED_CODE_EVENT, onScanned);
  }, [check]);

  const device = current?.result?.kind === 'device' ? current.result.device : null;
  const busy = pendingKey !== null;

  async function after(result: ActionResult): Promise<ActionResult> {
    // `run` has already refreshed the server's data; the card reads its own.
    if (result.ok && device) {
      await refresh(device.id);
      input.current?.focus();
    }
    return result;
  }

  return (
    <div className="wf-run dc">
      <header className="wf-run-head">
        <Link href="/workflows" className="wf-back">
          <Icon icon={ChevronLeft} size={16} weight="medium" />
          Workflows
        </Link>
        <div className="wf-run-heading">
          <h1 className="wf-run-title">Check a device</h1>
        </div>
      </header>

      <div className="dc-stage">
        <div className="wf-console panel">
          <ScanInput
            ref={input}
            id="dc-scan"
            label="Scan a device to check it"
            placeholder="Scan or type a tag or serial"
            hint="Nothing changes when you scan here. Each scan shows who has it."
            submitLabel="Check"
            active
            onCode={check}
          />
          <div className="wf-sources">
            <Button
              variant={camera ? 'primary' : 'secondary'}
              size="sm"
              icon={Camera}
              aria-pressed={camera}
              onClick={() => setCamera((open) => !open)}
            >
              {camera ? 'Camera on' : 'Use camera'}
            </Button>
            <Button
              variant={pairing ? 'primary' : 'secondary'}
              size="sm"
              icon={Smartphone}
              className="wf-pair-button"
              aria-pressed={pairing}
              onClick={() => setPairing((open) => !open)}
            >
              Scan with your phone
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={sound ? Volume2 : VolumeX}
              className="wf-sound"
              aria-pressed={sound}
              aria-label={sound ? 'Sound on' : 'Sound off'}
              title={sound ? 'Sound on' : 'Sound off'}
              onClick={() => writeSoundPreference(!sound)}
            />
          </div>
          {camera ? (
            <WorkflowCamera
              onCode={check}
              onClose={() => setCamera(false)}
              title="Check a device"
              note="Hold a tag in the frame. Who has it shows as soon as it ticks."
              feed={current ? <CheckGlance check={current} /> : null}
            />
          ) : null}
          {pairing ? <PhonePairing label="Check a device" onCode={check} onClose={() => setPairing(false)} /> : null}
        </div>

        <div className="dc-slot" aria-live="polite">
          <AnimatePresence mode="popLayout" initial={false}>
            {current ? (
              <motion.div
                key={current.key}
                className="dc-card-wrap"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: EASE_OUT }}
                exit={reduced ? { opacity: 0, transition: EASE_OUT_FAST } : { opacity: 0, y: -14, scale: 0.985, transition: EASE_OUT_FAST }}
              >
                <CheckCard
                  check={current}
                  busy={busy}
                  pendingKey={pendingKey}
                  onPick={checkId}
                  onAction={setDialog}
                />
              </motion.div>
            ) : (
              <motion.div key="empty" className="dc-empty" exit={{ opacity: 0, transition: EASE_OUT_FAST }}>
                <Icon icon={CHECK_ICON} size={28} />
                <p className="dc-empty-title">Scan a device to see who has it</p>
                <p className="dc-empty-body">
                  Its holder, where it should be, any open tickets, and what happened to it last.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {recent.length > 0 ? (
          <section className="dc-recent" aria-labelledby="dc-recent-title">
            <h2 id="dc-recent-title" className="wf-section-title">
              Checked before
            </h2>
            <ul className="dc-recent-list">
              {recent.map((one) =>
                one.result?.kind === 'device' ? (
                  <li key={one.key}>
                    <button
                      type="button"
                      className="dc-recent-row pressable"
                      onClick={() => checkId((one.result as { device: CheckedDevice }).device.id, one.code)}
                    >
                      <span className="mono dc-recent-tag">{one.result.device.label}</span>
                      <span className="dc-recent-glance">{checkedGlance(one.result.device)}</span>
                      <span className="dc-recent-time">
                        <TimeAgo iso={new Date(one.at).toISOString()} />
                      </span>
                    </button>
                  </li>
                ) : null,
              )}
            </ul>
          </section>
        ) : null}
      </div>

      {device ? (
        <>
          <AssignDeviceDialog
            open={dialog === 'assign'}
            onClose={() => setDialog(null)}
            subject={device.label}
            pending={pendingKey === `assign:${device.id}`}
            currentHolderId={device.holder?.id ?? null}
            onSubmit={async ({ person, note }) =>
              after(
                await run(`assign:${device.id}`, () =>
                  assignDeviceAction(device.id, person.id, note, device.version),
                ),
              )
            }
          />
          <ReturnDeviceDialog
            open={dialog === 'return'}
            onClose={() => setDialog(null)}
            subject={device.label}
            statuses={statuses}
            pending={pendingKey === `return:${device.id}`}
            onSubmit={async ({ status, note }) =>
              after(
                await run(`return:${device.id}`, () => returnDeviceAction(device.id, status, note, device.version)),
              )
            }
          />
          <MoveDeviceDialog
            open={dialog === 'move'}
            onClose={() => setDialog(null)}
            subject={device.label}
            current={device.location}
            locations={locations}
            pending={pendingKey === `move:${device.id}`}
            onSubmit={async (location) =>
              after(await run(`move:${device.id}`, () => bulkUpdateDevicesAction([device.id], { location })))
            }
          />
        </>
      ) : null}
    </div>
  );
}

function sameDevice(a: Check, b: Check): boolean {
  return (
    a.result?.kind === 'device' && b.result?.kind === 'device' && a.result.device.id === b.result.device.id
  );
}

/** One line under the camera on a phone: what the last scan found. */
function CheckGlance({ check }: { check: Check }) {
  const result = check.result;
  return (
    <p className="dc-glance">
      <span className="mono">{result?.kind === 'device' ? result.device.label : check.code}</span>
      <span>
        {result === null
          ? 'Looking up'
          : result.kind === 'device'
            ? checkedGlance(result.device)
            : result.kind === 'person'
              ? `${result.person.displayName}'s ID`
              : result.kind === 'ambiguous'
                ? 'Two machines share this code'
                : result.kind === 'unknown'
                  ? 'Not in the inventory'
                  : result.message}
      </span>
    </p>
  );
}

function CheckCard({
  check,
  busy,
  pendingKey,
  onPick,
  onAction,
}: {
  check: Check;
  busy: boolean;
  pendingKey: string | null;
  onPick: (id: string, label: string) => void;
  onAction: (dialog: Dialog) => void;
}) {
  const result = check.result;

  if (result === null) {
    return (
      <article className="dc-card panel" aria-busy="true">
        <p className="dc-tag mono">{check.code}</p>
        <p className="dc-looking">Looking it up</p>
      </article>
    );
  }

  if (result.kind === 'device') {
    return <DeviceCard device={result.device} busy={busy} pendingKey={pendingKey} onAction={onAction} />;
  }

  if (result.kind === 'ambiguous') {
    return (
      <article className="dc-card panel" data-tone="warn">
        <p className="dc-tag mono">{result.code}</p>
        <p className="dc-headline">More than one machine has this code. Which one is in your hand?</p>
        <div className="dc-choices">
          {result.options.map((option) => (
            <Button key={option.id} size="sm" onClick={() => onPick(option.id, option.label)}>
              <span className="mono">{option.label}</span>
            </Button>
          ))}
        </div>
      </article>
    );
  }

  if (result.kind === 'person') {
    const person = result.person;
    return (
      <article className="dc-card panel">
        <div className="dc-holder">
          <Avatar name={person.displayName} size="md" />
          <div className="dc-holder-text">
            <p className="dc-headline">That is an ID card, not a machine.</p>
            <Link href={`/people/${person.id}`} className="dc-holder-name">
              {person.displayName}
            </Link>
            <span className="dc-holder-meta">
              {PERSON_KIND_LABELS[person.kind]}
              {person.externalId ? (
                <>
                  , <span className="mono">{person.externalId}</span>
                </>
              ) : null}
              , holds {person.holding === 1 ? '1 machine' : `${person.holding} machines`}
            </span>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="dc-card panel" data-tone="bad">
      <p className="dc-tag mono">{result.code}</p>
      <p className="dc-headline">
        <Icon icon={CircleAlert} size={16} />
        {result.kind === 'unknown' ? 'Not in the inventory.' : result.message}
      </p>
      {result.kind === 'unknown' ? (
        <>
          <p className="dc-body">Check the label and scan it again, or search for part of it.</p>
          <div className="dc-actions">
            <Button size="sm" onClick={() => openLookup(result.code)}>
              Search for it
            </Button>
          </div>
        </>
      ) : null}
    </article>
  );
}

function DeviceCard({
  device,
  busy,
  pendingKey,
  onAction,
}: {
  device: CheckedDevice;
  busy: boolean;
  pendingKey: string | null;
  onAction: (dialog: Dialog) => void;
}) {
  const subtitle = checkedSubtitle(device);
  const holder = device.holder;

  return (
    <article className="dc-card panel" aria-label={`${device.label}: ${checkedGlance(device)}`}>
      <header className="dc-card-head">
        <div className="dc-card-title">
          <h2 className="dc-tag mono">{device.label}</h2>
          {subtitle ? <p className="dc-subtitle">{subtitle}</p> : null}
        </div>
        <DeviceStatusBadge status={device.status} />
      </header>

      <div className="dc-holder" data-empty={holder ? undefined : ''}>
        {holder ? (
          <>
            <Avatar name={holder.name} size="md" />
            <div className="dc-holder-text">
              <Link href={`/people/${holder.id}`} className="dc-holder-name">
                {holder.name}
              </Link>
              <span className="dc-holder-meta">
                {PERSON_KIND_LABELS[holder.kind]}
                {holder.externalId ? (
                  <>
                    , {holder.kind === 'student' ? 'OSIS' : 'staff id'} <span className="mono">{holder.externalId}</span>
                  </>
                ) : null}
                {device.assignedAt ? (
                  <>
                    , since <TimeAgo iso={device.assignedAt} />
                  </>
                ) : null}
              </span>
            </div>
          </>
        ) : (
          <>
            <span className="dc-holder-glyph" aria-hidden="true">
              <Icon icon={UserRound} size={18} />
            </span>
            <div className="dc-holder-text">
              <span className="dc-holder-name">Nobody has it</span>
              <span className="dc-holder-meta">It is {device.status.trim() ? device.status : 'without a status'}.</span>
            </div>
          </>
        )}
      </div>

      <dl className="dc-facts">
        <div>
          <dt>
            <Icon icon={MapPin} size={14} />
            Location
          </dt>
          <dd>{device.location || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Serial</dt>
          <dd className="mono">{device.serialNumber || 'None'}</dd>
        </div>
      </dl>

      <div className="dc-section">
        <h3 className="dc-section-title">
          <Icon icon={Ticket} size={14} />
          Open tickets
        </h3>
        {device.openTickets.length === 0 ? (
          <p className="dc-quiet">None you can see.</p>
        ) : (
          <ul className="dc-tickets">
            {device.openTickets.slice(0, 4).map((ticket) => (
              <li key={ticket.id}>
                <Link href={`/tickets/${ticket.id}`} className="dc-ticket">
                  <span className="mono dc-ticket-number">{ticket.number}</span>
                  <span className="dc-ticket-title">{ticket.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dc-section">
        <h3 className="dc-section-title">Last changes</h3>
        {device.recent.length === 0 ? (
          <p className="dc-quiet">Nothing recorded yet.</p>
        ) : (
          <ol className="dc-history">
            {device.recent.map((event) => (
              <li key={event.id}>
                <span className="dc-history-summary">{event.summary}</span>
                <span className="dc-history-time">
                  <TimeAgo iso={event.at} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="dc-actions" role="group" aria-label={`Actions for ${device.label}`}>
        {holder ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            loading={pendingKey === `return:${device.id}`}
            onClick={() => onAction('return')}
          >
            Return
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            loading={pendingKey === `assign:${device.id}`}
            onClick={() => onAction('assign')}
          >
            Assign
          </Button>
        )}
        {holder ? (
          <Button size="sm" disabled={busy} onClick={() => onAction('assign')}>
            Reassign
          </Button>
        ) : null}
        <Button size="sm" disabled={busy} loading={pendingKey === `move:${device.id}`} onClick={() => onAction('move')}>
          Move
        </Button>
        <ButtonLink size="sm" icon={Plus} href={`/tickets/new?device=${device.id}`}>
          New ticket
        </ButtonLink>
        <ButtonLink size="sm" icon={Printer} href={labelsHref([device.id])}>
          Print label
        </ButtonLink>
        <ButtonLink size="sm" variant="ghost" icon={ExternalLink} href={`/devices/${device.id}`}>
          Open
        </ButtonLink>
      </div>
    </article>
  );
}
