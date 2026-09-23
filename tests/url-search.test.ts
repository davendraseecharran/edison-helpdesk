import { describe, expect, it } from 'vitest';
import { reconcileArrival } from '@/components/ui/useUrlSearch';

describe('a search box whose value lives in the URL', () => {
  it('keeps what was typed while its own earlier push lands', () => {
    // "Whi" and then "Whitney" were sent; the answer for "Whi" arrives first.
    expect(reconcileArrival(['Whi', 'Whitney'], 'Whi')).toEqual({ adopt: false, sent: ['Whitney'] });
  });

  it('forgets every older push once a newer one lands', () => {
    expect(reconcileArrival(['Whi', 'Whitney'], 'Whitney')).toEqual({ adopt: false, sent: [] });
  });

  it('follows a change from elsewhere, such as Clear filters or Back', () => {
    expect(reconcileArrival(['Whi'], '')).toEqual({ adopt: true, sent: [] });
    expect(reconcileArrival([], 'Rivera')).toEqual({ adopt: true, sent: [] });
  });
});
