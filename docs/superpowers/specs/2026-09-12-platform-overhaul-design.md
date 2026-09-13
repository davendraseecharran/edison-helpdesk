# Edison Helpdesk platform overhaul — design

Date: 2026-09-12. Branch: `platform-overhaul`. Delivered as one pull request, per the repository owner's request, built in reviewable commits.

## 1. Why and what

The owner approved turning the M4 ticketing pilot into the school IT team's single system: ticketing, the people directory and the device inventory currently living in the AppSheet app "TAEHS IT Inventory", Google sign-in with admin-controlled access, and an AI assistant that can act on a technician's behalf with clear attribution. The interface is rebuilt to feel polished on a helpdesk laptop first and to work properly on a phone or Chromebook in a hallway.

Decisions recorded here supersede the "no Google OAuth/SSO", "no email", "no attachments" and "no directory/inventory" lines in AGENTS.md and TICKETING-PLAN.md. AGENTS.md is updated in this PR.

Out of scope: GPT-Live/realtime voice (needs a paid API key), public intake form, AppSheet two-way sync, historical ticket import from the old Google Sheet.

## 2. Design system

Subject: a school IT shop. Asset tags, serial numbers, OSIS numbers, Lenovo carts, a helpdesk counter. The user is a student technician (the team is the NetRiders) who needs to find the right thing fast and act on it.

**The one bold element is the lookup bar.** It sits at the top of every authenticated screen. Typing a name, OSIS, staff ID, asset tag, serial number, ticket number or model returns mixed results (tickets, people, devices) instantly, grouped, keyboard-navigable. On phones it is the center tab with a camera barcode-scan button. Everything else is quiet so this reads as the feature.

Tokens (light; the dark theme redefines the same names):

| Token | Value | Role |
|---|---|---|
| `--ink` | `#0F1F3D` | text, rail, primary text on brass |
| `--paper` | `#F3F5F8` | page background |
| `--surface` | `#FFFFFF` | panels, rows |
| `--line` | `#D9DEE7` | borders, separators |
| `--brass` | `#D4A72C` | the single accent: primary button fill, active-nav marker, focus ring, count pills |
| `--signal` | `#2457B6` | links and interactive text |

Blue and gold are the school's colours and the AppSheet app already uses gold, so the palette belongs to the client rather than to a template. Status colours (open blue, waiting amber, resolved green, cancelled slate) always carry a text label; priority adds a glyph. Contrast meets WCAG AA in both themes.

Type: IBM Plex Sans for the interface, IBM Plex Mono only for identifiers (ticket numbers, asset tags, serials, OSIS), loaded with `next/font/google` so they are self-hosted at build time and the school network never talks to Google Fonts. Scale 12 / 13 / 14 / 16 / 20 / 26 / 34, 14px body, tabular figures in tables, headings at 600 weight, line length capped at 72ch for prose.

Layout: desktop keeps a 232px left rail (Queue, My tickets, Collaborating, Resolved, People, Devices, Insights; Admin group for admins) and a top bar (lookup, new ticket, notifications, AI toggle, user menu). Under 720px the rail disappears, a bottom tab bar appears (Queue, Mine, Lookup, Devices, More) and tables become row cards showing the three most important fields. Ticket detail is a 2fr timeline / 1fr facts grid that stacks on phones. Everything is left-aligned; numbers right-align in tables. The page body never scrolls horizontally.

Motion: one reveal (lookup results). Everything else is feedback to a user action. `prefers-reduced-motion` disables all of it. Keyboard focus is always visible (brass ring). Dark theme follows the system and can be pinned in Settings.

Copy: sentence case, plain verbs, a button says what it does ("Claim ticket", "Send invite"), errors say what happened and what to do next, empty states point to the next action.

Not used, deliberately: cream backgrounds, terracotta, near-black with neon, identical rounded cards with the same grey shadow, all-caps eyebrow labels, middle-dot meta strings, monospace for ordinary labels, arrows appended to buttons.

## 3. Authentication and access

### States

`app_accounts.status` gains two values: `pending_approval` and `denied`. Existing values (`active`, `inactive`, `setup_pending`) and every existing password/setup/recovery flow stay intact, including their tests. `app_active_account_id()`, `app_is_admin()` and `app_require_actor()` already gate on `status = 'active'`, so the new states are blocked from every table and RPC without touching those functions.

### Google sign-in

- Supabase Google provider. Any Google account may attempt sign-in; there is no domain restriction, because staff use `schools.nyc.gov`, students use `nycstudents.net`, and some team members use personal addresses.
- Server action `signInWithGoogleAction()` calls `signInWithOAuth({ provider: 'google', options: { redirectTo: <APP_ORIGIN>/auth/callback, queryParams: { prompt: 'select_account' } } })` and redirects. The origin comes only from `NEXT_PUBLIC_APP_ORIGIN`.
- Route `GET /auth/callback` exchanges `code` for a session, then calls the trusted RPC `app_trusted_link_identity(p_user uuid)` with the service role, then redirects to `/queue`. The authenticated layout routes restricted states from there. Failures redirect to `/login?oauthError=1` with no account information.
- `app_trusted_link_identity` (SECURITY DEFINER, executable by service role only) reads the auth user and its Google identity. It requires a verified email (`email_verified = true` in identity data or `email_confirmed_at` set) and fails closed otherwise. Then:
  1. An `app_accounts` row already exists: no change. Supabase automatically links a Google identity to an existing user with the same verified email, so the existing password admin keeps their account.
  2. An unaccepted, unrevoked, unexpired `account_invites` row matches the normalised email: create the account as `active` with the invite's role and display name, mark the invite accepted, log `invite_accepted`.
  3. Otherwise: create the account as `pending_approval`, role `technician`, display name from Google, log `access_requested`, and notify every active admin.
- The function is idempotent and takes the migration-007 exclusive advisory lock, since it changes an account's access.

### Invites and approvals

- `account_invites`: id, email (lower-cased, unique among live invites), role, display_name, invited_by, created_at, expires_at (14 days), accepted_at, accepted_account_id, revoked_at. RPCs in the admin's session: `app_admin_create_invite`, `app_admin_revoke_invite`. Re-sending is a new invite that supersedes the old one.
- Email delivery: the server action posts to the Resend HTTP API with `RESEND_API_KEY` and `MAIL_FROM`. The message says who invited them, what role, and that they sign in with Google using that exact address at the app URL. When email is not configured, or Resend fails, the action still succeeds and returns the invite message text for the admin to copy and send themselves. The invite carries no secret; the security property is Google's email verification plus the invite match.
- Access requests: `app_admin_review_access_request(p_account, p_decision, p_role)` sets `active` (with role) or `denied`; both log account events and notify the requester in-app. A denied user sees a screen saying access was denied and whom to contact. An admin can later approve a denied account.
- Password sign-in stays as a secondary option on the login page ("Sign in with a password" disclosure) for the bootstrap admin and any password accounts. The setup/recovery link tooling remains in Administration under "Password accounts".
- `loadActor()` gains restricted reasons `pending_approval` and `denied`; `/pending` is a new screen, `/restricted` covers the others.
- Local development and tests do not need Google credentials: auth tests create users through the admin API with `email_confirm: true` and a synthetic Google identity payload, then exercise `app_trusted_link_identity` directly. `supabase/config.toml` enables the provider with `env()` placeholders so a developer can plug real credentials in without editing the file.

## 4. Attribution: people and their AIs

- `activity_events` and the new `record_events` gain `performed_via text not null default 'user'` (`user` | `ai`) and `ai_model text`.
- `app_log_event()` and the record-event equivalent read the PostgREST request header `x-edison-via`; when it equals `ai` the event is stored with `performed_via = 'ai'` and `ai_model` from `x-edison-ai-model`. The AI tool executor sets those headers on the user's own Supabase client; nothing else does. A user who sets the header manually only mislabels their own action, which is harmless.
- Everywhere an actor is shown (ticket timeline, device history, person history, audit log, notifications) the label is the person's display name, or `<Name>'s AI` with a small sparkle glyph when `performed_via = 'ai'`. The audit log can filter by it.

## 5. People directory

Table `people`: id, kind (`student` | `staff`), first_name, last_name, display_name, email, osis (text, unique when present), staff_id (text, unique when present), school_dbn, department, role_title, official_class, class_of, parent_name, parent_phone, home_phone, address, notes, active (bool), source (`import` | `manual`), created_at, updated_at. Trigram indexes on display_name, email, osis, staff_id.

Rules: every active account can read all people and create or edit them (the owner confirmed all users may see this data). Only admins can deactivate. Every change writes a `record_events` row.

Ticket linkage: `requesters.person_id` (nullable). Creating a ticket with a chosen person finds or creates the linked requester. The intake form searches people first and keeps "new minimal requester" and "unknown" as fallbacks. Person pages show open and past tickets and current and previous devices.

Screens: `/people` (list with kind/department/class filters, search, pagination), `/people/[id]` (details, devices, tickets, history, edit), new-person form.

## 6. Inventory

Table `devices`: id, device_id (AppSheet key, unique), serial_number (unique when present), asset_tag (unique when present), type, manufacturer, model, os, status (`in_stock` | `deployed` | `in_repair` | `retired` | `lost` | `surplus`), location, notes, source, created_at, updated_at. Trigram indexes on serial_number, asset_tag, device_id, model.

Table `device_assignments`: id, device_id, person_id, assigned_at, assigned_by, returned_at, returned_by, note. A partial unique index enforces at most one open assignment per device. Assigning sets status `deployed`; returning sets `in_stock` unless the caller chooses another status.

Table `ticket_devices`: ticket_id, device_id, linked_by, linked_at. Ticket detail gets "Link a device" through the lookup; the existing free-text device observation stays for devices not in inventory.

RPCs: upsert, assign, return, set status (with reason), move location, link and unlink to ticket, detail, list with filters, bulk update by id list, export. All write `record_events`.

Screens: `/devices` (filters by type, status, location, holder kind; search; multi-select with bulk assign / status / location; CSV export), `/devices/[id]` (identifiers in mono, holder, assignment history, linked tickets, history, edit, actions), new-device form. Barcode scan from the lookup bar uses the browser `BarcodeDetector` when available and falls back to manual entry.

## 7. Import from the AppSheet spreadsheet

- `src/lib/import/` holds a dependency-free RFC 4180 CSV parser, column presets for the three AppSheet tabs (Student Directory, Staff Directory, Master Inventory), header auto-detection and row normalisation (OSIS `243,025,319` becomes text `243025319`; DeviceID `PW0FYJ9B-WIN` splits into serial and OS; emails lower-cased; phone digits kept as text). This module uses relative imports only so the CLI can run it with Node's native type stripping.
- RPC `app_admin_import(p_kind, p_rows jsonb, p_mode)` (admin session, SECURITY DEFINER, one transaction). `dry_run` returns `{ inserts, updates, unchanged, errors: [{ row, message }] }` without writing. `commit` upserts by natural key (OSIS, staff email, serial/device_id), derives `device_assignments` from the inventory sheet's OSIS / StaffID columns, reports unmatched holders, and writes one `import_runs` row plus `record_events`.
- Screens: Administration → Import: upload CSV, choose preset or map columns, dry run, review, commit. Import history lists past runs with counts and who ran them.
- CLI `scripts/import-directory.mts --dir <folder> [--commit]` for local rehearsal against the local stack; refuses hosted URLs like the existing scripts.
- Real exports live outside the repository (`~/.edison-private/`). No real rows in fixtures, tests, screenshots or docs.

## 8. Lookup

RPC `app_search(p_query text, p_limit int)` (SECURITY INVOKER, so RLS applies) unions tickets (number, title, requester name), people (name, email, OSIS, staff ID) and devices (serial, asset tag, device ID, model, holder) with trigram similarity and prefix matching, ranked. `LookupBar` is a client component: `Ctrl/Cmd+K` or `/` focuses it, results group by kind, arrow keys and Enter navigate, recent selections are remembered per browser, the scan button opens the camera on supported devices.

## 9. Notifications

Table `notifications`: id, account_id, kind, title, body, href, created_at, read_at. RLS: own rows only. Written by the existing RPCs when a ticket is assigned to you, you are added as a collaborator, your ticket is reopened by an admin, a ticket you returned is claimed, an access request arrives (admins), or your access request is decided. Bell in the top bar shows the unread count, a dropdown lists recent ones, `/notifications` shows all, "Mark all read". The client refreshes counts on focus and every 60 seconds; no realtime subscription.

## 10. Insights

`/insights` for every active account. RPC `app_insights(p_days)` returns opened and resolved per day, open tickets by status, priority and category, median and mean time to resolve, per-technician resolved counts and logged minutes, top device types in tickets, and inventory counts by status and type. Charts are inline SVG (bars and a line) built to the dataviz guidance: one palette, labelled axes, accessible text alternatives, dark-theme aware. No chart library.

## 11. Attachments

Private Storage bucket `attachments`; table `attachments`: id, ticket_id or device_id, path, filename, mime, bytes, uploaded_by, uploaded_at. Uploads: a server action checks permission with the caller's session, then issues a signed upload URL with the service role; the browser resizes images to at most 1600px and 1MB before uploading; a second server action registers the row. Reads: server actions issue 60-second signed URLs after the same permission check. Bucket policies allow nothing directly. Images and PDFs, 8MB cap. Thumbnails in the ticket timeline and device page, lightbox on click.

## 12. Ticket improvements

- `tickets.category` (`chromebook`, `laptop_desktop`, `projector_display`, `network`, `printer`, `account`, `software`, `phone`, `other`; default `other`) with labels, intake field, list filter, insights.
- Row cards and tables show age ("open 3d"), category, requester, owner, priority glyph. Queue rows offer "Claim" inline.
- Ticket detail: facts column (requester with link to person, category, channel, location, devices linked, attachments), timeline column (notes, events, attachments), action bar (claim / resolve / waiting / return / admin actions) that becomes a sticky bottom bar on phones.
- Intake form reorganised into sections with the person lookup first; walk-in defaults preserved.

## 13. AI assistant

- Connection: Settings → AI → "Connect ChatGPT". The server starts the Codex device-code flow (`POST {auth}/api/accounts/deviceauth/usercode` with the public Codex client id), shows the code and `https://chatgpt.com/codex/device`, and the client polls a server action that calls `POST {auth}/api/accounts/deviceauth/token` until it returns an authorization code, which the server exchanges at `{auth}/oauth/token` with PKCE for `access_token`, `refresh_token` and `id_token`. Exact endpoints and fields are read from the open-source Codex CLI at build time and recorded in the docs with the commit they were read from. Tokens are encrypted with AES-256-GCM using the server-only `AI_TOKEN_KEY` and stored in `ai_connections` (service role only, no RLS policies for users). The ChatGPT account id and plan come from the id token claims. Refresh happens server-side when the access token is within five minutes of expiry. Disconnect deletes the row.
- Model: `gpt-5.6-luna` only, fixed in code and labelled "GPT-5.6 Luna" in the panel. Reasoning effort defaults to `high`; the user can choose low, medium, high or extra high in the panel and the choice is saved. `gpt-5.3-codex-spark` is not offered: it is a research preview retiring the week of 2026-09-14.
- Requests go to `https://chatgpt.com/backend-api/codex/responses` in Responses API shape with the headers the Codex CLI sends (`Authorization`, `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, `originator`, `session_id`), streaming. This endpoint is undocumented and tolerated by OpenAI rather than guaranteed; the docs say so and the feature is enabled by the `AI_TOKEN_KEY` being set.
- Tools are function tools that call the same server-side data layer the UI uses, through the user's own session client with the `x-edison-via: ai` header, so RLS and attribution apply. Read tools: search, get ticket, list queue, list my tickets, get person, get device, list devices. Write tools: create ticket, claim, add note, set priority, set waiting, resume, resolve, return to queue, add collaborator, link device, assign device, return device, set device status; admin-only tools (reassign, reopen, cancel, review access request) are only exposed to admins.
- "Ask before making changes" (on by default, per user): read tools run immediately; write tools pause the stream and show an approval card with the exact action; the user approves or rejects; approved calls run and the model continues. With the setting off, write tools run immediately and the card shows what was done.
- Conversation storage: `ai_conversations` and `ai_messages` per account (RLS: own rows). The panel lists past conversations. The model receives the actor's name and role, today's school date, the current page's ticket, person or device when there is one, and the tool list.
- Panel: right drawer on desktop (`Ctrl/Cmd+J`), full-screen sheet on phones. Messages render a small safe markdown subset (paragraphs, lists, inline code, code blocks, links). Tool activity shows as chips such as "Claimed EDT-1042". Composer has a microphone: browser `SpeechRecognition` push-to-talk where supported (hidden otherwise) and an optional "Speak replies" toggle using `speechSynthesis`. No GPT-Live or realtime API.

## 14. Settings and administration

- `/settings`: display name, theme (system / light / dark), AI connection and preferences, notification preferences.
- `/admin` tabs: People & access (accounts, invites, access requests, password-account tools), Import, Audit log (all activity, account and record events with actor, via, kind and date filters; admin only), Backups (CSV export of every table for the owner's backup routine).

## 15. PWA

`manifest.webmanifest`, icons generated from the brand mark, `theme-color` per theme, `apple-touch-icon`. Installable on phones and Chromebooks. No service worker, so no stale authenticated pages.

## 16. Data and security invariants kept

- Every migration is additive. Existing RLS, triggers, advisory-lock protocol, credential binding and revocation stay exactly as they are and their tests stay green.
- New tables have RLS enabled and explicit policies; nothing is filtered in JavaScript for security; service-role usage is limited to the trusted identity-link RPC, signed storage URLs, invite email, and AI token storage, each preceded by a session check.
- No secrets in the repository. New server-only variables: `RESEND_API_KEY`, `MAIL_FROM`, `AI_TOKEN_KEY`; Google client id and secret live in Supabase provider settings, not in the app.
- Real student or staff data never enters fixtures, tests, screenshots or docs.

## 17. Verification

- `npm run check` (typecheck, lint, unit tests, build) and `npm run test:local` (DB and auth suites) stay green with new tests: CSV parser and presets, search parameter parsing, permission helpers, RLS on people/devices/notifications/attachments/ai tables, invite acceptance and approval paths of `app_trusted_link_identity`, assignment uniqueness, import dry-run and idempotent commit, search visibility, attribution header handling.
- `scripts/review-overhaul.cjs` drives a real browser through login, queue, ticket detail, intake, people, device, admin, settings and the AI panel at 1440, 1024 and 390 pixel widths and saves screenshots for the PR.
- Docs: `docs/M5-PLATFORM-OVERHAUL.md` (architecture, trust boundaries, AI endpoint caveats, owner runbook for Google Cloud, Supabase provider, Resend and environment variables, migration and import steps), README, AGENTS.md decisions, PROJECT_STATUS.md.

## 18. Phone as a barcode scanner for the desktop session

The team's hardware scanner is broken, and technicians work on a laptop with a phone in their pocket. Any screen that accepts an identifier (the lookup bar, the device form's serial and asset-tag fields, "Link a device" on a ticket, bulk assign) offers "Scan with your phone". It opens a dialog with a QR code. Scanning it on the phone opens `/scan/<session>` in the phone's browser; the phone must be signed in to the same account. The phone page runs the camera with `BarcodeDetector` (fallback: a large text field with "Type the code") and every scan is sent to the server. The desktop dialog receives scans live and drops each one into the field that opened it, or runs a lookup when the lookup bar opened it. Both sides show the last few scans and a "Stop" button.

Data: `scan_sessions` (id, account_id, created_at, expires_at 30 minutes, ended_at, label such as "Device form"), `scan_events` (id, session_id, code, format, scanned_at). RLS: rows belong to the session's account. Live delivery uses Supabase Realtime (`postgres_changes` on `scan_events` filtered by `session_id`, which respects RLS) with a two-second polling fallback when the channel does not connect. The QR code is rendered server-side as SVG with the `qrcode` package; the pairing URL carries only the session id, because the phone's own signed-in session is the authorization.

## 19. Command palette, loading and motion

- The lookup bar is a command palette built on `cmdk`. `Ctrl/Cmd+K` opens it anywhere. It searches records (section 8) and also lists actions: New ticket, Claim a ticket by number, Go to a page, Toggle theme, Ask the assistant ("Ask: how many projectors are open?" hands the text to the AI panel), Scan with your phone. Recent items and keyboard hints are shown. On phones it opens as a full-height sheet from the Lookup tab.
- Every route in the authenticated group has a `loading.tsx` skeleton that mirrors the page's real layout (rail and top bar stay static; only the content area shimmers), so navigation feels immediate while server components stream.
- Motion is done with the `motion` package and respects `prefers-reduced-motion`: list rows settle in with a short stagger on first paint, sheets and dialogs spring in, the command palette scales in, tool chips and approval cards in the AI panel slide in. Hover effects stay minimal. Toasts use the existing Flash region restyled with motion.
- The assistant has a thinking orb: a layered gradient sphere (CSS conic and radial gradients with blur and slow rotation) that breathes when idle, swirls faster while the model is thinking, ripples with the microphone level while listening, and pulses in time with speech while replying. It sits in the panel header and shrinks into the AI toggle button while the panel is closed and work is in progress. Its states are checked visually with Playwright screenshots during development.

## 20. AI tool coverage

In addition to section 13, the assistant can: list and filter people and devices; create and update people and devices; move devices; bulk update devices by id list or by filter; log work minutes; record a device observation on a ticket; remove a collaborator; read the caller's notifications and insights; and, for admins, run the CSV importer from pasted CSV text (dry run first, then commit with approval), create invites and change roles. Every write goes through the approval card unless the user has turned confirmations off. The panel works on phones as a full-screen sheet with the same tools and push-to-talk.
