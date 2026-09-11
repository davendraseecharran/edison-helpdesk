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

export function OwnershipPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [collaboratorId, setCollaboratorId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayManage = canManageCollaborators(ticket, actor);
  const mayClaim = canClaimTicket(ticket, actor);

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
    <div className="card">
      <div className="card-header">
        <h2>People</h2>
      </div>
      <div className="card-body stack">
        <div>
          <p className="small subtle" style={{ marginBottom: 4 }}>
            Primary owner
          </p>
          {detail.owner ? (
            <div className="person-row">
              <span className="person">
                <Avatar name={detail.owner.displayName} />
                <span>
                  <span className="person-name">{detail.owner.displayName}</span>
                  <span className="person-meta">
                    {' '}
                    {ticket.assignedAt ? (
                      <>
                        since <TimeAgo iso={ticket.assignedAt} />
                      </>
                    ) : null}
                  </span>
                </span>
              </span>
              <RoleBadge role={detail.owner.role} />
            </div>
          ) : (
            <div className="person-row">
              <span className="muted">Unassigned — sitting in the Open Queue</span>
              {mayClaim ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void onClaim()}
                  disabled={pendingKey !== null}
                >
                  {pendingKey === `claim:${ticket.id}` ? 'Claiming…' : 'Claim'}
                </button>
              ) : null}
            </div>
          )}
        </div>

        {canReturnToQueue(ticket, actor) ? (
          <div className="stack-sm">
            <button
              type="button"
              className="btn btn-sm"
              disabled={pendingKey !== null}
              onClick={() => void run(`return:${ticket.id}`, () => returnTicketAction(ticket.id))}
            >
              {pendingKey === `return:${ticket.id}` ? 'Returning…' : 'Return to Open Queue'}
            </button>
            <p className="small subtle">
              Unable to finish? Release this ticket for another technician to claim.
              All notes, device information, time entries, collaborators, and history stay on the ticket.
            </p>
          </div>
        ) : null}

        <div>
          <p className="small subtle" style={{ marginBottom: 4 }}>
            Collaborators
          </p>
          {detail.collaborators.length === 0 ? (
            <p className="small muted">No collaborators.</p>
          ) : (
            detail.collaborators.map((collaborator) => (
              <div className="person-row" key={collaborator.id}>
                <span className="person">
                  <Avatar name={collaborator.displayName} />
                  <span className="person-name">{collaborator.displayName}</span>
                </span>
                {mayManage ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => void onRemove(collaborator.id)}
                    disabled={pendingKey !== null}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>

        {mayManage && candidates.length > 0 ? (
          <form onSubmit={onAdd} className="stack-sm">
            <Field label="Add a collaborator" htmlFor={`add-collab-${ticket.id}`} error={error}>
              <select
                id={`add-collab-${ticket.id}`}
                value={collaboratorId}
                onChange={(event) => {
                  setCollaboratorId(event.target.value);
                  setError(null);
                }}
              >
                <option value="">Select an account…</option>
                {candidates.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <button
                type="submit"
                className="btn btn-sm"
                disabled={!collaboratorId || pendingKey !== null}
              >
                {pendingKey === `add-collab:${ticket.id}` ? 'Adding…' : 'Add collaborator'}
              </button>
            </div>
          </form>
        ) : null}

        <p className="small subtle">
          Removing a collaborator revokes their further access. Notes and events they already
          authored keep their names.
        </p>
      </div>
    </div>
  );
}
