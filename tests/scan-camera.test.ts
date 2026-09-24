import { describe, expect, it } from 'vitest';
import {
  CAMERA_PROBLEMS,
  clampZoom,
  pinchZoom,
  problemFromError,
  torchSupported,
  zoomLabel,
  zoomRange,
} from '../src/lib/scan/camera';

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('what a camera failure means', () => {
  it('names each getUserMedia refusal by what a person can do about it', () => {
    expect(problemFromError(domError('NotAllowedError'))).toBe('refused');
    expect(problemFromError(domError('SecurityError'))).toBe('refused');
    expect(problemFromError(domError('NotFoundError'))).toBe('no-camera');
    expect(problemFromError(domError('OverconstrainedError'))).toBe('no-camera');
    expect(problemFromError(domError('NotReadableError'))).toBe('in-use');
    expect(problemFromError(domError('AbortError'))).toBe('in-use');
    expect(problemFromError(domError('NotSupportedError'))).toBe('unsupported');
    expect(problemFromError(domError('TypeError'))).toBe('failed');
    expect(problemFromError('nonsense')).toBe('failed');
    expect(problemFromError(domError('NotAllowedError'), false)).toBe('insecure');
  });

  it('says every problem in the voice: a title, what to do, no exclamation, no apology', () => {
    for (const copy of Object.values(CAMERA_PROBLEMS)) {
      expect(copy.title.length).toBeGreaterThan(5);
      expect(copy.body.length).toBeLessThanOrEqual(110);
      expect(`${copy.title} ${copy.body}`).not.toMatch(/!|sorry|oops/i);
    }
    expect(CAMERA_PROBLEMS.refused.retry).toBe(true);
    expect(CAMERA_PROBLEMS.insecure.retry).toBe(false);
  });
});

describe('torch and zoom', () => {
  it('offers the torch only when the track says so', () => {
    expect(torchSupported({ torch: true })).toBe(true);
    expect(torchSupported({ torch: false })).toBe(false);
    expect(torchSupported({})).toBe(false);
    expect(torchSupported(null)).toBe(false);
  });

  it('offers zoom only when there is a real range', () => {
    expect(zoomRange({ zoom: { min: 1, max: 8, step: 0.1 } })).toEqual({ min: 1, max: 8, step: 0.1 });
    expect(zoomRange({ zoom: { min: 1, max: 1.2, step: 0.1 } })).toBeNull();
    expect(zoomRange({ zoom: { min: 1, max: 4 } })).toEqual({ min: 1, max: 4, step: 0.1 });
    expect(zoomRange({})).toBeNull();
  });

  it('keeps a zoom on the range and its step, and a pinch scales from where it began', () => {
    const range = { min: 1, max: 5, step: 0.5 };
    expect(clampZoom(range, 9)).toBe(5);
    expect(clampZoom(range, 0)).toBe(1);
    expect(clampZoom(range, 2.3)).toBe(2.5);
    expect(pinchZoom(range, 2, 1.5)).toBe(3);
    expect(pinchZoom(range, 2, 10)).toBe(5);
    expect(pinchZoom(range, 2, Number.NaN)).toBe(2);
    expect(zoomLabel(1)).toBe('1×');
    expect(zoomLabel(2.54)).toBe('2.5×');
  });
});
