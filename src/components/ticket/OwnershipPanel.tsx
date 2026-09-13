'use client';

import { useMemo, useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import {
  addCollaboratorAction,
  claimTicketAction,
  removeCollaboratorAction,
  returnTicketAction,
} from '@/lib/data/actions';
import {
  canClaimTicket,
  canReturnToQueue,
  canManageCollaborators,
} from '@/lib/domain/permissions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Avatar, Field, TimeAgo } from '@/components/Primitives';
import { RoleBadge } from '@/components/Badges';
import { Button } from '@/components/ui/Button';

/** Owner and collaborators, with claim, return and the collaborator list. */
export function OwnershipPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [collaboratorId, setCollaboratorId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayManage = canManageCollaborators(ticket, actor);
  const mayClaim = canClaimTicket(ticket, actor);
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
    await run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id));
  }

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
              {mayClaim ? (
                <span className="person-end">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void onClaim()}
                    disabled={busy}
                    loading={pendingKey === `claim:${ticket.id}`}
                  >
                    Claim ticket
                  </Button>
                </span>
              ) : null}
            </div>
          )}
        </div>

        {canReturnToQueue(ticket, actor) ? (
          <div className="stack-xs">
            <div className="form-actions">
              <Button
                size="sm"
                disabled={busy}
                loading={pendingKey === `return:${ticket.id}`}
                onClick={() => void run(`return:${ticket.id}`, () => returnTicketAction(ticket.id))}
              >
                Return to queue
              </Button>
            </div>
            <p className="panel-note">
              Cannot finish it? Release the ticket for another technician. Notes, devices, time,
              collaborators and history all stay with it.
            </p>
          </div>
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
                      variant="ghost"
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

        {mayManage && candidates.length > 0 ? (
          <form onSubmit={onAdd} className="form">
            <Field label="Add a collaborator" htmlFor={`add-collab-${ticket.id}`} error={error}>
              <select
                id={`add-collab-${ticket.id}`}
                value={collaboratorId}
                onChange={(event) => {
                  setCollaboratorId(event.target.value);
                  setError(null);
                }}
              >
                <option value="">Choose an account</option>
                {candidates.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
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
