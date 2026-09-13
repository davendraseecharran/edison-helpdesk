import { describe, expect, it } from 'vitest';
import {
  DARK_MEDIA_QUERY,
  resolveTheme,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
} from '../src/components/shell/theme-script';

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

describe('THEME_BOOT_SCRIPT', () => {
  // The blocking script cannot import these constants, so it interpolates them.
  // If either one were retyped instead, the pre-paint theme and the provider
  // would read different sources and the page would flash on reload.
  it('reads the same storage key and media query as the provider', () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(DARK_MEDIA_QUERY));
  });
});
