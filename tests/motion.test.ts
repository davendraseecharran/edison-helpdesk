/**
 * Pure helpers behind the motion layer: the list stagger schedule and the
 * toast queue reducer. The React wrappers are thin and are checked visually
 * with Playwright; everything with an edge case worth naming lives here.
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AdminLoading from '../src/app/(app)/admin/loading';
import TicketLoading from '../src/app/(app)/tickets/[id]/loading';
import { STAGGER_CAP, STAGGER_STEP, staggerDelay } from '../src/components/ui/Motion';
import {
  TOAST_LIFETIME_MS,
  TOAST_LIMIT,
  initialToastState,
  nextDeadline,
  toastReducer,
  type ToastHold,
  type ToastState,
} from '../src/components/ui/toast';

describe('staggerDelay', () => {
  it('starts at zero and grows by one step per row', () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(1)).toBeCloseTo(STAGGER_STEP);
    expect(staggerDelay(3)).toBeCloseTo(3 * STAGGER_STEP);
  });

  it('uses a 20ms step and caps at twelve rows', () => {
    expect(STAGGER_STEP).toBe(0.02);
    expect(STAGGER_CAP).toBe(12);
  });

  it('stops growing past the cap so a long page settles as one group', () => {
    expect(staggerDelay(STAGGER_CAP)).toBeCloseTo(STAGGER_CAP * STAGGER_STEP);
    expect(staggerDelay(200)).toBeCloseTo(STAGGER_CAP * STAGGER_STEP);
  });

  it('treats a negative index as the first row', () => {
    expect(staggerDelay(-4)).toBe(0);
  });

  it('accepts a custom step and cap', () => {
    expect(staggerDelay(5, { step: 0.05, cap: 3 })).toBeCloseTo(0.15);
  });
});

function push(state: ToastState, kind: 'success' | 'error', text: string, now: number) {
  return toastReducer(state, { type: 'push', kind, text, now });
}

function hold(state: ToastState, by: ToastHold, toast: number, now: number) {
  return toastReducer(state, { type: 'hold', by, toast, now });
}

function release(state: ToastState, by: ToastHold, toast: number, now: number) {
  return toastReducer(state, { type: 'release', by, toast, now });
}

function dismiss(state: ToastState, id: number, now: number) {
  return toastReducer(state, { type: 'dismiss', id, now });
}

describe('toastReducer', () => {
  it('gives a success toast a five second deadline from the moment it is pushed', () => {
    const state = push(initialToastState, 'success', 'Ticket claimed', 1_000);
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]).toMatchObject({
      kind: 'success',
      text: 'Ticket claimed',
      deadline: 1_000 + TOAST_LIFETIME_MS,
    });
    expect(TOAST_LIFETIME_MS).toBe(5_000);
  });

  it('never gives an error toast a deadline', () => {
    const state = push(initialToastState, 'error', 'That change could not be saved.', 1_000);
    expect(state.toasts[0]).toMatchObject({ kind: 'error', deadline: null, remaining: null });
    expect(nextDeadline(state)).toBeNull();
    const later = toastReducer(state, { type: 'expire', now: 1_000_000 });
    expect(later.toasts).toHaveLength(1);
  });

  it('assigns increasing ids so React keys stay stable across pushes', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    state = push(state, 'success', 'Ticket claimed', 0);
    expect(state.toasts[0].id).toBeLessThan(state.toasts[1].id);
  });

  it('removes a toast whose deadline has passed and keeps the others', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    state = push(state, 'success', 'Ticket claimed', 2_000);
    state = toastReducer(state, { type: 'expire', now: TOAST_LIFETIME_MS });
    expect(state.toasts.map((toast) => toast.text)).toEqual(['Ticket claimed']);
    expect(nextDeadline(state)).toBe(2_000 + TOAST_LIFETIME_MS);
  });

  it('dismisses by id', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    state = push(state, 'error', 'Something failed', 0);
    const [first] = state.toasts;
    state = dismiss(state, first.id, 10);
    expect(state.toasts.map((toast) => toast.text)).toEqual(['Something failed']);
  });

  it('pauses the clock while a toast is hovered and resumes with the time left', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    const id = state.toasts[0].id;
    state = hold(state, 'hover', id, 1_500);
    expect(state.paused).toBe(true);
    expect(state.toasts[0].deadline).toBeNull();
    expect(state.toasts[0].remaining).toBe(TOAST_LIFETIME_MS - 1_500);
    expect(nextDeadline(state)).toBeNull();

    // Nothing expires while paused, however long the pointer rests there.
    state = toastReducer(state, { type: 'expire', now: 60_000 });
    expect(state.toasts).toHaveLength(1);

    state = release(state, 'hover', id, 60_000);
    expect(state.paused).toBe(false);
    expect(state.toasts[0].deadline).toBe(60_000 + TOAST_LIFETIME_MS - 1_500);
  });

  it('stays paused until both the pointer and keyboard focus have left', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    const id = state.toasts[0].id;
    state = hold(state, 'hover', id, 1_000);
    state = hold(state, 'focus', id, 2_000);
    state = release(state, 'hover', id, 3_000);
    expect(state.paused).toBe(true);
    expect(state.toasts[0].deadline).toBeNull();
    state = release(state, 'focus', id, 4_000);
    expect(state.paused).toBe(false);
    expect(state.toasts[0].deadline).toBe(4_000 + TOAST_LIFETIME_MS - 1_000);
  });

  it('pushes a toast while paused without a deadline until the hold is released', () => {
    let state = push(initialToastState, 'error', 'Failed', 0);
    const error = state.toasts[0].id;
    state = hold(state, 'hover', error, 0);
    state = push(state, 'success', 'Ticket claimed', 100);
    expect(state.toasts[1].deadline).toBeNull();
    expect(state.toasts[1].remaining).toBe(TOAST_LIFETIME_MS);
    state = release(state, 'hover', error, 400);
    expect(state.toasts[1].deadline).toBe(400 + TOAST_LIFETIME_MS);
  });

  it('is unchanged by a repeated hold or an unpaired release', () => {
    const running = push(initialToastState, 'success', 'Note added', 0);
    const id = running.toasts[0].id;
    expect(release(running, 'hover', id, 10)).toBe(running);
    const paused = hold(running, 'hover', id, 10);
    expect(hold(paused, 'hover', id, 20)).toBe(paused);
  });

  it('ignores a hold for a toast that is not on the stack', () => {
    const state = push(initialToastState, 'success', 'Note added', 0);
    expect(hold(state, 'focus', 99, 10)).toBe(state);
  });

  it('drops the hold of a dismissed toast and re-arms the survivors', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    state = push(state, 'success', 'Ticket claimed', 0);
    const [focused, other] = state.toasts;
    state = hold(state, 'focus', focused.id, 1_000);
    expect(state.toasts[1].deadline).toBeNull();

    // Closing the focused toast with its own button unmounts it; no blur ever
    // arrives, so the reducer must let go of the hold itself.
    state = dismiss(state, focused.id, 2_000);
    expect(state.paused).toBe(false);
    expect(state.holds).toEqual([]);
    expect(state.toasts.map((toast) => toast.id)).toEqual([other.id]);
    expect(state.toasts[0].deadline).toBe(2_000 + TOAST_LIFETIME_MS - 1_000);
    expect(nextDeadline(state)).toBe(2_000 + TOAST_LIFETIME_MS - 1_000);
  });

  it('keeps a hold from another toast when one is removed', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    state = push(state, 'success', 'Ticket claimed', 0);
    const [hovered, focused] = state.toasts;
    state = hold(state, 'hover', hovered.id, 1_000);
    state = hold(state, 'focus', focused.id, 1_500);

    state = dismiss(state, hovered.id, 2_000);
    expect(state.paused).toBe(true);
    expect(state.holds).toEqual([{ by: 'focus', toast: focused.id }]);
    expect(state.toasts[0].deadline).toBeNull();

    state = release(state, 'focus', focused.id, 3_000);
    expect(state.paused).toBe(false);
    expect(state.toasts[0].deadline).toBe(3_000 + TOAST_LIFETIME_MS - 1_000);
  });

  it('releases the hold of a toast the limit pushes out', () => {
    let state = push(initialToastState, 'success', 'First', 0);
    state = hold(state, 'hover', state.toasts[0].id, 0);
    state = push(state, 'success', 'Second', 100);
    state = push(state, 'success', 'Third', 200);
    state = push(state, 'success', 'Fourth', 300);
    expect(state.toasts.map((toast) => toast.text)).toEqual(['Second', 'Third', 'Fourth']);
    expect(state.paused).toBe(false);
    expect(state.toasts.map((toast) => toast.deadline)).toEqual([
      300 + TOAST_LIFETIME_MS,
      300 + TOAST_LIFETIME_MS,
      300 + TOAST_LIFETIME_MS,
    ]);
  });

  it('drops every hold once the stack is empty, so the next toast gets a clock', () => {
    let state = push(initialToastState, 'success', 'Note added', 0);
    const id = state.toasts[0].id;
    state = hold(state, 'hover', id, 100);
    state = dismiss(state, id, 150);
    expect(state.toasts).toHaveLength(0);
    expect(state.paused).toBe(false);
    state = push(state, 'success', 'Ticket claimed', 200);
    expect(state.toasts[0].deadline).toBe(200 + TOAST_LIFETIME_MS);
  });

  it('expires nothing when no deadline has passed and keeps the same state object', () => {
    const state = push(initialToastState, 'success', 'Note added', 0);
    expect(toastReducer(state, { type: 'expire', now: 10 })).toBe(state);
  });

  it('refreshes a repeated message instead of stacking a duplicate', () => {
    let state = push(initialToastState, 'success', 'Ticket claimed', 0);
    const id = state.toasts[0].id;
    state = push(state, 'success', 'Ticket claimed', 3_000);
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0].id).toBe(id);
    expect(state.toasts[0].deadline).toBe(3_000 + TOAST_LIFETIME_MS);
  });

  it('keeps the stack short by dropping the oldest success before any error', () => {
    let state = push(initialToastState, 'error', 'Failed once', 0);
    state = push(state, 'success', 'First', 0);
    state = push(state, 'success', 'Second', 0);
    state = push(state, 'success', 'Third', 0);
    expect(TOAST_LIMIT).toBe(3);
    expect(state.toasts).toHaveLength(TOAST_LIMIT);
    expect(state.toasts.map((toast) => toast.text)).toEqual(['Failed once', 'Second', 'Third']);
  });

  it('drops the oldest error only when the stack is nothing but errors', () => {
    let state = push(initialToastState, 'error', 'One', 0);
    state = push(state, 'error', 'Two', 0);
    state = push(state, 'error', 'Three', 0);
    state = push(state, 'error', 'Four', 0);
    expect(state.toasts.map((toast) => toast.text)).toEqual(['Two', 'Three', 'Four']);
  });

  it('reports the earliest deadline for scheduling one timer', () => {
    let state = push(initialToastState, 'success', 'Later', 4_000);
    state = push(state, 'success', 'Sooner', 1_000);
    state = push(state, 'error', 'Never', 0);
    expect(nextDeadline(state)).toBe(1_000 + TOAST_LIFETIME_MS);
    expect(nextDeadline(initialToastState)).toBeNull();
  });
});

describe('route skeletons', () => {
  it('mirrors the administration page: header without an action, three tabs, a callout and four panels', () => {
    const html = renderToStaticMarkup(h(AdminLoading));
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/class="tab"/g)).toHaveLength(3);
    expect(html.match(/class="callout"/g)).toHaveLength(1);
    expect(html.match(/class="panel"/g)).toHaveLength(4);
    // The header carries a title and a description bar only; no action placeholder.
    const header = html.slice(html.indexOf('class="page-header"'), html.indexOf('class="tabs"'));
    expect(header.match(/class="skeleton"/g)).toHaveLength(2);
  });

  it('reserves the phone action bar space under the ticket detail skeleton', () => {
    const html = renderToStaticMarkup(h(TicketLoading));
    expect(html).toContain('class="ticket"');
    expect(html.match(/class="ticket-bar-space"/g)).toHaveLength(1);
    expect(html.indexOf('ticket-bar-space')).toBeGreaterThan(html.indexOf('class="ticket-grid"'));
  });
});
