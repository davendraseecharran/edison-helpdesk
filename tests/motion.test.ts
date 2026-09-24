/**
 * Pure helpers behind the motion layer: the list stagger schedule and the four
 * rules a toast obeys. The React wrappers are thin and are checked visually
 * with Playwright; everything with an edge case worth naming lives here.
 */

import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Sonner stands in, so the stack it owns stays its own business and what this
 * file can see is the wiring: which id a message is raised under, which
 * duration comes with it, and which of the product's rules reach the stack as
 * props. Everything else about a toast — the queue, the clocks, the swipe — is
 * the library's and is tested there.
 */
const sonner = vi.hoisted(() => ({
  custom: vi.fn(() => 'toast-id'),
  dismiss: vi.fn(),
  stack: { props: null as Record<string, unknown> | null },
}));

vi.mock('sonner', () => ({
  toast: { custom: sonner.custom, dismiss: sonner.dismiss },
  Toaster: (props: Record<string, unknown>) => {
    sonner.stack.props = props;
    return null;
  },
}));

import AdminLoading from '../src/app/(app)/admin/loading';
import TicketLoading from '../src/app/(app)/tickets/[id]/loading';
import { markJustResolved, ResolvedMark } from '../src/components/ticket/ResolvedMark';
import {
  CountSwap,
  DURATION,
  EASE_OUT,
  EASE_OUT_CSS,
  EASE_OUT_CURVE,
  EASE_OUT_FAST,
  SCRIM_IN,
  SCRIM_OUT,
  STAGGER_CAP,
  STAGGER_STEP,
  staggerDelay,
} from '../src/components/ui/Motion';
import { showToast, Toaster } from '../src/components/ui/shadcn/sonner';
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
 * its own to test. What is ours is the four rules in `ui/toast.ts` — what a
 * repeated message is, how long each kind lives, what a held clock reads, and
 * where the stack sits — and, just as much, whether those rules actually reach
 * the library. These replace the reducer's tests: the reducer is gone, and each
 * behaviour it covered is named again here against the rule that now produces
 * it and the call that now carries it.
 */

interface ToastHandlers {
  onFocus: () => void;
  onBlur: (event: {
    currentTarget: { contains: (node: unknown) => boolean };
    relatedTarget: unknown;
  }) => void;
  children: ReactElement[];
}

/** The last message raised: the options Sonner was handed, and what it renders. */
function lastToast(): { options: Record<string, unknown>; body: ReactElement } {
  const call = sonner.custom.mock.lastCall;
  if (!call) throw new Error('nothing was raised');
  const [render, options] = call as unknown as [
    (id: string | number) => ReactElement,
    Record<string, unknown>,
  ];
  return { options, body: render('toast-id') };
}

/**
 * The toast's own element, one step inside the element Sonner is handed.
 *
 * `toast.custom` is given `<ToastBody>`; the handlers under test are on the
 * `<div>` that component returns, and it is a plain function of its props.
 */
function lastToastBox(): ToastHandlers {
  const body = lastToast().body;
  const render = body.type as (props: unknown) => ReactElement;
  return render(body.props).props as unknown as ToastHandlers;
}

describe('toast rules', () => {
  it('gives a success five seconds and an error no clock at all', () => {
    expect(toastDuration('success')).toBe(TOAST_LIFETIME_MS);
    expect(toastDuration('error')).toBe(Number.POSITIVE_INFINITY);
  });

  it('stops the clock of either kind while focus rests inside the toast', () => {
    expect(toastDuration('success', true)).toBe(Number.POSITIVE_INFINITY);
    expect(toastDuration('error', true)).toBe(Number.POSITIVE_INFINITY);
  });

  it('separates two different messages, and a success from an error that reads the same', () => {
    expect(toastKey('success', 'Note added')).not.toBe(toastKey('success', 'Note removed'));
    expect(toastKey('success', 'Saved')).not.toBe(toastKey('error', 'Saved'));
  });

  it('sits bottom-right where there is room and at the top where the tabs are', () => {
    expect(toastPosition(false)).toBe('bottom-right');
    expect(toastPosition(true)).toBe('top-center');
  });
});

describe('raising a toast', () => {
  beforeEach(() => {
    sonner.custom.mockClear();
    sonner.dismiss.mockClear();
  });

  it('raises the message under its own id, with the life its kind is given', () => {
    showToast('success', 'Ticket claimed');
    const { options } = lastToast();
    expect(options.id).toBe(toastKey('success', 'Ticket claimed'));
    expect(options.duration).toBe(TOAST_LIFETIME_MS);
  });

  it('gives the same message the same id, so a repeat refreshes rather than stacks', () => {
    showToast('success', 'Ticket claimed');
    const first = lastToast().options.id;
    showToast('success', 'Ticket claimed');
    expect(lastToast().options.id).toBe(first);
    showToast('error', 'Ticket claimed');
    expect(lastToast().options.id).not.toBe(first);
  });

  it('leaves an error on screen with no clock at all', () => {
    showToast('error', 'Could not save that note.');
    expect(lastToast().options.duration).toBe(Number.POSITIVE_INFINITY);
  });

  it('renders the message, its stripe and a dismiss button, and no live region of its own', () => {
    showToast('error', 'Could not save that note.');
    const html = renderToStaticMarkup(lastToast().body);
    expect(html).toContain('class="toast toast-error"');
    expect(html).toContain('Could not save that note.');
    expect(html).toContain('aria-label="Dismiss message"');
    // Sonner's own <li> is the live region; a second one inside it is a
    // message a reader may announce twice.
    expect(html).not.toContain('role=');
  });

  it('stops the clock while focus rests inside, and starts it again when focus leaves', () => {
    showToast('success', 'Ticket claimed');
    const props = lastToastBox();

    props.onFocus();
    expect(lastToast().options.duration).toBe(Number.POSITIVE_INFINITY);
    // Under the same id, so the toast is updated in place rather than replaced.
    expect(lastToast().options.id).toBe(toastKey('success', 'Ticket claimed'));

    props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(lastToast().options.duration).toBe(TOAST_LIFETIME_MS);
  });

  it('keeps the clock stopped while focus only moves within the toast', () => {
    showToast('success', 'Ticket claimed');
    const props = lastToastBox();
    props.onFocus();
    sonner.custom.mockClear();
    props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
    expect(sonner.custom).not.toHaveBeenCalled();
  });

  it('dismisses the toast it was rendered for', () => {
    showToast('success', 'Ticket claimed');
    const dismiss = lastToastBox().children[1].props as { onClick: () => void };
    dismiss.onClick();
    expect(sonner.dismiss).toHaveBeenCalledWith('toast-id');
  });
});

describe('the stack', () => {
  it('carries the product rules to Sonner: three at once, and where they sit', () => {
    renderToStaticMarkup(h(Toaster));
    const props = sonner.stack.props;
    expect(props).not.toBeNull();
    expect(props?.visibleToasts).toBe(TOAST_LIMIT);
    expect(props?.position).toBe(toastPosition(false));
    expect(props?.toastOptions).toEqual({ unstyled: true });
  });
});

describe('route skeletons', () => {
  it('mirrors the administration page: header without an action, three tabs and four panels', () => {
    const html = renderToStaticMarkup(h(AdminLoading));
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/class="tab"/g)).toHaveLength(3);
    // No callout: the screen's banner said what the page header above it
    // already said, and the skeleton has to reserve what actually arrives.
    expect(html).not.toContain('class="callout"');
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

describe('one motion vocabulary', () => {
  it('names the same three durations as the stylesheet tokens', () => {
    // --dur-press, --dur-hover, --dur-surface in tokens.css.
    expect(DURATION.fast).toBe(0.12);
    expect(DURATION.hover).toBe(0.15);
    expect(DURATION.base).toBe(0.2);
  });

  it('runs every JS transition on the --ease-out control points', () => {
    expect(EASE_OUT.ease).toEqual(EASE_OUT_CURVE);
    expect(EASE_OUT_FAST.ease).toEqual(EASE_OUT_CURVE);
    expect(EASE_OUT_CSS).toBe(`cubic-bezier(${EASE_OUT_CURVE.join(', ')})`);
  });

  it('fades a scrim in with its surface and out faster than it came', () => {
    expect(SCRIM_IN.duration).toBe(DURATION.base);
    expect(SCRIM_OUT.duration).toBe(DURATION.fast);
  });
});

describe('earned moments', () => {
  it('reads a count once for assistive technology and hides the rolling digits', () => {
    const html = renderToStaticMarkup(h(CountSwap, { value: 7 }));
    expect(html).toContain('<span class="visually-hidden">7</span>');
    expect(html).toContain('aria-hidden="true"');
  });

  it('draws the resolved check only for a ticket resolved from this tab', () => {
    expect(renderToStaticMarkup(h(ResolvedMark, { ticketId: 't-1' }))).not.toContain('data-draw');
    markJustResolved('t-2');
    expect(renderToStaticMarkup(h(ResolvedMark, { ticketId: 't-2' }))).toContain('data-draw');
  });

  it('puts the skeleton settle inside every route skeleton', () => {
    const html = renderToStaticMarkup(h(AdminLoading));
    expect(html).toMatch(/aria-busy="true"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?<span hidden=""><\/span>/);
  });
});
