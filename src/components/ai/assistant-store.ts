'use client';

/**
 * What the rest of the shell may know about the assistant panel.
 *
 * The panel and the top-bar toggle are mounted in different places and must
 * not depend on each other's position in the tree, so they meet here: a tiny
 * external store the panel writes and the toggle reads. Opening is a window
 * event rather than a store write, because the settings screen and the
 * command palette already speak that event and they carry a payload (a prompt
 * to send, a section to show) that is a request, not state.
 */

import { useSyncExternalStore } from 'react';
import type { Moment } from './orb-state';

export interface AssistantSnapshot {
  open: boolean;
  /** What the assistant is doing, for the toggle's small orb while the panel is closed. */
  moment: Moment;
  /** A request is in flight. */
  busy: boolean;
  /** A reply finished while the panel was closed and has not been seen. */
  unread: boolean;
}

const INITIAL: AssistantSnapshot = { open: false, moment: 'idle', busy: false, unread: false };

let snapshot: AssistantSnapshot = INITIAL;
const listeners = new Set<() => void>();

export function setAssistant(patch: Partial<AssistantSnapshot>): void {
  const next = { ...snapshot, ...patch };
  if (
    next.open === snapshot.open &&
    next.moment === snapshot.moment &&
    next.busy === snapshot.busy &&
    next.unread === snapshot.unread
  ) {
    return;
  }
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): AssistantSnapshot {
  return snapshot;
}

function getServerSnapshot(): AssistantSnapshot {
  return INITIAL;
}

export function useAssistant(): AssistantSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Dispatched on `window` to open the assistant panel, wherever it lives. */
export const OPEN_ASSISTANT_EVENT = 'edison:open-assistant';

export interface OpenAssistantDetail {
  /** Send this text as soon as the panel is open. */
  prompt?: string;
  /** Open on the ChatGPT connection step. */
  section?: 'connect';
  /** Close the panel if it is open, instead of opening it. */
  toggle?: boolean;
}

export function openAssistant(detail?: OpenAssistantDetail): void {
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT, { detail: detail ?? null }));
}

export function toggleAssistant(): void {
  openAssistant({ toggle: true });
}

/** Reads the event's payload defensively: other callers send `null`, a prompt, or nothing. */
export function readOpenDetail(event: Event): OpenAssistantDetail {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== 'object') return {};
  const record = detail as Record<string, unknown>;
  return {
    prompt: typeof record.prompt === 'string' && record.prompt.trim() !== '' ? record.prompt : undefined,
    section: record.section === 'connect' ? 'connect' : undefined,
    toggle: record.toggle === true,
  };
}
