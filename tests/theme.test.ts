import { describe, expect, it } from 'vitest';
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  preferenceFromStored,
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
  it('follows the system for any preference that is not light or dark', () => {
    expect(resolveTheme('purple' as never, true)).toBe('dark');
    expect(resolveTheme('purple' as never, false)).toBe('light');
  });
  it('exposes a stable storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('edison.theme');
  });
});

describe('preferenceFromStored', () => {
  it('defaults to dark when nothing is stored', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(preferenceFromStored(null)).toBe('dark');
    expect(preferenceFromStored(undefined)).toBe('dark');
    expect(preferenceFromStored('')).toBe('dark');
  });
  it('keeps an explicit choice, including system', () => {
    expect(preferenceFromStored('system')).toBe('system');
    expect(preferenceFromStored('light')).toBe('light');
    expect(preferenceFromStored('dark')).toBe('dark');
  });
  it('treats a corrupt value as unset', () => {
    expect(preferenceFromStored('purple')).toBe('dark');
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
  it('falls back to the default theme, not the operating system', () => {
    expect(THEME_BOOT_SCRIPT).toContain(`var f=${JSON.stringify(DEFAULT_THEME)}`);
    // Only an explicit "system" consults the media query.
    expect(THEME_BOOT_SCRIPT).toContain("p==='system'");
  });
  it('stamps the theme even when storage throws', () => {
    // Run the script against a fake window whose storage refuses access.
    const html = { attributes: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attributes[k] = v; } };
    const scope = {
      localStorage: { getItem() { throw new Error('blocked'); } },
      window: { matchMedia: () => ({ matches: true }) },
      document: { documentElement: html },
    };
    new Function('localStorage', 'window', 'document', THEME_BOOT_SCRIPT)(
      scope.localStorage,
      scope.window,
      scope.document,
    );
    expect(html.attributes['data-theme']).toBe('dark');
  });
});
