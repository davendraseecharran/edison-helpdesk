/**
 * The two guards in front of every single-key shortcut, and the attributes the
 * surfaces have to carry for those guards to see them.
 *
 * A bare `n` or `c` reaching a handler while somebody is typing is the whole
 * risk of single-key shortcuts, and the surfaces that type are not only the
 * fields: a Radix menu and a Radix select list both navigate with the arrows
 * and jump on a letter, and neither stops the character travelling on to the
 * document afterwards. So the guards are tested against the markup those
 * components actually produce, rather than against a description of it.
 *
 * There is no DOM in this suite, so the few pieces of one these two functions
 * touch are stubbed here: an element with attributes, and a `querySelector`
 * that understands the attribute selectors the guard is written with. Both
 * stubs are honest about what they support and fail loudly on anything else.
 */

import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isEditable, modalOpen } from '../src/components/ui/shortcuts';
import { DropdownMenuContent } from '../src/components/ui/shadcn/dropdown-menu';
import { Popover, PopoverContent } from '../src/components/ui/shadcn/popover';
import { SelectContent } from '../src/components/ui/shadcn/select';

/** One compound selector of nothing but attribute clauses, e.g. `[a][b="c"]`. */
function matchesCompound(attributes: Record<string, string>, compound: string): boolean {
  const clauses = compound.trim().match(/\[[^\]]+\]/g);
  if (!clauses || clauses.join('') !== compound.trim()) {
    throw new Error(`the stub only understands attribute selectors, not ${compound}`);
  }
  return clauses.every((clause) => {
    const body = clause.slice(1, -1);
    const equals = body.indexOf('=');
    if (equals === -1) return body in attributes;
    const name = body.slice(0, equals);
    const value = body.slice(equals + 1).replace(/^"(.*)"$/, '$1');
    return attributes[name] === value;
  });
}

function matchesSelector(attributes: Record<string, string>, selector: string): boolean {
  return selector.split(',').some((compound) => matchesCompound(attributes, compound));
}

/** The parts of an element the two guards read, and nothing else. */
class StubElement {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  readonly attributes: Record<string, string>;

  constructor(tagName: string, attributes: Record<string, string> = {}, editable = false) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.isContentEditable = editable;
  }

  closest(selector: string): StubElement | null {
    return matchesSelector(this.attributes, selector) ? this : null;
  }
}

/** A stub in the shape `isEditable` is handed one: the event's target. */
function focused(element: StubElement): EventTarget {
  return element as unknown as EventTarget;
}

/** Put `elements` on screen for the duration of one assertion. */
function withDocument(elements: StubElement[]): void {
  vi.stubGlobal('HTMLElement', StubElement);
  vi.stubGlobal('document', {
    querySelector: (selector: string) =>
      elements.find((element) => matchesSelector(element.attributes, selector)) ?? null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isEditable', () => {
  it('names the fields a letter would be typed into', () => {
    vi.stubGlobal('HTMLElement', StubElement);
    expect(isEditable(focused(new StubElement('INPUT')))).toBe(true);
    expect(isEditable(focused(new StubElement('TEXTAREA')))).toBe(true);
    expect(isEditable(focused(new StubElement('DIV', {}, true)))).toBe(true);
    expect(isEditable(focused(new StubElement('BUTTON')))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });

  it('counts a focused select trigger, which types ahead with its list still shut', () => {
    vi.stubGlobal('HTMLElement', StubElement);
    const trigger = new StubElement('BUTTON', { 'data-slot': 'select-trigger' });
    expect(isEditable(focused(trigger))).toBe(true);
  });
});

describe('modalOpen', () => {
  it('is false with nothing open', () => {
    withDocument([new StubElement('MAIN')]);
    expect(modalOpen()).toBe(false);
  });

  it('sees a modal dialog', () => {
    withDocument([new StubElement('DIV', { role: 'dialog', 'aria-modal': 'true' })]);
    expect(modalOpen()).toBe(true);
  });

  it('ignores a dialog that is not modal, such as the desktop assistant panel', () => {
    withDocument([new StubElement('DIV', { role: 'dialog' })]);
    expect(modalOpen()).toBe(false);
  });

  it('sees the surfaces that own the keyboard without being dialogs', () => {
    withDocument([new StubElement('DIV', { 'data-keyboard-owner': '' })]);
    expect(modalOpen()).toBe(true);
  });

  it('sees an open menu and an open select list, which is how they are marked', () => {
    withDocument([menuAttributes()]);
    expect(modalOpen()).toBe(true);
    withDocument([selectAttributes()]);
    expect(modalOpen()).toBe(true);
  });
});

/** The props our wrapper hands to the Radix content inside its portal. */
function contentProps(portal: ReactElement): Record<string, unknown> {
  const children = (portal.props as { children: unknown }).children;
  if (!isValidElement(children)) throw new Error('expected one Radix content inside the portal');
  return children.props as Record<string, unknown>;
}

function attributesOf(portal: ReactElement): StubElement {
  const props = contentProps(portal);
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === 'string' && (name.startsWith('data-') || name.startsWith('aria-'))) {
      attributes[name] = value;
    }
  }
  return new StubElement('DIV', attributes);
}

function menuAttributes(): StubElement {
  return attributesOf(DropdownMenuContent({}) as ReactElement);
}

function selectAttributes(): StubElement {
  return attributesOf(SelectContent({ children: null }) as ReactElement);
}

describe('the surfaces the guard has to see', () => {
  it('marks an open menu as the keyboard owner', () => {
    expect(contentProps(DropdownMenuContent({}) as ReactElement)).toHaveProperty(
      'data-keyboard-owner',
      '',
    );
  });

  it('marks an open select list as the keyboard owner', () => {
    expect(contentProps(SelectContent({ children: null }) as ReactElement)).toHaveProperty(
      'data-keyboard-owner',
      '',
    );
  });

  it('marks a popover as the keyboard owner', () => {
    expect(contentProps(PopoverContent({}) as ReactElement)).toHaveProperty(
      'data-keyboard-owner',
      '',
    );
  });
});

describe('Popover', () => {
  it('is modal unless a caller says otherwise, so focus is trapped and the page behind is inert', () => {
    const root = Popover({ children: null }) as ReactElement;
    expect((root.props as { modal?: boolean }).modal).toBe(true);
  });

  it('still lets a caller ask for a non-modal one', () => {
    const root = Popover({ children: null, modal: false }) as ReactElement;
    expect((root.props as { modal?: boolean }).modal).toBe(false);
  });
});
