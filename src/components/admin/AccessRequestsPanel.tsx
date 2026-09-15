'use client';

/**
 * Access requests.
 *
 * Somebody signed in with Google using an address Google confirmed they own,
 * and no invite was waiting for it. That proves who they are and nothing about
 * whether they belong here, so the account exists with no access at all until
 * an administrator answers. Approving is also where the role is chosen — the
 * database refuses to separate the two decisions.
 *
 * Presentational: the dialog and the actions live in AccessScreen, so the same
 * approve flow serves this panel and the accounts table.
 */

import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { AdminAccountView } from '@/lib/data/admin-view';

export function AccessRequestsPanel({
  requests,
  busy,
  pendingKey,
  onApprove,
  onDecline,
}: {
  requests: AdminAccountView[];
  busy: boolean;
  pendingKey: string | null;
  onApprove: (account: AdminAccountView) => void;
  onDecline: (account: AdminAccountView) => void;
}) {
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
      key: 'asked',
      header: 'First signed in',
      width: 220,
      cell: (account) => formatDateTime(account.createdAt),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'right',
      cell: (account) => (
        <div className="btn-row admin-actions">
          {/*
            Not the accented one. A waiting list of seven requests drew seven
            filled Approve buttons down one column, which is the accent used as
            a highlighter rather than as a signal, and it read as a
            recommendation to let everybody in. Neither answer is the default
            here: the pair is quiet and the decision is the reader's.
          */}
          <Button size="sm" disabled={busy} onClick={() => onApprove(account)}>
            Approve
          </Button>
          <Button
            size="sm"
            disabled={busy}
            loading={pendingKey === `review:${account.id}`}
            onClick={() => onDecline(account)}
          >
            Decline
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="panel" aria-labelledby="access-requests-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="access-requests-heading">
          Access requests
        </h2>
        <span className="panel-aside">
          {requests.length === 0 ? 'Nobody waiting' : `${requests.length} waiting for a decision`}
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={requests}
        rowKey={(account) => account.id}
        caption="People who signed in with Google and are waiting for an access decision"
        cardTitle={(account) => account.displayName}
        cardMeta={(account) => account.email}
        /* One line, not a 280px illustration of nothing. The panel's own head
           already says "Nobody waiting" four inches above this, and an empty
           state that restates the heading in three sentences pushes the
           accounts table — the thing an administrator came for — below the
           fold. */
        empty={
          <p className="panel-empty empty-line">
            Requests appear here when somebody signs in with no invite.
          </p>
        }
      />
    </section>
  );
}
