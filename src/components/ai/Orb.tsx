'use client';

/**
 * The assistant's face.
 *
 * A `thinking-orbs` canvas with the moment-to-state map from `orb-state.ts`
 * applied, the theme pinned to what the provider has painted, and a soft
 * brass glow behind it that breathes on its own and swells with the
 * microphone level while listening. Under `prefers-reduced-motion` the
 * library draws one still frame and the glow holds still with it.
 *
 * Two sizes exist, and they are different drawings rather than one scaled:
 * 64 for the panel header and the welcome, 20 for anything inline (a chip,
 * the thinking line, the top-bar toggle).
 */

import { ThinkingOrb } from 'thinking-orbs';
import type { CSSProperties } from 'react';
import { useReducedMotion } from '@/components/ui/media';
import { useTheme } from '@/components/shell/ThemeProvider';
import { isBusyMoment, orbAppearanceFor, type Moment } from './orb-state';

export type OrbSize = 64 | 20;

/** What assistive technology hears for each moment. */
const LABELS: Record<Moment, string> = {
  idle: 'Assistant, ready',
  sending: 'Assistant, sending',
  reasoning: 'Assistant, thinking',
  writing: 'Assistant, writing a reply',
  reading: 'Assistant, looking something up',
  searching: 'Assistant, searching records',
  changing: 'Assistant, making a change',
  approval: 'Assistant, waiting for your decision',
  listening: 'Assistant, listening',
  speaking: 'Assistant, speaking',
  connecting: 'Assistant, waiting for ChatGPT',
  error: 'Assistant, the last request failed',
};

/**
 * Per-moment tempo on top of the library's tuning. Waiting states run a
 * touch slower so they read as patience, not effort; the working ones a
 * touch quicker so the panel feels busy while it is.
 */
const SPEED: Partial<Record<Moment, number>> = {
  idle: 0.85,
  approval: 0.85,
  sending: 1.1,
  reasoning: 1.15,
  writing: 1.1,
  searching: 1.2,
  listening: 1.1,
  speaking: 0.95,
};

export function Orb({
  moment,
  size = 64,
  level,
  className,
  label,
  style,
}: {
  moment: Moment;
  size?: OrbSize;
  /** Microphone or speech level, 0 to 1, while listening or speaking. */
  level?: number;
  className?: string;
  /** Overrides the per-moment accessible name. */
  label?: string;
  style?: CSSProperties;
}) {
  const { resolved } = useTheme();
  const reduced = useReducedMotion();
  const { state, paused, tone } = orbAppearanceFor(moment);
  const active = isBusyMoment(moment) || moment === 'listening' || moment === 'speaking' || moment === 'connecting';
  const clamped = level === undefined ? 0 : Math.min(1, Math.max(0, level));

  return (
    <span
      className={className ? `ai-orb ${className}` : 'ai-orb'}
      data-size={size}
      data-tone={tone}
      data-moment={moment}
      data-active={active || undefined}
      style={{ ...style, '--ai-level': clamped } as CSSProperties}
    >
      <ThinkingOrb
        className="ai-orb-canvas"
        state={state}
        size={size}
        theme={resolved}
        speed={SPEED[moment] ?? 1}
        paused={paused || reduced}
        aria-label={label ?? LABELS[moment]}
      />
    </span>
  );
}
