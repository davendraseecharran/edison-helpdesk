import { createDemoData } from '../src/lib/demo/fixtures';
import { describe, expect, it } from 'vitest';
import { formatClockTime, formatDateTime, toDateKey } from '../src/lib/format';

describe('school-local dates', () => {
  it('keeps late evening requests on the correct school day across UTC midnight', () => {
    expect(toDateKey(new Date('2026-09-11T02:30:00Z'))).toBe('2026-09-10');
    expect(formatClockTime('2026-09-11T02:30:00Z')).toBe('10:30 PM');
  });
  it('handles winter offset and shows the year in historical timestamps', () => {
    expect(toDateKey(new Date('2026-01-02T04:30:00Z'))).toBe('2026-01-01');
    expect(formatDateTime('2026-01-02T04:30:00Z')).toBe('Jan 1, 2026, 11:30 PM');
  });
});

 describe('school-day fixtures', () => {
  it.each(['2026-09-11T02:30:00Z', '2026-01-02T04:30:00Z'])(
    'keeps intake and event timestamps on the same school day at %s', (iso) => {
      const now = new Date(iso);
      const ticket = createDemoData(now).tickets[0];
      expect(ticket.submittedOn).toBe(toDateKey(now));
      expect(toDateKey(new Date(ticket.createdAt))).toBe(ticket.submittedOn);
      expect(formatClockTime(ticket.createdAt)).toBe('7:52 AM');
    },
  );
});
