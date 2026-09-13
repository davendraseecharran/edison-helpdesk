import { createDemoData } from '../src/lib/demo/fixtures';
import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  formatClockTime,
  formatDateTime,
  schoolDayEnd,
  schoolDayStart,
  toDateKey,
} from '../src/lib/format';

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

describe('ticket age', () => {
  it('labels ticket age compactly', () => {
    const now = new Date('2026-09-12T15:00:00Z');
    expect(ageLabel('2026-09-12T14:59:40Z', now)).toBe('just now');
    expect(ageLabel('2026-09-12T14:30:00Z', now)).toBe('30m');
    expect(ageLabel('2026-09-12T09:00:00Z', now)).toBe('6h');
    expect(ageLabel('2026-09-09T15:00:00Z', now)).toBe('3d');
    expect(ageLabel('2026-07-01T15:00:00Z', now)).toBe('10w');
  });

  it('never goes negative for a clock slightly ahead of the server', () => {
    const now = new Date('2026-09-12T15:00:00Z');
    expect(ageLabel('2026-09-12T15:00:30Z', now)).toBe('just now');
  });
});

/**
 * The bounds a date filter turns into.
 *
 * These are the instants Postgres compares against, so an hour of error here
 * is an hour of the desk's history silently missing from an audit answer. The
 * two transition days are the whole reason the conversion is not
 * `new Date(key)`: a school day is twenty-three hours long in March and
 * twenty-five in November, and neither is twenty-four.
 */
describe('school-local day bounds', () => {
  it('brackets an ordinary summer day at the eastern daylight offset', () => {
    // Eastern Daylight Time: UTC-4, so midnight local is 04:00Z.
    expect(schoolDayStart('2026-09-13')).toBe('2026-09-13T04:00:00.000Z');
    expect(schoolDayEnd('2026-09-13')).toBe('2026-09-14T03:59:59.999Z');
  });

  it('brackets an ordinary winter day at the eastern standard offset', () => {
    // Eastern Standard Time: UTC-5, so midnight local is 05:00Z.
    expect(schoolDayStart('2026-01-15')).toBe('2026-01-15T05:00:00.000Z');
    expect(schoolDayEnd('2026-01-15')).toBe('2026-01-16T04:59:59.999Z');
  });

  it('keeps the spring-forward day to twenty-three hours', () => {
    // 2026-03-08: the clocks go forward at 2 a.m. local. Midnight is still
    // UTC-5 and the end of the day is already UTC-4.
    const start = schoolDayStart('2026-03-08');
    const end = schoolDayEnd('2026-03-08');
    expect(start).toBe('2026-03-08T05:00:00.000Z');
    expect(end).toBe('2026-03-09T03:59:59.999Z');
    const hours = (Date.parse(end!) - Date.parse(start!) + 1) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('keeps the fall-back day to twenty-five hours', () => {
    // 2026-11-01: the clocks go back at 2 a.m. local. Midnight is UTC-4 and
    // the end of the day is UTC-5.
    const start = schoolDayStart('2026-11-01');
    const end = schoolDayEnd('2026-11-01');
    expect(start).toBe('2026-11-01T04:00:00.000Z');
    expect(end).toBe('2026-11-02T04:59:59.999Z');
    const hours = (Date.parse(end!) - Date.parse(start!) + 1) / 3_600_000;
    expect(hours).toBe(25);
  });

  it('puts a year boundary on the right side of UTC midnight', () => {
    // New Year's Eve locally runs into 31 December in UTC terms and ends in
    // the new year; a naive `new Date('2026-01-01')` would start the day five
    // hours early and lose the last evening of the old one.
    expect(schoolDayStart('2026-01-01')).toBe('2026-01-01T05:00:00.000Z');
    expect(schoolDayEnd('2025-12-31')).toBe('2026-01-01T04:59:59.999Z');
    expect(schoolDayStart('2025-12-31')).toBe('2025-12-31T05:00:00.000Z');
  });

  it('refuses a key that is not a real date rather than inventing one', () => {
    expect(schoolDayStart('2026-02-30')).toBeNull();
    expect(schoolDayEnd('not-a-date')).toBeNull();
    expect(schoolDayStart('')).toBeNull();
  });
});
