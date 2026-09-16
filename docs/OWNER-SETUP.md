# Setting up the hosted helpdesk

A checklist for the person who owns the Supabase project and the Vercel
deployment. It assumes the directory and the inventory are already live on the
hosted database — they are — and that this branch has been merged into `main`.

Nothing here needs the repository open in an editor. Everything is either one
command in a terminal or a setting in a dashboard. Where an order is marked, it
matters.

Two pieces of vocabulary, because the screens use them:

- **NetRider** is what this school calls the students who run the helpdesk.
  Inside the database the old spelling `technician` survives as a derived
  value; nobody is shown it.
- **Skills officer** is somebody who works the student and staff directory.
  They see People and read the inventory. They see no tickets at all.

## Contents

- [1. Release the new version](#1-release-the-new-version)
- [2. Turn on Google sign-in](#2-turn-on-google-sign-in)
- [3. Let the first people in](#3-let-the-first-people-in)
- [4. What the first sign-in looks like](#4-what-the-first-sign-in-looks-like)
- [If something goes wrong](#if-something-goes-wrong)

## 1. Release the new version

The database changes are **additive**. No table the district's data lives in is
dropped, renamed or rewritten, and no existing policy or grant is changed. The
thirty-eight new migrations are all numbered above the nineteen the hosted
project already carries, so they apply in order after them.

Do this from a terminal in a copy of the repository that is linked to the
hosted project (`npx supabase link` has already been run there).

**Before you push.**

1. Take a backup. The provider's own snapshot is fine; so is
   Administration → Backups inside the app. A restore is the only answer to a
   data mistake, and there is no undo migration.
2. Set the Vercel environment variables for **Production**. Three are already
   there from the first deployment (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) and stay as
   they are. Add:

   | Variable | Value | Needed for |
   | --- | --- | --- |
   | `NEXT_PUBLIC_APP_ORIGIN` | `https://edison-helpdesk.vercel.app` | Setup and recovery links. Required. |
   | `AI_TOKEN_KEY` | the output of `openssl rand -base64 32` | The assistant. Optional. |
   | `RESEND_API_KEY` | a Resend API key | Emailed invites. Optional. |
   | `MAIL_FROM` | an address on a domain verified with Resend | Emailed invites. Optional. |

   `AI_TOKEN_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only. Never give
   either a `NEXT_PUBLIC_` prefix and never paste them into a browser. Rotating
   `AI_TOKEN_KEY` makes every saved assistant connection unreadable, and
   everybody reconnects.

   Without `RESEND_API_KEY` and `MAIL_FROM`, invites still work: the
   Administration screen hands you the message to send yourself.

3. Check what is pending:

   ```bash
   npx supabase migration list --linked
   ```

   Thirty-eight files should be listed as present locally and missing remotely,
   and nothing should be the other way round.

**The release.**

```bash
npx supabase db push        # applies the thirty-eight migrations, in order
vercel --prod --skip-domain # build and deploy
# promote the alias once the deployment is Ready and you have looked at it
```

**Then, in the Supabase dashboard, in this order.** The order of the first two
is the one that matters for safety: with sign-ups allowed and no hook, anybody
who knows the project URL and the public anon key can create an account.

1. **Authentication → Hooks → Before User Created.** Choose *Postgres function*,
   pick `public.hook_before_user_created`, and enable it. Confirm it reads as
   enabled before you continue. It refuses email-and-password sign-up with a
   403 and lets Google through.
2. **Authentication → Sign In / Providers → Allow new users to sign up.** Turn
   it on.
3. **Storage.** There should be a bucket named `attachments`: **not public**,
   8 MiB file size limit, accepting `image/jpeg`, `image/png`, `image/webp`,
   `image/gif` and `application/pdf`. The release creates it. The app checks
   for it at startup and says so if it is missing.
4. **Database → Replication (Realtime).** Turn Realtime on for the
   `scan_events` table. This is optional: with it off, a phone used as a
   scanner still works, it just polls instead of pushing.
5. **A daily job for the scan sweeper**, when you get to it.
   `public.app_sweep_scan_sessions()` clears pairing sessions that ended more
   than a day ago. It needs an external scheduler calling it with the service
   key; it cannot be driven by `pg_cron` as written.

**Do not import anything.** The directory and the inventory are already live.
This version adds no import path of its own, and the old preparation scripts
refuse to run once a requester carries an external id.

## 2. Turn on Google sign-in

Everyone signs in with Google. Password sign-in exists only as a break-glass
path for an administrator (see [If something goes wrong](#if-something-goes-wrong)).

**In Google Cloud**, in the project you want to own this:

1. **APIs & Services → OAuth consent screen.** User type *External*. Fill in
   the app name, a support email and a developer contact email. **Publish** it
   — while it is in testing only the accounts you list by hand can sign in.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
   Application type *Web application*. Set:

   - **Authorised JavaScript origin**: `https://edison-helpdesk.vercel.app`
   - **Authorised redirect URI**: `https://<project-ref>.supabase.co/auth/v1/callback`

   The redirect URI is **Supabase's** callback, not the application's own
   `/auth/callback`. Supabase is what Google talks to; Supabase then sends the
   browser on to the app. `<project-ref>` is the subdomain in your Supabase
   project URL.
3. Copy the client id and the client secret.

**In the Supabase dashboard:**

4. **Authentication → Sign In / Providers → Google.** Paste the client id and
   the client secret, and enable it.
5. **Authentication → URL Configuration.** Site URL
   `https://edison-helpdesk.vercel.app`, and add
   `https://edison-helpdesk.vercel.app/auth/callback` to the redirect allow
   list.

**On Vercel:**

6. Confirm `NEXT_PUBLIC_APP_ORIGIN` is `https://edison-helpdesk.vercel.app`
   with no trailing slash, then **redeploy** so the running build picks up any
   variable you added after the last deployment. Environment variables are read
   at build time; adding one without redeploying changes nothing.

Then sign in yourself, in a private window, to check the whole loop.

## 3. Let the first people in

Any Google account with a verified email address may *reach* the sign-in page,
including a personal one. The gate is not the email domain — it is the invite
or your approval.

**Inviting somebody** (the normal way):

1. Sign in as an administrator and open **Administration**.
2. Invite by email address, and choose the roles: administrator, NetRider,
   skills officer, or more than one. An account holds a set of roles and must
   keep at least one.
3. If mail is configured the invite is sent. If it is not, the screen gives you
   the message to pass on. Either way the invite is a row in the database, not
   a link with a token in it, so a missing mail provider never blocks anybody.

**Approving somebody who signed in without an invite:**

1. They sign in with Google and land on a waiting screen. They can reach
   nothing else.
2. You see them under Administration, and either approve them with a set of
   roles or decline.
3. Fifty requests may be outstanding at once. Past that, a new uninvited
   sign-in is turned away and told to come back, and nothing is recorded —
   answering any waiting request frees a slot at once. Invites are never
   affected by this.

**Changing what somebody can do:** Administration → Access shows each account's
roles as chips. Editing them there is the only door to a role change, and it
refuses to remove the last administrator and refuses to leave an account with
no role at all. Every change is written to the audit log.

A reasonable first set: yourself as administrator, the students who run the
helpdesk as NetRiders, and whoever maintains the student and staff lists as a
skills officer.

## 4. What the first sign-in looks like

- The sign-in page offers **Sign in with Google**, and a quieter "Use a
  password" for the break-glass account.
- An invited person lands on **Today**: the four things that might need them
  right now — the unclaimed queue, their own tickets waiting on a reply, their
  live work, and, for an administrator, the people waiting for access. When
  nothing needs them it says so rather than showing an empty table.
- A skills officer lands on **People** instead, because they work the directory
  and see no tickets.
- An uninvited person lands on the waiting screen and stays there until you
  answer.
- The rail is Today, the queue, People, Devices, and Administration for
  administrators. The command palette opens with the keyboard and also talks to
  the assistant.
- The assistant is only there if `AI_TOKEN_KEY` is set, and each person
  connects their own ChatGPT account to it once.

Nothing in the app can be reached without signing in. Every screen that needs a
session is rendered per request; nothing about the school is baked into the
deployed files.

## If something goes wrong

**Rolling back a deployment.** The migrations are additive, so the previous
version of the application keeps working against the new schema. Re-promote the
last known-good deployment on Vercel. Nothing in the database needs undoing,
and there is deliberately no down migration: reversing a schema the live
directory depends on is worse than the fault it would be reverting.

**Locked out of every administrator account.** Password sign-in is the way
back. An administrator account is created from Administration and given a
single-use setup or recovery link, handed over directly rather than emailed.

If you instead reset an administrator's password from the Supabase dashboard,
or with the admin API, **that account's sessions stop working on purpose**: the
app records a fingerprint of the stored password when the account is created
and treats a change it did not make as a sign that the credential was changed
out from under it. Every request then answers "This session has been signed
out". Use the app's own recovery link, which re-approves the fingerprint in the
same transaction as the password change.

**Attachments after a deletion.** Deleting a ticket or a device removes its
attachment rows but not the uploaded bytes, which stay in the private bucket.
Nothing can read them. To reclaim the space, list `storage.objects` in the
`attachments` bucket, left-join `public.attachments` on `name = path`, and
delete the objects with no match. That is safe at any time.

**Where the detail is.** [docs/M5-PLATFORM-OVERHAUL.md](M5-PLATFORM-OVERHAUL.md)
carries the full runbook, the deployment transcript and the known limitations.
