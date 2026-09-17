# Setting up the hosted helpdesk

This is the checklist for the person who owns the Supabase project and the
Vercel deployment. It is written to be followed top to bottom, once, and it
says at each step what you should see, so you know the step worked before you
move to the next one. Budget about thirty minutes.

It assumes three things, all true today:

- the students' and staff directory and the device inventory are already live
  on the hosted database (they are; nothing here touches them);
- this version of the application has been merged into `main` (it has);
- you have a copy of the repository on your computer that is linked to the
  hosted project, which is the copy you ran `npx supabase link` in.

Nothing here needs the code open in an editor. Everything is one command in a
terminal or one setting in a dashboard. **Where an order is given, the order
matters, and the reason is stated.**

Two words the screens use:

- **NetRider** is what this school calls the students who run the helpdesk.
  Inside the database the old spelling `technician` survives as a derived
  value; nobody is shown it.
- **Skills officer** is somebody who works the student and staff directory.
  They see People and read the inventory. They see no tickets at all.

## Read this first: the site is already live, and it is waiting on you

Vercel builds `main` on every push. So the new code went live the moment the
branch landed on `main`, against the database exactly as it was. Until you
apply the database changes in section 1, the live site is in a known, harmless
half-state. This is what it looks like, so you recognise it and do not go
looking for a different fault:

- a notice at the top of every screen saying the database is behind the code;
- your own account is shown as a NetRider rather than an administrator, and
  Administration is missing from the rail;
- Queue, Collaborating and Resolved cannot load, and their counts read 0;
- Today says "The briefing could not be read just now."

None of this has changed anything in the database. The old functions are
being called with new arguments and refusing, that is all. Section 1 ends it.
Nothing else is needed for that.

## Where things stand, and what to do from now on

1. **Now:** section 1, the database push. That is the whole of what the live
   site is waiting on.
2. **Sign-in for now:** Google is not set up yet, and that is fine. Until it
   is, everyone signs in with a password. You create their account under
   Administration → Password accounts, hand them the single-use setup link
   it gives you, and they choose a password on it (at least eight
   characters). Anyone can change theirs later under Settings → Sign-in
   methods.
3. **Google, when you get to it:** section 4, then the one-command push in
   section 3. Nobody has to re-register: the same person adds Google to their
   existing account from Settings → Sign-in methods, and keeps their history.
4. **Email (Resend):** optional and skippable. Invites still work without it;
   the screen hands you the message to send yourself.

## Contents

- [What you need on hand](#what-you-need-on-hand)
- [1. Apply the database changes](#1-apply-the-database-changes)
- [2. Environment variables on Vercel](#2-environment-variables-on-vercel)
- [3. Supabase dashboard settings, in order](#3-supabase-dashboard-settings-in-order)
- [4. Turn on Google sign-in](#4-turn-on-google-sign-in)
- [5. Let the first people in](#5-let-the-first-people-in)
- [6. The assistant: what it is and what each person does](#6-the-assistant-what-it-is-and-what-each-person-does)
- [7. What the first sign-in looks like](#7-what-the-first-sign-in-looks-like)
- [8. Done when](#8-done-when)
- [If something goes wrong](#if-something-goes-wrong)

## What you need on hand

- A terminal, in the linked copy of the repository, on the latest `main`
  (`git pull origin main` first if it has been a while).
- The Supabase dashboard for the hosted project, signed in as its owner.
- The Vercel dashboard for the `edison-helpdesk` project.
- Nothing from OpenAI. Read the next paragraph twice.

**There is no API key.** The assistant does not use an OpenAI API key, and you
will not be asked to buy, create or paste one anywhere. The one variable with
"token" and "key" in its name, `AI_TOKEN_KEY`, is a random secret **you
generate yourself** with `openssl rand -base64 32`. It is used to encrypt each
person's own ChatGPT sign-in at rest, the way a password manager encrypts its
vault. Each person connects their own ChatGPT account from inside the app, with
the same device-code sign-in that Codex uses, and their usage is their own
plan's. The school pays nothing for the assistant. Section 6 has the detail.

## 1. Apply the database changes

Do this first, and do it now: it ends the half-state described above.

The changes are **additive**. No table the district's data lives in is dropped,
renamed or rewritten, and no existing policy or grant is changed. There are
fifty-two new migration files, all numbered above the nineteen the hosted
project already carries, so they apply in order after them.

**1.1 Take a backup.** Supabase dashboard → Database → Backups, and confirm a
recent one exists (daily backups are on by default). If you would rather make
one yourself, Administration → Backups inside the app also works, but the
dashboard's is enough. A restore is the only answer to a data mistake, and
there is deliberately no undo migration.

**1.2 Check what is pending.**

```bash
npx supabase migration list --linked
```

You should see the nineteen migrations you already have listed on both sides,
followed by **fifty-two** rows that are present locally and blank on the
remote side. If you see fewer than fifty-two, your checkout is old: run
`git pull origin main` and look again. If you see rows the other way round
(remote has something local does not), stop and ask before pushing.

**1.3 Apply them.**

```bash
npx supabase db push
```

It lists the fifty-two files, asks you to confirm, and applies them in
order. It takes about a minute. The last file it names is
`20260916160200_m5_welcome_marks.sql`, followed by "Finished supabase db push."

**1.4 Verify.** Reload the live site.

- The notice at the top is gone.
- Your account is an administrator again: Administration is in the rail.
- Queue, Collaborating and Resolved load, and Today shows its real sentence.
- `npx supabase migration list --linked` now shows every row on both sides.

If the notice is still there after a reload, hard-refresh once (Ctrl or Cmd +
Shift + R). If it is still there after that, see
[If something goes wrong](#if-something-goes-wrong).

## 2. Environment variables on Vercel

Vercel → the project → Settings → Environment Variables. Three are already
there from the first deployment and stay exactly as they are:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`.

Add these, each for the **Production** environment:

| Variable | Value | What it is for | Required? |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_ORIGIN` | `https://edison-helpdesk.vercel.app` (no trailing slash) | The address the app uses when it writes a link to itself: setup and recovery links, the Google sign-in return. | **Yes.** |
| `AI_TOKEN_KEY` | the output of `openssl rand -base64 32`, pasted whole | Encrypts each person's ChatGPT sign-in at rest. **A random secret you generate; not an API key.** Without it the assistant is simply absent from the app. | Optional, but wanted. |
| `RESEND_API_KEY` | an API key from resend.com | Emailed invites. | Optional. |
| `MAIL_FROM` | an address on a domain you have verified with Resend | The From address on those emails. | Optional. |

To generate `AI_TOKEN_KEY` on a Mac or Linux terminal:

```bash
openssl rand -base64 32
```

Copy the whole line it prints, including any trailing `=`, and paste it as the
value. Do not shorten it, do not add quotes.

Three rules:

- `AI_TOKEN_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only. Never give
  either a `NEXT_PUBLIC_` prefix and never paste them into a browser.
- If you ever change `AI_TOKEN_KEY`, every saved assistant connection becomes
  unreadable and everybody reconnects (thirty seconds each, see section 6).
  Nothing else is lost.
- Without `RESEND_API_KEY` and `MAIL_FROM`, invites still work: the
  Administration screen hands you the message to send yourself.

**Then redeploy.** Environment variables are read when the site is built, so
adding one changes nothing until the next build. Vercel → Deployments → the
top deployment → the three-dot menu → Redeploy. Wait for it to say Ready.

## 3. Supabase dashboard settings, in order

**The one-command way.** The repository's `supabase/config.toml` describes
the hosted auth settings this version expects: the sign-up hook enabled,
sign-ups allowed, Google enabled, manual identity linking on (so one person
can hold both Google and a password), the site URL and the redirect list,
and an eight-character password minimum. The CLI can apply all of it at once:

```bash
export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID="<the client id from section 4>"
export SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET="<the client secret from section 4>"
npx supabase config diff     # shows exactly what would change; read it
npx supabase config push     # applies it, asking before each changed resource
```

Do the two `export` lines first even if Google is not set up yet, with
placeholder values, or the push refuses because the file reads them. Then
walk 3.1 to 3.3 below anyway, as a check: each should already read as
described. If you would rather click than push, the steps below do the same
thing by hand, and 3.1 before 3.2 is the order that matters for safety. With sign-ups
allowed and no hook, anybody who knows the project URL and the public anon key
could create an account. With the hook in place first, that door is shut before
it opens.

**3.1 The hook that guards sign-up.** Authentication → Hooks → "Before User
Created". Choose *Postgres function*, pick `public.hook_before_user_created`
(the release created it; it appears in the list once section 1 is done), and
enable it. Confirm it reads as **enabled** before you continue. What it does:
it refuses email-and-password sign-up with a 403, and lets Google through.

**3.2 Allow sign-ups.** Authentication → Sign In / Providers → "Allow new users
to sign up" → **on**. Only now.

**3.3 The attachments bucket.** Storage. There should be a bucket named
`attachments`: **not public**, 8 MiB file size limit, accepting `image/jpeg`,
`image/png`, `image/webp`, `image/gif` and `application/pdf`. The release
created it. If it is missing, the app says so on the ticket screen and photos
cannot be added; create it by hand with those exact settings.

**3.4 Realtime for the phone scanner (optional).** Database → Replication →
turn Realtime on for the `scan_events` table. With it off, a phone paired as a
scanner still works; it polls instead of being pushed to.

**3.5 A daily job for the scan sweeper (optional, later).**
`public.app_sweep_scan_sessions()` clears pairing sessions that ended more than
a day ago. It needs an external scheduler calling it with the service key; it
cannot be driven by `pg_cron` as written. Nothing breaks without it; the table
just grows slowly.

**Do not import anything.** The directory and the inventory are already live.
This version adds no import path of its own, and the old preparation scripts
refuse to run once a requester carries an external id.

## 4. Turn on Google sign-in

Everyone signs in with Google. A password is the second way in, set by each
person from Settings once they are inside (see
[One account, both ways in](#one-account-both-ways-in)), and it is still the
break-glass path when every administrator is locked out (see
[If something goes wrong](#if-something-goes-wrong)). Nobody can create an
account with a password: public password sign-up is refused by the hook in 3.1.

**In Google Cloud**, in the project you want to own this:

1. APIs & Services → OAuth consent screen. User type *External*. Fill in the
   app name, a support email and a developer contact email. **Publish** it.
   While it is in "Testing", only the accounts you list by hand can sign in,
   which is the most common reason a colleague's sign-in fails.
2. APIs & Services → Credentials → Create credentials → OAuth client ID.
   Application type *Web application*. Set exactly:

   - **Authorised JavaScript origin**: `https://edison-helpdesk.vercel.app`
   - **Authorised redirect URI**: `https://<project-ref>.supabase.co/auth/v1/callback`

   The redirect URI is **Supabase's** callback, not the application's own
   `/auth/callback`. Supabase is what Google talks to; Supabase then sends the
   browser on to the app. `<project-ref>` is the twenty-character subdomain in
   your Supabase project URL.
3. Copy the client ID and the client secret.

**In the Supabase dashboard** (or, if you ran `npx supabase config push` in
section 3 with the two `export` lines set to the real values, both of these
are already done; check them):

4. Authentication → Sign In / Providers → Google. Paste the client ID and the
   client secret, and enable it.
5. Authentication → URL Configuration. Site URL
   `https://edison-helpdesk.vercel.app`, and add
   `https://edison-helpdesk.vercel.app/auth/callback` to the redirect allow
   list. Save.

**On Vercel:**

6. Confirm `NEXT_PUBLIC_APP_ORIGIN` is `https://edison-helpdesk.vercel.app`
   with no trailing slash (section 2), and that a deployment has been made
   since you added it.

**Test it** in a private browser window: open the site, press "Sign in with
Google", sign in as yourself. You should land on Today as an administrator.
If Google shows `redirect_uri_mismatch`, the redirect URI in step 2 does not
match Supabase's callback exactly; if the app says the provider is not
enabled, step 4 was not saved.

### One account, both ways in

One person, one account, two doors: Google and a password. Settings →
**Sign-in methods** is where each person adds whichever one they do not have —
"Add Google" hands the browser to Google and attaches that identity to the
account they are already signed in to; "Set" gives the account a password of at
least eight characters, which does not sign anybody out.

**The dashboard switch this needs.** Authentication → Settings → **"Allow
manual linking"** → on. Without it the auth server refuses to attach a second
identity, and the Settings row says so rather than failing quietly. Nothing
else on this page changes.

**The rule, and it is worth saying out loud to the team:** *sign in with the
method you have, then add the other one from Settings.* Somebody who signs in
with Google FIRST, under an address their invite was not for, does not get a
second way into their account — they get a second ACCOUNT, waiting on the
approval screen, which an administrator should decline. The first sign-in is
what decides which account an address belongs to; everything after it is added
from the inside.

## 5. Let the first people in

Any Google account with a verified email address may *reach* the sign-in page,
including a personal one. The gate is not the email domain; it is the invite or
your approval.

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
   sign-in is turned away and told to come back, and nothing is recorded;
   answering any waiting request frees a slot at once. Invites are never
   affected by this.

**Changing what somebody can do:** Administration → Access shows each account's
roles as chips. Editing them there is the only door to a role change, and it
refuses to remove the last administrator and refuses to leave an account with
no role at all. Every change is written to the audit log.

A reasonable first set: yourself as administrator, the students who run the
helpdesk as NetRiders, and whoever maintains the student and staff lists as a
skills officer.

## 6. The assistant: what it is and what each person does

The assistant is the OpenAI mark in the top bar, and it also answers from the
command palette. It can do anything the signed-in person can do, and nothing
more: a NetRider's assistant works tickets, a skills officer's works the
directory, and an administrator's asks before it changes a setting.

**What you, the owner, do:** set `AI_TOKEN_KEY` (section 2) and redeploy. That
is all. There is no key to buy and no account to create. If `AI_TOKEN_KEY` is
not set, the assistant button is simply not there and nothing else is affected.

**What each person does, once:**

1. Press the OpenAI mark in the top bar. The panel opens with a **Connect
   ChatGPT** button.
2. Press it. A short code appears, with a button to copy it and a button that
   opens `chatgpt.com/codex/device` in a new tab.
3. On that page, sign in to **their own ChatGPT account** and enter the code.
   This is the same device sign-in that OpenAI's Codex uses. They need a
   ChatGPT account that can use Codex; a school Google account with ChatGPT
   Edu, or a personal Plus or Pro plan, both work.
4. Back in the helpdesk the panel notices within a few seconds and is ready.

Their sign-in tokens are stored encrypted with `AI_TOKEN_KEY`. Nobody else can
use their connection, the app never sees their ChatGPT password, and they can
disconnect at any time from the panel's menu. What the assistant is sent is
the person's own question plus the ticket or record on screen; students' and
staff members' details go only where the person has already looked.

### What the desk asked for, all in this version, no setup needed

The chapter's tools:

- **Groups**: rosters, in the directory rather than a spreadsheet. "SkillsUSA
  members", "Officers", "Regionals competitors". Add people by search, by a
  class filter, or by pasting a list of OSIS numbers, staff ids, emails or
  names. Every group page can email everyone, copy their addresses, names,
  ids or guardian phones, and export a CSV. The assistant knows them: "add
  these to Regionals", "who is in Officers".
- **Attendance**: on a group, name an event and take the register by scanning
  student IDs with a phone or laptop camera, or by typing an OSIS. Live count,
  a copyable list of absentees, CSV at the end. "Who missed Tuesday" is a
  question the assistant answers.
- **Checklists**: yes/no columns per group that you name, as many as you need (dues paid,
  permission slip in, shirt size collected), ticked on the group page,
  filterable by what is missing, in the CSV.
- **Copy and Gmail anywhere people are listed**: on People, on a selection, on
  a group. "Open in Gmail" opens a compose window addressed to everyone
  directly; the chevron beside it switches to CC or BCC, and the choice is
  remembered per account (also under Settings → Appearance). The assistant
  hands over the same lists and links: "emails for 9A", "guardian phones for
  Officers". Export CSV is administrators
  and skills officers only, and every export is written to the audit log.
- **Quick tickets**: the calls that repeat all day as presets the desk edits
  under Settings → Quick tickets. The top bar's New ticket button has a menu
  of them; one tap opens intake with everything but the requester filled.

And the four from the first day:

- **Notes for the assistant.** Settings → Assistant has two boxes. "Notes for
  the assistant" is personal (how you like to work). "Shared notes" is one
  short text the whole team can read and edit: what the desk is, room names,
  the rules of the house. Both are read by the assistant on every message.
  Six hundred characters each; keep them short.
- **Resolved analytics**, administrators only: Resolved → Analytics, or the
  palette. Who resolved how many, by priority, median time to resolve, top
  category, for this week, month, term or all time.
- **Importing the old spreadsheet.** Paste the rows into the assistant panel
  and ask it to import them. It maps the columns (date called, who and where,
  the problem, who fixed it, date resolved), asks once if a column is
  ambiguous, and files each row as a resolved ticket dated when it actually
  happened, owned by whoever fixed it. Up to fifty rows per message; a row
  that is already in is returned rather than duplicated, so pasting a sheet
  twice is safe. Naming a colleague as the fixer is administrator-only; a
  NetRider's import is owned by them.
- **Looking up thirty people at once.** Paste a list of OSIS numbers, staff
  ids, emails or names into the assistant and ask who they are. One call
  answers up to two hundred: name, class or department, devices held, and,
  for ticket workers, open tickets. Skills officers have it too.
- **The command palette reaches further.** Ctrl K finds a group or one of
  its events by name, a student by their guardian's phone number (any
  punctuation), anybody by email address, and every Settings section by name
  or by what is in it ("gmail", "password", "chatgpt"), landing on that section
  of the page. Typing "settings" lists the sections; "due" offers the due-back
  list.
- **People, for a skills officer.** The Devices and Open columns are ticket
  work, so an account that does none sees Email and Groups in their place.
  NetRiders and administrators see the list as before.
- **Today points onward.** When "Needs you" or "Devices due back" shows only
  the head of its list, a line under it says how many more there are and
  links to where they live: the Open Queue, My tickets, Administration, and
  a new page, Devices → due back, which lists every machine due back, oldest
  first, with the same Return button as Today.
- **The welcome effect.** Settings → Assistant → Welcome effect is a checklist
  of seven animations for the assistant's opening mark (Diamond and Wave are
  on by default). One ticked plays every time; several ticked, one is picked
  at random each time the panel opens. The assistant can change it too.

## 7. What the first sign-in looks like

- The sign-in page draws its bulb, lights it, and offers **Sign in with
  Google**, with a quieter "Use a password" for anybody who has set one under
  Settings → Sign-in methods.
- An invited person lands on **Today**: the things that might need them right
  now, the unclaimed queue, their own tickets waiting on a reply, their live
  work, and, for an administrator, the people waiting for access. When nothing
  needs them it says so rather than showing an empty table.
- A skills officer lands on **People** instead, because they work the directory
  and see no tickets.
- An uninvited person lands on the waiting screen and stays there until you
  answer.
- The rail is Today, the queue, People, Devices, and Administration for
  administrators. The command palette opens with Ctrl K (⌘K on a Mac) and also
  talks to the assistant.

Nothing in the app can be reached without signing in. Every screen that needs a
session is rendered per request; nothing about the school is baked into the
deployed files.

## 8. Done when

- [ ] `npx supabase migration list --linked` shows every migration on both sides.
- [ ] The live site shows no notice at the top, and you are an administrator.
- [ ] `NEXT_PUBLIC_APP_ORIGIN` and `AI_TOKEN_KEY` are set for Production and a
      deployment has been made since.
- [ ] The "Before User Created" hook is enabled, and only then are sign-ups
      allowed.
- [ ] The `attachments` bucket exists, private, 8 MiB.
- [ ] Google sign-in works for you in a private window.
- [ ] You have connected your own ChatGPT to the assistant and asked it
      something.
- [ ] The first NetRiders are invited.

## If something goes wrong

**The "database is behind" notice is still there after `db push`.** First a
hard refresh. Then check `npx supabase migration list --linked`: if the
fifty-two are on both sides, the site is simply serving a cached page; wait
a minute and reload. If some are missing on the remote side, `db push` did not
finish; run it again, it continues where it stopped.

**Somebody's Google sign-in fails.** In order: the consent screen is still in
Testing (publish it, section 4 step 1); the redirect URI is not Supabase's
callback exactly (step 2); the provider is not enabled or not saved in
Supabase (step 4); the person is uninvited and sitting on the waiting screen,
which is not a failure (section 5).

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

**The assistant says it is not enabled.** `AI_TOKEN_KEY` is not set for
Production, or it was set after the last deployment. Set it, redeploy, reload.
It has to decode to exactly 32 bytes, which is what `openssl rand -base64 32`
produces; a shortened or hand-typed value is refused with a message saying so.

**Attachments after a deletion.** Deleting a ticket or a device removes its
attachment rows but not the uploaded bytes, which stay in the private bucket.
Nothing can read them. To reclaim the space, list `storage.objects` in the
`attachments` bucket, left-join `public.attachments` on `name = path`, and
delete the objects with no match. That is safe at any time.

**Where the detail is.** [docs/M5-PLATFORM-OVERHAUL.md](M5-PLATFORM-OVERHAUL.md)
carries the full runbook, the deployment transcript and the known limitations.
