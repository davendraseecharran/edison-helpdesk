'use client';

import { useMemo, useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import {
  addCollaboratorAction,
  joinTicketAction,
  claimTicketAction,
  removeCollaboratorAction,
} from '@/lib/data/actions';
import {
  canClaimTicket,
  canReturnToQueue,
  canJoinTicket,
  canManageCollaborators,
} from '@/lib/domain/permissions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { canWorkTickets } from '@/lib/auth/roles';
import { Avatar, Field, TimeAgo } from '@/components/Primitives';
import { RoleBadge } from '@/components/Badges';
import { Button } from '@/components/ui/Button';
import { useShortcut } from '@/components/ui/shortcuts';
import { Select } from '@/components/ui/Select';

/**
 * Owner and collaborators, and the collaborator list.
 *
 * Claim and Return are not here: `TicketActionBar` offers both from the same
 * predicates this panel used, at every width, so a button here would be a
 * second live control with the same label. What stays is `c` — the key still
 * claims the open ticket, and the bar's button carries the keycap in its
 * tooltip.
 */
export function OwnershipPanel({ detail }: { detail: TicketDetail }) {
  const { actor: runtimeActor, directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [collaboratorId, setCollaboratorId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayManage = canManageCollaborators(ticket, actor);
  const mayClaim = canClaimTicket(ticket, actor);
  const mayJoin = canWorkTickets(runtimeActor.roles) && canJoinTicket(ticket, actor);
  const busy = pendingKey !== null;

  const candidates = useMemo(
    () =>
      directory.filter(
        (account) =>
          account.status === 'active' &&
          account.id !== ticket.ownerId &&
          !ticket.collaboratorIds.includes(account.id),
      ),
    [directory, ticket.ownerId, ticket.collaboratorIds],
  );

  async function onClaim() {
    await run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id, ticket.number));
  }

  /*
   * `c` claims the ticket that is open.
   *
   * Claiming is the first thing a technician does with a queued ticket and the
   * only reason many of them open one, so it is worth a key. Bound only while
   * this account can actually claim THIS ticket and nothing else is in flight,
   * so the key does nothing rather than failing at the server; the shortcut
   * guards (no editable focus, no modal open) live in useShortcut. The keycap
   * on the button is what makes it findable.
   */
  useShortcut('c', () => void onClaim(), mayClaim && !busy);

  async function onAdd(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(`add-collab:${ticket.id}`, () =>
      addCollaboratorAction(ticket.id, collaboratorId),
    );
    if (result.ok) {
      setCollaboratorId('');
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  async function onJoin() {
    await run(`join:${ticket.id}`, () => joinTicketAction(ticket.number));
  }

  async function onRemove(accountId: string) {
    await run(`remove-collab:${ticket.id}:${accountId}`, () =>
      removeCollaboratorAction(ticket.id, accountId),
    );
  }

  return (
    <section className="panel" aria-labelledby={`people-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`people-heading-${ticket.id}`}>
          People
        </h2>
      </div>
      <div className="panel-body stack">
        <div>
          <p className="people-label">Owner</p>
          {detail.owner ? (
            <div className="person">
              <Avatar name={detail.owner.displayName} />
              <span className="person-text">
                <span className="person-name">{detail.owner.displayName}</span>
                {ticket.assignedAt ? (
                  <span className="person-meta">
                    Since <TimeAgo iso={ticket.assignedAt} />
                  </span>
                ) : null}
              </span>
              <span className="person-end">
                <RoleBadge role={detail.owner.role} />
              </span>
            </div>
          ) : (
            <div className="person">
              <span className="person-text muted">Unassigned. Anyone can claim it from the queue.</span>
              {/* No Claim button here. `TicketActionBar` offers it from the
                  same predicate at every width, and two live controls with one
                  label is a question about whether they do the same thing. */}
            </div>
          )}
        </div>

        {/* What returning does, without the second button that does it: the
            bar above carries the action, and this is the consequence somebody
            reads before pressing it. */}
        {canReturnToQueue(ticket, actor) ? (
          <p className="panel-note">
            Cannot finish it? &ldquo;Return to queue&rdquo; at the top releases the ticket for
            another NetRider. Notes, devices, time, collaborators and history all stay with it.
          </p>
        ) : null}

        <div>
          <p className="people-label">Collaborators</p>
          {detail.collaborators.length === 0 ? (
            <p className="panel-empty">No collaborators.</p>
          ) : (
            detail.collaborators.map((collaborator) => (
              <div className="person" key={collaborator.id}>
                <Avatar name={collaborator.displayName} />
                <span className="person-text">
                  <span className="person-name">{collaborator.displayName}</span>
                </span>
                {mayManage ? (
                  <span className="person-end">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void onRemove(collaborator.id)}
                      disabled={busy}
                      loading={pendingKey === `remove-collab:${ticket.id}:${collaborator.id}`}
                    >
                      Remove
                    </Button>
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>

        {/* The other direction from "Add a collaborator": the person asked
            for help puts themselves on. The owner is told, and the log says
            they added themselves. */}
        {mayJoin ? (
          <div className="form-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void onJoin()}
              disabled={busy}
              loading={pendingKey === `join:${ticket.id}`}
            >
              Join this ticket
            </Button>
          </div>
        ) : null}

        {mayManage && candidates.length > 0 ? (
          <form onSubmit={onAdd} className="form">
            <Field label="Add a collaborator" htmlFor={`add-collab-${ticket.id}`} error={error}>
              <Select
                id={`add-collab-${ticket.id}`}
                value={collaboratorId}
                onChange={(value) => {
                  setCollaboratorId(value);
                  setError(null);
                }}
                options={[
                  { value: '', label: 'Choose an account' },
                  ...candidates.map((account) => ({
                    value: account.id,
                    label: account.displayName,
                  })),
                ]}
              />
            </Field>
            <div className="form-actions">
              <Button
                type="submit"
                size="sm"
                disabled={!collaboratorId || busy}
                loading={pendingKey === `add-collab:${ticket.id}`}
              >
                Add collaborator
              </Button>
            </div>
          </form>
        ) : null}

        {mayManage ? (
          <p className="panel-note">
            Removing a collaborator ends their access. Notes and events they already wrote keep
            their name.
          </p>
        ) : null}
      </div>
    </section>
  );
}
