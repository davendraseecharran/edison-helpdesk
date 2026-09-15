# Executable handoff — M5 platform overhaul, and Phase 2 on top of it

M5 and Phase 2 are built on the branch `platform-overhaul`, off `main` at `e999242`. It is **not pushed, not merged and not deployed**; the user reviews it on the running dev server and decides between a pull request and a direct merge. Do not push, open a PR, or merge without being told to.

Read AGENTS.md and PROJECT_STATUS.md first, then **[docs/M5-PLATFORM-OVERHAUL.md](docs/M5-PLATFORM-OVERHAUL.md)** — what M5 is, its trust boundaries, the ordered owner runbook for the hosted project, and the known limitations. TICKETING-PLAN.md is the original product specification; its superseded decisions are flagged at the top of that file. Prior handoffs are docs/handoffs/M1.md and M2.md; the M3 handoff this file used to hold is in its git history, and docs/handoffs/PRE-M4-STATUS.md and M4-PRE-LAUNCH-STATUS.md carry the M4 record.

## What is on the branch

Google sign-in with invites and an approval queue; the district's own directory and inventory (`requesters` / `inventory_devices`), which this branch builds **on** rather than beside; ticket categories, directory requesters and device links; search with a `Ctrl/Cmd+K` command palette; attachments; in-app notifications; an audit log; CSV backups of the district's tables; the phone as a barcode scanner; an AI assistant on each person's own ChatGPT account, with every change it makes attributed as that person's AI; and a dark-first design system with tokens, streaming skeletons and phone layouts.

Phase 2 added: People and Devices over the owner's rows with facets, bulk assign and return (the owner's `InventoryManager` and `/inventory/*` are gone); roles as a set of {admin, netrider, skills_officer} with `role` kept as a derived column; `/today` as the landing page, with one keyboard model across every list; intake that drafts a category and a priority, reads a pasted email and warns about a duplicate; a monochrome palette on Geist with Tailwind v4 and shadcn/ui primitives derived from the tokens. Insights was removed by the user, and there is no import path anywhere in the application.

31 migrations, `20260914100000_m5_foundation.sql` through `20260914170100_m5_public_totals_retire.sql`, all additive, applied to the local stack only. Every one is numbered `20260914` so that all of them apply AFTER the owner's four. The release procedure is [Deploy this branch](docs/M5-PLATFORM-OVERHAUL.md#deploy-this-branch).

The per-task briefs, reports, review rounds and rulings are in `.superpowers/sdd/2026-09-12-platform-overhaul/`. `progress.md` there is the ledger; `constraints.md` is binding for anybody still working on this branch.

## Working rules on this branch

- Node 24 via nvm: prefix any shell that runs npm or node with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;`. Supabase CLI only through `npx supabase`.
- The local stack runs on 55321/55322/55323 through an **uncommitted** patch to `supabase/config.toml`, which also turns Realtime on and lowers `minimum_password_length` to 8; a second worktree runs its own stack on 56321/2/3 with a distinct `project_id`. Never stage that file — the committed values are the defaults, and the hosted project does not read it at all. Never `git add -A`; add files by name, and prefer `git commit --only <paths>` while another lane's work is staged. Never commit `.env.local`. The DB and auth suites derive their container name from the worktree's own `project_id`, so a run in one worktree never resets another's database.
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

`scripts/review-overhaul.cjs` creates one synthetic account of each role through the local admin API, seeds directory records, machines and tickets through the owner's own RPCs, signs in with the password form, and walks Today, the queue, a ticket, intake, My tickets, People (students and staff), a person, Devices, a device, Administration, Settings, notifications, the palette and the assistant panel, plus the signed-out sign-in page, at 1440×900, 1024×768 and 390×844 on both themes — asserting no horizontal overflow, no browser console errors, and never more than one element wearing the lamp. PNGs land in `/tmp/edison-overhaul-review/final` unless `REVIEW_OUTPUT_DIR` says otherwise.

`scripts/review-intake.cjs` and `scripts/review-inventory-management.cjs` are retired; both refuse to run and say what replaced the screens they drove.

## Next

1. Finish the outstanding branch work (final whole-branch review, full verification, captures, re-seed), then hand the branch to the user with the screenshots and the exact commands run.
2. Rehearse what the owner's merge will do: the branch's 31 migrations applied onto a database holding only the 19 that are live, then the DB and auth suites against it. Zero manual steps is the bar.
3. The user decides PR or direct merge. Nothing is pushed until they say so.
4. After the merge, release per [Deploy this branch](docs/M5-PLATFORM-OVERHAUL.md#deploy-this-branch) and then work the ordered runbook in docs/M5-PLATFORM-OVERHAUL.md. Step 2 — enabling the Before User Created hook — must happen before step 3 turns sign-ups on.
