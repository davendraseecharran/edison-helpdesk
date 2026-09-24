import { describe, expect, it } from 'vitest';
import {
  assignedAtFrom,
  checkedGlance,
  checkedSubtitle,
  checkHref,
  isOpenTicket,
} from '../src/lib/domain/device-check';

describe('the device check card', () => {
  it('dates the holder from the latest assignment, unless a return came after it', () => {
    expect(
      assignedAtFrom([
        { kind: 'bulk_updated', at: '2026-09-20T10:00:00Z' },
        { kind: 'assigned', at: '2026-09-18T09:00:00Z' },
        { kind: 'assigned', at: '2026-09-01T09:00:00Z' },
      ]),
    ).toBe('2026-09-18T09:00:00Z');
    expect(
      assignedAtFrom([
        { kind: 'returned', at: '2026-09-19T09:00:00Z' },
        { kind: 'assigned', at: '2026-09-18T09:00:00Z' },
      ]),
    ).toBeNull();
    expect(assignedAtFrom([])).toBeNull();
  });

  it('counts only open tickets', () => {
    expect(isOpenTicket({ status: 'waiting' })).toBe(true);
    expect(isOpenTicket({ status: 'resolved' })).toBe(false);
    expect(isOpenTicket({ status: 'cancelled' })).toBe(false);
  });

  it('says a machine in one line: who has it, or its status and place', () => {
    expect(
      checkedGlance({ holder: { id: 'p', name: 'Juniper Vale', kind: 'student', externalId: '' }, status: 'Assigned', location: '' }),
    ).toBe('With Juniper Vale');
    expect(checkedGlance({ holder: null, status: 'In repair', location: 'IT office' })).toBe('In repair, IT office');
    expect(checkedGlance({ holder: null, status: '', location: '' })).toBe('No status');
    expect(checkedSubtitle({ deviceType: 'Chromebook', manufacturer: 'Lenovo', model: '300e' })).toBe(
      'Chromebook, Lenovo 300e',
    );
  });

  it('links the check with a code to look up', () => {
    expect(checkHref()).toBe('/workflows/check');
    expect(checkHref(' DOE 1/2 ')).toBe('/workflows/check?code=DOE%201%2F2');
  });
});
