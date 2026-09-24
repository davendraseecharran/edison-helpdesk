'use client';

/**
 * One workflow, from choosing the target to the summary.
 *
 * Three phases. SETUP asks what the scans are for, and is skipped when the
 * link already said (a shortcut, a "run again"). SCAN is the loop: one field
 * that holds the keyboard for a USB scanner, the camera, a paired phone, the
 * list, and beside it the thing the run is filling — the cart, the audit's
 * three piles, the person at the front of the line. FINISHED keeps the list
 * and puts the summary above it.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, ChevronLeft, Smartphone, Timer, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { showToast } from '@/components/ui/shadcn/sonner';
import { recordWorkflowRunAction, workflowLocationDevicesAction } from '@/lib/data/workflow-actions';
import {
  targetLabel,
  targetReady,
  workflowFor,
  workflowHref,
  type WorkflowKind,
  type WorkflowTarget,
} from '@/lib/domain/workflows';
import {
  auditDiff,
  auditMachines,
  countRows,
  formatElapsed,
  summaryText,
  undoQueue,
  type ExpectedDevice,
  type SessionRow,
} from '@/lib/workflows/session';
import { AuditBoard } from './AuditBoard';
import { AuditResolution } from './AuditResolution';
import { FinishSummary } from './FinishSummary';
import { HandoutPanel } from './HandoutPanel';
import { LaptopCart } from './LaptopCart';
import { PhonePairing } from './PhonePairing';
import { ScanInput, type ScanInputHandle } from './ScanInput';
import { ScanList } from './ScanList';
import { SettleNumber } from './SettleNumber';
import { TargetStep } from './TargetStep';
import { useScanSession } from './useScanSession';
import { WorkflowCamera } from './WorkflowCamera';

type Phase = 'setup' | 'loading' | 'scan' | 'finished';

export interface WorkflowRunnerProps {
  kind: WorkflowKind;
  initialTarget: WorkflowTarget;
  locations: string[];
  statuses: string[];
}

/** The time, read in an event handler rather than during a render. */
function wallClock(): number {
  return Date.now();
}

/** Kinds that read the location's own list before the first scan. */
function readsLocation(kind: WorkflowKind): boolean {
  return kind === 'move' || kind === 'audit';
}

/**
 * Where a run opens. A hand-out has no setup; a link that already names its
 * target goes straight to scanning; a bare collection link shows its two
 * choices first, even though it could start without them.
 */
function initialPhase(kind: WorkflowKind, target: WorkflowTarget): Phase {
  if (kind === 'handout') return 'scan';
  if (kind === 'collect') return target.location !== '' || target.status !== '' ? 'scan' : 'setup';
  if (!targetReady(kind, target)) return 'setup';
  return readsLocation(kind) ? 'loading' : 'scan';
}

export function WorkflowRunner({ kind, initialTarget, locations, statuses }: WorkflowRunnerProps) {
  const router = useRouter();
  const info = workflowFor(kind);
  const [target, setTarget] = useState<WorkflowTarget>(initialTarget);
  const [phase, setPhase] = useState<Phase>(() => initialPhase(kind, initialTarget));
  const [expected, setExpected] = useState<ExpectedDevice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [personSince, setPersonSince] = useState(0);
  const input = useRef<ScanInputHandle>(null);

  const session = useScanSession({ kind, target, expected });
  const { rows, person } = session;

  // The room's own list, read once the target is known.
  useEffect(() => {
    if (phase !== 'loading') return;
    let cancelled = false;
    void workflowLocationDevicesAction(target.location).then(
      (result) => {
        if (cancelled) return;
        if (result.ok) {
          setExpected(result.devices);
          setPhase('scan');
        } else if (kind === 'audit') {
          setLoadError(result.error);
          setPhase('setup');
        } else {
          // A cart can still be loaded without knowing what is already in it.
          setPhase('scan');
        }
      },
      () => {
        if (cancelled) return;
        if (kind === 'audit') {
          setLoadError('The room’s list could not be read. Try again.');
          setPhase('setup');
        } else {
          setPhase('scan');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase, target.location, kind]);

  // The run's clock starts at its first scan and ticks while it is open.
  const startedAt = rows.length > 0 ? rows[rows.length - 1].at : null;
  useEffect(() => {
    if (phase !== 'scan' || startedAt === null) return;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    const first = window.setTimeout(tick, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [phase, startedAt]);
  const elapsed = startedAt === null ? 0 : Math.max(0, (finishedAt ?? now ?? startedAt) - startedAt);

  const counts = countRows(rows);
  const label = targetLabel(kind, target);
  const diff = useMemo(
    () => (kind === 'audit' ? auditDiff(target.location, expected, auditMachines(rows)) : null),
    [kind, target.location, expected, rows],
  );

  const choosePerson = session.choosePerson;
  const onChoosePerson = useCallback(
    (next: Parameters<typeof choosePerson>[0]) => {
      choosePerson(next);
      setPersonSince(wallClock());
      input.current?.focus();
    },
    [choosePerson],
  );

  // A card scanned mid-run switches the person; mark when, for "given".
  const latest = session.latest;
  const [seenPersonRow, setSeenPersonRow] = useState<string | null>(null);
  if (latest?.state === 'person' && latest.key !== seenPersonRow) {
    setSeenPersonRow(latest.key);
    setPersonSince(latest.at);
  }
  const given = person
    ? rows.filter(
        (row) =>
          row.at >= personSince &&
          row.state === 'done' &&
          row.undo !== 'undone' &&
          row.targetKey === `person:${person.id}`,
      ).length
    : 0;

  function start(next: WorkflowTarget) {
    setTarget(next);
    setLoadError(null);
    setPhase(readsLocation(kind) ? 'loading' : 'scan');
    // The URL says what is running, so a reload or a shared link lands here.
    router.replace(workflowHref(kind, next), { scroll: false });
  }

  async function finish() {
    const at = wallClock();
    setFinishedAt(at);
    setPhase('finished');
    setCamera(false);
    setPairing(false);
    if (counts.scanned === 0) return;
    const audit = diff;
    const result = await recordWorkflowRunAction({
      kind,
      label,
      location: target.location,
      status: target.status,
      done: audit ? audit.found.length : counts.done,
      skipped: audit ? audit.missing.length : counts.skipped,
      errors: counts.errors,
      startedAt: new Date(startedAt ?? at).toISOString(),
    });
    if (!result.ok) showToast('error', result.error ?? 'The run could not be recorded. The scans still count.');
  }

  function keepScanning() {
    setFinishedAt(null);
    setPhase('scan');
  }

  function newRun() {
    session.reset();
    setExpected([]);
    setFinishedAt(null);
    setNow(null);
    setCamera(false);
    setPairing(false);
    setPhase(kind === 'handout' ? 'scan' : 'setup');
    router.replace(workflowHref(kind), { scroll: false });
  }

  // Every machine the run touched, once, for "Print labels for these".
  const labelIds = useMemo(() => runDeviceIds(rows), [rows]);

  const headline = headlineFor(kind, label, counts.done, diff?.found.length ?? 0, expected.length, rows);
  const scanning = phase === 'scan';

  return (
    <div className="wf-run" data-kind={kind}>
      <header className="wf-run-head">
        <Link href="/workflows" className="wf-back">
          <Icon icon={ChevronLeft} size={16} weight="medium" />
          Workflows
        </Link>
        <div className="wf-run-heading">
          <h1 className="wf-run-title">{info.title}</h1>
          {label && phase !== 'setup' ? <p className="wf-run-target">{label}</p> : null}
        </div>
        {phase !== 'setup' && phase !== 'loading' && kind !== 'handout' && rows.length === 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setPhase('setup')}>
            Change
          </Button>
        ) : null}
      </header>

      {phase === 'setup' ? (
        <>
          {loadError ? (
            <p className="flash flash-error" role="alert">
              {loadError}
            </p>
          ) : null}
          <p className="wf-run-lede">{info.description}</p>
          <TargetStep
            kind={kind}
            initial={target}
            locations={locations}
            statuses={statuses}
            onStart={start}
          />
        </>
      ) : phase === 'loading' ? (
        <div className="wf-stage" aria-busy="true">
          <div className="wf-stage-main">
            <Skeleton height={56} />
            <Skeleton height={200} />
          </div>
          <div className="wf-stage-side">
            <Skeleton height={240} />
          </div>
        </div>
      ) : (
        <div className="wf-stage">
          <aside className="wf-stage-side" aria-label="Progress">
            {kind === 'move' ? (
              <LaptopCart name={target.location} resident={expected.length} added={counts.done} />
            ) : kind === 'audit' && diff ? (
              <AuditBoard
                location={target.location}
                expectedCount={expected.length}
                diff={diff}
              />
            ) : kind === 'handout' ? (
              <HandoutPanel
                person={person}
                given={given}
                onChoose={onChoosePerson}
                finished={phase === 'finished'}
              />
            ) : (
              <div className="wf-tally panel">
                <SettleNumber value={counts.done} className="wf-tally-number" />
                <p className="wf-tally-label">
                  {kind === 'status' ? `set to ${target.status}` : 'collected'}
                </p>
              </div>
            )}
          </aside>

          <div className="wf-stage-main">
            {phase === 'finished' ? (
              <FinishSummary
                kind={kind}
                target={target}
                headline={headline}
                counts={counts}
                countsLine={
                  diff
                    ? [
                        `${diff.missing.length} not seen`,
                        `${diff.elsewhere.length} recorded elsewhere`,
                        ...(counts.errors > 0 ? [`${counts.errors} not in the inventory`] : []),
                      ].join(', ')
                    : undefined
                }
                elapsedMs={elapsed}
                undoable={undoQueue(rows).length}
                undoingAll={session.undoingAll}
                summary={() => summaryText(kind, target, rows, elapsed)}
                onUndoAll={session.undoAll}
                onKeepScanning={keepScanning}
                onNewRun={newRun}
                labelIds={labelIds}
              />
            ) : (
              <div className="wf-console panel">
                <ScanInput
                  ref={input}
                  id="wf-scan"
                  label={kind === 'handout' && !person ? 'Scan an ID card or a device' : 'Scan a device'}
                  placeholder={
                    kind === 'handout' && !person ? 'Scan an ID card or type an OSIS' : 'Scan or type a code'
                  }
                  hint={
                    kind === 'handout' && !person
                      ? 'The first scan is the person. Their laptops follow.'
                      : 'A USB scanner types here. Press Enter after a typed code.'
                  }
                  active={scanning}
                  onCode={session.submit}
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
                    icon={session.sound ? Volume2 : VolumeX}
                    className="wf-sound"
                    aria-pressed={session.sound}
                    aria-label={session.sound ? 'Sound on' : 'Sound off'}
                    title={session.sound ? 'Sound on' : 'Sound off'}
                    onClick={() => session.setSound(!session.sound)}
                  />
                </div>
                {camera ? (
                  <WorkflowCamera
                    onCode={session.submit}
                    onClose={() => setCamera(false)}
                    title={label ? `${info.title}: ${label}` : info.title}
                    feed={
                      rows.length > 0 ? (
                        <ScanList
                          kind={kind}
                          target={target}
                          rows={rows.slice(0, 3)}
                          personName={person?.displayName}
                          onUndo={(key) => void session.undo(key)}
                          describe={kind === 'audit' ? (row) => auditNote(row, target.location, expected) : undefined}
                          empty=""
                        />
                      ) : null
                    }
                  />
                ) : null}
                {pairing ? (
                  <PhonePairing
                    label={label ? `${info.title}: ${label}` : info.title}
                    onCode={session.submit}
                    onClose={() => setPairing(false)}
                  />
                ) : null}
              </div>
            )}

            {phase === 'finished' && diff && (diff.missing.length > 0 || diff.elsewhere.length > 0) ? (
              <AuditResolution location={target.location} diff={diff} statuses={statuses} locations={locations} />
            ) : null}

            <div className="wf-stats" aria-live="off">
              <span className="wf-stat wf-stat-main">
                <SettleNumber value={kind === 'audit' ? diff?.found.length ?? 0 : counts.done} />
                {kind === 'audit' ? ' found' : ' done'}
              </span>
              {counts.skipped > 0 ? (
                <span className="wf-stat">
                  <span className="num">{counts.skipped}</span> skipped
                </span>
              ) : null}
              {counts.errors > 0 ? (
                <span className="wf-stat wf-stat-bad">
                  <span className="num">{counts.errors}</span> {counts.errors === 1 ? 'error' : 'errors'}
                </span>
              ) : null}
              <span className="wf-stat wf-clock">
                <Icon icon={Timer} size={14} />
                <span className="num">{formatElapsed(elapsed)}</span>
              </span>
              {scanning ? (
                <Button
                  variant="primary"
                  size="sm"
                  className="wf-finish-button"
                  disabled={counts.pending > 0}
                  onClick={() => void finish()}
                >
                  Finish
                </Button>
              ) : null}
            </div>

            <p className="visually-hidden" role="status">
              {announce(kind, latest, target)}
            </p>

            <ScanList
              kind={kind}
              target={target}
              rows={rows}
              personName={person?.displayName}
              onUndo={(key) => void session.undo(key)}
              describe={kind === 'audit' ? (row) => auditNote(row, target.location, expected) : undefined}
              empty={emptyLine(kind, Boolean(person))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function emptyLine(kind: WorkflowKind, hasPerson: boolean): string {
  switch (kind) {
    case 'move':
      return 'Scan the first laptop going in.';
    case 'audit':
      return 'Scan everything you can see in the room.';
    case 'handout':
      return hasPerson ? 'Scan the first laptop they are taking.' : 'Scan a student’s ID card to start.';
    case 'collect':
      return 'Scan the first machine coming back.';
    case 'status':
      return 'Scan the first machine.';
  }
}

function headlineFor(
  kind: WorkflowKind,
  label: string,
  done: number,
  found: number,
  expected: number,
  rows: readonly SessionRow[],
): string {
  const machines = (count: number) => (count === 1 ? '1 machine' : `${count} machines`);
  switch (kind) {
    case 'move':
      return `${done === 1 ? '1 laptop' : `${done} laptops`} into ${label}.`;
    case 'audit':
      return `${found} of ${expected} found in ${label}.`;
    case 'status':
      return `${machines(done)} set to ${label}.`;
    case 'collect':
      return `${machines(done)} collected.`;
    case 'handout': {
      const people = new Set(rows.filter((row) => row.state === 'done' && row.undo !== 'undone').map((row) => row.targetKey)).size;
      return `${machines(done)} handed out to ${people === 1 ? '1 person' : `${people} people`}.`;
    }
  }
}

function auditNote(row: SessionRow, location: string, expected: readonly ExpectedDevice[]): string | null {
  if (row.state !== 'done' || !row.device) return null;
  const listed = expected.some((device) => device.id === row.device?.id);
  if (listed) return 'Found.';
  const recorded = row.before?.location?.trim();
  if (recorded && recorded.toLowerCase() === location.trim().toLowerCase()) return 'Found.';
  return recorded ? `Recorded in ${recorded}.` : 'No location on record.';
}

function announce(kind: WorkflowKind, row: SessionRow | null, target: WorkflowTarget): string {
  if (!row || row.state === 'pending') return '';
  const name = row.device?.label ?? row.code;
  if (row.state === 'person') return `Handing out to ${row.person?.displayName ?? row.code}.`;
  if (row.state === 'error') return `${name}: not found.`;
  if (row.state === 'skipped') return `${name}: skipped.`;
  if (kind === 'audit') return `${name}: found.`;
  return `${name}: ${targetLabel(kind, target) || 'done'}.`;
}

/** The machines a run read, oldest first, once each: what "Print labels for these" prints. */
function runDeviceIds(rows: readonly SessionRow[]): string[] {
  const ids: string[] = [];
  for (const row of [...rows].reverse()) {
    if (!row.device || row.state === 'error' || row.state === 'pending') continue;
    if (row.state === 'done' && row.undo === 'undone') continue;
    if (!ids.includes(row.device.id)) ids.push(row.device.id);
  }
  return ids;
}
