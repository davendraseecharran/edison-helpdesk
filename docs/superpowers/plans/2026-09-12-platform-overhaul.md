# Platform Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M4 ticketing pilot into the school IT team's single system: new design system, Google sign-in with invites and approvals, people directory, device inventory, AppSheet import, global lookup, notifications, insights, attachments, an AI assistant with attribution, settings, audit log and PWA, delivered as one PR.

**Architecture:** Next.js 16 App Router server components call Supabase RPCs through the signed-in user's client so RLS decides every row; additive SQL migrations add tables, RPCs and policies; a small set of service-role operations (identity link, signed storage URLs, invite email, AI token storage) each run only after a verified session check. The UI is rebuilt on a token-based CSS system with IBM Plex, a persistent lookup bar, a rail on desktop and bottom tabs on phones.

**Tech Stack:** Next.js 16.3, React 19, TypeScript 5.9, @supabase/ssr 0.12, supabase-js 2.116, Supabase CLI 2.117 (Postgres 17), Vitest 4, `lucide-react` (new), `next/font/google` (IBM Plex Sans + Mono), Resend HTTP API, OpenAI Responses API via the Codex ChatGPT endpoint, Playwright (local only, for screenshots).

**Spec:** `docs/superpowers/specs/2026-09-12-platform-overhaul-design.md`

## Global Constraints

- Node `24.x`; in this shell run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24` before any npm command. Use `npx supabase` (2.117), never the global CLI.
- Local stack currently runs on ports 55321/55322/55323 via an uncommitted patch to `supabase/config.toml` (`scratchpad/portpatch.sh`). Never commit those port lines: before staging `supabase/config.toml`, run `portpatch.sh revert`, stage, then `apply`. `.env.local` points at 55321.
- Migrations are additive and numbered `20260912HHMMSS_m5_<name>.sql` in the order listed in this plan. Replacing an RPC whose parameter list changes MUST `drop function` the old signature first (PostgREST cannot resolve overloads with overlapping named parameters).
- Every new table: `enable row level security`, explicit policies, `revoke all ... from anon, authenticated` then targeted grants, following `20260910200200_identity_rls.sql`.
- Every RPC: `set search_path = ''`, schema-qualified names, `security definer` only when it must bypass RLS and then `revoke execute ... from public, anon` and grant to `authenticated` (or to nobody for trusted/service-only functions, as in `app_trusted_*`).
- Mutating RPCs start with `v_actor := public.app_require_actor();` (shared advisory lock, active + current session) and admin-only ones additionally check `v_actor.role = 'admin'`.
- No real student/staff data anywhere. Test fixtures use the `edison.example` domain and invented names.
- Copy rules: sentence case, buttons name the action ("Send invite"), errors say what happened and what to do, no all-caps labels, no middle dots, no arrows in button text.
- Baseline that must stay green: `npm run check` (81 unit tests + build) and `npm run test:local` (122 DB, 31 auth). New tests extend these suites.
- Commit after each task with a conventional message; one PR at the end. Never `git add -A`; add files by name.
- Icons come from `lucide-react` (pin exact version from `npm view lucide-react version` at install time).

## File map

Styles: `src/app/globals.css` (imports only) → `src/styles/tokens.css`, `base.css`, `shell.css`, `components.css`, `tickets.css`, `directory.css`, `ai.css`, `auth.css`, `insights.css`.
Fonts/theme: `src/app/fonts.ts`, `src/components/shell/ThemeProvider.tsx`, `src/components/shell/theme-script.ts`.
Shell: `src/components/shell/AppShell.tsx` (replaces `src/components/AppShell.tsx`), `RailNav.tsx`, `TopBar.tsx`, `BottomTabs.tsx`, `UserMenu.tsx`, `LookupBar.tsx`, `LookupResults.tsx`, `ScanButton.tsx`, `NotificationsBell.tsx`, `AiToggle.tsx`.
UI primitives: `src/components/ui/Button.tsx`, `Sheet.tsx`, `Dialog.tsx`, `Menu.tsx`, `Tabs.tsx`, `DataTable.tsx`, `Skeleton.tsx`, `Icon.tsx`, `SegmentedControl.tsx`, `Pagination.tsx`, `FilterBar.tsx`, `ActorLabel.tsx`. Existing `src/components/Primitives.tsx` and `Badges.tsx` stay and are restyled.
Auth: `src/lib/auth/google-actions.ts`, `src/app/auth/callback/route.ts`, `src/app/pending/page.tsx`, `src/components/auth/GoogleButton.tsx`, `src/lib/email/resend.ts`, `src/lib/data/invite-actions.ts`, `src/lib/data/access-actions.ts`, `src/lib/data/admin-view.ts` (extend).
Data layers: `src/lib/data/people.ts` + `people-actions.ts`, `devices.ts` + `device-actions.ts`, `search.ts` + `search-actions.ts`, `notifications.ts` + `notification-actions.ts`, `insights.ts`, `attachments.ts` + `attachment-actions.ts`, `audit.ts`, `preferences.ts` + `preferences-actions.ts`, `import-actions.ts`, `export-actions.ts`.
Import: `src/lib/import/csv.ts`, `presets.ts`, `normalize.ts`, `index.ts` (relative imports only).
AI: `src/lib/ai/crypto.ts`, `codex-auth.ts`, `connections.ts`, `responses-client.ts`, `tools.ts`, `prompt.ts`, `conversations.ts`, `ai-actions.ts`, `src/app/api/ai/chat/route.ts`; UI `src/components/ai/AiPanel.tsx`, `AiMessage.tsx`, `AiComposer.tsx`, `AiConnectCard.tsx`, `ToolApprovalCard.tsx`, `ConversationList.tsx`, `useSpeech.ts`, `markdown.ts`.
Pages: `src/app/(app)/people/page.tsx`, `people/[id]/page.tsx`, `people/new/page.tsx`, `devices/page.tsx`, `devices/[id]/page.tsx`, `devices/new/page.tsx`, `insights/page.tsx`, `notifications/page.tsx`, `settings/page.tsx`, `admin/page.tsx` (tabs), `admin/import/page.tsx`, `admin/audit/page.tsx`, `admin/backups/page.tsx`; `src/app/pending/page.tsx`, `src/app/manifest.ts`.
Migrations: `supabase/migrations/20260912100000_m5_foundation.sql` … `20260912101200_m5_ticket_notifications.sql` (see tasks).
Tests: `tests/import/*.test.ts`, `tests/ai/*.test.ts`, `tests/db/m5-*.test.ts`, `tests/auth/google-link.test.ts`, `tests/db/support/identities.ts` (extend with `requester` and `denied`? no — keep; add `pendingApproval` and `denied` identities).
Scripts/docs: `scripts/review-overhaul.cjs`, `scripts/import-directory.mts`, `scripts/generate-icons.cjs`, `docs/M5-PLATFORM-OVERHAUL.md`, `README.md`, `AGENTS.md`, `PROJECT_STATUS.md`, `.env.example`.

## Dependency graph (for parallel dispatch)

```
T1 tokens/fonts/theme ─┬─ T2 shell+primitives ─┬─ T3 auth page restyle
                       │                       ├─ T4 ticket screens restyle
                       │                       ├─ T19 lookup UI (needs T11)
                       │                       └─ T28 PWA
T5 foundation SQL ──┬─ T6 google auth + invites + approvals (needs T3)
                    ├─ T8 people SQL ── T9 devices SQL ── T10 ticket category/devices SQL ── T11 search SQL ── T13 insights SQL
                    ├─ T12a import lib (pure TS, no deps)  ── T12 import SQL (needs T9) ── T23 import UI + CLI
                    ├─ T14 attachments SQL ── T22 attachments UI
                    ├─ T15 ai/preferences SQL ── T24 settings UI ── T26 AI backend (needs T17,T18) ── T27 AI panel
                    └─ T16 audit + ticket notification hooks (needs T10) ── T20 notifications UI, T25 audit/backups UI
T17 people UI (T8,T10,T2) ── T18 devices UI (T9,T10,T17)
T21 insights UI (T13,T2)
T29 attribution rendering (T5,T4,T17,T18)
T30 screenshots, docs, verification (everything)
```

---

### Task 1: Design tokens, fonts and theme

**Files:**
- Create: `src/app/fonts.ts`, `src/styles/tokens.css`, `src/styles/base.css`, `src/components/shell/ThemeProvider.tsx`, `src/components/shell/theme-script.ts`
- Modify: `src/app/layout.tsx`, `src/app/globals.css` (becomes imports + legacy rules until later tasks remove them)
- Test: `tests/theme.test.ts`

**Interfaces:**
- Produces: CSS custom properties listed below; `ThemeProvider` with `useTheme(): { theme: 'system'|'light'|'dark'; setTheme(t): void; resolved: 'light'|'dark' }`; `plexSans.variable` / `plexMono.variable` class names on `<html>`; `resolveTheme(pref, systemDark): 'light'|'dark'` pure helper in `theme-script.ts`.

- [ ] **Step 1: Failing test for the pure theme resolver**

```ts
// tests/theme.test.ts
import { describe, expect, it } from 'vitest';
import { resolveTheme, THEME_STORAGE_KEY } from '../src/components/shell/theme-script';

describe('resolveTheme', () => {
  it('follows the system when preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
  it('pins an explicit preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
  it('treats unknown stored values as system', () => {
    expect(resolveTheme('purple' as never, true)).toBe('dark');
  });
  it('exposes a stable storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('edison.theme');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/theme.test.ts` → fails (module missing).

- [ ] **Step 3: Implement**

`src/components/shell/theme-script.ts` (no React; also inlined as a blocking script to prevent flash):

```ts
export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'edison.theme';
export function resolveTheme(pref: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark ? 'dark' : 'light';
}
/** Inline script source: reads the stored preference and stamps data-theme before first paint. */
export const THEME_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=(p==='dark'||p==='light')?p:(d?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
```

`ThemeProvider.tsx` ('use client'): context with `theme`, `resolved`, `setTheme` (writes localStorage + `data-theme` attribute + listens to `matchMedia` changes when `system`). The server-side preference (Task 24) is passed as `initialTheme` prop and wins over localStorage on mount.

`src/app/fonts.ts`:

```ts
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
export const plexSans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
export const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });
```

`src/styles/tokens.css` — define on `:root` (light) and `:root[data-theme="dark"]`:

```css
:root {
  color-scheme: light;
  --ink: #0f1f3d; --ink-2: #33415c; --ink-3: #5b6780;
  --paper: #f3f5f8; --surface: #ffffff; --surface-2: #f7f8fb; --surface-3: #eef1f6;
  --line: #d9dee7; --line-2: #c5ccd8;
  --brass: #d4a72c; --brass-2: #b98d1c; --brass-soft: #fbf3d9; --brass-ink: #0f1f3d;
  --signal: #2457b6; --signal-soft: #e6eefb;
  --ok: #1f6b45; --ok-soft: #e4f2ea; --warn: #8a5a08; --warn-soft: #fbf1da; --bad: #9c2b2b; --bad-soft: #fbe9e9; --slate: #5b6780; --slate-soft: #eceff4;
  --focus: 0 0 0 3px rgba(212, 167, 44, 0.55);
  --radius-1: 4px; --radius-2: 8px; --radius-3: 12px;
  --shadow-1: 0 1px 2px rgba(15, 31, 61, 0.06); --shadow-2: 0 6px 24px rgba(15, 31, 61, 0.10);
  --rail-w: 232px; --topbar-h: 56px; --tabs-h: 60px;
  --fs-0: 12px; --fs-1: 13px; --fs-2: 14px; --fs-3: 16px; --fs-4: 20px; --fs-5: 26px; --fs-6: 34px;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --ink: #e8ecf3; --ink-2: #b7c0d0; --ink-3: #8b96aa;
  --paper: #0d1526; --surface: #131d31; --surface-2: #182440; --surface-3: #1e2c4c;
  --line: #27365a; --line-2: #34466f;
  --brass: #e2b93f; --brass-2: #f0c95a; --brass-soft: #3a3116; --brass-ink: #0d1526;
  --signal: #7aa2ec; --signal-soft: #1a2a4d;
  --ok: #6fcf97; --ok-soft: #14301f; --warn: #e6b45a; --warn-soft: #3a2c10; --bad: #ef8a8a; --bad-soft: #3b1717; --slate: #9aa6bb; --slate-soft: #202c46;
  --focus: 0 0 0 3px rgba(226, 185, 63, 0.55);
  --shadow-1: 0 1px 2px rgba(0,0,0,0.4); --shadow-2: 0 8px 28px rgba(0,0,0,0.5);
}
```

`base.css`: reset, `body { background: var(--paper); color: var(--ink); font: 400 var(--fs-2)/1.5 var(--font-sans), ui-sans-serif, system-ui; }`, headings (h1 `--fs-5` 600, h2 `--fs-4` 600, h3 `--fs-3` 600), `.mono { font-family: var(--font-mono), ui-monospace; font-variant-numeric: tabular-nums; }`, `:focus-visible { outline: none; box-shadow: var(--focus); }`, `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }`, `.visually-hidden`, `.prose { max-width: 72ch; }`.

`src/app/layout.tsx`: `<html lang="en" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>`, `<head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /></head>`, wrap body in `<ThemeProvider>`. Add `metadata.applicationName = 'Edison Helpdesk'`.

`globals.css`: `@import '../styles/tokens.css'; @import '../styles/base.css';` followed by the existing rules (kept until Tasks 2–4 replace them; map old variable names to new ones at the top of the legacy block: `--bg: var(--paper); --surface-muted: var(--surface-2); --border: var(--line); --text: var(--ink); --text-muted: var(--ink-2); --text-subtle: var(--ink-3); --accent: var(--signal); --accent-soft: var(--signal-soft); --danger: var(--bad); --success: var(--ok); --warning: var(--warn);` so nothing breaks mid-way).

- [ ] **Step 4: Run** `npx vitest run tests/theme.test.ts` → pass; `npm run typecheck && npm run lint && npm run build` → pass (fonts download at build).

- [ ] **Step 5: Commit** `git add src/app/fonts.ts src/app/layout.tsx src/app/globals.css src/styles src/components/shell tests/theme.test.ts && git commit -m "feat(ui): design tokens, IBM Plex fonts and theme provider"`

---

### Task 2: Shell and UI primitives

**Files:**
- Create: `src/components/shell/AppShell.tsx`, `RailNav.tsx`, `TopBar.tsx`, `BottomTabs.tsx`, `UserMenu.tsx`, `LookupBar.tsx` (ticket-only stub), `src/components/ui/{Button,Sheet,Dialog,Menu,Tabs,DataTable,Skeleton,Icon,SegmentedControl,Pagination,FilterBar,ActorLabel}.tsx`, `src/styles/shell.css`, `src/styles/components.css`
- Modify: `src/app/(app)/layout.tsx` (import new shell), `src/components/Primitives.tsx` (restyle classes, keep exports), `src/components/Badges.tsx` (glyph + label), `package.json` (add `lucide-react`)
- Delete: `src/components/AppShell.tsx`
- Test: `tests/nav.test.ts`

**Interfaces:**
- Produces: `AppShell({ counts, unreadNotifications, children })`; `navItems(role: 'admin'|'technician', counts): NavItem[]` pure function in `RailNav.tsx` exported for tests; `DataTable<Row>({ columns, rows, rowKey, cardTitle, cardMeta, empty })` where `columns: Array<{ key, header, cell(row), align?: 'right', mono?: boolean, hideOnPhone?: boolean }>` renders a `<table>` ≥720px and `.row-card` list below; `Button({ variant: 'primary'|'secondary'|'ghost'|'danger', size?: 'sm'|'md', icon?, loading?, ...props })`; `Sheet({ open, onClose, side: 'right'|'bottom', title, children })` with focus trap and Escape; `Dialog` same API centered; `Menu({ trigger, items })` keyboard navigable; `Tabs({ items: {href,label,count?}[] })` link tabs; `Pagination({ page, pageCount, hrefFor })`; `FilterBar` (children in a wrapping flex row with a "Clear filters" link when any active); `ActorLabel({ name, via, model })` renders `name` or `${name}'s AI` with sparkle icon and `title="Made by ${name}'s AI (model)"`.
- Consumes: Task 1 tokens.

- [ ] **Step 1: Failing test for nav composition**

```ts
// tests/nav.test.ts
import { describe, expect, it } from 'vitest';
import { navItems } from '../src/components/shell/RailNav';
const counts = { openQueue: 3, myTickets: 1, collaborating: 0, closed: 9, all: 13 };
describe('navItems', () => {
  it('gives technicians work, directory and insights but no admin group', () => {
    const items = navItems('technician', counts);
    expect(items.map((i) => i.href)).toEqual(['/queue', '/my-tickets', '/collaborating', '/resolved', '/people', '/devices', '/insights']);
    expect(items.find((i) => i.href === '/queue')?.count).toBe(3);
  });
  it('adds all tickets and administration for admins', () => {
    const items = navItems('admin', counts);
    expect(items.map((i) => i.href)).toContain('/all-tickets');
    expect(items.map((i) => i.href)).toContain('/admin');
    expect(items.find((i) => i.href === '/all-tickets')?.count).toBe(13);
  });
});
```

- [ ] **Step 2: Run** → fails. 

- [ ] **Step 3: Implement.** `npm install lucide-react@<exact>`. Shell layout: `.shell { display: grid; grid-template-columns: var(--rail-w) 1fr; grid-template-rows: var(--topbar-h) 1fr; min-height: 100dvh }`; rail spans both rows on desktop; under 720px the grid is one column, rail hidden, `BottomTabs` fixed at bottom (`padding-bottom: env(safe-area-inset-bottom)`), main gets `padding-bottom: calc(var(--tabs-h) + 16px)`. TopBar: brand mark (an "E" monogram in a brass square with ink letter), `LookupBar` (stub: input that navigates to `/all-tickets?q=` or `/queue?q=` on Enter; Task 19 replaces), "New ticket" primary button (icon-only on phone), notifications bell placeholder (Task 20 fills), AI toggle placeholder (Task 27 fills), `UserMenu` (avatar → name, role, "Settings", theme segmented control, "Sign out"). Rail groups: Work (Queue, My tickets, Collaborating, Resolved), Directory (People, Devices), Insights; Admin group (All tickets, Administration). Active item: brass 3px left marker + `aria-current="page"`. Bottom tabs: Queue, Mine, Lookup (opens the lookup sheet), Devices, More (sheet with the remaining items + sign out). Restyle `Primitives.tsx` classes (`.btn` → variants), `Badges.tsx` (status: coloured dot + label; priority: glyph `▲▲`, `▲`, `–`, `▽` + label). No decorative shadows on rows; cards only for the ticket facts panel and forms.

- [ ] **Step 4: Run** `npx vitest run tests/nav.test.ts` → pass; `npm run check` → pass. Start `npm run dev` on 3000 and eyeball `/login` and `/queue` at 1440 and 390 widths (log in with the bootstrap admin from Task 6 prerequisites; if not yet bootstrapped, run `npm run bootstrap:admin -- --email admin@edison.example --name "Admin Example"` and use the printed one-time password).

- [ ] **Step 5: Commit** `git add package.json package-lock.json src/components src/styles src/app && git commit -m "feat(ui): new application shell, rail, bottom tabs and primitives"`

---

### Task 3: Auth pages restyle

**Files:**
- Create: `src/styles/auth.css`
- Modify: `src/app/login/page.tsx`, `src/components/auth/LoginForm.tsx`, `src/app/set-password/page.tsx`, `src/components/auth/SetPasswordForm.tsx`, `src/app/restricted/page.tsx`, `src/app/globals.css` (import auth.css, delete legacy `.auth-*` rules)

**Interfaces:** none new. Login page keeps `searchParams` handling (`linkError`, `signedOut`, `setup`) and adds `oauthError` (Task 6 wires it) and `invite=accepted` notices.

- [ ] **Step 1:** Layout: full-height two-column on ≥1024 (left: ink panel with the brand mark, "Edison Helpdesk", one line "Tickets, people and devices for the NetRiders IT team."; right: form column, max-width 420px, left-aligned). Single column on phones. Primary action area reserved for the Google button (Task 6 inserts `<GoogleButton />` above the disclosure); password form lives inside a `<details>` "Sign in with a password" (open by default until Task 6 flips it closed). Keep every existing message string.
- [ ] **Step 2:** `npm run check`; view at 1440/390; keyboard-tab through the form.
- [ ] **Step 3: Commit** `git commit -m "feat(ui): restyle sign-in, password and restricted screens"`

---

### Task 4: Ticket screens restyle

**Files:**
- Create: `src/styles/tickets.css`
- Modify: `src/components/TicketListView.tsx` (use `DataTable`, `FilterBar`, `Pagination`; row card shows number (mono), title, requester, owner, age, status, priority; inline "Claim" when `allowClaim`), `src/app/(app)/tickets/[id]/page.tsx` (2fr/1fr grid → stacked; sticky action bar on phone), all `src/components/ticket/*Panel.tsx` (restyle, keep logic), `src/components/ticket/ActivityTimeline.tsx` (use `ActorLabel`; `performed_via` arrives in Task 5), `src/app/(app)/tickets/new/page.tsx` (sections: Who is asking, What is wrong, Where, Device, Priority and date; walk-in defaults untouched), `src/components/admin/AdministrationScreen.tsx` (tabs shell only; contents move in Task 6), `src/app/globals.css` (remove legacy rules now unused)
- Test: existing unit tests must pass unchanged.

- [ ] **Step 1:** Add `ageLabel(createdAt: string, now: Date): string` to `src/lib/format.ts` returning `"just now" | "12m" | "3h" | "2d" | "5w"` with a test in `tests/format.test.ts`:

```ts
it('labels ticket age compactly', () => {
  const now = new Date('2026-09-12T15:00:00Z');
  expect(ageLabel('2026-09-12T14:59:40Z', now)).toBe('just now');
  expect(ageLabel('2026-09-12T14:30:00Z', now)).toBe('30m');
  expect(ageLabel('2026-09-12T09:00:00Z', now)).toBe('6h');
  expect(ageLabel('2026-09-09T15:00:00Z', now)).toBe('3d');
  expect(ageLabel('2026-07-01T15:00:00Z', now)).toBe('10w');
});
```
- [ ] **Step 2:** Implement and restyle. Empty states: "No open tickets. Nice." with a "New ticket" button; loading skeleton rows.
- [ ] **Step 3:** `npm run check`; screenshots at 1440/1024/390 for queue, detail, new ticket.
- [ ] **Step 4: Commit** `git commit -m "feat(ui): responsive ticket queues, detail and intake"`

---

### Task 5: Foundation migration — notifications, record events, attribution

**Files:**
- Create: `supabase/migrations/20260912100000_m5_foundation.sql`, `tests/db/m5-foundation.test.ts`
- Modify: `tests/db/support/harness.ts` (add `rpcOkAs(client, fn, args, headers)` helper that creates a client with `global: { headers }`), `src/lib/domain/types.ts` (add `performedVia`, `aiModel` to `ActivityEvent`; `Notification` type), `src/lib/data/mapping.ts` (`mapActivity` reads `performed_via`, `ai_model`)

**Interfaces (SQL):**

```sql
create table public.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  href text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_account_unread_idx on public.notifications (account_id, created_at desc) where read_at is null;

create table public.record_events (
  id uuid primary key default extensions.gen_random_uuid(),
  entity_type text not null check (entity_type in ('person','device','invite','import','account')),
  entity_id uuid not null,
  kind text not null,
  actor_id uuid references public.app_accounts (id) on delete restrict,
  performed_via text not null default 'user' check (performed_via in ('user','ai')),
  ai_model text,
  at timestamptz not null default now(),
  summary text not null,
  detail text
);
create index record_events_entity_idx on public.record_events (entity_type, entity_id, at);

alter table public.activity_events
  add column performed_via text not null default 'user' check (performed_via in ('user','ai')),
  add column ai_model text;

create function public.app_request_via() returns text language sql stable set search_path = '' as $$
  select case when coalesce(nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb ->> 'x-edison-via', '') = 'ai' then 'ai' else 'user' end;
$$;
create function public.app_request_ai_model() returns text language sql stable set search_path = '' as $$
  select case when public.app_request_via() = 'ai'
    then left(nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb ->> 'x-edison-ai-model', 80) end;
$$;
-- app_log_event: same signature, now stores performed_via/ai_model from the helpers above.
create function public.app_log_record_event(p_entity_type text, p_entity_id uuid, p_kind text, p_actor uuid, p_summary text, p_detail text default null) returns void security definer;  -- revoked from all roles
create function public.app_notify(p_account uuid, p_kind text, p_title text, p_body text default null, p_href text default null) returns void security definer; -- revoked from all roles
create function public.app_notify_admins(p_kind text, p_title text, p_body text default null, p_href text default null) returns void security definer; -- revoked
create function public.app_notifications(p_limit integer default 20, p_unread_only boolean default false) returns setof public.notifications; -- own rows, newest first
create function public.app_unread_notification_count() returns integer;
create function public.app_mark_notifications_read(p_ids uuid[] default null) returns integer; -- null marks all; returns rows updated
```
RLS: `notifications` select/update own rows only (`account_id = auth.uid()` and account active); no insert/delete for users. `record_events` select where `public.app_active_account_id() is not null and (entity_type in ('person','device') or public.app_is_admin())`.

- [ ] **Step 1: Failing DB tests** (`tests/db/m5-foundation.test.ts`): (a) `app_log_event` via an existing RPC (`app_add_note`) records `performed_via='user'` when no header; (b) the same call through a client created with `global: { headers: { 'x-edison-via': 'ai', 'x-edison-ai-model': 'gpt-5.6-luna' } }` records `performed_via='ai'`, `ai_model='gpt-5.6-luna'` (read with service client); (c) a header value other than `ai` stores `user`; (d) `app_notify` is not executable by `authenticated` (expect `rpcFails` with permission error); (e) service client inserting a notification for `owner` → `owner` sees it in `app_notifications()`, `unrelated` does not, count is 1, `app_mark_notifications_read(null)` returns 1 then count 0; (f) `pending` identity gets zero rows/`insufficient_privilege` from `app_notifications`.
- [ ] **Step 2:** `npm run test:db` → new file fails.
- [ ] **Step 3:** Write the migration (drop and recreate `app_log_event(uuid,text,uuid,text,text)` with identical signature; keep `revoke execute` list). Update mapping and types.
- [ ] **Step 4:** `npm run test:db` → 122 + new pass. `npm run check` pass.
- [ ] **Step 5: Commit** `git commit -m "feat(db): notifications, record events and AI attribution foundation"`

---

### Task 6: Google sign-in, invites and access requests

**Files:**
- Create: `supabase/migrations/20260912100100_m5_account_states_invites.sql`, `src/lib/auth/google-actions.ts`, `src/app/auth/callback/route.ts`, `src/app/pending/page.tsx`, `src/components/auth/GoogleButton.tsx`, `src/lib/email/resend.ts`, `src/lib/data/invite-actions.ts`, `src/lib/data/access-actions.ts`, `src/components/admin/AccessScreen.tsx`, `src/components/admin/InvitesPanel.tsx`, `src/components/admin/AccessRequestsPanel.tsx`, `src/components/admin/PasswordAccountsPanel.tsx` (moved from AdministrationScreen), `tests/db/m5-invites.test.ts`, `tests/auth/google-link.test.ts`
- Modify: `src/lib/auth/session.ts` (statuses + reasons), `src/app/(app)/layout.tsx`, `src/app/login/page.tsx`, `src/app/restricted/page.tsx`, `src/lib/data/admin-view.ts`, `src/app/(app)/admin/page.tsx`, `supabase/config.toml` (`[auth.external.google] enabled = true; client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"; secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"; skip_nonce_check = false` and `additional_redirect_urls` includes `http://127.0.0.1:3000/auth/callback`), `.env.example`, `tests/db/support/identities.ts` (add keys `pendingApproval` status `pending_approval` and `denied` status `denied`; type union extended)

**Interfaces (SQL):**

```sql
alter table public.app_accounts drop constraint app_accounts_status_valid;
alter table public.app_accounts add constraint app_accounts_status_valid
  check (status in ('active','inactive','setup_pending','pending_approval','denied'));
alter table public.account_events drop constraint account_events_kind_valid;
alter table public.account_events add constraint account_events_kind_valid check (kind in (
  'account_provisioned','setup_issued','setup_verified','setup_completed','recovery_issued','recovery_verified','recovery_completed',
  'credential_action_cancelled','status_changed','sessions_invalidated',
  'identity_linked','invite_accepted','access_requested','access_approved','access_denied','role_changed'));

create table public.account_invites (
  id uuid primary key default extensions.gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null check (role in ('admin','technician')),
  display_name text,
  invited_by uuid not null references public.app_accounts (id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_account_id uuid references public.app_accounts (id) on delete restrict,
  revoked_at timestamptz
);
create unique index account_invites_live_email_idx on public.account_invites (email) where accepted_at is null and revoked_at is null;

create function public.app_admin_create_invite(p_email text, p_role text, p_display_name text default null) returns uuid; -- admin session; revokes a live invite for the same email first; record_events('invite', id, 'invited')
create function public.app_admin_revoke_invite(p_invite uuid) returns void;
create function public.app_admin_list_invites() returns table (id uuid, email text, role text, display_name text, invited_by uuid, invited_by_name text, created_at timestamptz, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz, state text); -- state: 'pending'|'accepted'|'expired'|'revoked'
create function public.app_admin_review_access_request(p_account uuid, p_decision text, p_role text default 'technician') returns void; -- decision 'approve'|'deny'; exclusive advisory lock; sets status + role; account_events; app_notify(requester)
create function public.app_admin_set_role(p_account uuid, p_role text) returns void; -- cannot demote self; exclusive lock
create function public.app_trusted_link_identity(p_user uuid) returns table (outcome text, account_id uuid, status text);
-- outcome: 'existing' | 'invited' | 'requested' | 'unverified'. Executable by nobody but the owner (service role). Reads auth.users + auth.identities; requires verified email; exclusive advisory lock (1162103123, 1); idempotent.
```
Also: `app_my_account()` unchanged; `app_directory()` excludes `pending_approval`/`denied` accounts (check its body and add the filter if it lists non-active accounts).

**Interfaces (TS):**
- `session.ts`: `AccountStatus` adds `'pending_approval' | 'denied'`; `RestrictionReason` adds `'pending_approval' | 'denied'`; routing: `pending_approval` → `/pending`, `denied` → `/restricted?reason=denied`.
- `google-actions.ts`: `export async function signInWithGoogleAction(): Promise<never>` (builds redirect with `redirectTo: new URL('/auth/callback', appOrigin()).toString()`, `queryParams: { prompt: 'select_account' }`; calls `redirect(data.url)`).
- `/auth/callback` GET: reads `code`; on missing/invalid → `/login?oauthError=1`; `exchangeCodeForSession(code)`; `adminClient().rpc('app_trusted_link_identity', { p_user: user.id })`; on `unverified` → sign out, `/login?oauthError=unverified`; redirect `/queue`; `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- `resend.ts`: `export async function sendMail({ to, subject, text, html }): Promise<{ ok: true } | { ok: false; reason: 'not_configured' | 'failed'; message?: string }>` using `fetch('https://api.resend.com/emails', { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY } })`, `from: process.env.MAIL_FROM`.
- `invite-actions.ts`: `createInviteAction(email, role, displayName): Promise<ActionResult & { inviteId?: string; emailed?: boolean; message?: string; inviteText?: string }>`; `revokeInviteAction(id)`. Invite text: "Hi {name}, {admin} invited you to Edison Helpdesk as a {role}. Sign in with Google using {email} at {APP_ORIGIN}. This invite expires on {date}."
- `access-actions.ts`: `reviewAccessRequestAction(accountId, decision, role)`, `setRoleAction(accountId, role)`.
- `admin-view.ts`: `loadAdminAccounts()` now returns pending/denied too; `loadInvites()`.
- Login page: `<GoogleButton />` primary ("Continue with Google"), password disclosure closed by default, copy: "Use the Google account your administrator invited. No invite yet? Sign in anyway and an administrator will review your request."
- `/pending`: "Your request is waiting for an administrator." + who to contact (admin display names from a public-safe RPC? No: show generic "the helpdesk administrator") + Sign out.

- [ ] **Step 1: Failing DB tests** (`tests/db/m5-invites.test.ts`): admin creates invite (returns id, listed `pending`); technician cannot (`insufficient_privilege`); duplicate live invite for same email supersedes (old `revoked`); revoke works; `pendingApproval` identity: cannot read tickets, `app_my_account` reports `pending_approval`; admin approves with role admin → status active, role admin, `account_events` has `access_approved`, requester has a notification; deny → `denied`; technician cannot review; admin cannot set own role to technician (`rpcFails`); `app_trusted_link_identity` not executable by authenticated or anon.
- [ ] **Step 2: Failing auth tests** (`tests/auth/google-link.test.ts`, uses the auth suite's globalSetup): with service client create an auth user via `auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name: 'Casey Invite' }, app_metadata: { provider: 'google', providers: ['google'] } })` then call `app_trusted_link_identity` → outcome `requested`, account `pending_approval`; create invite first for another email then link → `invited`, account active with invite role, invite accepted; linking again → `existing`; a user created with `email_confirm: false` → `unverified`, no account row.
- [ ] **Step 3:** `npm run test:local` → new files fail.
- [ ] **Step 4:** Implement migration, TS, UI (Administration → People & access: Accounts table with role menu + activate/deactivate; Invites panel with form (email, role, name) → result shows "Invite sent to x" or the copyable message when email is not configured; Access requests panel with Approve (role select) / Deny). Restricted page handles `denied`.
- [ ] **Step 5:** `npm run test:local` and `npm run check` pass. Manual: `/login` shows Google button; clicking without provider config shows the `oauthError` notice cleanly.
- [ ] **Step 6: Commit** (revert port patch before staging config.toml) `git commit -m "feat(auth): Google sign-in, email invites and admin access approval"`

---

### Task 8: People migration

**Files:**
- Create: `supabase/migrations/20260912100200_m5_people.sql`, `tests/db/m5-people.test.ts`

**Interfaces (SQL):**

```sql
create extension if not exists pg_trgm with schema extensions;
create table public.people (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null check (kind in ('student','staff')),
  first_name text not null default '',
  last_name text not null default '',
  display_name text not null,
  email text check (email is null or email = lower(btrim(email))),
  osis text check (osis is null or osis ~ '^[0-9]{6,12}$'),
  staff_id text,
  school_dbn text,
  department text,
  role_title text,
  official_class text,
  class_of text,
  parent_name text,
  parent_phone text,
  home_phone text,
  address text,
  notes text,
  active boolean not null default true,
  source text not null default 'manual' check (source in ('manual','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index people_osis_idx on public.people (osis) where osis is not null;
create unique index people_staff_id_idx on public.people (staff_id) where staff_id is not null;
create unique index people_email_idx on public.people (email) where email is not null;
create index people_display_name_trgm on public.people using gin (display_name extensions.gin_trgm_ops);
create index people_search_trgm on public.people using gin ((coalesce(email,'') || ' ' || coalesce(osis,'') || ' ' || coalesce(staff_id,'')) extensions.gin_trgm_ops);

create function public.app_list_people(p_query text default null, p_kind text default null, p_department text default null, p_class_of text default null, p_active boolean default true, p_limit integer default 25, p_offset integer default 0)
returns table (id uuid, kind text, display_name text, email text, osis text, staff_id text, department text, role_title text, official_class text, class_of text, active boolean, device_count integer, open_ticket_count integer, total_count bigint); -- security invoker
create function public.app_person_detail(p_person uuid) returns jsonb;
-- { person: {...all columns}, devices: [{ assignment_id, assigned_at, returned_at, device: {id, device_id, serial_number, asset_tag, type, model, status} }] (empty until Task 9 adds the join; write it now with a `to_regclass('public.device_assignments')` guard? No: create the function in Task 9's migration instead and here return devices: [] ), tickets: [{id, number, title, status, priority, created_at}], events: [{...record_events}] }
create function public.app_upsert_person(p_person jsonb) returns uuid; -- keys as columns; id null → insert; validates kind, display_name (derived from first/last when blank); logs record event 'created'|'updated' with changed keys in detail
create function public.app_set_person_active(p_person uuid, p_active boolean) returns void; -- admin only
create function public.app_people_facets() returns jsonb; -- { departments: text[], class_years: text[] }
```
RLS: select for active accounts; insert/update/delete not granted (RPCs only).

- [ ] **Step 1: Failing tests:** technician creates a student (osis `240000123`), reads it back via `app_list_people(p_query := '240000123')`; duplicate osis fails with a readable message; `pending` identity cannot list; admin deactivates → excluded from default list, included with `p_active := null`; `app_upsert_person` with `id` updates and logs an `updated` event visible in `record_events`; facets include the department created.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(db): people directory tables and RPCs"`

---

### Task 9: Devices migration

**Files:**
- Create: `supabase/migrations/20260912100300_m5_devices.sql`, `tests/db/m5-devices.test.ts`

**Interfaces (SQL):**

```sql
create table public.devices (
  id uuid primary key default extensions.gen_random_uuid(),
  device_id text,                -- AppSheet DeviceID, e.g. PW0FYJ9B-WIN
  serial_number text,
  asset_tag text,
  type text not null default 'Laptop',
  manufacturer text,
  model text,
  os text,
  status text not null default 'in_stock' check (status in ('in_stock','deployed','in_repair','retired','lost','surplus')),
  location text,
  notes text,
  source text not null default 'manual' check (source in ('manual','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_has_identifier check (coalesce(device_id, serial_number, asset_tag) is not null)
);
create unique index devices_device_id_idx on public.devices (upper(device_id)) where device_id is not null;
create unique index devices_serial_idx on public.devices (upper(serial_number)) where serial_number is not null;
create unique index devices_asset_tag_idx on public.devices (upper(asset_tag)) where asset_tag is not null;
create index devices_search_trgm on public.devices using gin ((coalesce(device_id,'')||' '||coalesce(serial_number,'')||' '||coalesce(asset_tag,'')||' '||coalesce(model,'')) extensions.gin_trgm_ops);

create table public.device_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.app_accounts (id) on delete restrict,
  returned_at timestamptz,
  returned_by uuid references public.app_accounts (id) on delete restrict,
  note text
);
create unique index device_assignments_open_idx on public.device_assignments (device_id) where returned_at is null;
create index device_assignments_person_idx on public.device_assignments (person_id, assigned_at desc);

create function public.app_list_devices(p_query text default null, p_type text default null, p_status text default null, p_location text default null, p_holder_kind text default null, p_limit integer default 25, p_offset integer default 0)
returns table (id uuid, device_id text, serial_number text, asset_tag text, type text, manufacturer text, model text, os text, status text, location text, holder_id uuid, holder_name text, holder_kind text, updated_at timestamptz, total_count bigint);
create function public.app_device_detail(p_device uuid) returns jsonb; -- { device, holder: {id, display_name, kind} | null, assignments: [{id, person_id, person_name, person_kind, assigned_at, assigned_by_name, returned_at, returned_by_name, note}], tickets: [] (Task 10 fills), events: [...] }
create function public.app_upsert_device(p_device jsonb) returns uuid;
create function public.app_assign_device(p_device uuid, p_person uuid, p_note text default null) returns uuid; -- closes any open assignment first, sets status deployed, logs events on device and person
create function public.app_return_device(p_device uuid, p_status text default 'in_stock', p_note text default null) returns void; -- error if no open assignment
create function public.app_set_device_status(p_device uuid, p_status text, p_reason text default null) returns void;
create function public.app_move_device(p_device uuid, p_location text) returns void;
create function public.app_bulk_update_devices(p_ids uuid[], p_patch jsonb) returns integer; -- patch keys: status, location, person_id (assign each), return (true); max 500 ids
create function public.app_device_facets() returns jsonb; -- { types, statuses (fixed list), locations }
-- Also: recreate app_person_detail (same signature) to include devices via device_assignments.
```

- [ ] **Step 1: Failing tests:** create device with serial only; duplicate serial (different case) fails; assign to person → status deployed, person detail lists device, device detail holder set; assigning to a second person auto-returns the first (assignment history has two rows, one open); return → status in_stock; `app_return_device` on unassigned device fails; bulk status change on 3 devices returns 3; `pending` cannot list; list filter by status and holder_kind works; total_count correct.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(db): device inventory and assignments"`

---

### Task 10: Ticket category, device links and person requesters

**Files:**
- Create: `supabase/migrations/20260912100400_m5_ticket_category_devices.sql`, `tests/db/m5-ticket-links.test.ts`
- Modify: `src/lib/domain/types.ts` (`TicketCategory`, `TICKET_CATEGORY_LABELS`, `Ticket.category`, `Ticket.deviceIds`), `src/lib/data/mapping.ts`, `src/lib/data/tickets.ts` (`QueueFilters.category`; `TicketDetail.devices` linked devices), `src/lib/data/actions.ts` (`createTicketAction` fields `category`, `personId`; `setCategoryAction`, `linkDeviceAction`, `unlinkDeviceAction`), `src/app/(app)/search-params.ts` (+ `category`), `tests/queue-params.test.ts`, `tests/intake.test.ts` (category default)

**Interfaces (SQL):**

```sql
alter table public.tickets add column category text not null default 'other'
  check (category in ('chromebook','laptop_desktop','projector_display','network','printer','account','software','phone','other'));
alter table public.requesters add column person_id uuid references public.people (id) on delete restrict;
create unique index requesters_person_idx on public.requesters (person_id) where person_id is not null;
create table public.ticket_devices (
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete restrict,
  linked_by uuid not null references public.app_accounts (id) on delete restrict,
  linked_at timestamptz not null default now(),
  primary key (ticket_id, device_id)
);
-- RLS: select where app_can_view_ticket(ticket_id).
drop function public.app_create_ticket(text,text,text,text,date,uuid,text,text,text,boolean,text,boolean,uuid,uuid[],jsonb);
create function public.app_create_ticket(... same params ..., p_category text default 'other', p_person_id uuid default null, p_device_ids uuid[] default '{}') returns uuid;
-- p_person_id: find requester by person_id or insert one (display_name, kind from person.kind, descriptor = department or official_class) then proceed as before.
drop function public.app_list_tickets(text,text,text,text,text,text,integer,integer);
create function public.app_list_tickets(p_scope text default 'open_queue', p_query text default null, p_status text default null, p_priority text default null, p_channel text default null, p_owner text default null, p_category text default null, p_limit integer default 25, p_offset integer default 0) returns table (... existing columns ..., category text, device_count integer, total_count bigint);
-- app_ticket_detail: same signature; ticket json gains category, person_id (via requester); adds 'linked_devices': [{id, device_id, serial_number, asset_tag, type, model, status, linked_at, linked_by}]
create function public.app_set_category(p_ticket uuid, p_category text) returns void; -- contributor rule; activity event 'category_changed'
create function public.app_link_ticket_device(p_ticket uuid, p_device uuid) returns void; -- contributor rule; event 'device_linked' (activity) + record_event on device
create function public.app_unlink_ticket_device(p_ticket uuid, p_device uuid) returns void;
-- activity_events_kind_valid: add 'category_changed','device_linked','device_unlinked'.
-- app_device_detail: recreate to fill tickets: [{id, number, title, status, created_at}] from ticket_devices where app_can_view_ticket.
```
Check `tests/db/intake.test.ts` and `tests/db/lifecycle.test.ts` for calls to `app_create_ticket`/`app_list_tickets`: positional calls must still work because new params have defaults and come last.

- [ ] **Step 1: Failing tests:** create ticket with `p_person_id` → requester created with `person_id`, second ticket for same person reuses requester; `p_category` invalid fails; list filter `p_category` works; link device as owner ok, as unrelated fails, `pending` cannot see `ticket_devices`; unlink; detail includes `linked_devices` and `category`; device detail lists the ticket for the owner and not for `unrelated`.
- [ ] **Step 2–4:** fail → implement → pass. Update TS layer + existing unit tests (`tests/intake.test.ts`, `tests/queue-params.test.ts` add category).
- [ ] **Step 5: Commit** `git commit -m "feat(db): ticket categories, device links and person requesters"`

---

### Task 11: Search migration

**Files:**
- Create: `supabase/migrations/20260912100500_m5_search.sql`, `tests/db/m5-search.test.ts`

**Interfaces (SQL):**

```sql
create function public.app_search(p_query text, p_limit integer default 8)
returns table (kind text, id uuid, title text, subtitle text, meta text, rank real)
language sql stable set search_path = '' as $$ ... $$;  -- SECURITY INVOKER
-- kind: 'ticket' | 'person' | 'device'. Empty/short (<2 chars) query returns nothing.
-- ticket: title = number + ' ' + title, subtitle = requester_name, meta = status. Matches number (prefix, case-insensitive), title/issue (trgm), requester name.
-- person: title = display_name, subtitle = kind + department/official_class, meta = osis or staff_id. Matches display_name (trgm), osis/staff_id/email (prefix).
-- device: title = coalesce(asset_tag, serial_number, device_id), subtitle = model + ' ' + type, meta = status + holder name. Matches asset_tag/serial/device_id (prefix, case-insensitive) and model (trgm).
-- rank: exact identifier match 1.0, prefix 0.9, trgm similarity otherwise; order by rank desc, limit p_limit per kind.
```

- [ ] **Step 1: Failing tests:** owner searches an asset tag prefix → device; searches OSIS → person; searches ticket number → their ticket; `unrelated` searching the same ticket number gets no ticket row (RLS) but still gets the device; `pending` gets nothing; one-character query returns nothing.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(db): global lookup search"`

---

### Task 12a: Import library (pure TypeScript)

**Files:**
- Create: `src/lib/import/csv.ts`, `src/lib/import/presets.ts`, `src/lib/import/normalize.ts`, `src/lib/import/index.ts`, `tests/import/csv.test.ts`, `tests/import/presets.test.ts`, `tests/import/normalize.test.ts`

**Interfaces:**

```ts
// csv.ts
export interface ParsedCsv { headers: string[]; rows: string[][]; }
export function parseCsv(text: string): ParsedCsv; // RFC 4180: quotes, escaped quotes, embedded newlines, CRLF, BOM strip, trailing empty line ignored; ragged rows padded with ''
// presets.ts
export type ImportKind = 'people' | 'devices';
export interface ColumnPreset { id: 'appsheet_students' | 'appsheet_staff' | 'appsheet_inventory' | 'custom'; label: string; kind: ImportKind; fixed?: Partial<Record<string, string>>; map: Record<string, string>; } // map: target field → source header
export const PRESETS: ColumnPreset[];
export function detectPreset(headers: string[]): ColumnPreset | null; // case/space-insensitive header match; needs ≥3 of the preset's mapped headers
export const PEOPLE_FIELDS: readonly string[]; export const DEVICE_FIELDS: readonly string[];
// normalize.ts
export interface PersonRow { kind: 'student'|'staff'; first_name: string; last_name: string; display_name: string; email: string|null; osis: string|null; staff_id: string|null; school_dbn: string|null; department: string|null; role_title: string|null; official_class: string|null; class_of: string|null; parent_name: string|null; parent_phone: string|null; home_phone: string|null; address: string|null; notes: string|null; }
export interface DeviceHolder { kind: 'student'|'staff'; osis: string|null; staff_id: string|null; name: string|null; }
export interface DeviceRow { device_id: string|null; serial_number: string|null; asset_tag: string|null; type: string; manufacturer: string|null; model: string|null; os: string|null; status: 'in_stock'|'deployed'|'in_repair'|'retired'|'lost'|'surplus'; location: string|null; notes: string|null; holder: DeviceHolder|null; }
export interface RowError { row: number; message: string; }
export function normaliseOsis(raw: string): string | null;      // strips commas/spaces; must be 6–12 digits else null
export function splitDeviceId(raw: string): { serial: string|null; os: string|null }; // 'PW0FYJ9B-WIN' → { serial:'PW0FYJ9B', os:'WIN' }
export function mapStatus(raw: string): DeviceRow['status'];   // 'Deployed'→deployed, 'In Stock'/'Available'/''→in_stock, 'Repair'/'In Repair'→in_repair, 'Retired'→retired, 'Lost'/'Missing'→lost, 'Surplus'→surplus, unknown→in_stock
export function toPersonRows(csv: ParsedCsv, preset: ColumnPreset): { rows: PersonRow[]; errors: RowError[] };
export function toDeviceRows(csv: ParsedCsv, preset: ColumnPreset): { rows: DeviceRow[]; errors: RowError[] };
```
Presets map exactly the AppSheet headers: students `Student ID:`, `Name`, `studentEmail`, `Parent`, `parentNumber`, `homeNumber`, `Class of`, `officalClass`, `studentAddress`, `Notes`; staff `firstName`, `lastName`, `staffEmail`, `schoolDBN`, `Department:`, `Role:`; inventory `DeviceID`, `SerialNumber`, `Type`, `Manufacturer`, `Model`, `OS`, `AssetTag`, `Status`, `Assigned To`, `Location`, `OSIS`, `Student Name`, `StaffID`, `Staff Name`, `Notes`. Student `Name` splits on the last space into first/last. Errors: missing name, invalid OSIS, device without any identifier.

- [ ] **Step 1: Failing tests** with invented rows (e.g. `Pat Example,240000123`), quoted fields with commas and newlines, BOM, CRLF; preset detection for each header set; normalisation cases above.
- [ ] **Step 2–4:** fail → implement → pass (`npx vitest run tests/import`).
- [ ] **Step 5: Commit** `git commit -m "feat(import): CSV parser, AppSheet presets and normalisation"`

---

### Task 12: Import migration

**Files:**
- Create: `supabase/migrations/20260912100600_m5_import.sql`, `tests/db/m5-import.test.ts`

**Interfaces (SQL):**

```sql
create table public.import_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null check (kind in ('people','devices')),
  mode text not null check (mode in ('dry_run','commit')),
  actor_id uuid not null references public.app_accounts (id) on delete restrict,
  at timestamptz not null default now(),
  row_count integer not null,
  inserted integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  error_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb
);
create function public.app_admin_import(p_kind text, p_rows jsonb, p_mode text default 'dry_run') returns jsonb;
-- Admin only. Rows are PersonRow[] or DeviceRow[] from Task 12a. Returns
-- { run_id, kind, mode, total, inserts, updates, unchanged, errors: [{row, message}], unmatched_holders: [{row, holder}], assignments_created }.
-- People upsert key: osis, else staff_id, else email; conflicts on a different natural key → error row. Devices key: upper(device_id), else upper(serial_number), else upper(asset_tag). Device holder: match people by osis (students) or staff_id, else by exact display_name of the right kind; when matched and no open assignment for that person → close others and create assignment (assigned_by = actor, note 'Imported'). dry_run computes the same counts inside a transaction and raises a custom exception caught by a wrapper that returns the json — implement as: run everything in a savepoint and `rollback to savepoint` when p_mode = 'dry_run'. Only commits write import_runs (dry runs are not recorded). Max 5000 rows per call.
create function public.app_admin_import_runs(p_limit integer default 20) returns setof public.import_runs;
```

- [ ] **Step 1: Failing tests:** dry run of 2 people reports 2 inserts and writes nothing; commit inserts 2; second commit of same rows → 2 unchanged; changed department → 1 updated; invalid row reports error with row index and the other rows still commit; device rows with holder osis matching → assignment created, unknown holder listed in `unmatched_holders`; technician cannot call; runs listed for admin.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(db): admin import with dry run and assignment derivation"`

---

### Task 13: Insights migration

**Files:**
- Create: `supabase/migrations/20260912100700_m5_insights.sql`, `tests/db/m5-insights.test.ts`

**Interfaces (SQL):**

```sql
create function public.app_insights(p_days integer default 30) returns jsonb; -- security invoker over tickets visible to caller? No: insights are team-wide by decision; SECURITY DEFINER, active account required, returns:
-- { days, series: [{ date:'YYYY-MM-DD', opened:int, resolved:int }], open_by_status: {open,assigned,in_progress,waiting}, open_by_priority: {...}, by_category: [{category,count}], resolution: { median_hours, mean_hours, resolved_count }, technicians: [{ account_id, name, resolved, minutes, open }], device_types_in_tickets: [{type,count}], inventory: { by_status: {...}, by_type: [{type,count}], total } }
```

- [ ] **Step 1: Failing tests:** seeded tickets produce correct opened/resolved counts for today; `pending` cannot call; technician can; categories counted.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(db): insights aggregates"`

---

### Task 14: Attachments migration

**Files:**
- Create: `supabase/migrations/20260912100800_m5_attachments.sql`, `tests/db/m5-attachments.test.ts`

**Interfaces (SQL):**

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments','attachments', false, 8388608, array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict (id) do nothing;
create table public.attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  ticket_id uuid references public.tickets (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  path text not null unique,             -- '<ticket|device>/<uuid>/<sanitised filename>'
  filename text not null,
  mime text not null,
  bytes integer not null check (bytes > 0 and bytes <= 8388608),
  uploaded_by uuid not null references public.app_accounts (id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  constraint attachments_one_parent check ((ticket_id is null) <> (device_id is null))
);
create function public.app_can_attach(p_ticket uuid, p_device uuid) returns boolean; -- ticket: contributor rule (owner/collab/admin, not closed); device: any active account
create function public.app_register_attachment(p_ticket uuid, p_device uuid, p_path text, p_filename text, p_mime text, p_bytes integer) returns uuid; -- checks app_can_attach; activity event 'attachment_added' or record event
create function public.app_list_attachments(p_ticket uuid default null, p_device uuid default null) returns setof public.attachments; -- RLS: ticket visible or device (any active)
create function public.app_delete_attachment(p_id uuid) returns text; -- uploader or admin; returns path for storage removal; logs event
-- activity_events_kind_valid: add 'attachment_added','attachment_removed'.
```
No storage policies are created (all storage access goes through server-issued signed URLs).

- [ ] **Step 1: Failing tests:** owner registers on own ticket, unrelated cannot; collaborator can; closed ticket refuses; device attachment by any technician; delete by uploader ok, by other technician fails, by admin ok; list respects ticket visibility.
- [ ] **Step 2–4.** **Step 5: Commit** `git commit -m "feat(db): attachments registry and private bucket"`

---

### Task 15: AI and preferences migration

**Files:**
- Create: `supabase/migrations/20260912100900_m5_ai_preferences.sql`, `tests/db/m5-ai.test.ts`

**Interfaces (SQL):**

```sql
create table public.account_preferences (
  account_id uuid primary key references public.app_accounts (id) on delete cascade,
  theme text not null default 'system' check (theme in ('system','light','dark')),
  ai_reasoning text not null default 'high' check (ai_reasoning in ('low','medium','high','xhigh')),
  ai_confirm_changes boolean not null default true,
  ai_speak_replies boolean not null default false,
  notify_in_app boolean not null default true,
  updated_at timestamptz not null default now()
);
create function public.app_my_preferences() returns public.account_preferences; -- inserts defaults on first call
create function public.app_update_preferences(p_patch jsonb) returns public.account_preferences; -- whitelisted keys only
create function public.app_update_display_name(p_name text) returns void; -- 2..80 chars; account_events 'status_changed'? no: use record_events('account', id, 'renamed')

create table public.ai_connections (
  account_id uuid primary key references public.app_accounts (id) on delete cascade,
  provider text not null default 'codex' check (provider = 'codex'),
  ciphertext text not null,      -- base64 AES-256-GCM of JSON { access_token, refresh_token, id_token, expires_at }
  chatgpt_account_id text,
  account_email text,
  plan_type text,
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  last_used_at timestamptz
);
-- RLS enabled, NO policies, revoke all from anon/authenticated: service role only.
create function public.app_my_ai_connection() returns table (connected boolean, account_email text, plan_type text, connected_at timestamptz, last_used_at timestamptz); -- security definer; own row; never returns ciphertext

create table public.ai_conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.ai_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role text not null check (role in ('user','assistant','tool','system')),
  content jsonb not null,        -- Responses API input item(s) for this turn
  created_at timestamptz not null default now()
);
-- RLS: own conversations (account_id = auth.uid() and active); messages via conversation ownership. Users may insert/update/delete their own rows directly (grant insert, update, delete with policies).
```

- [ ] **Step 1: Failing tests:** preferences default row created; patch unknown key ignored, invalid reasoning fails; `ai_connections` invisible/unwritable to authenticated (select returns 0 rows even after service insert; insert fails); `app_my_ai_connection` reports connected true/false without ciphertext; conversations/messages own-only.
- [ ] **Step 2–4.** **Step 5: Commit** `git commit -m "feat(db): account preferences, AI connections and conversations"`

---

### Task 16: Audit log and ticket notification hooks

**Files:**
- Create: `supabase/migrations/20260912101000_m5_audit_notifications.sql`, `tests/db/m5-audit.test.ts`

**Interfaces (SQL):**

```sql
create function public.app_audit_log(p_actor uuid default null, p_via text default null, p_kind text default null, p_entity text default null, p_from timestamptz default null, p_to timestamptz default null, p_limit integer default 50, p_offset integer default 0)
returns table (source text, id uuid, at timestamptz, actor_id uuid, actor_name text, performed_via text, ai_model text, kind text, entity_type text, entity_id uuid, entity_label text, summary text, detail text, total_count bigint);
-- admin only. Union of activity_events (entity_type 'ticket', label = ticket number), account_events ('account', label = display name), record_events (label = person display_name / device asset tag or serial / invite email / import kind).
-- Notification hooks: recreate (same signatures, bodies copied from the latest definitions) app_claim_ticket, app_reassign_ticket, app_add_collaborator, app_reopen_ticket, app_return_ticket_to_queue and add:
--   claim: notify previous owner if any ('ticket_claimed', 'EDT-1042 was claimed by <name>')  -- only when returned-then-claimed by someone else
--   reassign: notify new owner ('ticket_assigned', 'You were assigned EDT-1042: <title>', href '/tickets/<id>')
--   add_collaborator: notify the added account ('collaborator_added')
--   reopen: notify owner ('ticket_reopened')
--   return_to_queue: notify admins ('ticket_returned')
-- Never notify the actor about their own action.
```

- [ ] **Step 1: Failing tests:** admin reassigns to `collaborator` → collaborator has one `ticket_assigned` notification with href; admin adding self as collaborator creates none; technician cannot call `app_audit_log`; admin audit log includes the note event with `performed_via`, filters by `p_via='ai'` return only AI rows (use the header client from Task 5), `total_count` matches.
- [ ] **Step 2–4.** **Step 5: Commit** `git commit -m "feat(db): audit log and ticket notifications"`

---

### Task 17: People UI

**Files:**
- Create: `src/lib/data/people.ts`, `src/lib/data/people-actions.ts`, `src/app/(app)/people/page.tsx`, `src/app/(app)/people/[id]/page.tsx`, `src/app/(app)/people/new/page.tsx`, `src/components/people/PeopleList.tsx`, `PersonForm.tsx`, `PersonDetail.tsx`, `PersonPicker.tsx` (client, debounced search via `searchPeopleAction`, used by intake and device assign), `src/styles/directory.css`
- Modify: `src/app/(app)/tickets/new/page.tsx` (PersonPicker first; category select), `src/lib/domain/types.ts` (`Person`, `PersonSummary`), `src/lib/data/mapping.ts`

**Interfaces (TS):**
```ts
// people.ts (server-only)
export interface PeopleFilters { query?: string; kind?: 'student'|'staff'; department?: string; classOf?: string; active?: 'true'|'false'|'all'; page?: number }
export async function loadPeople(f: PeopleFilters): Promise<{ people: PersonSummary[]; total: number; page: number; pageCount: number }>;
export async function loadPerson(id: string): Promise<PersonDetail | null>; // { person, devices, tickets, events }
export async function loadPeopleFacets(): Promise<{ departments: string[]; classYears: string[] }>;
// people-actions.ts ('use server')
export async function savePersonAction(fields: PersonFields & { id?: string }): Promise<ActionResult & { id?: string }>;
export async function setPersonActiveAction(id: string, active: boolean): Promise<ActionResult>;
export async function searchPeopleAction(query: string): Promise<PersonSummary[]>; // uses app_list_people limit 8
```
Screens: list with `FilterBar` (search, kind segmented, department select, class of select, show inactive toggle), `DataTable` columns Name (link), Kind, Department/Class, ID (mono), Devices, Open tickets. Detail: header (name, kind badge, IDs mono, email link), sections Devices (current with "Return", history), Tickets (open then recent), Contact (student: parent, phones, address; staff: department, role, DBN), Notes, History (record events with `ActorLabel`), Edit button → form sheet. New person form: kind first, then fields per kind.

- [ ] Steps: implement; `npm run check`; screenshots 1440/390; commit `feat(people): directory list, detail and forms`.

---

### Task 18: Devices UI

**Files:**
- Create: `src/lib/data/devices.ts`, `src/lib/data/device-actions.ts`, `src/lib/data/export-actions.ts` (`exportDevicesCsvAction(filters)` → string; `exportTableCsvAction(table)` admin), `src/app/(app)/devices/page.tsx`, `devices/[id]/page.tsx`, `devices/new/page.tsx`, `src/components/devices/DeviceList.tsx` (multi-select + bulk bar: Assign, Change status, Move, Return), `DeviceForm.tsx`, `DeviceDetail.tsx`, `DevicePicker.tsx`, `AssignDeviceDialog.tsx`, `src/components/ticket/LinkedDevicesPanel.tsx`
- Modify: `src/app/(app)/tickets/[id]/page.tsx` (LinkedDevicesPanel in facts column), `src/components/ticket/DevicePanel.tsx` (rename heading "Device details observed"), `src/lib/domain/types.ts` (`Device`, `DeviceAssignment`, `DEVICE_STATUS_LABELS`), `src/lib/data/mapping.ts`

**Interfaces (TS):** `loadDevices(filters)`, `loadDevice(id)`, `loadDeviceFacets()`; actions `saveDeviceAction`, `assignDeviceAction(deviceId, personId, note)`, `returnDeviceAction(deviceId, status, note)`, `setDeviceStatusAction`, `moveDeviceAction`, `bulkUpdateDevicesAction(ids, patch)`, `searchDevicesAction(query)`, `linkDeviceAction(ticketId, deviceId)`, `unlinkDeviceAction`.
Detail page: identifiers block (asset tag, serial, device id in mono with copy buttons), status + location, holder card (person link, since), actions row (Assign, Return, Change status, Move), Assignment history table, Linked tickets, History, attachments slot (Task 22). CSV export button on list respects current filters.

- [ ] Steps: implement; `npm run check`; screenshots; commit `feat(devices): inventory list, detail, assignments and bulk actions`.

---

### Task 19: Lookup bar and barcode scan

**Files:**
- Create: `src/lib/data/search.ts`, `src/lib/data/search-actions.ts` (`searchAction(q): Promise<SearchHit[]>`), `src/components/shell/LookupResults.tsx`, `src/components/shell/ScanButton.tsx`, `src/components/shell/useLookup.ts`
- Modify: `src/components/shell/LookupBar.tsx` (replace stub), `src/components/shell/BottomTabs.tsx` (Lookup tab opens bottom `Sheet` with the bar focused), `src/styles/shell.css`
- Test: `tests/lookup.test.ts` for `groupHits(hits): { tickets, people, devices }` and `hrefFor(hit)` (`/tickets/<id>`, `/people/<id>`, `/devices/<id>`).

Behaviour: debounce 150ms, min 2 chars, `Ctrl/Cmd+K` and `/` (when not in an input) focus; results listbox with `role="listbox"`, arrow keys, Enter opens, Escape closes; recent 5 selections in `localStorage` key `edison.lookup.recent` shown when empty; the one motion: results container fades/slides 120ms, disabled under reduced motion. `ScanButton`: shown when `'BarcodeDetector' in window`; opens a `Dialog` with `<video>` from `getUserMedia({ video: { facingMode: 'environment' } })`, detects formats `code_128, code_39, qr_code, ean_13`, on detect sets the query and stops the stream; otherwise a hint "Scanning needs Chrome on Android or a recent Chromebook; type the tag instead."

- [ ] Steps: test → implement → `npm run check` → commit `feat(lookup): global search bar with keyboard navigation and barcode scan`.

---

### Task 20: Notifications UI

**Files:**
- Create: `src/lib/data/notifications.ts`, `src/lib/data/notification-actions.ts` (`markReadAction(ids|null)`), `src/components/shell/NotificationsBell.tsx` (client; initial count from server; refetch via `refreshCountAction()` on focus and every 60s), `src/app/(app)/notifications/page.tsx`
- Modify: `src/app/(app)/layout.tsx` (pass unread count), `src/components/shell/TopBar.tsx`

- [ ] Steps: implement; `npm run check`; commit `feat(notifications): bell, dropdown and notifications page`.

---

### Task 21: Insights UI

**Files:**
- Create: `src/lib/data/insights.ts`, `src/app/(app)/insights/page.tsx`, `src/components/insights/{BarChart,LineChart,StatTile,TechTable}.tsx`, `src/styles/insights.css`
- Test: `tests/insights-scale.test.ts` for `niceTicks(max, count)` and `pathFor(points, w, h)` helpers exported from `LineChart.tsx`.

Load the `dataviz` skill before writing chart code. Range selector (7 / 30 / 90 days) via search param. Charts are inline SVG with `<title>`/`aria-label` and a visually hidden data table. Colours from tokens (`--signal` opened, `--ok` resolved, `--brass` highlight).

- [ ] Steps: test → implement → `npm run check` → commit `feat(insights): team and inventory insights`.

---

### Task 22: Attachments UI

**Files:**
- Create: `src/lib/data/attachments.ts`, `src/lib/data/attachment-actions.ts` (`requestUploadAction({ ticketId?|deviceId, filename, mime, bytes })` → `{ path, signedUrl, token }` after `app_can_attach`; `registerAttachmentAction(...)`; `attachmentUrlAction(id)` → 60s signed URL; `deleteAttachmentAction(id)` → RPC then `storage.remove`), `src/components/attachments/{AttachmentUploader,AttachmentGrid,Lightbox}.tsx`, `src/lib/image/resize.ts` (canvas resize to ≤1600px, JPEG 0.85, only for image/*)
- Modify: ticket detail (uploader + grid in timeline column), device detail
- Test: `tests/attachments.test.ts` for `sanitiseFilename(name)` and `attachmentPath(kind, id, name)`.

- [ ] Steps: test → implement → `npm run check` → commit `feat(attachments): photo and PDF attachments on tickets and devices`.

---

### Task 23: Import UI and CLI

**Files:**
- Create: `src/lib/data/import-actions.ts` (`previewImportAction(kind, presetId, csvText, customMap?)` → parsed + normalised + dry-run result; `commitImportAction(...)`), `src/app/(app)/admin/import/page.tsx`, `src/components/admin/ImportScreen.tsx` (steps: Upload → Map columns (auto-detected preset, editable selects) → Dry run results (counts, errors table with row numbers, unmatched holders) → Commit → Done; history table below), `scripts/import-directory.mts` (reads `--dir`, finds `students.csv`, `staff.csv`, `inventory.csv`, uses `src/lib/import` via relative import, calls `app_admin_import` with an admin session obtained by `--email` + private stdin password like `bootstrap-admin.mjs`; refuses non-loopback URLs), `package.json` script `"import:csv": "node scripts/import-directory.mts"`
- Modify: `src/app/(app)/admin/page.tsx` tabs

- [ ] Steps: implement; run the CLI against synthetic CSVs in the scratchpad (invented rows) on the local stack; `npm run check`; commit `feat(import): admin CSV import with dry run and rehearsal CLI`.

---

### Task 24: Settings UI

**Files:**
- Create: `src/lib/data/preferences.ts`, `src/lib/data/preferences-actions.ts`, `src/app/(app)/settings/page.tsx`, `src/components/settings/{ProfileSection,AppearanceSection,AiSection,NotificationsSection}.tsx`
- Modify: `src/components/shell/ThemeProvider.tsx` (accept `initialTheme` from preferences and persist changes via `updatePreferencesAction`), `src/components/shell/UserMenu.tsx` (theme control calls the same)

- [ ] Steps: implement; `npm run check`; commit `feat(settings): profile, appearance, AI and notification preferences`.

---

### Task 25: Audit log and backups UI

**Files:**
- Create: `src/lib/data/audit.ts`, `src/app/(app)/admin/audit/page.tsx`, `src/components/admin/AuditLog.tsx` (filters: actor, via, kind, entity, date range; `ActorLabel`; pagination), `src/app/(app)/admin/backups/page.tsx`, `src/components/admin/BackupsScreen.tsx` (one "Download CSV" per table: tickets, notes, work_logs, activity_events, people, devices, device_assignments, app_accounts (no emails? include email; admin only), record_events — via `exportTableCsvAction` from Task 18)

- [ ] Steps: implement; `npm run check`; commit `feat(admin): audit log and CSV backups`.

---

### Task 26: AI backend

**Files:**
- Create: `src/lib/ai/crypto.ts`, `codex-auth.ts`, `connections.ts`, `responses-client.ts`, `tools.ts`, `prompt.ts`, `conversations.ts`, `ai-actions.ts`, `src/app/api/ai/chat/route.ts`, `tests/ai/crypto.test.ts`, `tests/ai/tools.test.ts`, `tests/ai/sse.test.ts`
- Modify: `.env.example` (`AI_TOKEN_KEY`), `src/lib/supabase/server.ts` (add `createClientWithHeaders(headers)` variant used by the tool executor)

**Interfaces (TS):**
```ts
// crypto.ts
export function encryptJson(value: unknown, keyB64 = process.env.AI_TOKEN_KEY): string; // 'v1.' + base64(iv) + '.' + base64(ciphertext+tag)
export function decryptJson<T>(payload: string, keyB64?: string): T;
export function aiEnabled(): boolean; // AI_TOKEN_KEY present and 32 bytes
// codex-auth.ts — constants read from the Codex CLI source at build time; record the commit hash in a comment
export const CODEX_CLIENT_ID: string; export const CODEX_AUTH_BASE = 'https://auth.openai.com'; export const CODEX_DEVICE_VERIFY_URL = 'https://chatgpt.com/codex/device';
export async function startDeviceAuth(): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds: number }>;
export async function pollDeviceAuth(deviceAuthId: string, userCode: string): Promise<{ status: 'pending' } | { status: 'complete'; tokens: CodexTokens }>; // one poll; complete = exchanged with PKCE
export async function refreshTokens(t: CodexTokens): Promise<CodexTokens>;
export function claimsFromIdToken(idToken: string): { chatgptAccountId: string | null; email: string | null; planType: string | null };
export interface CodexTokens { accessToken: string; refreshToken: string; idToken: string; expiresAt: string }
// connections.ts (server-only, service role)
export async function saveConnection(accountId, tokens): Promise<void>; export async function loadConnection(accountId): Promise<{ tokens: CodexTokens; chatgptAccountId: string } | null>; export async function disconnect(accountId): Promise<void>;
// responses-client.ts
export const AI_MODEL = 'gpt-5.6-luna'; export type Reasoning = 'low'|'medium'|'high'|'xhigh';
export async function* streamResponses(req: { tokens, chatgptAccountId, input: InputItem[], instructions: string, tools: ToolDef[], reasoning: Reasoning, signal }): AsyncGenerator<ResponsesEvent>; // POST https://chatgpt.com/backend-api/codex/responses, headers per Codex CLI (Authorization, chatgpt-account-id, OpenAI-Beta: responses=experimental, originator: codex_cli_rs, session_id, accept: text/event-stream), body { model, instructions, input, tools, tool_choice:'auto', parallel_tool_calls:false, reasoning:{effort, summary:'auto'}, store:false, stream:true, include:['reasoning.encrypted_content'] }
export function parseSse(chunk: string, state): ResponsesEvent[]; // pure, tested
// tools.ts
export interface ToolDef { type:'function'; name: string; description: string; parameters: JsonSchema; strict: true }
export const READ_TOOLS: string[]; export const WRITE_TOOLS: string[]; export const ADMIN_TOOLS: string[];
export function toolsFor(role: 'admin'|'technician'): ToolDef[];
export async function executeTool(name, args, ctx: { supabase: SupabaseClient /* with x-edison-via headers */, actor }): Promise<{ ok: boolean; result: unknown; summary: string }>; // summary like 'Claimed EDT-1042'
export function isWriteTool(name): boolean;
// prompt.ts
export function systemInstructions(ctx: { actorName, role, today, page?: { kind:'ticket'|'person'|'device'; id; label } }): string;
// route.ts POST body: { conversationId?: string; message?: string; approve?: string[]; reject?: string[]; page?: {...} }
// streams NDJSON lines: {type:'conversation', id} | {type:'delta', text} | {type:'tool_call', callId, name, args, summary, needsApproval} | {type:'tool_result', callId, ok, summary} | {type:'done'} | {type:'error', message}
```
Tools (names → RPC/actions): `search_records`, `get_ticket`, `list_queue`, `list_my_tickets`, `get_person`, `get_device`, `list_devices`, `create_ticket`, `claim_ticket`, `add_note`, `set_priority`, `set_category`, `set_waiting`, `resume_work`, `resolve_ticket`, `return_to_queue`, `add_collaborator`, `link_device_to_ticket`, `assign_device`, `return_device`, `set_device_status`; admin: `reassign_ticket`, `reopen_ticket`, `cancel_ticket`, `review_access_request`. Every tool validates args with a hand-written checker (no zod), passes only known fields.

Flow: verify actor (`activeAccount()`), `aiEnabled()`, load connection (refresh if needed, save back), load preferences (reasoning, confirm), load conversation input items, append user message, stream; on `function_call`: if write tool and confirm → persist the pending call in the conversation (`role:'tool'`, content `{pending:true, call}`) and emit `tool_call needsApproval:true`, end stream; on `approve` request: execute, append `function_call_output`, continue streaming; read tools execute inline. Titles: first user message truncated to 60 chars.

- [ ] **Step 1: Failing tests:** `crypto` round trip and tamper detection; `parseSse` handles split frames; `toolsFor('technician')` excludes admin tools; `isWriteTool('get_ticket')` false; arg checker rejects unknown fields.
- [ ] **Step 2–4:** implement; `npm run check`.
- [ ] **Step 5: Commit** `git commit -m "feat(ai): Codex device auth, encrypted tokens, tool executor and chat route"`

---

### Task 27: AI panel UI and voice

**Files:**
- Create: `src/components/ai/{AiPanel,AiMessage,AiComposer,AiConnectCard,ToolApprovalCard,ConversationList}.tsx`, `src/components/ai/useSpeech.ts`, `src/components/ai/markdown.ts` (+ `tests/ai/markdown.test.ts`), `src/styles/ai.css`, `src/components/shell/AiToggle.tsx`
- Modify: `src/components/shell/AppShell.tsx` (panel mount, `Ctrl/Cmd+J`), `src/components/settings/AiSection.tsx` (connect/disconnect using `startCodexAuthAction`, `pollCodexAuthAction`, `disconnectCodexAction` from `ai-actions.ts`)

Panel: header "Assistant" + model label "GPT-5.6 Luna" (static) + reasoning `SegmentedControl` (Low / Medium / High / Extra high) + "Ask before changes" switch + conversations menu; body: messages (`markdown.ts` renders paragraphs, `**bold**`, `` `code` ``, fenced code, `- lists`, links → escapes HTML first), tool chips, approval cards (Approve / Reject); composer: textarea (Enter sends, Shift+Enter newline), mic button (hold on touch, toggle on desktop; `webkitSpeechRecognition || SpeechRecognition`, `lang 'en-US'`, interim results into the textarea), "Speak replies" reads final assistant text with `speechSynthesis`. Not connected: `AiConnectCard` with the device code, the link, and "Waiting for you to approve in ChatGPT…" polling every `intervalSeconds`. AI disabled (no key): panel shows "The assistant is not enabled on this deployment."

- [ ] Steps: test markdown → implement → `npm run check` → screenshots → commit `feat(ai): assistant side panel with approvals and push-to-talk`.

---

### Task 28: PWA

**Files:**
- Create: `src/app/manifest.ts` (name "Edison Helpdesk", short_name "Edison", start_url "/queue", display "standalone", theme_color "#0f1f3d", background_color "#f3f5f8", icons 192/512 + maskable), `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `scripts/generate-icons.cjs` (renders an inline SVG brand mark with Playwright to PNGs; run once)
- Modify: `src/app/layout.tsx` (`metadata.manifest`, `appleWebApp`, `viewport.themeColor` per scheme)

- [ ] Steps: generate icons; `npm run build`; Lighthouse "installable" sanity via Chrome DevTools is optional; commit `feat(pwa): installable app manifest and icons`.

---

### Task 29: Attribution everywhere

**Files:**
- Modify: `src/components/ticket/ActivityTimeline.tsx`, `src/components/people/PersonDetail.tsx`, `src/components/devices/DeviceDetail.tsx`, `src/components/admin/AuditLog.tsx`, `src/components/shell/NotificationsBell.tsx` — all render `ActorLabel` with `via`/`model`; mapping layers pass `performedVia`/`aiModel` through.
- Test: `tests/actor-label.test.ts` for `actorLabelText(name, via)` → `"Tanav"` / `"Tanav's AI"` (names ending in "s" still get `'s`).

- [ ] Steps: test → implement → `npm run check` → commit `feat(attribution): label AI-made changes as the person's AI`.

---

### Task 30: Screenshots, docs, verification, PR

**Files:**
- Create: `scripts/review-overhaul.cjs`, `docs/M5-PLATFORM-OVERHAUL.md`
- Modify: `README.md`, `AGENTS.md` (Established decisions: Google sign-in with invites/approvals; email via Resend for invites; people/devices in scope; attachments; AI assistant; design direction), `PROJECT_STATUS.md`, `.env.example`, `CLAUDE-HANDOFF.md` (point to this PR), `TICKETING-PLAN.md` (short "Superseded decisions" note at top)

- [ ] **Step 1:** `scripts/review-overhaul.cjs`: like `review-m3.cjs`, creates synthetic admin + technician via the local admin API, seeds a few tickets/people/devices through RPCs, logs in with password, visits login, queue, ticket detail, new ticket, people list, person, devices list, device, insights, admin (access, import, audit), settings, notifications, AI panel (unconnected) at 1440×900, 1024×768 and 390×844, saves PNGs to `/tmp/edison-overhaul-review/`, asserts no horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`) and no console errors.
- [ ] **Step 2:** Run `npm run check` and `npm run test:local`; run the review script; fix anything found.
- [ ] **Step 3:** Docs: architecture, trust boundaries, the Codex endpoint caveat with the source commit, owner runbook (Google Cloud OAuth client + Supabase provider + redirect URL; Resend key + `MAIL_FROM`; `AI_TOKEN_KEY` generation `openssl rand -base64 32`; `supabase db push`; first import steps; Vercel env vars), what changed for users, remaining ideas.
- [ ] **Step 4:** Commit docs. Report to the user with screenshots and the exact commands run; do not open the PR until they have looked.

---

## Self-review

- Spec coverage: §2 → T1–T4, T28; §3 → T6; §4 → T5, T29; §5 → T8, T17; §6 → T9, T10, T18; §7 → T12a, T12, T23; §8 → T11, T19; §9 → T5, T16, T20; §10 → T13, T21; §11 → T14, T22; §12 → T4, T10, T18, T22; §13 → T15, T26, T27; §14 → T24, T25, T6; §15 → T28; §16 → global constraints; §17 → T30.
- Names used across tasks: `ActorLabel` (T2, T29), `DataTable`/`FilterBar`/`Pagination` (T2, T4, T17, T18), `PersonPicker` (T17, T18), `app_can_view_ticket` (existing), `app_request_via` (T5, T16), `record_events` (T5, T8, T9, T16), `app_admin_import` (T12, T23), `AI_MODEL` (T26, T27), `searchAction` (T19), `createClientWithHeaders` (T26).
