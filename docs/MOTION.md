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
| Buttons, rail items, table rows, menu items, tabs, segmented options, Today's rows, saved-view chips, the lookup trigger, the palette's input row, the assistant's example chips | pointer enters or leaves | `background-color`, `color`, `border-color`, `box-shadow` | 150 ms (`--dur-hover`) | `ease` | colour changes, no transition |
| Any pressable (`.btn`, `.pressable`) | pointer down | `scale` 1 → 0.98 | 120 ms (`--dur-press`) | `ease-out` | no scale |
| Menus, selects and popovers | open | `opacity` 0 → 1, `scale` 0.97 → 1 from the corner Radix measured the surface into (`--radix-popper-transform-origin`) | 200 ms (`--dur-surface`) | `--ease-out` | opacity only |
| Menus and popovers | close | `opacity`, `scale` | 120 ms (`--dur-press`) | `--ease-out` | opacity only |
| A select's list | close | **none** — it is removed. Radix's Select takes the function-child form of `Presence`, which unmounts without waiting for an animation, so the list has no exit to play | 0 | — | — |
| Select's chevron | the list opens | `rotate` 0 → 180° | 200 ms | `--ease-out` | no rotation |
| Tooltips | a pointer rests on an icon-only control | `opacity`, `scale` 0.97 → 1 from the trigger | 150 ms, after a 400 ms wait that the next tooltip within 300 ms skips | `--ease-out` | opacity only |
| Tooltips | the pointer leaves | `opacity`, `scale` | 120 ms, no delay | `--ease-out` | opacity only |
| Dialogs | open | `opacity`, `scale` 0.98 → 1, centred | 200 ms (`--dur-surface`) | `--ease-out` | none |
| Command palette (desktop) | open | `opacity` 0 → 1, `translateY` −48px → 0, overshooting by about twelve pixels, back by three, and settling: the surface is caught, not delivered | ~340 ms spring, bounce 0.6 (`DROP`) | spring | none |
| Command palette (desktop) | close | `opacity` 1 → 0, `translateY` 0 → −8px: a slight lift | 120 ms (`--dur-press`) | `easeOut` | none |
| Dialogs | close | `opacity`, `scale` | 120 ms (`--dur-press`) | `--ease-out` | none |
| Scrim behind any modal surface | open | `opacity`; the ground is `--scrim` with `backdrop-filter: blur(12px) saturate(120%)` | 200 ms | `--ease-out` | opacity only |
| Drawers (phone bottom sheets) | open | `translateY(100% → 0)`, then the finger | vaul's own | vaul's own | none |
| Drawers | drag | follows the pointer, damped past the boundary; released above the velocity threshold it dismisses, below it returns | — | — | drag still works; nothing else moves |
| The content column | the path changes (not a search or filter, which change only the query) | `opacity` 0.35 → 1 on `<main>`; opacity only, so the fixed selection bar and sticky filter bar keep their containing block | 180 ms | `cubic-bezier(0.23, 1, 0.32, 1)` | none |
| Checkboxes (`.row-check`, `.check`, `.setting-choice`) | ticked | box fills with ink; the tick draws left to right (`clip-path`); press `scale` 0.9 | 180 ms tick, 150 ms fill | `--ease-out` | fill only |
| Selection count | the number changes | old digit leaves up, new one rises (8px) | 120 ms (`EASE_OUT_FAST`) | easeOut | swap, no movement |
| Phone filters | Filters pressed | the folded selects fade in, 4px down | 200 ms (`--dur-surface`) | `--ease-out` | none |
| Sheets (desktop, from the right) | open | `translate: 100% → 0`, no fade | 200 ms (`--dur-surface`) | `--ease-out` | none |
| Sheets (desktop, from the right) | close | `translate: 0 → 100%` | 120 ms (`--dur-press`) | `--ease-out` | none |
| Intake's "More details" | opened or closed | **none** for the region — it is as tall as the page, opened rarely, and its state is remembered per account, so the reflow is a transition almost nobody sees twice. Its chevron turns: `rotate` 0 → 180° | 200 ms on the chevron | `--ease-out` | no rotation |
| Intake's "Opened" and "Resolved" moments | pressed | the popover is a menu surface and opens like one (`opacity`, `scale` 0.97 → 1 from the trigger); the chevron turns `rotate` 0 → 180°. "Already resolved" reveals its section with **none**: it is one press away from Create and a section sliding in under the finger would move the button | 200 ms (`--dur-surface`) | `--ease-out` | opacity only, no rotation |
| Import from a spreadsheet: the paste box | a file is held over it | `border-color`, `background-color` | 150 ms (`--dur-hover`) | `ease` | colour, no transition |
| Palette selection | arrow key | **none** | 0 | — | — |
| Assistant composer | panel opens | one border-beam lap | 3 s, once | linear | not rendered |
| Assistant mark (top bar, connect card) | a reply is on its way | `transform: rotate`, `opacity` 1 → 0.55 → 1 | 6 s turn, 2.4 s breath | `linear`, `ease-in-out` | static, held dim |
| Assistant orb (in panel) | conversation state | canvas, per `orb-state.ts` | per state | per state | one still frame |
| Assistant panel | a question handed in from the palette or Settings | the panel opens on the sending mark alone; the first turn takes its place. The welcome (mark and example chips) is never shown for a prompt that is already on its way, so nothing flashes between the slide-in and the conversation. Not connected: the text lands in the composer and the connect card rises in (`opacity`, `translateY` 8px → 0) while the welcome slides to its new centre (`layout="position"`) | 200 ms (`--dur-surface`); the slide is `SPRING` | `--ease-out` | card appears, welcome jumps |
| Assistant welcome mark | the panel opens, or a new conversation starts | the dotted mark, drawn on its own clock (`MarkCloud`): opens on the assembled logo, holds there with every dot in place, then plays one of the account's welcome effects from that frame; a different one each time when more than one is ticked | 1 s hold, then the effect's own cycle | the effect's own | the assembled mark, still |
| Selection bar (devices) | the first row of a selection is ticked | `opacity` 0 → 1, `translateY` 8px → 0 | 200 ms (`--dur-surface`) | `--ease-out` | none |
| Toasts | arrive | `opacity`, `transform` from beyond the edge the stack sits on | 400 ms, Sonner's | `cubic-bezier(.21,1.02,.73,1)`, Sonner's | none: Sonner drops every transition under reduced motion |
| Toasts | leave | `opacity`, `transform` back past the edge | 200 ms, Sonner's | `cubic-bezier(.06,.71,.55,1)`, Sonner's | none |
| Toast stack | the pointer enters, or one is dismissed | the stack expands and the survivors take their new places | 400 ms, Sonner's | Sonner's | none |
| Toast clock | the pointer rests on one, focus lands inside it, or the tab goes to the background | **stops**, and resumes with the time that was left | — | — | same |
| Toasts | a swipe away from the edge the stack sits on | follows the finger; past the threshold it goes | Sonner's | Sonner's | same |
| Icon swaps (`IconSwap`) | the icon's meaning changes | `opacity`, `scale` 0.25 → 1, `blur(4px → 0)` | 300 ms | spring, no bounce | swap, no animation |
| Today's list | first paint only | `opacity`, `translateY` staggered 20 ms a row, capped at 12 | 300 ms total | `easeOut` | no entrance |
| Every other list | navigation | **none** | 0 | — | — |
| Analytics charts (`/analytics`) | first paint only; the page is opened a few times a term | columns and bars grow from their baseline (`transform: scaleY` or `scaleX` 0 → 1, `transform-box: fill-box`), the backlog line and the sparklines are revealed from the left by a clip that widens (`transform: scaleX` 0 → 1 on a `clipPath` rect; a dash over `pathLength` leaves gaps under a non-scaling stroke in a stretched viewBox), the donut's arcs sweep open (`stroke-dasharray` from empty to their share), heat rows and area washes fade in | 300 ms, staggered 8–60 ms a mark by chart and capped at 240 ms, so sixty columns finish with seven | `--ease-out` | none: every keyframe runs from a start state to the mark's own resting style, so with animations off each mark is already drawn |
| Analytics period control | a period is chosen | the pill moves at once (optimistic) and the control dims to 0.7 while the new page streams | `--dur-press` on the dim; the pill is the segmented control's own | `ease-out` | the pill jumps; the dim is opacity |
| Analytics column slots and heat cells | pointer rests on a slot or cell | slot: the hit area behind the columns fills `--surface-3`; cell: a 1.5px `--ink` outline | 150 ms (`--dur-hover`) on the slot; none on the cell | `ease` | colour only |
| Skeleton → content | the stream lands | content replaces the skeleton in place, no layout shift | 120 ms | `easeOut` | same |
| Switch | pressed | `transform` on the thumb, `background-color` on the track | 120 ms | `ease` | colour only |
| Segmented controls, everywhere: reasoning level, theme, Gmail links, students or staff, notification and audit filters | a choice is picked | the pill's two edges, `left` and `right`, on different clocks under an SVG goo filter, so it stretches between options and snaps shut | 240 ms leading edge, 420 ms trailing edge after 70 ms | `--ease-out` | the pill jumps, no filter |
| Sign-in mark (the bulb) | the page arrives | three strokes draw themselves (`stroke-dashoffset` 1 → 0 over `pathLength` 1): the globe, then the base, then the filament; the two words rise 8px out of a 3px blur; a halo behind the globe swells in and then breathes | globe 520 ms, base 320 ms from 180 ms, filament 600 ms from 300 ms, words 520 ms from 400 and 500 ms, halo 620 ms from 900 ms, breath 5.2 s | `--ease-out`, breath `ease-in-out` | everything already drawn, halo still |
| Sign-in mark | pointer rests on the wordmark | the halo scales 1 → 1.25 | 200 ms (`--dur-surface`) | `--ease-out` | none |
| Settings | arriving at a section link (`/settings#quick-tickets`) | the page scrolls to the section, which stops under the top bar (`scroll-margin-top`) | the browser's smooth scroll | — | jumps |
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

**One hover number, and it is the token.** The row above is every surface that
warms up under the pointer, and each of them reads `--dur-hover` rather than a
literal — five of them used to say 100 ms or 120 ms, which is how a table and
the row of chips above it came to warm up at different speeds. The only
literal durations left in the stylesheets are the seven that are deliberately
not transitions: the caret's blink, the spinner's revolution, the skeleton's
sweep, the orb's two breathing rates (4.4 s at rest, 2.4 s while working), the
orb canvas's 90 ms smoothing of a live microphone level, and the FAB label's
220 ms delay, which is measured against where the satellites are. Each says so
where it is written.

**A phone's chrome is not the same chrome.** The top bar keeps the wordmark and
loses what a finger cannot ask for: scanning moves into the More sheet where
its name is written out, because its name in the bar lives in a tooltip and a
tooltip has no touch equivalent. The toast stack moves to the top, below the
bar rather than over it, because the bottom edge belongs to the tabs and the
thumb.

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
| `Sheet` (bottom) | shadcn Drawer, on vaul | A bottom sheet is dragged. Ours slid on a spring and ignored the finger; vaul brings the drag, the velocity threshold, the boundary damping and the handle. Our header, body and footer markup, and our tokens throughout: `.sheet` and `.sheet-bottom` carry the surface, the hairline, the radius ladder and how tall it may grow, and the scrim is the same blur every modal surface gets. No Tailwind utility and no shadcn variable survives in the file. |
| `Sheet` (right), `Dialog` | shadcn Dialog, on Radix | A hand-rolled modal is the case where almost right is quietly wrong. A Tab handler is not a focus trap — it does nothing about a screen reader's own cursor on the page behind — and `overflow: hidden` loses the scroll position. Radix makes the rest of the document inert and hidden, keeps the position, returns focus to the opener, and owns Escape and the outside press. `data-autofocus` still names the control somebody came to use. |
| `Menu` | shadcn Dropdown Menu, on Radix | Typeahead, placement that flips or shifts instead of being clipped, a `transform-origin` measured from where the surface actually landed, and one highlight rule driven by `data-highlighted`, so pointer and keyboard agree and a tap cannot leave an item looking hovered. Every menu in the product is this one, the assistant's settings menu included; that one asks for `portal={false}` so it stays inside the panel's own focus trap. |
| `Select` | shadcn Select, on Radix | The one control a browser refuses to let a product design: the box, the chevron and the popup are the operating system's, so the same screen is three different widgets on three machines. Radix returns the typeahead, Home and End, the roving focus and the pointer-versus-keyboard rule for what counts as a selection, and lets the list be ours. The typeahead is why a focused trigger counts as editable to `shortcuts.ts`, and `name` submits through our own hidden input so a form gets the caller's value rather than the token the empty option is mapped to. |
| `Tooltip` | shadcn Tooltip, on Radix | The browser has `title` and it is unusable: about a second of wait, the operating system's font, no placement, it leaves on its own, and it never appears for the keyboard. One provider around the application is what lets the second tooltip skip the wait the first served. |
| Account panel, notifications list | shadcn Popover, on Radix | Two surfaces that each hand-wired a focus trap, an Escape listener, an outside press and an `aria-modal` the shortcut guard had to be told about. One contract instead — `modal` by default, because Radix's popover traps nothing unless it is asked and each of these is a panel somebody opened to work in — and `data-keyboard-owner` tells the guard the truth about a surface that is not a dialog. |
| Settings switch | shadcn Switch, on Radix | Ours was the right element (`role="switch"`) missing what a control collects in a form: the hidden input, the form association, and a `disabled` that is real. The in-flight state is not one of those: a focused element that becomes `disabled` loses focus to `<body>`, so a save in progress is `aria-disabled` and `aria-busy` with the press refused in the handler, and the keyboard stays where it was. |
| Toasts | Sonner | It stacks, lifts and expands under the pointer, stops every clock while the tab is hidden and resumes with the time that was left, takes a swipe with a velocity threshold, and survives a toast replaced mid-flight. The announcement is Sonner's too — every toast sits in its own `role="status" aria-live="polite"` list item, so ours carries no role of its own to be announced twice. Four rules stay ours in `ui/toast.ts`: five seconds for a success and never for an error, no clock while a message is being read (Sonner gives the pointer, `duration: Infinity` gives the keyboard), the same message twice is one message because the id is the message, and three at once. Every toast goes through `toast.custom`, so what is on screen is still our `.toast`. |
| Command palette | cmdk | Unchanged, and staying: the layout and the groups are the product's own; the drop on open is described above. |
| `Tabs` | ours | shadcn's are a tablist over panels; ours are links, so they work with the URL, the back button and middle-click. Radix here would cost the routing and buy nothing. |
| `Skeleton` | ours | shadcn's is a pulsing div. Ours carries the route-level parity the loading tests assert. |
| `Badge` | ours | A status chip with its own tone tokens, not a styled span. |
| `Button`, inputs, tables | ours | Our `variant/size/block/loading/icon` API and the optical centring that goes with it. |
| Date field | the browser | The one native control left, and kept deliberately. `type=date` types, arrows, takes Home and Page Up, speaks the reader's locale and knows what a month is; a hand-rolled calendar grid buys a nicer popup and pays for it in every one of those. What was not kept is how it looked: the picker button is a filled black glyph in both themes and a selected segment lights up in the operating system's blue, which is the one colour this palette does not contain. `components.css` replaces the button with our own calendar mark — a mask, so it recolours by state like every other icon rather than being a second asset — and gives the digits `--ink`, the separators a step back and the focused segment `--accent-soft`. Firefox and Safari expose no picker button, so there is nothing there to restyle and the field is the same box either way. |
| Separator | Radix, inside the menu and the select | The only place a rule that needs a role was ever wanted. shadcn's standalone Separator, Badge, Button, Skeleton, Tabs and ScrollArea files were deleted unused: nothing imported them and all of them still carried Tailwind utility strings, which the tokens rule forbids. |

## Verifying

`scripts/review-overhaul.cjs` asserts the invariants a screenshot cannot show:
no page scrolls sideways, no page logs a browser error, and never more than one
element wears the lamp. Motion itself is checked by eye at a tenth speed —
Playwright with `Animation.setPlaybackRate(0.1)` through CDP — opening the
palette, a menu, the assistant and a toast, and photographing the frames.
