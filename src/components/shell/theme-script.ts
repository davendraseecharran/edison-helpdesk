/**
 * Theme preference resolution, shared by the React provider and the blocking
 * boot script.
 *
 * This module is deliberately free of React and of any import, so the same
 * rules can be serialized into the inline `<head>` script that runs before the
 * first paint.
 */

export type ThemePreference = 'system' | 'light' | 'dark';

/** localStorage key holding the user's theme preference. */
export const THEME_STORAGE_KEY = 'edison.theme';

/** The media query that decides the theme while the preference is `system`. */
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * Turn a stored preference into the theme that should actually be painted.
 *
 * Anything that is not an explicit `light` or `dark` — including a value left
 * behind by an older build or edited by hand — is treated as `system`, so a
 * corrupt storage entry can never leave the app without a theme.
 */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark ? 'dark' : 'light';
}

/**
 * Inline script source: reads the stored preference and stamps data-theme
 * before first paint.
 *
 * It repeats the logic of `resolveTheme` and the media query literal rather
 * than importing them, because it is injected as a standalone string with no
 * module loader available. Every access is wrapped in try/catch: a browser that
 * blocks storage must still render, just in the light theme.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=(p==='dark'||p==='light')?p:(d?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
