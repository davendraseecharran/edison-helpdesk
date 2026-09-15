/**
 * Pure helpers behind the motion layer: the list stagger schedule and the four
 * rules a toast obeys. The React wrappers are thin and are checked visually
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
  toastDuration,
  toastKey,
  toastPosition,
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

/*
 * The stack, the clocks, the hover pause and the swipe are Sonner's, and are
 * its own to test. What is ours is the four rules in `ui/toast.ts`, which is
 * what a repeated message is, how long each kind lives, what a held clock
 * reads, and where the stack sits. These replace the reducer's tests: the
 * reducer is gone, and each behaviour it covered is named again here against
 * the rule that now produces it.
 */
describe('toast rules', () => {
  it('gives a success five seconds and an error no clock at all', () => {
    expect(toastDuration('success')).toBe(TOAST_LIFETIME_MS);
    expect(toastDuration('error')).toBe(Number.POSITIVE_INFINITY);
  });

  it('stops the clock of either kind while focus rests inside the toast', () => {
    expect(toastDuration('success', true)).toBe(Number.POSITIVE_INFINITY);
    expect(toastDuration('error', true)).toBe(Number.POSITIVE_INFINITY);
  });

  it('restores the five seconds when focus leaves a success', () => {
    expect(toastDuration('success', false)).toBe(TOAST_LIFETIME_MS);
  });

  it('gives the same message the same id, so a repeat refreshes rather than stacks', () => {
    expect(toastKey('success', 'Ticket claimed')).toBe(toastKey('success', 'Ticket claimed'));
  });

  it('separates two different messages, and a success from an error that reads the same', () => {
    expect(toastKey('success', 'Note added')).not.toBe(toastKey('success', 'Note removed'));
    expect(toastKey('success', 'Saved')).not.toBe(toastKey('error', 'Saved'));
  });

  it('keeps the stack to three, so a corner of messages is never a log', () => {
    expect(TOAST_LIMIT).toBe(3);
  });

  it('sits bottom-right where there is room and at the top where the tabs are', () => {
    expect(toastPosition(false)).toBe('bottom-right');
    expect(toastPosition(true)).toBe('top-center');
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
