'use client';

/**
 * People and access.
 *
 * Everything on this tab answers one question: who may use the helpdesk, and as
 * what. Four surfaces, in the order an administrator meets them — requests
 * waiting for an answer, the accounts that already exist, invites for people
 * who have not signed in yet, and the password fallback underneath.
 *
 * No decision is made here. Every action calls an RPC that re-derives the
 * administrator from auth.uid(), takes its own lock and writes its own history,
 * so a stale page, a forged request or two administrators clicking at once all
 * end up with the database's answer rather than this component's.
 */

import { useState } from 'react';
import { reviewAccessRequestAction, setRolesAction } from '@/lib/data/access-actions';
import { setAccountStatusAction } from '@/lib/data/account-actions';
import { useRuntime } from '@/components/AppRuntime';
import { AccountStatusBadge, RoleBadges } from '@/components/Badges';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { RolePicker } from '@/components/ui/RolePicker';
import { AccessRequestsPanel } from './AccessRequestsPanel';
import { InvitesPanel } from './InvitesPanel';
import { PasswordAccountsPanel } from './PasswordAccountsPanel';
import { sameRoles, type AccountRole } from '@/lib/auth/roles';
import type { AdminAccountView, InviteView } from '@/lib/data/admin-view';

export function AccessScreen({
  accounts,
  invites,
  invitesError,
  currentAccountId,
}: {
  accounts: AdminAccountView[];
  invites: InviteView[];
  invitesError: string | null;
  currentAccountId: string;
}) {
  const { pendingKey, run } = useRuntime();
  const [approving, setApproving] = useState<AdminAccountView | null>(null);
  const [approveRoles, setApproveRoles] = useState<AccountRole[]>(['netrider']);
  // The account a "Deactivate" press is asking about. The press opens the
  // question; the dialog is where the destructive answer lives.
  const [deactivating, setDeactivating] = useState<AdminAccountView | null>(null);
  // Which account's role chips are open, and what has been ticked in them.
  // Held here rather than in the cell so the table can rerender freely.
  const [editing, setEditing] = useState<{ id: string; roles: AccountRole[] } | null>(null);

  const busy = pendingKey !== null;
  const requests = accounts.filter((account) => account.status === 'pending_approval');

  async function onReview(
    account: AdminAccountView,
    decision: 'approve' | 'deny',
    roles: readonly AccountRole[] = ['netrider'],
  ) {
    await run(`review:${account.id}`, async () => {
      const outcome = await reviewAccessRequestAction(account.id, decision, roles);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  async function onRoles(account: AdminAccountView, roles: readonly AccountRole[]) {
    await run(`role:${account.id}`, async () => {
      const outcome = await setRolesAction(account.id, roles);
      if (outcome.ok) setEditing(null);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  async function onStatus(account: AdminAccountView, status: 'active' | 'inactive') {
    await run(`status:${account.id}`, async () => {
      const outcome = await setAccountStatusAction(account.id, status);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  function startApprove(account: AdminAccountView) {
    setApproveRoles(['netrider']);
    setApproving(account);
  }

  const columns: Column<AdminAccountView>[] = [
    {
      key: 'name',
      header: 'Name',
      hideOnPhone: true,
      cell: (account) => (
        <>
          <span className="admin-name">{account.displayName}</span>
          <span className="admin-sub">{account.email}</span>
        </>
      ),
    },
    {
      key: 'role',
      header: 'Roles',
      width: 260,
      cell: (account) => {
        const isSelf = account.id === currentAccountId;
        // Roles are chosen by approving, so an account waiting for or refused a
        // decision has none yet — showing the stored default would read as a
        // role somebody already holds. Nobody changes their own.
        if (account.status === 'pending_approval' || account.status === 'denied') {
          return <span className="muted">Set on approval</span>;
        }
        if (isSelf) return <RoleBadges roles={account.roles} />;

        const open = editing?.id === account.id;
        if (!open) {
          return (
            <div className="btn-row admin-actions">
              <RoleBadges roles={account.roles} />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setEditing({ id: account.id, roles: account.roles })}
              >
                Change
              </Button>
            </div>
          );
        }

        const chosen = editing.roles;
        return (
          <div className="stack-xs">
            <RolePicker
              label={`Roles for ${account.displayName}`}
              idPrefix={`role-${account.id}`}
              value={chosen}
              disabled={busy}
              onChange={(roles) => setEditing({ id: account.id, roles })}
            />
            <div className="btn-row">
              <Button
                variant="primary"
                size="sm"
                loading={pendingKey === `role:${account.id}`}
                disabled={busy || sameRoles(chosen, account.roles)}
                onClick={() => void onRoles(account, chosen)}
              >
                Save roles
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: 170,
      cell: (account) => (
        <>
          <AccountStatusBadge status={account.status} />
          {account.credentialActionPending ? (
            <span className="admin-sub">Link outstanding</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'active',
      header: 'Active tickets',
      align: 'right',
      width: 120,
      cell: (account) =>
        account.activeTicketCount === 0 ? (
          <span className="muted">None</span>
        ) : (
          <>
            {account.activeTicketCount}
            {account.status !== 'active' ? (
              <span className="admin-sub admin-sub-warn">Needs reassignment</span>
            ) : null}
          </>
        ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'right',
      cell: (account) => {
        const isSelf = account.id === currentAccountId;
        if (isSelf) return <span className="muted">Your account</span>;
        return (
          <div className="btn-row admin-actions">
            {account.status === 'pending_approval' || account.status === 'denied' ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => startApprove(account)}
                >
                  Approve
                </Button>
                {account.status === 'pending_approval' ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    loading={pendingKey === `review:${account.id}`}
                    onClick={() => void onReview(account, 'deny')}
                  >
                    Decline
                  </Button>
                ) : null}
              </>
            ) : null}
            {account.status === 'active' ? (
              /*
               * Quiet, because there is one of these on every active row and a
               * column of red outlines reads as a screen full of warnings
               * rather than a list of colleagues. The danger is not removed,
               * it is moved: the tone arrives under the pointer, and the
               * confirm dialog this opens carries the destructive button.
               */
              <Button
                variant="ghost"
                size="sm"
                className="btn-danger-quiet"
                disabled={busy}
                loading={pendingKey === `status:${account.id}`}
                onClick={() => setDeactivating(account)}
              >
                Deactivate
              </Button>
            ) : null}
            {account.status === 'inactive' ? (
              <Button
                size="sm"
                disabled={busy}
                loading={pendingKey === `status:${account.id}`}
                onClick={() => void onStatus(account, 'active')}
              >
                Reactivate
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  /*
   * No banner. The page header directly above this said the same two sentences
   * — people sign in with Google, an invite sets the role and anyone without
   * one waits here — and a screen that explains itself twice in four inches is
   * a screen that trusts neither copy.
   *
   * The two facts the banner had that the header does not are now where they
   * are actually needed rather than in a paragraph read once: that an account
   * can hold more than one role is under the role picker in the approve
   * dialog, and what deactivation does to open sessions is in the dialog that
   * deactivates.
   */
  return (
    <div className="stack">
      <AccessRequestsPanel
        requests={requests}
        busy={busy}
        pendingKey={pendingKey}
        onApprove={startApprove}
        onDecline={(account) => void onReview(account, 'deny')}
      />

      <section className="panel" aria-labelledby="accounts-heading">
        <div className="panel-head">
          <h2 className="panel-title" id="accounts-heading">
            Accounts
          </h2>
          <span className="panel-aside">
            {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
          </span>
        </div>
        <DataTable
          columns={columns}
          rows={accounts}
          rowKey={(account) => account.id}
          caption="Helpdesk accounts, their roles and their access state"
          cardTitle={(account) => account.displayName}
          cardMeta={(account) => account.email}
        />
      </section>

      <InvitesPanel invites={invites} loadError={invitesError} />

      <PasswordAccountsPanel accounts={accounts} currentAccountId={currentAccountId} />

      <Dialog
        open={approving !== null}
        onClose={() => setApproving(null)}
        title="Approve access"
        description={
          approving
            ? `${approving.displayName} signed in with ${approving.email}. Choose what they may do.`
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setApproving(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={approving !== null && pendingKey === `review:${approving.id}`}
              onClick={async () => {
                if (!approving) return;
                // Stay open while the database decides, so the spinner is on
                // the button that was pressed; close either way afterwards, and
                // the flash behind carries the outcome.
                await onReview(approving, 'approve', approveRoles);
                setApproving(null);
              }}
            >
              Approve
            </Button>
          </>
        }
      >
        <div className="field">
          <span className="field-label">Roles</span>
          <RolePicker
            label="Roles"
            idPrefix="approve"
            value={approveRoles}
            disabled={busy}
            onChange={setApproveRoles}
          />
          <span className="field-hint">
            NetRiders work tickets. Skills officers work the student and staff directory and see no
            tickets. Administrators also manage accounts, invites and access. Pick more than one if
            somebody does more than one job; you can change this later.
          </span>
        </div>
      </Dialog>

      <Dialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        title="Deactivate this account?"
        description={
          deactivating
            ? `${deactivating.displayName} (${deactivating.email}) will be signed out of every open session and will not be able to sign in again until an administrator reactivates the account.`
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setDeactivating(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={deactivating !== null && pendingKey === `status:${deactivating.id}`}
              onClick={async () => {
                if (!deactivating) return;
                await onStatus(deactivating, 'inactive');
                setDeactivating(null);
              }}
            >
              Deactivate
            </Button>
          </>
        }
      >
        <p className="muted">
          Everything they have written stays where it is, under their name: tickets they own, notes
          they added and the history they are in are all preserved.
        </p>
      </Dialog>
    </div>
  );
}
