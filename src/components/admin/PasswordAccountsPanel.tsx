'use client';

/**
 * Password accounts: the path for somebody without a Google account.
 *
 * Google sign-in and invites are the normal way in now, so this is the fallback
 * and sits below them. The behaviour is unchanged from M3: the generated link
 * is a credential, shown once in the result of the action that created it and
 * never written to the account history, the audit trail, or anywhere else.
 * Reloading the page does not bring it back — the administrator issues a new
 * one instead.
 */

import { useState } from 'react';
import {
  cancelCredentialActionAction,
  createTechnicianAccountAction,
  issueCredentialLinkAction,
} from '@/lib/data/account-actions';
import { useRuntime } from '@/components/AppRuntime';
import { formatDateTime } from '@/lib/format';
import { Field } from '@/components/Primitives';
import { AccountStatusBadge } from '@/components/Badges';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { AdminAccountView } from '@/lib/data/admin-view';

interface IssuedLink {
  displayName: string;
  url: string;
  expiresInSeconds: number;
}

export function PasswordAccountsPanel({
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

  const busy = pendingKey !== null;

  // An account still waiting for an access decision has no password flow at
  // all: approving it is the next step, not handing over a link.
  const rows = accounts.filter(
    (account) => account.status !== 'pending_approval' && account.status !== 'denied',
  );

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
    let link: string | undefined;
    let ttl = 0;

    const result = await run(`link:${account.id}:${purpose}`, async () => {
      const outcome = await issueCredentialLinkAction(account.id, purpose);
      link = outcome.link;
      ttl = outcome.expiresInSeconds ?? 0;
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });

    if (result.ok && link) {
      setIssued({ displayName: account.displayName, url: link, expiresInSeconds: ttl });
    }
  }

  async function onCancel(account: AdminAccountView) {
    await run(`cancel:${account.id}`, async () => {
      const outcome = await cancelCredentialActionAction(account.id);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
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
        if (isSelf) return <span className="muted">Your account</span>;
        return (
          <div className="btn-row admin-actions">
            {account.status === 'setup_pending' ? (
              <Button
                size="sm"
                disabled={busy}
                loading={pendingKey === `link:${account.id}:setup`}
                onClick={() => void onIssue(account, 'setup')}
              >
                {account.credentialActionPending ? 'Reissue setup link' : 'Issue setup link'}
              </Button>
            ) : null}
            {account.status === 'active' ? (
              <Button
                size="sm"
                disabled={busy}
                loading={pendingKey === `link:${account.id}:recovery`}
                onClick={() => void onIssue(account, 'recovery')}
              >
                Issue recovery link
              </Button>
            ) : null}
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
          </div>
        );
      },
    },
  ];

  return (
    <section className="panel" aria-labelledby="password-accounts-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="password-accounts-heading">
          Password accounts
        </h2>
        <span className="panel-aside">For anyone who cannot use Google</span>
      </div>
      <div className="panel-body stack-sm">
        <p className="panel-note">
          Setup and recovery links are single-use and expire. Hand one over in person after you
          have confirmed who you are talking to; the system sends no email for these. Issuing a
          link suspends that account&apos;s access until they finish choosing a password.
        </p>

        {issued ? (
          <div className="callout callout-warn">
            <p>
              <strong>Link for {issued.displayName}.</strong> Copy it now and deliver it
              directly. It is not stored anywhere and will not be shown again. It expires in{' '}
              {Math.round(issued.expiresInSeconds / 60)} minutes and stops working as soon as it
              is used.
            </p>
            <div className="admin-link-row">
              <input
                type="text"
                readOnly
                value={issued.url}
                aria-label={`Single-use link for ${issued.displayName}`}
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
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(account) => account.id}
        caption="Accounts that sign in with a password, and their credential actions"
        cardTitle={(account) => account.displayName}
        cardMeta={(account) => account.email}
        empty={<p className="muted">No password accounts yet.</p>}
      />

      <div className="panel-body stack-sm">
        <p className="panel-note">
          <strong>Add a password account.</strong> Only for somebody who cannot sign in with
          Google. Everyone else gets an invite instead.
        </p>
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
            hint="The account starts with setup pending and cannot reach tickets until they set a password."
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
              size="sm"
              disabled={busy}
              loading={pendingKey === 'create-account'}
            >
              Add a password account
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
