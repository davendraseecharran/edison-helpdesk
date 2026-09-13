import { describe, expect, it } from 'vitest';
import { navItems } from '../src/components/shell/RailNav';

const counts = { openQueue: 3, myTickets: 1, collaborating: 0, closed: 9, all: 13 };

describe('navItems', () => {
  it('gives technicians work, directory and insights but no admin group', () => {
    const items = navItems('technician', counts);
    expect(items.map((i) => i.href)).toEqual([
      '/queue',
      '/my-tickets',
      '/collaborating',
      '/resolved',
      '/people',
      '/devices',
      '/insights',
    ]);
    expect(items.find((i) => i.href === '/queue')?.count).toBe(3);
  });

  it('adds all tickets and administration for admins', () => {
    const items = navItems('admin', counts);
    expect(items.map((i) => i.href)).toContain('/all-tickets');
    expect(items.map((i) => i.href)).toContain('/admin');
    expect(items.find((i) => i.href === '/all-tickets')?.count).toBe(13);
  });

  it('keeps the admin group last and every item in a named group', () => {
    const items = navItems('admin', counts);
    const groups = items.map((i) => i.group);
    // Groups appear in rail order and never interleave.
    expect([...new Set(groups)]).toEqual(['Work', 'Directory', 'Insights', 'Admin']);
    expect(items.every((i) => i.label.length > 0 && i.icon)).toBe(true);
  });
});
