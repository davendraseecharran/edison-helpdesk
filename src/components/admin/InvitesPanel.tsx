'use client';

/**
 * Invites.
 *
 * An invite is a pre-authorization, not a credential: it says what roles the
 * address gets when somebody proves to Google that they own it. Nothing here is
 * secret, which is why the message can safely be copied and sent by hand when
 * the server has no mail configured.
 *
 * Re-inviting an address supersedes the earlier invite rather than adding a
 * second one, and the list says so by showing the old row as revoked.
 */

import { useState } from 'react';
import { createInviteAction, revokeInviteAction } from '@/lib/data/invite-actions';
import { useRuntime } from '@/components/AppRuntime';
import { formatDateTime } from '@/lib/format';
import { Field } from '@/components/Primitives';
import { RoleBadges } from '@/components/Badges';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useCopied } from '@/components/ui/useCopied';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RolePicker } from '@/components/ui/RolePicker';
import type { AccountRole } from '@/lib/auth/roles';
import type { InviteState, InviteView } from '@/lib/data/admin-view';

const INVITE_STATE_TONE: Record<InviteState, string> = {
  pending: 'status-open',
  accepted: 'status-resolved',
  expired: 'status-waiting',
  revoked: 'status-cancelled',
};

const INVITE_STATE_LABEL: Record<InviteState, string> = {
  pending: 'Waiting to be used',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Revoked',
};

function InviteStateBadge({ state }: { state: InviteState }) {
  return (
    <span className={`badge badge-status ${INVITE_STATE_TONE[state]}`}>
      <span className="badge-dot" aria-hidden="true" />
      {INVITE_STATE_LABEL[state]}
    </span>
  );
}

export function InvitesPanel({
  invites,
  loadError,
}: {
  invites: InviteView[];
  /** Set when the list could not be read. An empty list is not the same thing. */
  loadError: string | null;
}) {
  const { notify, pendingKey, run } = useRuntime();
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<AccountRole[]>(['netrider']);
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [unsent, setUnsent] = useState<{ email: string; text: string } | null>(null);
  const { copied, copy } = useCopied();

  const busy = pendingKey !== null;
  const live = invites.filter((invite) => invite.state === 'pending').length;

  async function onSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setUnsent(null);

    let emailed = true;
    let text: string | undefined;
    const target = email.trim().toLowerCase();

    const result = await run('create-invite', async () => {
      const outcome = await createInviteAction(email, roles, name);
      emailed = outcome.emailed === true;
      text = outcome.inviteText;
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });

    if (!result.ok) {
      setFormError(result.error ?? 'The invite could not be created.');
      return;
    }
    setEmail('');
    setName('');
    setRoles(['netrider']);
    // Mail is a convenience: when it did not go out, the administrator sends
    // the same words themselves rather than the invite being lost.
    if (!emailed && text) setUnsent({ email: target, text });
  }

  async function onRevoke(invite: InviteView) {
    await run(`revoke:${invite.id}`, async () => {
      const outcome = await revokeInviteAction(invite.id);
      return { ok: outcome.ok, error: outcome.error, message: outcome.message };
    });
  }

  const columns: Column<InviteView>[] = [
    {
      key: 'email',
      header: 'Email',
      hideOnPhone: true,
      cell: (invite) => (
        <>
          <span className="admin-name">{invite.email}</span>
          {invite.displayName ? <span className="admin-sub">{invite.displayName}</span> : null}
        </>
      ),
    },
    {
      key: 'role',
      header: 'Roles',
      width: 190,
      cell: (invite) => <RoleBadges roles={invite.roles} />,
    },
    {
      key: 'state',
      header: 'State',
      width: 180,
      cell: (invite) => (
        <>
          <InviteStateBadge state={invite.state} />
          {invite.state === 'pending' ? (
            <span className="admin-sub">Expires {formatDateTime(invite.expiresAt)}</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'invited',
      header: 'Invited by',
      hideOnPhone: true,
      width: 200,
      cell: (invite) => (
        <>
          {invite.invitedByName ?? 'An administrator'}
          <span className="admin-sub">{formatDateTime(invite.createdAt)}</span>
        </>
      ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'right',
      cell: (invite) =>
        invite.state === 'pending' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            loading={pendingKey === `revoke:${invite.id}`}
            onClick={() => void onRevoke(invite)}
          >
            Revoke invite
          </Button>
        ) : null,
    },
  ];

  return (
    <section className="panel" aria-labelledby="invites-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="invites-heading">
          Invites
        </h2>
        <span className="panel-aside">
          {live === 0 ? 'None waiting to be used' : `${live} waiting to be used`}
        </span>
      </div>

      <div className="panel-body stack-sm">
        {loadError ? (
          <p className="flash flash-error" role="alert">
            {loadError}
          </p>
        ) : null}
        {/* One sentence, and it is the one the page header does not already
            say: the header above states that an invite sets the role an address
            gets. Repeating that here in longer words was the third telling on
            one screen. */}
        <p className="panel-note">Inviting an address again replaces its earlier invite.</p>

        <form onSubmit={onSend} className="form">
          <Field
            label="Google email"
            htmlFor="invite-email"
            error={formError}
            hint="Must be the address they sign in to Google with."
          >
            <input
              id="invite-email"
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

          <div className="field">
            <span className="field-label">Roles</span>
            <RolePicker
              label="Roles"
              idPrefix="invite"
              value={roles}
              disabled={busy}
              onChange={setRoles}
            />
            <span className="field-hint">
              NetRiders work tickets. Skills officers work the student and staff directory and see
              no tickets. Administrators also manage accounts, invites and access.
            </span>
          </div>

          <Field label="Name" htmlFor="invite-name" optional hint="Used to address the message.">
            <input
              id="invite-name"
              type="text"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder="Jordan Pike"
            />
          </Field>

          <div className="form-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy}
              loading={pendingKey === 'create-invite'}
            >
              Send invite
            </Button>
          </div>
        </form>

        {unsent ? (
          <div className="callout callout-warn">
            <p>
              Email is not set up on this server, so copy this message and send it yourself to{' '}
              {unsent.email}.
            </p>
            <div className="admin-link-row">
              <input
                type="text"
                readOnly
                value={unsent.text}
                aria-label={`Invite message for ${unsent.email}`}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                size="sm"
                icon={copied ? Check : Copy}
                iconKey={copied ? 'copied' : 'copy'}
                onClick={async () => {
                  if (!(await copy(unsent.text))) {
                    notify('error', 'Could not copy the message. Select it and copy it instead.');
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy message'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setUnsent(null)}>
                Hide
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={invites}
        rowKey={(invite) => invite.id}
        caption="Invites and their current state"
        cardTitle={(invite) => invite.email}
        cardMeta={(invite) => invite.displayName ?? undefined}
        empty={
          <p className="muted">
            {loadError ? 'The invite list is unavailable.' : 'No invites yet. Send one above.'}
          </p>
        }
      />
    </section>
  );
}
