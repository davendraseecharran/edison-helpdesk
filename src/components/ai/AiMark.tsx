'use client';

/**
 * The provider's mark, where the chrome talks about the assistant.
 *
 * The assistant runs on the person's own ChatGPT account, so the thing the top
 * bar and the connect card show is OpenAI's mark — mono, in `currentColor`, so
 * it takes the ink of whatever it sits in and never becomes a second brand
 * colour on the screen. It replaced a sparkle, which is the icon every
 * generated product reaches for and which says nothing about what is behind
 * the button.
 *
 * The orb stays inside the panel. It is the assistant's face while it is
 * working — streaming, calling a tool, listening — and those are conversation
 * states, not chrome.
 *
 * `waiting` turns on the one animation: a six-second rotation with a breath of
 * opacity under it, transform and opacity only, so it composites on its own
 * layer and costs nothing. It runs while a reply is on its way or while the
 * connection is being made, and is paused — not removed — the rest of the
 * time, which is what keeps the mark from jumping when it starts again.
 */

import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono';

export function AiMark({
  size = 20,
  waiting = false,
  className,
}: {
  /** 20 in the top bar, 40 in the connect card. */
  size?: number;
  /** A reply is on its way, or the connection is being made. */
  waiting?: boolean;
  className?: string;
}) {
  return (
    <span
      className={className ? `ai-mark ${className}` : 'ai-mark'}
      data-waiting={waiting || undefined}
      aria-hidden="true"
    >
      <OpenAIMono size={size} />
    </span>
  );
}
