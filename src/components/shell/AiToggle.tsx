'use client';

/**
 * The assistant's place in the top bar.
 *
 * The orb, always: idle and calm when nothing is happening, and in whatever
 * state the panel would show while the assistant is working, so the work is
 * visible from anywhere. It used to be a sparkle, which is the icon every
 * generated product reaches for and says nothing about what this assistant is
 * doing. When a reply finishes unseen, a dot waits until the panel is opened.
 * Pressing it opens the panel, or closes it, and the panel hands focus back
 * here when it goes.
 */

import { useApplePlatform } from '@/components/ui/media';
import { Orb } from '@/components/ai/Orb';
import { toggleAssistant, useAssistant } from '@/components/ai/assistant-store';

export function AiToggle() {
  const { open, moment, busy, unread } = useAssistant();
  const apple = useApplePlatform();
  const showOrb = !open && busy;
  const shortcut = apple ? '⌘J' : 'Ctrl+J';

  const label = open
    ? 'Close the assistant'
    : showOrb
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
        <Orb size={20} moment={showOrb ? moment : 'idle'} label="" />
      </button>
      {unread && !open ? <span className="ai-toggle-dot" aria-hidden="true" /> : null}
    </span>
  );
}
