'use client';

/**
 * Account administration.
 *
 * The generated link is a credential: it is shown once, in the result of the
 * action that created it, and is never written to the account history, the
 * audit trail, or anywhere else. Reloading the page does not bring it back —
 * the admin issues a new one instead.
 */

import { useState } from 'react';
import {
  cancelCredentialActionAction,
  createTechnicianAccountAction,
  issueCredentialLinkAction,
  setAccountStatusAction,
} from '@/lib/data/account-actions';
import { useRuntime } from '@/components/AppRuntime';
import { formatDateTime } from '@/lib/format';
import { Field } from '@/components/Primitives';
import { AccountStatusBadge, RoleBadge } from '@/components/Badges';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Tabs } from '@/components/ui/Tabs';
import type { AdminAccountView } from '@/lib/data/admin-view';

interface IssuedLink {
  accountId: string;
  displayName: string;
  url: string;
  expiresInSeconds: number;
}

export function AdministrationScreen({
  accounts,
  currentAccountId,
}: {
  accounts: AdminAccountView[];
  currentAccountId: string;
}) {
  const { pendingKey, run } = useRuntime();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [copied, setCopied] = useState(false);

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const result = await run('create-account', async () => {
      const outcome = await createTechnicianAccountAction(displayName, email);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
    if (result.ok) {
      setDisplayName('');
      setEmail('');
    } else {
      setFormError(result.error ?? 'The account could not be created.');
    }
  }

  async function onIssue(account: AdminAccountView, purpose: 'setup' | 'recovery') {
    setIssued(null);
    setCopied(false);
    const key = `link:${account.id}:${purpose}`;
    let link: string | undefined;
    let ttl = 0;

    const result = await run(key, async () => {
      const outcome = await issueCredentialLinkAction(account.id, purpose);
      link = outcome.link;
      ttl = outcome.expiresInSeconds ?? 0;
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });

    if (result.ok && link) {
      setIssued({
        accountId: account.id,
        displayName: account.displayName,
        url: link,
        expiresInSeconds: ttl,
      });
    }
  }

  async function onStatus(account: AdminAccountView, status: 'active' | 'inactive') {
    await run(`status:${account.id}`, async () => {
      const outcome = await setAccountStatusAction(account.id, status);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  async function onCancel(account: AdminAccountView) {
    await run(`cancel:${account.id}`, async () => {
      const outcome = await cancelCredentialActionAction(account.id);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  const busy = pendingKey !== null;

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
      width: 132,
      cell: (account) => <RoleBadge role={account.role} />,
    },
    {
      key: 'status',
      header: 'Status',
      width: 150,
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
            {account.status === 'inactive' ? (
              <span className="admin-sub admin-sub-warn">Needs reassignment</span>
            ) : null}
          </>
        ),
    },
    {
      key: 'credential',
      header: 'Last credential action',
      hideOnPhone: true,
      width: 220,
      cell: (account) =>
        account.lastCredentialActionAt ? (
          <>
            {account.lastCredentialActionKind === 'setup_issued'
              ? 'Setup link issued'
              : 'Recovery link issued'}
            <span className="admin-sub">{formatDateTime(account.lastCredentialActionAt)}</span>
          </>
        ) : (
          <span className="muted">None recorded</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'right',
      cell: (account) => {
        const isSelf = account.id === currentAccountId;
        return (
          <div className="btn-row admin-actions">
            {account.status === 'setup_pending' ? (
              <Button
                size="sm"
                disabled={busy || isSelf}
                loading={pendingKey === `link:${account.id}:setup`}
                onClick={() => void onIssue(account, 'setup')}
              >
                {account.credentialActionPending ? 'Reissue setup link' : 'Issue setup link'}
              </Button>
            ) : null}
            {account.status === 'active' && !isSelf ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  loading={pendingKey === `link:${account.id}:recovery`}
                  onClick={() => void onIssue(account, 'recovery')}
                >
                  Issue recovery link
                </Button>
                {account.credentialActionPending ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    loading={pendingKey === `cancel:${account.id}`}
                    onClick={() => void onCancel(account)}
                  >
                    Cancel link
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  loading={pendingKey === `status:${account.id}`}
                  onClick={() => void onStatus(account, 'inactive')}
                >
                  Deactivate
                </Button>
              </>
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
            {isSelf ? <span className="muted">Your account</span> : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <Tabs items={[{ href: '/admin', label: 'Accounts', count: accounts.length }]} label="Administration sections" />

      <div className="stack">
        <p className="callout">
          Setup and recovery links are single-use and expire. Hand one over in person after you
          have confirmed who you are talking to; the system sends no email. Issuing a link suspends
          that account&apos;s access until they finish choosing a password.
        </p>

        {issued ? (
          <section className="panel" aria-labelledby="issued-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="issued-heading">
                Link for {issued.displayName}
              </h2>
              <span className="badge badge-chip badge-simulated">Shown once</span>
            </div>
            <div className="panel-body stack-sm">
              <p className="panel-note">
                Copy this now and deliver it directly. It is not stored anywhere and will not be
                shown again. It expires in {Math.round(issued.expiresInSeconds / 60)} minutes and
                stops working as soon as it is used.
              </p>
              <div className="admin-link-row">
                <input
                  type="text"
                  readOnly
                  value={issued.url}
                  aria-label={`Setup link for ${issued.displayName}`}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(issued.url);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
                  Hide
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="panel" aria-labelledby="accounts-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="accounts-heading">
              Technician accounts
            </h2>
            <span className="panel-aside">
              {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={accounts}
            rowKey={(account) => account.id}
            caption="Helpdesk accounts and credential actions"
            cardTitle={(account) => account.displayName}
            cardMeta={(account) => account.email}
          />
        </section>

        <div className="admin-grid">
          <section className="panel" aria-labelledby="add-account-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="add-account-heading">
                Add a technician
              </h2>
            </div>
            <div className="panel-body">
              <form onSubmit={onCreate} className="form">
                <Field label="Full name" htmlFor="new-account-name">
                  <input
                    id="new-account-name"
                    type="text"
                    required
                    value={displayName}
                    disabled={busy}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      setFormError(null);
                    }}
                    placeholder="Jordan Pike"
                  />
                </Field>
                <Field
                  label="School email"
                  htmlFor="new-account-email"
                  error={formError}
                  hint="The account starts with setup pending and cannot reach tickets until the technician sets a password."
                >
                  <input
                    id="new-account-email"
                    type="email"
                    required
                    value={email}
                    disabled={busy}
                    aria-invalid={formError ? 'true' : undefined}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setFormError(null);
                    }}
                    placeholder="first.last@edison.example"
                  />
                </Field>
                <div className="form-actions">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    loading={pendingKey === 'create-account'}
                  >
                    Create account
                  </Button>
                </div>
              </form>
            </div>
          </section>

          <section className="panel" aria-labelledby="rules-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="rules-heading">
                How accounts are handled
              </h2>
            </div>
            <div className="panel-body">
              <ul className="admin-rules">
                <li>Administrators create accounts; there is no public sign-up.</li>
                <li>
                  Links are handed over privately after you confirm the person. Knowing an email
                  address is not proof of ownership.
                </li>
                <li>You never see a chosen password; only the technician sets it.</li>
                <li>
                  Issuing a link supersedes any earlier one for that account, and using a link
                  signs every other session out.
                </li>
                <li>
                  Deactivation preserves authorship and history, and takes effect immediately for
                  sessions that are already open.
                </li>
                <li>Roles are not editable here; they are set when the account is provisioned.</li>
              </ul>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
