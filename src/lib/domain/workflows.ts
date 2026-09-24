/**
 * Workflows: the repetitive device jobs, named once.
 *
 * Five jobs a NetRider does with a trolley of laptops and a scanner, each one a
 * target chosen first and then a run of scans. What each is called, where it
 * lives in the URL, what a shortcut to it holds and what a finished run looks
 * like are said here, so the hub, the run page, the palette, the assistant and
 * the tests all agree without a database.
 *
 * The database is still what decides: `app_workflow_scan` and
 * `app_save_workflow_shortcut` re-derive the actor and check the same rules
 * (`20260923110000_workflows.sql`).
 */

import { isRecord, textOf } from '@/lib/guards';

/** The job, as the database names it. */
export type WorkflowKind = 'move' | 'handout' | 'collect' | 'audit' | 'status';

/** The kinds a shortcut can hold. A hand-out's person is new every time. */
export type ShortcutKind = Exclude<WorkflowKind, 'handout'>;

export const SHORTCUT_KINDS: readonly ShortcutKind[] = ['move', 'status', 'collect', 'audit'];

export interface WorkflowInfo {
  kind: WorkflowKind;
  /** The path segment under `/workflows`. */
  slug: string;
  /** The tile's name, sentence case. */
  title: string;
  /** One line under it: what the job does, in a NetRider's words. */
  description: string;
}

/** In the order the hub shows them: the one done most often first. */
export const WORKFLOWS: readonly WorkflowInfo[] = [
  {
    kind: 'move',
    slug: 'load-cart',
    title: 'Load a cart',
    description: 'Pick a cart or room, then scan every laptop that goes in it.',
  },
  {
    kind: 'handout',
    slug: 'hand-out',
    title: 'Hand out',
    description: 'Scan a student’s ID, then the laptops they take. Next student.',
  },
  {
    kind: 'collect',
    slug: 'collect',
    title: 'Collect',
    description: 'Scan laptops coming back. Each is returned from whoever had it.',
  },
  {
    kind: 'audit',
    slug: 'room-audit',
    title: 'Room audit',
    description: 'Scan what is in a room and see what is missing or misplaced.',
  },
  {
    kind: 'status',
    slug: 'set-status',
    title: 'Set status',
    description: 'Pick a status, like In repair, then scan the machines.',
  },
];

export function workflowFor(kind: WorkflowKind): WorkflowInfo {
  return WORKFLOWS.find((workflow) => workflow.kind === kind) ?? WORKFLOWS[0];
}

export function workflowBySlug(slug: string): WorkflowInfo | null {
  return WORKFLOWS.find((workflow) => workflow.slug === slug) ?? null;
}

export function isWorkflowKind(value: unknown): value is WorkflowKind {
  return typeof value === 'string' && WORKFLOWS.some((workflow) => workflow.kind === value);
}

export function isShortcutKind(value: unknown): value is ShortcutKind {
  return typeof value === 'string' && (SHORTCUT_KINDS as readonly string[]).includes(value);
}

/**
 * What a run is aimed at. Which halves matter depends on the job: a cart
 * load and an audit need a location, a status run needs a status, a
 * collection may name either or neither.
 */
export interface WorkflowTarget {
  location: string;
  status: string;
}

export const EMPTY_TARGET: WorkflowTarget = { location: '', status: '' };

/** What a collection sets when nobody said: the owner's word for the shelf. */
export const COLLECT_DEFAULT_STATUS = 'Available';

/**
 * What an audit marks a machine it could not find. Free text like every
 * inventory status; "Lost" is a conclusion, and a walk-through that did not see
 * a laptop has not reached one.
 */
export const MISSING_STATUS = 'Missing';

export const LOCATION_MAX = 120;
export const STATUS_MAX = 120;
export const SHORTCUT_NAME_MAX = 40;
export const SHORTCUT_CAP = 24;

/** The run page, with its target already chosen when there is one. */
export function workflowHref(kind: WorkflowKind, target?: Partial<WorkflowTarget>): string {
  const base = `/workflows/${workflowFor(kind).slug}`;
  const params = new URLSearchParams();
  const location = target?.location?.trim() ?? '';
  const status = target?.status?.trim() ?? '';
  if (location !== '') params.set('location', location);
  if (status !== '') params.set('status', status);
  const query = params.toString();
  return query === '' ? base : `${base}?${query}`;
}

/** The target from a URL's search params, trimmed and capped. */
export function targetFromParams(params: Record<string, string | string[] | undefined>): WorkflowTarget {
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
  return {
    location: one(params.location).slice(0, LOCATION_MAX),
    status: one(params.status).slice(0, STATUS_MAX),
  };
}

/**
 * Whether the target is enough to start scanning. A collection is ready as it
 * is: with nothing chosen it returns to Available and leaves the location.
 */
export function targetReady(kind: WorkflowKind, target: WorkflowTarget): boolean {
  switch (kind) {
    case 'move':
    case 'audit':
      return target.location.trim() !== '';
    case 'status':
      return target.status.trim() !== '' && target.status.trim() !== 'Assigned';
    case 'collect':
    case 'handout':
      return true;
  }
}

/** The target as the RPC takes it. */
export function scanTarget(
  kind: WorkflowKind,
  target: WorkflowTarget,
  personId?: string | null,
): Record<string, string> {
  const location = target.location.trim();
  const status = target.status.trim();
  switch (kind) {
    case 'move':
      return { location };
    case 'status':
      return { status };
    case 'collect':
      return {
        status: status || COLLECT_DEFAULT_STATUS,
        ...(location !== '' ? { location } : {}),
      };
    case 'handout':
      return personId ? { requester: personId } : {};
    case 'audit':
      return {};
  }
}

/** The RPC's own name for the job. */
export function scanAction(kind: WorkflowKind): 'move' | 'status' | 'assign' | 'collect' | 'resolve' {
  switch (kind) {
    case 'move':
      return 'move';
    case 'status':
      return 'status';
    case 'handout':
      return 'assign';
    case 'collect':
      return 'collect';
    case 'audit':
      return 'resolve';
  }
}

/** What the run is aimed at, as a heading and a recent-runs row say it. */
export function targetLabel(kind: WorkflowKind, target: WorkflowTarget): string {
  const location = target.location.trim();
  const status = target.status.trim();
  switch (kind) {
    case 'move':
    case 'audit':
      return location;
    case 'status':
      return status;
    case 'collect':
      return location || status || COLLECT_DEFAULT_STATUS;
    case 'handout':
      return '';
  }
}

/**
 * A name for a shortcut nobody has named yet: "Load Cart 3", "Audit Room 204",
 * "Set In repair", "Collect into Returns bin". Cut to the column's length.
 */
export function defaultShortcutName(kind: ShortcutKind, target: WorkflowTarget): string {
  const location = target.location.trim();
  const status = target.status.trim();
  const name = (() => {
    switch (kind) {
      case 'move':
        return `Load ${location}`;
      case 'audit':
        return `Audit ${location}`;
      case 'status':
        return `Set ${status}`;
      case 'collect':
        return location ? `Collect into ${location}` : `Collect as ${status || COLLECT_DEFAULT_STATUS}`;
    }
  })();
  return name.slice(0, SHORTCUT_NAME_MAX).trim();
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

/** One of the desk's saved runs. */
export interface WorkflowShortcut {
  id: string;
  name: string;
  kind: ShortcutKind;
  location: string;
  status: string;
  position: number;
}

export function shortcutFromRow(row: unknown): WorkflowShortcut | null {
  if (!isRecord(row)) return null;
  const id = textOf(row.id);
  const name = textOf(row.name);
  if (id === '' || name === '' || !isShortcutKind(row.kind)) return null;
  return {
    id,
    name,
    kind: row.kind,
    location: textOf(row.location),
    status: textOf(row.status),
    position: typeof row.position === 'number' ? row.position : 0,
  };
}

export function shortcutHref(shortcut: WorkflowShortcut): string {
  return workflowHref(shortcut.kind, shortcut);
}

/** The same rules the database applies, said beside the field. Not the boundary. */
export function shortcutError(input: {
  name: string;
  kind: string;
  location: string;
  status: string;
}): string | null {
  const name = input.name.trim();
  if (name === '') return 'Give the shortcut a name.';
  if (name.length > SHORTCUT_NAME_MAX) return `A shortcut's name is ${SHORTCUT_NAME_MAX} characters at most.`;
  if (!isShortcutKind(input.kind)) return 'Choose which workflow the shortcut runs.';
  if (input.location.trim().length > LOCATION_MAX || input.status.trim().length > STATUS_MAX) {
    return `Keep the location and status under ${LOCATION_MAX} characters.`;
  }
  if ((input.kind === 'move' || input.kind === 'audit') && input.location.trim() === '') {
    return 'Say which location the shortcut is for.';
  }
  if (input.kind === 'status' && input.status.trim() === '') return 'Say which status the shortcut sets.';
  if (input.status.trim() === 'Assigned') return 'Assigned means somebody has it. Hand the machines out instead.';
  return null;
}

/** Words that should find a shortcut in the palette. */
export function shortcutKeywords(shortcut: WorkflowShortcut): string[] {
  const words = `${shortcut.name} ${shortcut.location} ${shortcut.status} ${workflowFor(shortcut.kind).title}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
  return ['workflow', 'shortcut', 'scan', ...new Set(words)];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: string;
  kind: WorkflowKind;
  label: string;
  location: string;
  status: string;
  done: number;
  skipped: number;
  errors: number;
  startedAt: string;
  finishedAt: string;
  runBy: string;
  performedVia: 'user' | 'ai';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function runFromRow(row: unknown): WorkflowRun | null {
  if (!isRecord(row) || !isWorkflowKind(row.kind)) return null;
  const id = textOf(row.id);
  if (id === '') return null;
  return {
    id,
    kind: row.kind,
    label: textOf(row.label),
    location: textOf(row.location),
    status: textOf(row.status),
    done: count(row.done),
    skipped: count(row.skipped),
    errors: count(row.errors),
    startedAt: textOf(row.startedAt),
    finishedAt: textOf(row.finishedAt),
    runBy: textOf(row.runBy),
    performedVia: row.performedVia === 'ai' ? 'ai' : 'user',
  };
}

/** A recent run's title: "Load a cart: Cart 3". */
export function runTitle(run: Pick<WorkflowRun, 'kind' | 'label'>): string {
  const title = workflowFor(run.kind).title;
  return run.label.trim() === '' ? title : `${title}: ${run.label}`;
}

/** A recent run's counts, said plainly: "28 done, 2 skipped". */
export function runCounts(run: Pick<WorkflowRun, 'kind' | 'done' | 'skipped' | 'errors'>): string {
  const parts = [`${run.done} ${run.kind === 'audit' ? 'found' : 'done'}`];
  if (run.skipped > 0) parts.push(`${run.skipped} ${run.kind === 'audit' ? 'missing' : 'skipped'}`);
  if (run.errors > 0) parts.push(`${run.errors} ${run.errors === 1 ? 'error' : 'errors'}`);
  return parts.join(', ');
}

/** Whether a recent run can be run again from its row. A hand-out cannot. */
export function rerunHref(run: WorkflowRun): string | null {
  if (run.kind === 'handout') return null;
  const target = { location: run.location, status: run.status };
  return targetReady(run.kind, target) ? workflowHref(run.kind, target) : null;
}
