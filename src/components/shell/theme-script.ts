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
 * The theme a visitor gets before choosing one: dark.
 *
 * Only an explicit `system` choice follows the operating system; a first
 * visit, a cleared storage entry or a corrupt value all land here.
 */
export const DEFAULT_THEME: ThemePreference = 'dark';

/** Turn whatever localStorage holds into a preference, defaulting to dark. */
export function preferenceFromStored(value: string | null | undefined): ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
}

/**
 * Inline script source: reads the stored preference and stamps data-theme
 * before first paint.
 *
 * It repeats the logic of `preferenceFromStored` and `resolveTheme` rather
 * than importing them, because it is injected as a standalone string with no
 * module loader available. The storage key, the media query and the default
 * theme are interpolated from the constants above instead of being retyped, so
 * the script cannot drift away from the provider that takes over after
 * hydration. Every access is wrapped in try/catch: a browser that blocks
 * storage must still render, in the default theme.
 */
export const THEME_BOOT_SCRIPT = `(function(){var f=${JSON.stringify(DEFAULT_THEME)};var t=f;try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);if(p==='dark'||p==='light'){t=p;}else if(p==='system'){t=window.matchMedia(${JSON.stringify(DARK_MEDIA_QUERY)}).matches?'dark':'light';}}catch(e){}try{document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
