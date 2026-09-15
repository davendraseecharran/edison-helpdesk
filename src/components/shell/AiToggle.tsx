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
import { AiMark } from '@/components/ai/AiMark';
import { toggleAssistant, useAssistant } from '@/components/ai/assistant-store';

export function AiToggle() {
  const { open, busy, unread } = useAssistant();
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
      <button
        type="button"
        className="btn btn-ghost btn-icon ai-toggle"
        aria-label={label}
        aria-pressed={open}
        title={`Ask the assistant (${shortcut})`}
        data-ai-toggle
        onClick={toggleAssistant}
      >
        <AiMark size={20} state={waiting ? 'working' : 'still'} />
      </button>
      {unread && !open ? <span className="ai-toggle-dot" aria-hidden="true" /> : null}
    </span>
  );
}
