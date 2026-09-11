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

  return (
    <>
      <p className="notice" style={{ marginBottom: 16 }}>
        Setup and recovery links are single-use and expire. Hand one over in person after you have
        confirmed who you are talking to — the system sends no email. Issuing a link suspends that
        account&apos;s access until they finish choosing a password.
      </p>

      {issued ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h2>Link for {issued.displayName}</h2>
            <span className="badge badge-simulated">Shown once</span>
          </div>
          <div className="card-body stack-sm">
            <p className="small muted">
              Copy this now and deliver it directly. It is not stored anywhere and will not be
              shown again. It expires in {Math.round(issued.expiresInSeconds / 60)} minutes and
              stops working as soon as it is used.
            </p>
            <div className="row">
              <input
                readOnly
                value={issued.url}
                aria-label={`Setup link for ${issued.displayName}`}
                onFocus={(event) => event.currentTarget.select()}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.url);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setIssued(null)}>
                Hide
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-header">
          <h2>Technician accounts</h2>
          <span className="small subtle">{accounts.length} accounts</span>
        </div>
        <div className="table-wrap">
          <table className="tickets">
            <caption className="sr-only">Helpdesk accounts and credential actions</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Active tickets</th>
                <th scope="col">Last credential action</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const isSelf = account.id === currentAccountId;
                return (
                  <tr key={account.id}>
                    <td className="cell-title" data-label="Name">
                      <strong>{account.displayName}</strong>
                      <span className="cell-sub">{account.email}</span>
                    </td>
                    <td data-label="Role">
                      <RoleBadge role={account.role} />
                    </td>
                    <td data-label="Status">
                      <AccountStatusBadge status={account.status} />
                      {account.credentialActionPending ? (
                        <span className="cell-sub">Link outstanding</span>
                      ) : null}
                    </td>
                    <td data-label="Active tickets">
                      {account.activeTicketCount === 0 ? (
                        <span className="subtle">None</span>
                      ) : (
                        <span>
                          {account.activeTicketCount}
                          {account.status === 'inactive' ? (
                            <span className="cell-sub" style={{ color: 'var(--warning)' }}>
                              Needs reassignment
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td data-label="Last credential action">
                      {account.lastCredentialActionAt ? (
                        <span className="small">
                          {account.lastCredentialActionKind === 'setup_issued'
                            ? 'Setup link issued'
                            : 'Recovery link issued'}
                          <span className="cell-sub">
                            {formatDateTime(account.lastCredentialActionAt)}
                          </span>
                        </span>
                      ) : (
                        <span className="subtle">None recorded</span>
                      )}
                    </td>
                    <td className="cell-actions" data-label="Actions">
                      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        {account.status === 'setup_pending' ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy || isSelf}
                            onClick={() => void onIssue(account, 'setup')}
                          >
                            {account.credentialActionPending ? 'Reissue setup link' : 'Issue setup link'}
                          </button>
                        ) : null}
                        {account.status === 'active' && !isSelf ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => void onIssue(account, 'recovery')}
                            >
                              Issue recovery link
                            </button>
                            {account.credentialActionPending ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={busy}
                                onClick={() => void onCancel(account)}
                              >
                                Cancel link
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              disabled={busy}
                              onClick={() => void onStatus(account, 'inactive')}
                            >
                              Deactivate
                            </button>
                          </>
                        ) : null}
                        {account.status === 'inactive' ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => void onStatus(account, 'active')}
                          >
                            Reactivate
                          </button>
                        ) : null}
                        {isSelf ? <span className="small subtle">Your account</span> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-header">
            <h2>Add a technician</h2>
          </div>
          <div className="card-body">
            <form onSubmit={onCreate} className="stack-sm">
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
              <div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                  {pendingKey === 'create-account' ? 'Saving…' : 'Create account'}
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-header">
            <h2>Account handling rules</h2>
          </div>
          <div className="card-body">
            <ul className="stack-sm small muted" style={{ margin: 0, paddingLeft: 18 }}>
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
        </div>
      </div>
    </>
  );
}
