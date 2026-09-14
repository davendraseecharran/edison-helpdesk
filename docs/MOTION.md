# Motion

Every animation in the application, what triggers it, and what it is made of.
The rule behind the table: **motion answers an action, it never decorates.** If
a moment is not in this table it does not move.

Durations and curves come from `src/styles/tokens.css` (`--dur-hover`,
`--dur-press`, `--dur-surface`, `--ease-out`, `--ease-in-out`) and from
`src/components/ui/Motion.tsx` (`DURATION`, `SPRING`, `EASE_OUT`,
`EASE_OUT_FAST`). Nothing hard-codes a number that one of those already names.

Two rules hold everywhere and are not repeated per row:

- **Named properties only.** No rule in the codebase says `transition: all`. A
  shorthand that animates everything picks up unrelated changes for free and is
  the usual cause of a layout that jitters when a class flips.
- **Reduced motion.** `prefers-reduced-motion: reduce` keeps opacity and colour
  and drops movement: `base.css` mutes transitions and animations globally, and
  each wrapper takes its own branch (`INSTANT`, `initial={false}`, `animation:
  none`). The meaning of every state survives without the movement.

## The table

| Surface | Trigger | Properties | Duration | Curve | Reduced motion |
| --- | --- | --- | --- | --- | --- |
| Buttons, rail items, table rows, menu items, tabs, segmented options | pointer enters or leaves | `background-color`, `color`, `border-color`, `box-shadow` | 150 ms (`--dur-hover`) | `ease` | colour changes, no transition |
| Any pressable (`.btn`, `.pressable`) | pointer down | `scale` 1 → 0.98 | 120 ms (`--dur-press`) | `ease-out` | no scale |
| Menus and popovers | open | `opacity` 0 → 1, `scale` 0.97 → 1 from the trigger's corner (`transform-origin`) | 200 ms (`--dur-surface`) | `--ease-out` | opacity only |
| Menus and popovers | close | `opacity`, `scale` | 120 ms | `--ease-out` | opacity only |
| Dialogs | open | `opacity`, `scale` 0.98 → 1, centred | 220 ms (`DURATION.slow`) | spring, no bounce | none |
| Dialogs | close | `opacity`, `scale` | 120 ms (`DURATION.fast`) | `easeOut` | none |
| Scrim behind any modal surface | open | `opacity`; the ground is `--scrim` with `backdrop-filter: blur(12px) saturate(120%)` | 200 ms | `--ease-out` | opacity only |
| Drawers (phone bottom sheets) | open | `translateY(100% → 0)`, then the finger | vaul's own | vaul's own | none |
| Drawers | drag | follows the pointer, damped past the boundary; released above the velocity threshold it dismisses, below it returns | — | — | drag still works; nothing else moves |
| Sheets (desktop, from the right) | open | `translateX(100% → 0)` | 220 ms | spring, no bounce | none |
| Command palette | open | **none** — no scale, no slide | 0 | — | — |
| Palette selection | arrow key | **none** | 0 | — | — |
| Assistant composer | panel opens | one border-beam lap | 3 s, once | linear | not rendered |
| Assistant mark (top bar, connect card) | a reply is on its way | `transform: rotate`, `opacity` 1 → 0.55 → 1 | 6 s turn, 2.4 s breath | `linear`, `ease-in-out` | static, held dim |
| Assistant orb (in panel) | conversation state | canvas, per `orb-state.ts` | per state | per state | one still frame |
| Toasts | arrive | `opacity`, `translateY(16 → 0)`, `blur(2px → 0)` | 300 ms | `easeOut` | opacity only |
| Toasts | leave | `opacity`, `translateY(0 → 8)` | 200 ms | `easeOut` | opacity only |
| Toast stack | one is dismissed | `layout` position | 180 ms | `easeOut` | none |
| Icon swaps (`IconSwap`) | the icon's meaning changes | `opacity`, `scale` 0.25 → 1, `blur(4px → 0)` | 300 ms | spring, no bounce | swap, no animation |
| Today's list | first paint only | `opacity`, `translateY` staggered 20 ms a row, capped at 12 | 300 ms total | `easeOut` | no entrance |
| Every other list | navigation | **none** | 0 | — | — |
| Skeleton → content | the stream lands | content replaces the skeleton in place, no layout shift | 120 ms | `easeOut` | same |
| Theme switch | the preference changes | **none** — every transition is muted, a reflow is forced, the mute is lifted | 0 | — | same |

## Notes on the choices

**Exits are quicker than entrances.** A surface arriving is information and
earns its time; a surface leaving is over, and an exit as slow as its entrance
reads as the interface being reluctant. Nothing uses `ease-in`: it holds the
first frame back, and the first frame is the one the eye is on.

**The palette does not animate.** It is opened by a keyboard shortcut dozens of
times a day, and at that frequency any entrance is a delay. Its backdrop is a
real blur rather than a wash: `--ink` at 45% was near-white in the dark theme
and fogged the page instead of putting a surface above it.

**Hover transitions live on the base rule, not the `:hover` rule.** Declared on
the hovered state only, a fill fades in and snaps out, and crossing a table the
eye reads that asymmetry as a glitch on every row.

**Hover is gated.** Every `:hover` rule sits inside
`@media (hover: hover) and (pointer: fine)`. Without it a tap leaves the
control looking hovered until something else is touched — and the controls that
matter most here are the phone ones.

**One press number.** `scale(0.98)` and the 120 ms that carries it are declared
once, in `components.css`, shared by `.btn` and `.pressable`. A second copy in
another stylesheet is how a design system starts drifting.

**One lit element.** `--edge-light` is not motion, but it belongs in the same
discipline: `src/styles/lamp.css` is the only place that decides which element
wears it, and it is taken from whatever held it rather than added.

## Where the behaviour comes from

Some of these primitives are ours and some are shadcn/ui's, copied into
`src/components/ui/shadcn/` and ported to our tokens. The rule for taking one:
we keep it while ours is as good, and swap when theirs is better at the thing
that is hard — dragging, focus, dismissal, the keyboard — because none of that
is where this product's ideas are.

| Primitive | Behaviour from | Why |
| --- | --- | --- |
| `Sheet` (bottom) | shadcn Drawer, on vaul | A bottom sheet is dragged. Ours slid on a spring and ignored the finger; vaul brings the drag, the velocity threshold, the boundary damping and the handle. Our header, body and footer markup, our tokens, our scrim. |
| `Sheet` (right), `Dialog` | ours (`Overlay` + `SpringSurface`) | Nothing drags a desktop side panel, and the focus trap, the scroll lock and the exit are already right. |
| Command palette | cmdk | Unchanged, and staying: the layout, the groups and the instant open are the product's own. |
| Toasts | ours (`toast.ts` reducer) | Sonner is in the repository and not yet wired: our reducer carries tested behaviour Sonner does not have — a hold while the tab is hidden, a hold while a toast has focus, and a deadline armed from the reducer's own clock. Swapping it would delete tests, so it waits for a decision. |
| Buttons, inputs, tables, menus, tabs, badges | ours | Every one of them is a class over our tokens, and there is nothing shadcn does with them that this product needs and does not have. |

## Verifying

`scripts/review-overhaul.cjs` asserts the invariants a screenshot cannot show:
no page scrolls sideways, no page logs a browser error, and never more than one
element wears the lamp. Motion itself is checked by eye at a tenth speed —
Playwright with `Animation.setPlaybackRate(0.1)` through CDP — opening the
palette, a menu, the assistant and a toast, and photographing the frames.
