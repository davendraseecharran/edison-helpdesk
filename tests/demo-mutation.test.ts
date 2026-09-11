import { describe, expect, it } from 'vitest';
import { DemoMutationGuard } from '../src/lib/demo/mutation-guard';

describe('single-tab delayed demo writes', () => {
  it('rejects overlapping panel submissions, then permits the next write', () => {
    const guard = new DemoMutationGuard();
    const first = guard.begin()!;
    expect(guard.begin()).toBeNull();
    expect(guard.isCurrent(first)).toBe(true);
    expect(guard.finish(first)).toBe(true);
    expect(guard.begin()).not.toBeNull();
  });

  it('invalidates a write when the demo is reset or the identity changes', () => {
    const guard = new DemoMutationGuard();
    const old = guard.begin()!;
    guard.invalidate();
    expect(guard.isCurrent(old)).toBe(false);
    const next = guard.begin()!;
    expect(guard.finish(old)).toBe(false);
    expect(guard.isCurrent(next)).toBe(true);
    expect(guard.begin()).toBeNull();
    expect(guard.finish(next)).toBe(true);
  });
});
