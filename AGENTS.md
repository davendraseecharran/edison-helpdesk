# Shared working instructions

Read PROJECT_STATUS.md first, then the relevant portions of TICKETING-PLAN.md. For a Claude handoff also read CLAUDE-HANDOFF.md. Latest explicit user instructions take precedence. Keep this file short; progress belongs in PROJECT_STATUS.md.

## Established decisions

- Next.js App Router + TypeScript, Vercel Hobby (user selected), Supabase Postgres/Auth. Do not reopen platform selection.
- Google sign-in is the primary way in (M5, superseding the earlier email-and-password-only decision). An admin invites by email first; an uninvited verified Google address lands in `pending_approval` for an admin to approve or deny. Any verified Google address is allowed, personal ones included: the gate is the invite or the approval, not the domain.
- Password sign-in remains, as the admin's break-glass path. Admin creates those accounts and hands over privately delivered single-use setup/recovery links. Public password sign-up is closed by the Before User Created auth hook, not only by a dashboard setting.
- Email (Resend) is optional and only sends invite messages. With no key set an invite still succeeds and the admin screen hands over the message text.
- Roles are a SET, from {admin, netrider, skills_officer} (Phase 2). `netrider` replaces `technician`, which survives only as the internal spelling of the derived `role` column and is never shown to anybody; a skills officer works the student and staff directory, reads the inventory and cannot reach a ticket. `app_accounts.roles` is the source of truth and `app_set_account_roles` is the one door to a change. Enforce role rules in the database; the rail is a convenience.
- NetRiders see only claimable open tickets and tickets they own/collaborate on. Admin sees all. Enforce this on the backend/database, not just the UI.
- Admin creates any intake channel and selects owner or Open Queue. A NetRider's creation is Walk-in only, assigned to themselves; they can add collaborators.
- `/today` is the landing page after sign-in for anybody who works tickets, and the rail's first item; a skills officer lands on People. One keyboard model in every list: `j`/`k` move, `o` opens, `c` claims, `r` resolves, `e` edits.
- Primary owners can return unfinished tickets to Open Queue, preserving all contributions and collaborators and recording the return in history. Collaborators cannot release someone else’s ticket.
- Owner or collaborator resolves immediately with a solution. No approval step. Time logs are optional.
- People and devices are in scope (M5): `public.requesters` and `public.inventory_devices` are the district's own directory and inventory, and this system is their authoritative home. Tickets link to people and to machines. Attachments, in-app notifications and an audit log are in. Insights was removed by the user; public intake is still deferred.
- There is NO import path into those tables, in the app or anywhere else. M5's own `people`, `devices`, `device_assignments` and `import_runs` tables and the CSV importer that wrote them were deleted (unpushed, so deleted rather than reversed). The data arrives once through the owner's preparation scripts and is corrected from the screens. CSV goes out — Administration → Backups, the Devices export — never in.
- Attachments live in a private storage bucket with no policies on `storage.objects`; the server issues short-lived signed URLs after checking the parent record. 8 MiB per file, images and PDF.
- The AI assistant runs on each person's own ChatGPT account (device-code OAuth, tokens encrypted at rest with `AI_TOKEN_KEY`, server-only). It acts through the same RPCs a person uses, on that person's own client, so it can never see or change more than they can, and it is offered only the tools their roles allow. Admin tools always confirm. Every AI change is attributed as the person's AI — a label for readers, never a permission.
- About seven NetRiders and 20–40 new tickets daily. The live directory and inventory are 3,448 students, 261 staff and 4,278 machines (the plan's ~2,500/300/7,500 was the estimate before the import).
- Restrained, clean interface; neutral surfaces, readable type, practical tables, accessible keyboard/focus states, responsive layout. M5 and Phase 2 add: dark theme by default with light and system available, tokens only (no hard-coded colours outside `tokens.css`), a MONOCHROME gray ladder (navy, brass and the blue that briefly replaced them are all retired; retired token names survive as aliases), Geist Sans/Mono, Tailwind v4 and shadcn/ui primitives derived from the tokens, sentence case, no horizontal page scroll at 390px, reduced motion respected. `--edge-light` is worn by exactly one element on a screen; `src/styles/lamp.css` decides who. Motion is `docs/MOTION.md`, copy is `docs/VOICE.md`.

## Continuity and efficient delegation

- The user authorizes bounded subagents when useful. Default to one primary worker; add one helper for an independent task with explicit file ownership or a read-only review. Use more only when independent work justifies the additional context and usage. Do not spawn recursively without a concrete reason.
- Send helpers a short task, relevant paths, constraints, and expected output. Avoid copying the entire conversation. Require concise results with evidence and unresolved issues.
- User preference (September 11): use `gpt-6-luna` helpers at `max` reasoning for bounded work, with a fresh short context (`fork_turns="none"`). Primary worker reviews results; avoid repeated full-history reviews.
- Subagents are not a separate free usage budget. They can improve elapsed time but may increase total usage. Never claim an exact future exhaustion time.
- For Codex, read live account usage at the start of sustained work, after a milestone, and before expensive delegation. Save timestamp, plan, percentages, and reset times in PROJECT_STATUS.md. If the usage tool is unavailable, report unknown; do not infer remaining quota from elapsed time.
- Conservative workflow thresholds (not provider guarantees): at 70% of either window checkpoint and reduce delegation; at 85% finish the current bounded task and prepare a handoff; at 95% or a reported cap avoid starting a new large task. Checkpoint routinely even below these levels. A single operation or another thread may consume the remaining allowance.
- Do not consume reset credits, buy credits, or change paid plans without explicit authorization. Availability of a credit is not permission to use it.
- At each milestone and before stopping, update PROJECT_STATUS.md with actual changes, commands/results, unverified work, blockers, active processes, file ownership, and the exact next task. Never mark a prototype as production-ready.
- Session caps and context limits are different. Neither chat compaction nor a reset substitutes for a filesystem checkpoint. No automatic wakeup is configured; a new user turn resumes work unless a future automation is explicitly established.
- Codex and Claude must not edit the same files simultaneously. Record active work in PROJECT_STATUS.md as an advisory ownership note, not a real lock. Check with the user if another tool is still writing. Release ownership on handoff. Use isolated branches/worktrees for intentionally concurrent work once Git is available.

## Implementation and review

- Inspect current files/diff before editing. Preserve existing work. If Git is not initialized, do not pretend a commit or branch exists.
- Use synthetic people, devices, and tickets in prototypes. No real student/staff data, passwords, tokens, or source-sheet identifiers in fixtures, logs, or screenshots.
- A demo user selector is prototype-only and must never become an authentication bypass. Do not store passwords in demo state. Real auth/backend work is a separate milestone.
- Keep provider secrets server-only; use .env.example placeholders. Protect role fields and setup completion. Preserve atomic claim/resolve semantics and historical attribution.
- Verify current official framework/package documentation during scaffolding, select compatible stable versions, and keep one package-manager lockfile. Prefer a supported Node LTS for the project; the local Node installation may differ.
- Run meaningful checks for the changed behavior; report exact commands and outcomes. Do not claim tests passed if they were not run. Avoid repeated unchanged checks and large raw logs.
- Follow the user's task scope. Finish authorized local work without repeatedly asking for routine choices. Hosting accounts, credentials, real imports, and deployment are not prerequisites for a local M1 prototype.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
