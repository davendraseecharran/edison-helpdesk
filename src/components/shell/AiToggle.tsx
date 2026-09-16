'use client';

/**
 * The assistant's place in the top bar.
 *
 * The provider's mark, in the bar's own ink: the assistant runs on the
 * person's ChatGPT account, and this is the button that reaches it. While the
 * panel is closed and a reply is on its way the mark turns slowly, so the work
 * is visible from anywhere; when a reply finishes unseen, a dot waits until
 * the panel is opened. The orb stays inside the panel, where it is the
 * assistant's face during a conversation rather than a piece of chrome.
 *
 * Pressing it opens the panel, or closes it, and the panel hands focus back
 * here when it goes.
 */

import { useApplePlatform } from '@/components/ui/media';
import { Tooltip } from '@/components/ui/Tooltip';
import { AiMark } from '@/components/ai/AiMark';
import { Orb } from '@/components/ai/Orb';
import { toggleAssistant, useAssistant } from '@/components/ai/assistant-store';

export function AiToggle() {
  const { open, busy, unread, moment } = useAssistant();
  const apple = useApplePlatform();
  const waiting = !open && busy;
  const shortcut = apple ? '⌘J' : 'Ctrl+J';

  const label = open
    ? 'Close the assistant'
    : waiting
      ? 'Assistant is working. Open the assistant'
      : unread
        ? 'The assistant replied. Open the assistant'
        : 'Ask the assistant';

  return (
    <span className="ai-toggle-anchor">
      {/* The same words as the label, in the same tooltip as the two controls
          beside it. A native `title` was a second kind of tooltip in one bar,
          on its own clock and in its own colours, and it said something the
          label did not. */}
      <Tooltip
        label={
          <>
            {label}
            <kbd className="kbd">{shortcut}</kbd>
          </>
        }
      >
        <button
          type="button"
          className="btn btn-ghost btn-icon ai-toggle"
          aria-label={label}
          aria-pressed={open}
          data-ai-toggle
          onClick={toggleAssistant}
        >
          {/* At rest the drawn mark; while the assistant works with the panel
              closed, the same orb the panel shows, at 20 px, in its real state. */}
          {waiting ? <Orb moment={moment} size={20} /> : <AiMark size={20} state="still" />}
        </button>
      </Tooltip>
      {unread && !open ? <span className="ai-toggle-dot" aria-hidden="true" /> : null}
    </span>
  );
}
