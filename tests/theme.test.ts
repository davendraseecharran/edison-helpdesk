import { describe, expect, it } from 'vitest';
import { resolveTheme, THEME_STORAGE_KEY } from '../src/components/shell/theme-script';

describe('resolveTheme', () => {
  it('follows the system when preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
  it('pins an explicit preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
  it('treats unknown stored values as system', () => {
    expect(resolveTheme('purple' as never, true)).toBe('dark');
  });
  it('exposes a stable storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('edison.theme');
  });
});
