import { describe, expect, it } from 'vitest';
import {
  analyticsSentence,
  bucketFor,
  bucketLabel,
  deltaOf,
  hardScore,
  hourLabel,
  percentOf,
  type Overview,
} from '../src/lib/domain/analytics';

const OVERVIEW: Overview = {
  resolved: 0,
  resolvedPrevious: null,
  created: 0,
  createdPrevious: null,
  cancelled: 0,
  reopened: 0,
  medianHours: null,
  medianHoursPrevious: null,
  p90Hours: null,
  sameDayShare: null,
  schoolDays: 0,
  perSchoolDay: null,
  perWeek: null,
  openNow: 0,
  unassignedNow: 0,
  waitingNow: 0,
  oldestOpenHours: null,
};

describe('bucketFor', () => {
  it('reads a week and a month by the day, a term by the week, all time by the month', () => {
    expect(bucketFor('week')).toBe('day');
    expect(bucketFor('month')).toBe('day');
    expect(bucketFor('term')).toBe('week');
    expect(bucketFor('all')).toBe('month');
  });
});

describe('bucketLabel', () => {
  it('names a day by weekday and date, a week by its Monday, a month by name', () => {
    expect(bucketLabel('2026-09-16', 'day')).toBe('Wed 16');
    expect(bucketLabel('2026-09-14', 'week')).toBe('Sep 14');
    expect(bucketLabel('2026-09', 'month')).toBe('Sep');
  });
});

describe('hourLabel', () => {
  it('writes the hour the way a school timetable does', () => {
    expect(hourLabel(0)).toBe('12a');
    expect(hourLabel(8)).toBe('8a');
    expect(hourLabel(12)).toBe('12p');
    expect(hourLabel(15)).toBe('3p');
    expect(hourLabel(24)).toBe('12a');
  });
});

describe('hardScore', () => {
  it('weighs priority, logs time, and adds hands and reopens', () => {
    expect(hardScore('urgent', 0, 1, 0)).toBe(0);
    expect(hardScore('normal', Math.E - 1, 1, 0)).toBeCloseTo(2);
    expect(hardScore('high', Math.E - 1, 3, 1)).toBeCloseTo(3 + 1 + 1);
    // A ticket that sat for a week is not ten times a ticket that took a day.
    expect(hardScore('low', 168, 1, 0) / hardScore('low', 24, 1, 0)).toBeLessThan(2);
  });

  it('never rewards negative time or negative hands', () => {
    expect(hardScore('urgent', -5, 0, 0)).toBe(0);
  });
});

describe('deltaOf', () => {
  it('says there is nothing to compare with for all time', () => {
    expect(deltaOf(12, null)).toEqual({ direction: 'same', percent: null, text: 'No earlier period to compare' });
  });

  it('gives the whole percent and the direction', () => {
    expect(deltaOf(12, 10)).toEqual({ direction: 'up', percent: 20, text: 'Up 20% on the period before' });
    expect(deltaOf(8, 10)).toEqual({ direction: 'down', percent: 20, text: 'Down 20% on the period before' });
    expect(deltaOf(10, 10)).toEqual({ direction: 'same', percent: 0, text: 'Same as before' });
  });

  it('has no percentage to give when the earlier period was empty', () => {
    expect(deltaOf(3, 0)).toEqual({ direction: 'up', percent: null, text: 'Up from none' });
    expect(deltaOf(0, 0).direction).toBe('same');
  });
});

describe('percentOf', () => {
  it('rounds a share to a whole percent and shrugs at nothing', () => {
    expect(percentOf(0.456)).toBe('46%');
    expect(percentOf(1)).toBe('100%');
    expect(percentOf(null)).toBe('—');
    expect(percentOf(Number.NaN)).toBe('—');
  });
});

describe('analyticsSentence', () => {
  it('says so when nothing was resolved', () => {
    expect(analyticsSentence(OVERVIEW, 'week')).toBe('Nothing resolved this week yet.');
  });

  it('counts, names the period, and gives the pace to one decimal below ten', () => {
    expect(analyticsSentence({ ...OVERVIEW, resolved: 1, perSchoolDay: 0.2 }, 'month')).toBe(
      'One ticket resolved this month, about 0.2 a school day.',
    );
    expect(analyticsSentence({ ...OVERVIEW, resolved: 340, perSchoolDay: 12.4 }, 'term')).toBe(
      '340 tickets resolved this term, about 12 a school day.',
    );
    expect(analyticsSentence({ ...OVERVIEW, resolved: 5 }, 'all')).toBe('5 tickets resolved all time.');
  });
});
