/**
 * What the orb shows for each moment of the assistant's life.
 *
 * The map is Addendum 3 of the plan, confirmed by the user, and this module is
 * the whole of it: pure, tested, and the only place a moment turns into one of
 * the library's nine animations. Components describe WHAT is happening
 * (`moment`); nothing outside this file chooses HOW that looks.
 */

import type { OrbState } from 'thinking-orbs';

export type { OrbState };

/** A thing the assistant can be doing, as the panel sees it. */
export type Moment =
  /** Nothing in flight; the welcome screen, or a finished reply. */
  | 'idle'
  /** A message has gone up and the first token has not come back. */
  | 'sending'
  /** The reasoning summary is streaming. */
  | 'reasoning'
  /** The reply text is streaming. */
  | 'writing'
  /** A read tool is running. */
  | 'reading'
  /** The search tool is running. */
  | 'searching'
  /** A write tool is running. */
  | 'changing'
  /** A write is waiting for the person to approve or reject it. */
  | 'approval'
  /** The microphone is open. */
  | 'listening'
  /** The reply is being read aloud. */
  | 'speaking'
  /** The ChatGPT device pairing is waiting on the browser tab. */
  | 'connecting'
  /** A phone-scanner pairing dialog is waiting for the first scan. */
  | 'pairing'
  /** The last turn failed. */
  | 'error';

export const MOMENTS: readonly Moment[] = [
  'idle',
  'sending',
  'reasoning',
  'writing',
  'reading',
  'searching',
  'changing',
  'approval',
  'listening',
  'speaking',
  'connecting',
  'pairing',
  'error',
];

const STATE_FOR: Record<Moment, OrbState> = {
  idle: 'weaving',
  sending: 'breathing',
  reasoning: 'solving',
  writing: 'composing',
  reading: 'working',
  searching: 'searching',
  changing: 'connecting',
  approval: 'weaving',
  listening: 'listening',
  speaking: 'listening',
  connecting: 'shaping',
  // The same animation as the ChatGPT pairing, and for the same reason: two
  // devices are being introduced to each other and neither has spoken yet.
  pairing: 'shaping',
  // Frozen (see `orbAppearanceFor`): a still ring, tinted, reads as "stopped".
  error: 'breathing',
};

export function orbStateFor(moment: Moment): OrbState {
  return STATE_FOR[moment];
}

export interface OrbAppearance {
  state: OrbState;
  /** Frozen on its current frame. Also true under reduced motion, decided by the component. */
  paused: boolean;
  /** `bad` tints the orb with the error colour. */
  tone: 'ink' | 'bad';
}

export function orbAppearanceFor(moment: Moment): OrbAppearance {
  return {
    state: orbStateFor(moment),
    paused: moment === 'error',
    tone: moment === 'error' ? 'bad' : 'ink',
  };
}

/**
 * The moment a running tool puts the panel in, from its name alone.
 *
 * The backend classifies tools properly (`isWriteTool` in `lib/ai/tools.ts`),
 * but that module carries every tool's schema and executor and has no place
 * in the browser bundle. Every read tool is named `get_…`, `list_…` or
 * `search_records`, and the unit test pins that convention.
 */
export function momentForTool(name: string): Extract<Moment, 'reading' | 'searching' | 'changing'> {
  if (name === 'search_records') return 'searching';
  if (/^(get|list)_/.test(name)) return 'reading';
  return 'changing';
}

/** Whether the assistant is doing work on the person's behalf right now. */
export function isBusyMoment(moment: Moment): boolean {
  return (
    moment === 'sending' ||
    moment === 'reasoning' ||
    moment === 'writing' ||
    moment === 'reading' ||
    moment === 'searching' ||
    moment === 'changing'
  );
}
