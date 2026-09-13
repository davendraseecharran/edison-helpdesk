'use server';

/**
 * Invites.
 *
 * An invite is a pre-authorization, not a credential: a row saying "if somebody
 * proves to Google that they own this address, give them this role". It holds
 * no token and no link, so a forwarded or intercepted invite message buys the
 * reader nothing they could not have got by asking an administrator.
 *
 * That is why the email here is a convenience. The database decides; mail only
 * tells the person to go and sign in. When mail is not configured the action
 * still succeeds and hands the administrator the text to send themselves.
 *
 * Authorization is the database's, not this module's: `app_admin_create_invite`
 * and `app_admin_revoke_invite` run in the administrator's own session and
 * re-derive the actor from auth.uid(). The check below is a fast fail only.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { appOrigin } from '@/lib/supabase/config';
import { loadActor } from '@/lib/auth/session';
import { sendMail } from '@/lib/email/resend';
import { SCHOOL_TIME_ZONE } from '@/lib/format';
import type { AccountRole } from '@/lib/auth/session';

export interface InviteActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  inviteId?: string;
  /** False when mail is not set up or the provider refused: show the text. */
  emailed?: boolean;
  /** The message an administrator can copy and send by hand. */
  inviteText?: string;
}

const INVITE_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function roleWording(role: AccountRole): string {
  return role === 'admin' ? 'an administrator' : 'a technician';
}

/** Not exported: a `'use server'` module may only export async functions. */
function inviteMessage({
  name,
  invitedBy,
  role,
  email,
  expiresAt,
}: {
  name: string;
  invitedBy: string;
  role: AccountRole;
  email: string;
  expiresAt: string;
}): string {
  return (
    `Hi ${name}, ${invitedBy} invited you to Edison Helpdesk as ${roleWording(role)}. ` +
    `Sign in with Google using ${email} at ${appOrigin()}. ` +
    `This invite expires on ${INVITE_DATE.format(new Date(expiresAt))}.`
  );
}

export async function createInviteAction(
  email: string,
  role: AccountRole,
  displayName: string,
): Promise<InviteActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return { ok: false, error: 'Only a signed-in administrator can send an invite.' };
  }

  const supabase = await createClient();
  const normalisedEmail = email.trim().toLowerCase();
  const name = displayName.trim();

  const { data: inviteId, error } = await supabase.rpc('app_admin_create_invite', {
    p_email: normalisedEmail,
    p_role: role,
    p_display_name: name === '' ? null : name,
  });
  if (error || typeof inviteId !== 'string') {
    return { ok: false, error: error?.message ?? 'The invite could not be created. Try again.' };
  }

  // Read the row back rather than recomputing the expiry here, so the message
  // states the date the database will actually enforce.
  const { data: invites } = await supabase.rpc('app_admin_list_invites');
  const created = Array.isArray(invites)
    ? (invites as { id: string; expires_at: string }[]).find((row) => row.id === inviteId)
    : undefined;
  const expiresAt = created?.expires_at ?? new Date(Date.now() + 14 * 86_400_000).toISOString();

  const inviteText = inviteMessage({
    name: name === '' ? 'there' : name,
    invitedBy: actor.account.displayName,
    role,
    email: normalisedEmail,
    expiresAt,
  });

  const mail = await sendMail({
    to: normalisedEmail,
    subject: 'Your Edison Helpdesk invite',
    text: inviteText,
  });

  revalidatePath('/admin');

  if (mail.ok) {
    return {
      ok: true,
      inviteId,
      emailed: true,
      inviteText,
      message: `Invite sent to ${normalisedEmail}.`,
    };
  }

  return {
    ok: true,
    inviteId,
    emailed: false,
    inviteText,
    message:
      mail.reason === 'not_configured'
        ? `${normalisedEmail} is invited. Copy the message below and send it yourself.`
        : `${normalisedEmail} is invited, but the message could not be sent. Copy it below and send it yourself.`,
  };
}

export async function revokeInviteAction(inviteId: string): Promise<InviteActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return { ok: false, error: 'Only a signed-in administrator can revoke an invite.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_admin_revoke_invite', { p_invite: inviteId });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin');
  return { ok: true, message: 'Invite revoked. That address no longer gains access on sign-in.' };
}
