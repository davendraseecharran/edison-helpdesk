# The helpdesk's voice

One page. The copy rules live in `src/lib/voice/moments.ts` and are enforced by
`tests/voice.test.ts`; this is the reasoning behind them.

## Who the application sounds like

A calm senior NetRider who has seen this before. They name what happened, say
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
| `today.empty` | Nothing needs you | The most valuable state the application can report, and the easiest to under-sell. The one moment with a lighter second line: with nothing to do next, the desk may suggest a coffee |
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

`queue.cleared` and `ticket.resolved` are the two moments allowed to arrive
rather than appear. `queue.cleared` wears `.voice-mark` on Today: opacity and
eight pixels over 300ms on `--ease-out` (`src/styles/voice.css`).
`ticket.resolved` is a toast, so its entrance is the stack's own and it wears no
mark of its own. Nothing else in the voice moves — a device coming back is a
hundred-a-day action during a cart check-in and gets its line with no animation
at all. Under `prefers-reduced-motion` the line is simply there.

The other signature is the arrival (`.boot-lamp`, `BootLamp`): the first time
in a session an authenticated page loads — a fresh tab, or the navigation that
follows signing in — the sign-in screen's bulb is lit in the middle of the page
with "Edison Helpdesk" under it and the light passing across the words. It is
there only while that first page is actually loading and leaves the instant its
content is in; a page that is ready at once still gets about half a second, so
the mark never flashes. It carries no colour: ink, a halo of ink, and a band of
brighter ink. All of it is CSS and inline SVG, so it paints with the first HTML;
one line of script in the head can only ever suppress it (a reload later in the
same session), and an eight-second cap in CSS takes it away whatever is still
loading. Under `prefers-reduced-motion` it is the still wordmark for exactly as
long as the page takes, and nothing more.
