/**
 * Self check-in's rules, where a unit test can hold them.
 *
 * The database is the authority (`tests/db/checkin.test.ts` runs it); these
 * pin the mirror the page uses — how a name is folded and matched — and the
 * words a student reads, including the one that must not tell a stranger
 * whether somebody goes to the school.
 */

import { describe, expect, it } from 'vitest';
import {
  asksFor,
  checkinFromJson,
  checkinMessage,
  foldId,
  foldName,
  inputProblem,
  longDate,
  nameMatches,
  posterInstruction,
  publicCheckinFromJson,
  shortLink,
} from '../src/lib/domain/checkin';

describe('folding a name', () => {
  it('takes out case, accents, apostrophes and spacing', () => {
    expect(foldName('  José   O’Neil ')).toBe('jose oneil');
    expect(foldName("JOSE O'NEIL")).toBe('jose oneil');
    expect(foldName('Zoë')).toBe('zoe');
    expect(foldName('Mary-Jane St. John')).toBe('mary jane st john');
    expect(foldName('Okonkwo, Nia')).toBe('okonkwo nia');
    expect(foldName('Nguyễn')).toBe('nguyen');
    expect(foldName('')).toBe('');
    expect(foldName('---')).toBe('');
  });

  it('reads an OSIS without its spaces', () => {
    expect(foldId(' 2300 2004 9 ')).toBe('230020049');
    expect(foldId('T.Rivera')).toBe('t.rivera');
  });
});

describe('matching a name', () => {
  const nia = { displayName: 'Nia Okonkwo', firstName: 'Nia', lastName: 'Okonkwo' };

  it('matches the display name either way round and the first and last name on file', () => {
    expect(nameMatches(nia, 'nia', 'OKONKWO')).toBe(true);
    expect(nameMatches({ displayName: 'Okonkwo, Nia' }, 'Nia', 'Okonkwo')).toBe(true);
    expect(nameMatches({ displayName: 'Nia A. Okonkwo', firstName: 'Nia', lastName: 'Okonkwo' }, 'Nia', 'Okonkwo')).toBe(true);
    expect(nameMatches({ displayName: 'Amara Grace Bello', firstName: 'Amara Grace', lastName: 'Bello' }, 'Amara', 'Bello')).toBe(true);
    expect(nameMatches({ displayName: 'José O’Neil', firstName: 'José', lastName: "O'Neil" }, 'jose', 'oneil')).toBe(true);
  });

  it('does not match half a name, or a different person', () => {
    expect(nameMatches(nia, 'Nia', '')).toBe(false);
    expect(nameMatches(nia, '', 'Okonkwo')).toBe(false);
    expect(nameMatches(nia, 'Ni', 'Okonkwo')).toBe(false);
    expect(nameMatches(nia, 'Nia', 'Okonkwo-Bello')).toBe(false);
    expect(nameMatches({ displayName: 'Grace Bello', firstName: 'Grace', lastName: 'Bello' }, 'Amara', 'Bello')).toBe(false);
  });
});

describe('what the page asks for', () => {
  it('shows the boxes each setting needs, and says what is missing', () => {
    expect(asksFor('osis')).toEqual({ osis: true, name: false });
    expect(asksFor('name')).toEqual({ osis: false, name: true });
    expect(asksFor('both')).toEqual({ osis: true, name: true });
    expect(asksFor('either')).toEqual({ osis: false, name: true });

    const empty = { osis: '', first: '', last: '' };
    expect(inputProblem('name', empty, 'name')).toBe('Enter your first and last name.');
    expect(inputProblem('name', { ...empty, first: 'Nia' }, 'name')).toBe('Enter your last name.');
    expect(inputProblem('osis', { ...empty, first: 'Nia', last: 'O' }, 'name')).toBe('Enter your OSIS.');
    expect(inputProblem('either', { ...empty, osis: '123' }, 'osis')).toBeNull();
    expect(inputProblem('either', { ...empty, osis: '123' }, 'name')).toBe('Enter your first and last name.');
    expect(inputProblem('both', { osis: '1', first: 'a', last: 'b' }, 'name')).toBeNull();
    expect(inputProblem('both', { osis: '', first: 'a', last: 'b' }, 'name')).toBe('Enter your OSIS.');
  });
});

describe('what the page says', () => {
  it('says a name nobody has and a name not on this list the same way', () => {
    const line = checkinMessage('no_match', { identity: 'either', groupName: 'SkillsUSA', mode: 'name' });
    expect(line).toBe('That name is not on the list for SkillsUSA. Check the spelling, or use your OSIS.');
    expect(line).not.toMatch(/directory|school|exist/i);
  });

  it('asks for the OSIS when a name is shared, unless the setting takes names only', () => {
    expect(checkinMessage('ambiguous', { identity: 'either', groupName: '', mode: 'name' })).toContain('Add your OSIS');
    expect(checkinMessage('ambiguous', { identity: 'name', groupName: '', mode: 'name' })).toContain('Ask an officer');
  });

  it('keeps to the voice: no exclamation marks, no apologies, short lines', () => {
    const reasons = ['missing', 'closed', 'early', 'ended', 'incomplete', 'no_match', 'ambiguous', 'throttled', 'error'] as const;
    for (const identity of ['osis', 'name', 'either', 'both'] as const) {
      for (const reason of reasons) {
        const line = checkinMessage(reason, { identity, groupName: 'SkillsUSA', mode: 'osis' });
        expect(line).not.toContain('!');
        expect(line).not.toMatch(/sorry/i);
        expect(line.length).toBeLessThanOrEqual(100);
      }
      expect(posterInstruction(identity)).not.toContain('!');
    }
  });

  it('writes the day and the link the way a poster prints them', () => {
    expect(longDate('2026-10-02')).toBe('Friday, October 2');
    expect(longDate('not a day')).toBe('not a day');
    expect(shortLink('https://helpdesk.edison.example/c/k3x9q2mfab7p')).toBe('helpdesk.edison.example/c/k3x9q2mfab7p');
  });
});

describe('reading the database', () => {
  it('maps the settings and the public view, and refuses what is not one', () => {
    expect(
      checkinFromJson({
        event_id: 'e1',
        slug: 'k3x9q2mfab7p',
        is_open: true,
        identity: 'both',
        walk_ins: true,
        state: 'early',
        held_on: '2026-10-02',
        present_count: 3,
        self_count: 2,
        member_count: 20,
      }),
    ).toEqual({
      eventId: 'e1',
      slug: 'k3x9q2mfab7p',
      isOpen: true,
      identity: 'both',
      walkIns: true,
      state: 'early',
      heldOn: '2026-10-02',
      presentCount: 3,
      selfCount: 2,
      memberCount: 20,
    });
    expect(checkinFromJson(null)).toBeNull();
    expect(checkinFromJson({ slug: 1 })).toBeNull();
    expect(publicCheckinFromJson({ slug: 'k3x9q2mfab7p', identity: 'face', state: 'wide open' })).toMatchObject({
      identity: 'either',
      state: 'closed',
    });
  });
});
