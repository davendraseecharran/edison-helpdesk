/**
 * `actorLabelText`: the plain-text form of attribution, for the places that
 * cannot hold `ActorLabel`'s markup — a `title` attribute, an `aria-label`, a
 * notification row written by the database. Same wording as `ActorLabel`,
 * as a string.
 */

import { describe, expect, it } from 'vitest';

import { actorLabelText } from '../src/components/ui/ActorLabel';

describe('actorLabelText', () => {
  it('reads as the plain name when performed by a person', () => {
    expect(actorLabelText('Tanav', 'user')).toBe('Tanav');
  });

  it("reads as the person's AI when performed by AI", () => {
    expect(actorLabelText('Tanav', 'ai')).toBe("Tanav's AI");
  });

  it('keeps apostrophe-s after a name already ending in s', () => {
    expect(actorLabelText('Chris', 'ai')).toBe("Chris's AI");
  });

  it('never says "via AI"', () => {
    expect(actorLabelText('Chris', 'ai')).not.toContain('via AI');
  });

  it('treats a null via as the person, not the AI', () => {
    expect(actorLabelText('Tanav', null)).toBe('Tanav');
  });

  it('treats an undefined via as the person, not the AI', () => {
    expect(actorLabelText('Tanav')).toBe('Tanav');
  });
});
