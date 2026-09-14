# The helpdesk's voice

One page. The copy rules live in `src/lib/voice/moments.ts` and are enforced by
`tests/voice.test.ts`; this is the reasoning behind them.

## Who the application sounds like

A calm senior technician who has seen this before. They name what happened, say
what it means for you, and stop. They have been at the desk long enough to know
that a cleared queue is worth a sentence and that claiming a ticket is not.

They are talking to a NetRider who opened this between classes and wants to be
done.

## What it never says

- Never an exclamation mark. Nothing that happens at a helpdesk is that exciting,
  and the one time something is, the exclamation mark will not help.
- Never an emoji in body copy. The palette is neutral and precise; a smiley in
  the middle of it reads as a different application.
- Never an apology. "Sorry, something went wrong" tells you nothing. "That did
  not go through. Nothing changed. Try again." tells you what state you are in.
- Never a compliment for doing the job. "Great work!" on the fortieth ticket of
  the day is an insult. A win is marked by naming the win, not by praising you.
- Never title case, never all caps, never a middle dot, never an arrow inside a
  sentence or on a button.
- Never a line longer than 70 characters. Past that it is documentation, and
  documentation belongs on a page you chose to open.

## Where character is allowed

Character costs attention, and attention is charged every time the line appears.
So it is spent only where the moment is rare and the line either saves effort or
marks something real:

| Moment | When | Why it earns a line |
| --- | --- | --- |
| `today.morning` / `today.afternoon` / `today.evening` | The Today screen, every visit | It is the first thing read; a greeting by name is what makes it *your* desk |
| `today.empty` | Nothing needs you | The most valuable state the application can report, and the easiest to under-sell |
| `queue.cleared` | The queue reaches zero while you are looking at it | A handful of times a term. Real work, finished |
| `ticket.resolved` | A ticket closes | Names what the close was worth rather than confirming a database write |
| `ticket.claimed` | A ticket is claimed | Deliberately flat. This happens all day; the line is one clause and never more |
| `device.returned` | A device comes back | Marks the shelf, which is the thing the inventory is actually about |
| `signin.first` | The first sign-in on this account, ever | Two lines: welcome, and the one keyboard shortcut worth knowing |
| `friday.afternoon` | Friday from noon | The one calendar fact that changes what you do next |
| `error.generic` | A change did not commit | Says what state the record is in, which is the only question |
| `assistant.idle` | The assistant panel's welcome | Rotates over what it could actually do today, from real counts |

Everything not in this table gets no voice at all. The hundred-a-day
interactions — moving down a list, opening a ticket, typing a filter — are
silent and instant.

## How a line is chosen

`voiceLine(moment, context)` is pure and deterministic. The context carries the
reader's first name, a subject (a ticket number, an asset tag), a real count, the
palette's keycap for this platform, and the school-local hour and weekday. The
hour and weekday move the variant through the day, so the same screen does not
read identically at 8am and at 4pm, and an explicit `seed` pins it where a value
must not change between renders.

Two rules matter more than the wording:

- **A line that names a value the screen does not have is never chosen.** Lines
  declare their placeholders; unsatisfiable ones are filtered out before the
  pick. There is no path to "0 tickets are open" on a screen that never counted.
- **The server and the browser choose the same line.** Nothing is random, so a
  hydration never rewrites a sentence under the reader.

## Motion, for the two moments that get it

`queue.cleared` and `ticket.resolved` may animate once: opacity and eight pixels
over 300ms on `--ease-out` (`.voice-mark` in `src/styles/voice.css`). Nothing
else in the voice moves. Under `prefers-reduced-motion` the line is simply
there.

The other signature is the bench lamp (`.boot-lamp`): one second at the start of
a session, the wordmark with `--edge-light` warming up behind it, then gone. It
is rendered by the authenticated layout, so it plays on a real page load and
never on an in-app navigation, and it is pure CSS so no failed script can leave
it on screen.
