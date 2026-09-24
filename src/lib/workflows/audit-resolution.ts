/**
 * What a room audit ends with: a decision for every machine that did not add up.
 *
 * "Mark them all missing" was the only answer an audit used to offer, and it
 * is the wrong one for most of the pile. A machine not seen in Room 204 may be
 * in repair, may have moved to the library, may be a typo nobody ever owned,
 * or may be a duplicate of a record that WAS seen. So each one gets its own
 * decision, with one choice applied to the whole pile and a per-row override
 * for the exceptions — the way somebody actually works through a list of
 * twelve with a clipboard.
 *
 * Machines recorded elsewhere get the smaller pair: record them here, or leave
 * them.
 *
 * This module is the rules: what a decision is, which ones may be taken, and
 * how a page of decisions becomes a handful of writes. Pure, so the plan that
 * the confirmation names is the plan that runs, and both are tested.
 */

import { MISSING_STATUS } from '@/lib/domain/workflows';
import type { AuditDiff, ExpectedDevice, ScannedMachine } from '@/lib/workflows/session';

/** What becomes of one machine the walk-through did not see. */
export type MissingDecision =
  | { kind: 'missing' }
  | { kind: 'status'; status: string }
  | { kind: 'move'; location: string }
  | { kind: 'delete' }
  | { kind: 'leave' };

export type MissingKind = MissingDecision['kind'];

/** What becomes of one machine seen here but recorded somewhere else. */
export type ElsewhereDecision = 'here' | 'leave';

export const MISSING_CHOICES: ReadonlyArray<{ kind: MissingKind; label: string; adminOnly?: boolean }> = [
  { kind: 'missing', label: `Mark ${MISSING_STATUS.toLowerCase()}` },
  { kind: 'status', label: 'Set a status' },
  { kind: 'move', label: 'Move to a location' },
  { kind: 'delete', label: 'Delete the record', adminOnly: true },
  { kind: 'leave', label: 'Leave as is' },
];

export const ELSEWHERE_CHOICES: ReadonlyArray<{ kind: ElsewhereDecision; label: string }> = [
  { kind: 'here', label: 'Record it here' },
  { kind: 'leave', label: 'Leave as is' },
];

export interface AuditDecisions {
  /** Applied to every not-seen machine without an override. */
  missingAll: MissingDecision;
  missing: Record<string, MissingDecision>;
  elsewhereAll: ElsewhereDecision;
  elsewhere: Record<string, ElsewhereDecision>;
}

export function initialDecisions(): AuditDecisions {
  return { missingAll: { kind: 'missing' }, missing: {}, elsewhereAll: 'here', elsewhere: {} };
}

export function missingDecisionFor(decisions: AuditDecisions, id: string): MissingDecision {
  return decisions.missing[id] ?? decisions.missingAll;
}

export function elsewhereDecisionFor(decisions: AuditDecisions, id: string): ElsewhereDecision {
  return decisions.elsewhere[id] ?? decisions.elsewhereAll;
}

/** A decision with the text it needs filled in. */
function complete(decision: MissingDecision): boolean {
  if (decision.kind === 'status') return decision.status.trim() !== '' && decision.status.trim() !== 'Assigned';
  if (decision.kind === 'move') return decision.location.trim() !== '';
  return true;
}

/**
 * Why a machine cannot take a decision, before anything is sent. The database
 * says the same things and is the one that counts; saying them here means the
 * confirmation never names a change that is about to be refused.
 */
export function blockedReason(
  decision: MissingDecision,
  device: Pick<ExpectedDevice, 'state'>,
  isAdmin: boolean,
): string | null {
  if (decision.kind === 'delete') {
    if (!isAdmin) return 'Only an administrator can delete a record.';
    if (device.state.holderId) {
      return `With ${device.state.holderName ?? 'somebody'}. Return it first, or mark it Retired.`;
    }
  }
  if (decision.kind === 'status' && decision.status.trim() === 'Assigned') {
    return 'Assigned means somebody has it. Hand it out instead.';
  }
  if (!complete(decision)) {
    return decision.kind === 'status' ? 'Choose the status.' : 'Say where it goes.';
  }
  return null;
}

/** One write: a patch over a set of machines, or one deletion. */
export type AuditStep =
  | { kind: 'patch'; patch: { status: string } | { location: string }; ids: string[]; label: string }
  | { kind: 'delete'; id: string; label: string };

export interface AuditPlan {
  steps: AuditStep[];
  /** Lines for the confirmation, one per kind of change, with the count. */
  summary: string[];
  /** How many machines change. */
  changing: number;
  /** How many are left as they are. */
  leaving: number;
  /** Machines whose decision cannot be taken, with why. Nothing runs while there are any. */
  blocked: Array<{ id: string; label: string; reason: string }>;
}

function machines(count: number): string {
  return count === 1 ? '1 machine' : `${count} machines`;
}

/** Groups ids under a key, keeping first-seen order. */
function groupBy(entries: ReadonlyArray<{ key: string; id: string }>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { key, id } of entries) {
    const list = groups.get(key) ?? [];
    list.push(id);
    groups.set(key, list);
  }
  return groups;
}

/**
 * The decisions, as the writes that carry them out.
 *
 * Machines sharing a status or a location become one patch, so marking twelve
 * missing is one call rather than twelve; each deletion is its own call,
 * because each is refused or allowed on its own record. The order is the
 * order the confirmation reads: statuses, moves, deletions.
 */
export function planAudit(
  diff: Pick<AuditDiff, 'missing' | 'elsewhere'>,
  decisions: AuditDecisions,
  location: string,
  isAdmin: boolean,
): AuditPlan {
  const statuses: Array<{ key: string; id: string }> = [];
  const moves: Array<{ key: string; id: string }> = [];
  const deletions: ExpectedDevice[] = [];
  const blocked: AuditPlan['blocked'] = [];
  let leaving = 0;

  for (const device of diff.missing) {
    const decision = missingDecisionFor(decisions, device.id);
    const reason = blockedReason(decision, device, isAdmin);
    if (reason) {
      blocked.push({ id: device.id, label: device.label, reason });
      continue;
    }
    switch (decision.kind) {
      case 'missing':
        statuses.push({ key: MISSING_STATUS, id: device.id });
        break;
      case 'status':
        statuses.push({ key: decision.status.trim(), id: device.id });
        break;
      case 'move':
        moves.push({ key: decision.location.trim(), id: device.id });
        break;
      case 'delete':
        deletions.push(device);
        break;
      case 'leave':
        leaving += 1;
        break;
    }
  }

  for (const machine of diff.elsewhere) {
    if (elsewhereDecisionFor(decisions, machine.device.id) === 'here') {
      moves.push({ key: location.trim(), id: machine.device.id });
    } else {
      leaving += 1;
    }
  }

  const steps: AuditStep[] = [];
  const summary: string[] = [];
  for (const [status, ids] of groupBy(statuses)) {
    steps.push({ kind: 'patch', patch: { status }, ids, label: `set to ${status}` });
    summary.push(status === MISSING_STATUS ? `${machines(ids.length)} marked ${MISSING_STATUS}` : `${machines(ids.length)} set to ${status}`);
  }
  for (const [place, ids] of groupBy(moves)) {
    steps.push({ kind: 'patch', patch: { location: place }, ids, label: `moved to ${place}` });
    summary.push(`${machines(ids.length)} recorded in ${place}`);
  }
  for (const device of deletions) {
    steps.push({ kind: 'delete', id: device.id, label: device.label });
  }
  if (deletions.length > 0) {
    summary.push(`${deletions.length === 1 ? '1 record' : `${deletions.length} records`} deleted`);
  }
  if (leaving > 0) summary.push(leaving === 1 ? '1 machine left as it is' : `${leaving} machines left as they are`);

  const changing = statuses.length + moves.length + deletions.length;
  return { steps, summary, changing, leaving, blocked };
}

/** What happened to one machine when the plan ran. */
export interface AuditOutcome {
  id: string;
  label: string;
  /** "Marked Missing", "Recorded in Room 204", "Deleted", or the refusal. */
  text: string;
  ok: boolean;
}

/** The outcome line for a step that went through. */
export function outcomeText(step: AuditStep): string {
  if (step.kind === 'delete') return 'Record deleted';
  if ('status' in step.patch) {
    return step.patch.status === MISSING_STATUS ? `Marked ${MISSING_STATUS}` : `Set to ${step.patch.status}`;
  }
  return `Recorded in ${step.patch.location}`;
}

/** Every machine the plan would touch, by id, with its label, for the results list. */
export function labelsById(diff: Pick<AuditDiff, 'missing' | 'elsewhere'>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const device of diff.missing) labels.set(device.id, device.label);
  for (const machine of diff.elsewhere as ScannedMachine[]) labels.set(machine.device.id, machine.device.label);
  return labels;
}

/** The headline over the results. */
export function resultsHeadline(outcomes: readonly AuditOutcome[]): string {
  const done = outcomes.filter((one) => one.ok).length;
  const failed = outcomes.length - done;
  if (failed === 0) return `${machines(done)} updated.`;
  if (done === 0) return failed === 1 ? 'That change did not go through.' : `None of the ${failed} changes went through.`;
  return `${machines(done)} updated. ${failed} did not go through.`;
}
