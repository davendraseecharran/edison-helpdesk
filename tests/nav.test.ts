import { describe, expect, it } from 'vitest';
import { navItems } from '../src/components/shell/RailNav';

const counts = { openQueue: 3, myTickets: 1, collaborating: 0, closed: 9, all: 13 };

describe('navItems', () => {
  it('gives NetRiders work and the directory but no admin group', () => {
    const items = navItems(['netrider'], counts);
    expect(items.map((i) => i.href)).toEqual([
      '/today',
      '/queue',
      '/my-tickets',
      '/collaborating',
      '/resolved',
      '/workflows',
      '/analytics',
      '/people',
      '/groups',
      '/forms',
      '/devices',
    ]);
    expect(items.find((i) => i.href === '/queue')?.count).toBe(3);
  });

  it('adds all tickets and administration for admins', () => {
    const items = navItems(['admin'], counts);
    expect(items.map((i) => i.href)).toContain('/all-tickets');
    expect(items.map((i) => i.href)).toContain('/admin');
    expect(items.find((i) => i.href === '/all-tickets')?.count).toBe(13);
  });

  it('keeps the admin group last and every item in a named group', () => {
    const items = navItems(['admin'], counts);
    const groups = items.map((i) => i.group);
    // Groups appear in rail order and never interleave.
    expect([...new Set(groups)]).toEqual(['Work', 'Directory', 'Admin']);
    expect(items.every((i) => i.label.length > 0 && i.icon)).toBe(true);
  });

  it('gives a skills officer the directory and no ticket route', () => {
    const items = navItems(['skills_officer'], counts);
    // The inventory is a read for them: the device screen refuses the editor,
    // and so does the database.
    expect(items.map((i) => i.href)).toEqual(['/people', '/groups', '/forms', '/devices']);
    // Nothing in the rail leads anywhere they would be turned away from.
    expect(items.some((i) => i.group === 'Work' || i.group === 'Admin')).toBe(false);
    expect(items.some((i) => i.href === '/insights')).toBe(false);
    expect(items.some((i) => i.href === '/today')).toBe(false);
  });

  it('adds rather than replaces when somebody holds two roles', () => {
    const items = navItems(['netrider', 'skills_officer'], counts);
    expect(items.map((i) => i.href)).toEqual(navItems(['netrider'], counts).map((i) => i.href));

    const both = navItems(['admin', 'skills_officer'], counts);
    expect(both.map((i) => i.href)).toContain('/admin');
    expect(both.map((i) => i.href)).toContain('/queue');
    expect(both.map((i) => i.href)).toContain('/today');
  });
});
