'use client';

/**
 * The assistant's place in the top bar.
 *
 * A sparkle when nothing is happening. While the panel is closed and the
 * assistant is working, the sparkle gives way to the small orb in whatever
 * state the panel would show, so the work is visible from anywhere; when a
 * reply finishes unseen, a brass dot waits until the panel is opened.
 * Pressing it opens the panel, or closes it, and the panel hands focus back
 * here when it goes.
 */

import { Sparkles } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
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
        {showOrb ? <Orb size={20} moment={moment} label="" /> : <Icon icon={Sparkles} size={18} />}
      </button>
      {unread && !open ? <span className="ai-toggle-dot" aria-hidden="true" /> : null}
    </span>
  );
}
