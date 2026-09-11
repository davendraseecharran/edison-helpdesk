# Edison ticketing

Read AGENTS.md and PROJECT_STATUS.md, then CLAUDE-HANDOFF.md for the current executable handoff. TICKETING-PLAN.md is the full product specification.

Use the shared filesystem as the continuity source. Follow its single-writer and checkpoint instructions. Do not assume Codex is running, that a usage reset has happened, or that another agent's unverified claim is correct. Implement only the milestone selected by the user's prompt; finish it and leave a concise handback.
