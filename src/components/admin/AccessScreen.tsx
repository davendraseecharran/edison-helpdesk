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
import { ChevronDown } from 'lucide-react';
import { reviewAccessRequestAction, setRoleAction } from '@/lib/data/access-actions';
import { setAccountStatusAction } from '@/lib/data/account-actions';
import { useRuntime } from '@/components/AppRuntime';
import { AccountStatusBadge, RoleBadge } from '@/components/Badges';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AccessRequestsPanel } from './AccessRequestsPanel';
import { InvitesPanel } from './InvitesPanel';
import { PasswordAccountsPanel } from './PasswordAccountsPanel';
import type { AccountRole } from '@/lib/auth/session';
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
  const [approveRole, setApproveRole] = useState<AccountRole>('technician');

  const busy = pendingKey !== null;
  const requests = accounts.filter((account) => account.status === 'pending_approval');

  async function onReview(
    account: AdminAccountView,
    decision: 'approve' | 'deny',
    role: AccountRole = 'technician',
  ) {
    await run(`review:${account.id}`, async () => {
      const outcome = await reviewAccessRequestAction(account.id, decision, role);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  async function onRole(account: AdminAccountView, role: AccountRole) {
    await run(`role:${account.id}`, async () => {
      const outcome = await setRoleAction(account.id, role);
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
    setApproveRole('technician');
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
      header: 'Role',
      width: 190,
      cell: (account) => {
        const isSelf = account.id === currentAccountId;
        // A role is chosen by approving, so an account waiting for or refused a
        // decision has none yet — showing the stored default would read as a
        // role somebody already holds. Nobody changes their own.
        if (account.status === 'pending_approval' || account.status === 'denied') {
          return <span className="muted">Set on approval</span>;
        }
        if (isSelf) return <RoleBadge role={account.role} />;
        return (
          <div className="btn-row admin-actions">
            <RoleBadge role={account.role} />
            <Menu
              label={`Role for ${account.displayName}`}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronDown}
                  aria-label={`Change the role for ${account.displayName}`}
                  disabled={busy}
                />
              }
              items={[
                {
                  key: 'technician',
                  label: 'Make technician',
                  disabled: account.role === 'technician',
                  onSelect: () => void onRole(account, 'technician'),
                },
                {
                  key: 'admin',
                  label: 'Make administrator',
                  disabled: account.role === 'admin',
                  onSelect: () => void onRole(account, 'admin'),
                },
              ]}
            />
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
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                loading={pendingKey === `status:${account.id}`}
                onClick={() => void onStatus(account, 'inactive')}
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

  return (
    <div className="stack">
      <p className="callout">
        People sign in with Google. An invite decides the role an address gets the first time it
        is used; anyone else who signs in lands in access requests and can reach nothing until you
        answer. Deactivation preserves authorship and history and takes effect immediately for
        sessions that are already open.
      </p>

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
          caption="Helpdesk accounts, their role and their access state"
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
                await onReview(approving, 'approve', approveRole);
                setApproving(null);
              }}
            >
              Approve
            </Button>
          </>
        }
      >
        <div className="field">
          <span className="field-label">Role</span>
          <SegmentedControl
            label="Role"
            value={approveRole}
            options={[
              { value: 'technician', label: 'Technician' },
              { value: 'admin', label: 'Administrator' },
            ]}
            onChange={setApproveRole}
          />
          <span className="field-hint">
            Technicians work tickets. Administrators also manage accounts, invites and access. You
            can change this later.
          </span>
        </div>
      </Dialog>
    </div>
  );
}
