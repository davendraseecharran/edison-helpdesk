'use client';

/**
 * The end of a room audit: a decision for each machine that did not add up.
 *
 * Two lists. The machines nobody saw each get one of five answers — mark it
 * missing, give it another status, record it somewhere else, delete the
 * record (an administrator's, for typos and duplicates), or leave it. The
 * machines seen here but recorded elsewhere get two: record them here, or
 * leave them. One choice at the top of each list applies to the whole pile;
 * a row's own choice overrides it, which is how a list of twelve is actually
 * worked through.
 *
 * Nothing is written until one confirmation that names every change by count.
 * Then each machine says what became of it, and a refusal — a record that
 * cannot be deleted because a ticket names it — says why and what to do
 * instead, beside that machine.
 *
 * The rules are `src/lib/workflows/audit-resolution.ts`; this only draws them.
 */

import { useMemo, useState } from 'react';
import { Check, CircleAlert, RotateCcw } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select, type SelectOption } from '@/components/ui/Select';
import { bulkUpdateDevicesAction, deleteDeviceAction } from '@/lib/data/device-actions';
import { MISSING_STATUS } from '@/lib/domain/workflows';
import {
  blockedReason,
  ELSEWHERE_CHOICES,
  elsewhereDecisionFor,
  initialDecisions,
  labelsById,
  MISSING_CHOICES,
  missingDecisionFor,
  outcomeText,
  planAudit,
  resultsHeadline,
  type AuditDecisions,
  type AuditOutcome,
  type ElsewhereDecision,
  type MissingDecision,
  type MissingKind,
} from '@/lib/workflows/audit-resolution';
import { chunk, type AuditDiff, type ExpectedDevice } from '@/lib/workflows/session';

const INHERIT = 'inherit';

export interface AuditResolutionProps {
  location: string;
  diff: AuditDiff;
  statuses: string[];
  locations: string[];
}

function machineMeta(device: ExpectedDevice): string {
  const kind = [device.deviceType, device.model].filter(Boolean).join(' ');
  const where = device.state.holderName ? `with ${device.state.holderName}` : device.state.status;
  return [kind, where].filter(Boolean).join(', ');
}

/** A decision of this kind, keeping whatever text the last one of the same kind had. */
function decisionOf(kind: MissingKind, previous: MissingDecision, fallbackStatus: string): MissingDecision {
  switch (kind) {
    case 'status':
      return { kind, status: previous.kind === 'status' ? previous.status : fallbackStatus };
    case 'move':
      return { kind, location: previous.kind === 'move' ? previous.location : '' };
    default:
      return { kind };
  }
}

export function AuditResolution({ location, diff, statuses, locations }: AuditResolutionProps) {
  const { actor } = useRuntime();
  const isAdmin = actor.roles.includes('admin');
  const [decisions, setDecisions] = useState<AuditDecisions>(initialDecisions);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcomes, setOutcomes] = useState<AuditOutcome[] | null>(null);

  const statusChoices = useMemo(
    () => statuses.filter((status) => status.trim() !== '' && status !== 'Assigned' && status !== MISSING_STATUS),
    [statuses],
  );
  const firstStatus = statusChoices.includes('In repair') ? 'In repair' : (statusChoices[0] ?? '');
  const plan = useMemo(() => planAudit(diff, decisions, location, isAdmin), [diff, decisions, location, isAdmin]);

  const kindOptions: SelectOption[] = MISSING_CHOICES.filter((choice) => !choice.adminOnly || isAdmin).map(
    (choice) => ({ value: choice.kind, label: choice.label }),
  );
  const statusOptions: SelectOption[] = statusChoices.map((status) => ({ value: status, label: status }));

  function setMissingAll(next: MissingDecision) {
    setDecisions((current) => ({ ...current, missingAll: next }));
  }

  function setMissingRow(id: string, next: MissingDecision | null) {
    setDecisions((current) => {
      const missing = { ...current.missing };
      if (next === null) delete missing[id];
      else missing[id] = next;
      return { ...current, missing };
    });
  }

  function setElsewhereRow(id: string, next: ElsewhereDecision | null) {
    setDecisions((current) => {
      const elsewhere = { ...current.elsewhere };
      if (next === null) delete elsewhere[id];
      else elsewhere[id] = next;
      return { ...current, elsewhere };
    });
  }

  async function apply() {
    setApplying(true);
    const labels = labelsById(diff);
    const results: AuditOutcome[] = [];
    for (const step of plan.steps) {
      if (step.kind === 'delete') {
        let result: { ok: boolean; error?: string };
        try {
          result = await deleteDeviceAction(step.id, `Not seen in the room audit of ${location}.`);
        } catch {
          result = { ok: false, error: 'That did not reach the helpdesk. Nothing changed.' };
        }
        results.push({
          id: step.id,
          label: step.label,
          ok: result.ok,
          text: result.ok ? outcomeText(step) : (result.error ?? 'The record could not be deleted.'),
        });
        continue;
      }
      for (const batch of chunk(step.ids)) {
        let result: { ok: boolean; error?: string };
        try {
          result = await bulkUpdateDevicesAction(batch, step.patch);
        } catch {
          result = { ok: false, error: 'That did not reach the helpdesk. Nothing changed.' };
        }
        for (const id of batch) {
          results.push({
            id,
            label: labels.get(id) ?? id,
            ok: result.ok,
            text: result.ok ? outcomeText(step) : (result.error ?? 'That did not go through.'),
          });
        }
      }
    }
    setApplying(false);
    setConfirming(false);
    setOutcomes(results);
  }

  if (outcomes) {
    const failed = outcomes.filter((one) => !one.ok);
    return (
      <section className="wf-resolve panel" aria-labelledby="wf-resolve-title">
        <div className="wf-resolve-head">
          <h2 id="wf-resolve-title" className="wf-resolve-title">
            {resultsHeadline(outcomes)}
          </h2>
          {failed.length > 0 ? (
            <p className="wf-resolve-lede">Each one that did not go through says why. Nothing else changed.</p>
          ) : null}
        </div>
        <ul className="wf-resolve-results">
          {[...failed, ...outcomes.filter((one) => one.ok)].map((outcome) => (
            <li key={outcome.id} className="wf-resolve-result" data-ok={outcome.ok || undefined}>
              <Icon icon={outcome.ok ? Check : CircleAlert} size={16} className="wf-resolve-mark" />
              <span className="mono wf-resolve-label">{outcome.label}</span>
              <span className="wf-resolve-text">{outcome.text}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const missingAll = decisions.missingAll;

  return (
    <section className="wf-resolve panel" aria-labelledby="wf-resolve-title">
      <div className="wf-resolve-head">
        <h2 id="wf-resolve-title" className="wf-resolve-title">
          Decide what happens next
        </h2>
        <p className="wf-resolve-lede">
          Nothing changes until you apply. Set one answer for a list, then change the rows that differ.
        </p>
      </div>

      {diff.missing.length > 0 ? (
        <div className="wf-resolve-group">
          <div className="wf-resolve-group-head">
            <h3 className="wf-resolve-group-title">
              Not seen <span className="wf-resolve-count num">{diff.missing.length}</span>
            </h3>
            <div className="wf-resolve-all">
              <Select
                aria-label="For every machine not seen"
                value={missingAll.kind}
                options={kindOptions}
                onChange={(value) => setMissingAll(decisionOf(value as MissingKind, missingAll, firstStatus))}
              />
              <DecisionDetail
                decision={missingAll}
                statusOptions={statusOptions}
                locations={locations}
                idBase="wf-resolve-all"
                onChange={setMissingAll}
              />
            </div>
          </div>
          <ul className="wf-resolve-rows">
            {diff.missing.map((device) => {
              const own = decisions.missing[device.id];
              const effective = missingDecisionFor(decisions, device.id);
              const reason = blockedReason(effective, device, isAdmin);
              return (
                <li key={device.id} className="wf-resolve-row" data-own={own ? '' : undefined}>
                  <span className="wf-resolve-machine">
                    <span className="mono wf-resolve-label">{device.label}</span>
                    <span className="wf-resolve-meta">{machineMeta(device)}</span>
                  </span>
                  <span className="wf-resolve-choice">
                    <Select
                      aria-label={`What happens to ${device.label}`}
                      value={own ? own.kind : INHERIT}
                      options={[
                        { value: INHERIT, label: `Same as all: ${labelFor(missingAll)}` },
                        ...kindOptions,
                      ]}
                      onChange={(value) =>
                        setMissingRow(
                          device.id,
                          value === INHERIT ? null : decisionOf(value as MissingKind, own ?? missingAll, firstStatus),
                        )
                      }
                    />
                    {own ? (
                      <DecisionDetail
                        decision={own}
                        statusOptions={statusOptions}
                        locations={locations}
                        idBase={`wf-resolve-${device.id}`}
                        onChange={(next) => setMissingRow(device.id, next)}
                      />
                    ) : null}
                  </span>
                  {reason ? <span className="wf-resolve-blocked">{reason}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {diff.elsewhere.length > 0 ? (
        <div className="wf-resolve-group">
          <div className="wf-resolve-group-head">
            <h3 className="wf-resolve-group-title">
              Recorded elsewhere <span className="wf-resolve-count num">{diff.elsewhere.length}</span>
            </h3>
            <SegmentedControl<ElsewhereDecision>
              label="For every machine recorded elsewhere"
              size="sm"
              value={decisions.elsewhereAll}
              onChange={(value) => setDecisions((current) => ({ ...current, elsewhereAll: value }))}
              options={ELSEWHERE_CHOICES.map((choice) => ({
                value: choice.kind,
                label: choice.kind === 'here' ? `Record in ${location}` : choice.label,
              }))}
            />
          </div>
          <ul className="wf-resolve-rows">
            {diff.elsewhere.map((machine) => {
              const own = decisions.elsewhere[machine.device.id];
              const effective = elsewhereDecisionFor(decisions, machine.device.id);
              return (
                <li key={machine.device.id} className="wf-resolve-row" data-own={own ? '' : undefined}>
                  <span className="wf-resolve-machine">
                    <span className="mono wf-resolve-label">{machine.device.label}</span>
                    <span className="wf-resolve-meta">
                      {machine.state.location?.trim() ? `Recorded in ${machine.state.location}` : 'No location on record'}
                    </span>
                  </span>
                  <span className="wf-resolve-choice">
                    <Button
                      size="sm"
                      variant={effective === 'here' ? 'secondary' : 'ghost'}
                      aria-pressed={effective === 'here'}
                      onClick={() => {
                        const next: ElsewhereDecision = effective === 'here' ? 'leave' : 'here';
                        setElsewhereRow(machine.device.id, next === decisions.elsewhereAll ? null : next);
                      }}
                    >
                      {effective === 'here' ? `Record in ${location}` : 'Leave as is'}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="wf-resolve-foot">
        <p className="wf-resolve-plan" aria-live="polite">
          {plan.blocked.length > 0
            ? `${plan.blocked.length === 1 ? '1 machine needs' : `${plan.blocked.length} machines need`} a different answer first.`
            : plan.changing === 0
              ? 'Everything is left as it is.'
              : plan.summary.join(', ') + '.'}
        </p>
        <Button
          variant="primary"
          disabled={plan.blocked.length > 0 || plan.changing === 0}
          onClick={() => setConfirming(true)}
        >
          {plan.changing === 0 ? 'Nothing to apply' : `Apply ${plan.changing === 1 ? '1 change' : `${plan.changing} changes`}`}
        </Button>
      </div>

      <Dialog
        open={confirming}
        onClose={() => (applying ? undefined : setConfirming(false))}
        title={`Apply ${plan.changing === 1 ? '1 change' : `${plan.changing} changes`} from ${location}?`}
        description={
          plan.steps.some((step) => step.kind === 'delete')
            ? 'Each machine keeps its history. A deleted record cannot be brought back from here.'
            : 'Each machine keeps its history, and each change can be made again by hand.'
        }
        footer={
          <>
            <Button onClick={() => setConfirming(false)} disabled={applying}>
              Cancel
            </Button>
            <Button
              variant={plan.steps.some((step) => step.kind === 'delete') ? 'danger' : 'primary'}
              loading={applying}
              data-autofocus=""
              onClick={() => void apply()}
            >
              Apply changes
            </Button>
          </>
        }
      >
        <ul className="wf-resolve-summary">
          {plan.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Dialog>
    </section>
  );
}

function labelFor(decision: MissingDecision): string {
  switch (decision.kind) {
    case 'missing':
      return `mark ${MISSING_STATUS.toLowerCase()}`;
    case 'status':
      return decision.status ? `set to ${decision.status}` : 'set a status';
    case 'move':
      return decision.location ? `move to ${decision.location}` : 'move';
    case 'delete':
      return 'delete';
    case 'leave':
      return 'leave as is';
  }
}

function DecisionDetail({
  decision,
  statusOptions,
  locations,
  idBase,
  onChange,
}: {
  decision: MissingDecision;
  statusOptions: SelectOption[];
  locations: string[];
  idBase: string;
  onChange: (next: MissingDecision) => void;
}) {
  if (decision.kind === 'status') {
    return (
      <Select
        aria-label="Status"
        value={decision.status}
        options={statusOptions}
        onChange={(status) => onChange({ kind: 'status', status })}
      />
    );
  }
  if (decision.kind === 'move') {
    return (
      <>
        <input
          type="text"
          className="wf-resolve-input"
          aria-label="Location"
          placeholder="Library"
          list={`${idBase}-locations`}
          value={decision.location}
          autoComplete="off"
          onChange={(event) => onChange({ kind: 'move', location: event.target.value })}
        />
        <datalist id={`${idBase}-locations`}>
          {locations.map((one) => (
            <option key={one} value={one} />
          ))}
        </datalist>
      </>
    );
  }
  if (decision.kind === 'delete') {
    return (
      <span className="wf-resolve-hint">
        <Icon icon={RotateCcw} size={14} />
        For typos and duplicates. Refused while a ticket or a person has it.
      </span>
    );
  }
  return null;
}
