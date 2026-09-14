# Executable handoff — M5 platform overhaul

M5 is built on the branch `platform-overhaul`, off `main` at `e999242`. It is **not pushed, not merged and not deployed**; the user reviews it on the running dev server and decides between a pull request and a direct merge. Do not push, open a PR, or merge without being told to.

Read AGENTS.md and PROJECT_STATUS.md first, then **[docs/M5-PLATFORM-OVERHAUL.md](docs/M5-PLATFORM-OVERHAUL.md)** — what M5 is, its trust boundaries, the ordered owner runbook for the hosted project, and the known limitations. TICKETING-PLAN.md is the original product specification; its superseded decisions are flagged at the top of that file. Prior handoffs are docs/handoffs/M1.md and M2.md; the M3 handoff this file used to hold is in its git history, and docs/handoffs/PRE-M4-STATUS.md and M4-PRE-LAUNCH-STATUS.md carry the M4 record.

## What is on the branch

Google sign-in with invites and an approval queue; a people directory and a device inventory imported from the AppSheet CSV exports; ticket categories, person requesters and device links; search with a `Ctrl/Cmd+K` command palette; attachments; in-app notifications; an audit log; insights; the phone as a barcode scanner; an AI assistant on each technician's own ChatGPT account, with every change it makes attributed as that person's AI; and a dark-first design system with tokens, streaming skeletons and phone layouts.

Migrations `20260912100000_m5_foundation.sql` through `20260912101300_m5_row_attribution.sql`, all additive, applied to the local stack only.

The per-task briefs, reports, review rounds and rulings are in `.superpowers/sdd/2026-09-12-platform-overhaul/`. `progress.md` there is the ledger; `constraints.md` is binding for anybody still working on this branch.

## Working rules on this branch

- Node 24 via nvm: prefix any shell that runs npm or node with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;`. Supabase CLI only through `npx supabase`.
- The local stack runs on 55321/55322/55323 through an **uncommitted** patch to `supabase/config.toml`. Never stage that file. Never `git add -A`; add files by name. Never commit `.env.local`.
- A dev server runs on port 3005 for the user's review. Do not restart it. The documented default stays 3000.
- `npm run test:db`, `npm run test:auth` and `npm run test:local` **reset the local database** and destroy any account bootstrapped there. Do not run them while a browser review is in flight, and never against a hosted project.
- Migrations are additive only, with `set search_path = ''`, schema-qualified names, RLS enabled and explicit policies on every new table, and targeted grants after a revoke.
- No real student or staff data anywhere. Fixtures use invented names on the `edison.example` domain.
- Commit messages are conventional and end with the two trailer lines the repository uses.

## Verification

```bash
npm run check       # typecheck, lint, unit tests, production build
npm run test:local  # reset + DB tests, then reset + auth tests
PLAYWRIGHT_MODULE=/absolute/path/to/playwright REVIEW_BASE_URL=http://127.0.0.1:3005 node scripts/review-overhaul.cjs
```

`scripts/review-overhaul.cjs` creates its own synthetic administrator and technician through the local admin API, seeds people, devices and tickets through the ordinary RPCs, signs in with the password form, and walks every route at 1440×900, 1024×768 and 390×844 on both themes, asserting no horizontal overflow and no browser console errors. PNGs land in `/tmp/edison-overhaul-review/final` unless `REVIEW_OUTPUT_DIR` says otherwise.

## Next

1. Finish the outstanding branch work (polish pass, final whole-branch review), then hand the branch to the user with the screenshots and the exact commands run.
2. The user decides PR or direct merge. Nothing is pushed until they say so.
3. After the merge, the hosted rollout follows the ordered runbook in docs/M5-PLATFORM-OVERHAUL.md. Step 2 — enabling the Before User Created hook — must happen before step 3 turns sign-ups on.
