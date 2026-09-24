/**
 * What a beep sounds and feels like.
 *
 * A NetRider loading a cart is looking at the laptop in their hand, not the
 * screen, so every scan answers in sound as well: a short high tick when the
 * machine changed, a softer one when it was already done, and a low two-note
 * tone when nothing matched. On a phone the tick is also felt. All three are
 * drawn by WebAudio on the spot — no files, nothing to load — and are quiet
 * enough for a classroom.
 *
 * The sound can be switched off; the choice is this browser's, kept in
 * localStorage, because it belongs to the room somebody is standing in rather
 * than to their account.
 *
 * Browser-only. Every function tolerates a browser with no audio at all.
 */

export const SOUND_KEY = 'edison-workflow-sound';

export function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Session-only fallback for a browser that refuses storage. */
let unstored: boolean | null = null;
const listeners = new Set<() => void>();

export function writeSoundPreference(on: boolean): void {
  unstored = on;
  try {
    window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // A private window that refuses storage keeps the choice for this page.
  }
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: the switch, read without an effect. */
export function subscribeSoundPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function soundPreferenceSnapshot(): boolean {
  return unstored ?? readSoundPreference();
}

type AudioContextConstructor = new () => AudioContext;

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Constructor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!Constructor) return null;
  try {
    context ??= new Constructor();
    // A context made before the first tap starts suspended; the scan that is
    // playing this sound came from a key press or a tap, which resumes it.
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

/** One short note with a fast attack and an exponential tail. */
function note(ctx: AudioContext, frequency: number, start: number, length: number, peak: number, type: OscillatorType): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
}

export type Feedback = 'done' | 'skipped' | 'error';

/**
 * The sound, and on a touch screen the buzz. `sound` is the person's switch
 * for the speaker only: a phone in a pocket-sized hand is felt either way, and
 * the buzz is what somebody who muted a classroom still wants.
 */
export function feedback(kind: Feedback, sound: boolean): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse && kind !== 'skipped') navigator.vibrate(kind === 'error' ? [20, 60, 20] : 15);
  }
  if (!sound) return;
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (kind === 'done') note(ctx, 1760, now, 0.06, 0.07, 'sine');
  else if (kind === 'skipped') note(ctx, 1175, now, 0.05, 0.035, 'sine');
  else {
    note(ctx, 330, now, 0.1, 0.06, 'triangle');
    note(ctx, 247, now + 0.11, 0.14, 0.06, 'triangle');
  }
}
