'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useRuntime } from '@/components/AppRuntime';
import { updatePreferencesAction } from '@/lib/data/preferences-actions';
import { nextThemeAfterSave } from '@/lib/domain/preferences';
import type { ActionResult } from '@/lib/data/actions';
import type { ThemePreference } from './theme-script';
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  preferenceFromStored,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './theme-script';

/** `useLayoutEffect` on the client, `useEffect` on the server, where layout effects only warn. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Makes a theme change snap instead of smear.
 *
 * A flip repaints colour, background, border and shadow on nearly every
 * element at once. Everything carrying a transition on one of those fires
 * together and the switch reads as a slow wash rather than an instant change
 * — the buttons crossfade, the rail lags the page, the lamp on the current
 * row arrives last. So: drop a stylesheet that turns every transition off,
 * read `offsetHeight` for its side effect (a synchronous style flush, which
 * commits the new colours while the override still applies and so starts no
 * transition), then take the stylesheet away on the frame after that paint.
 *
 * Two frames, not one: the first `requestAnimationFrame` runs before the
 * paint that uses the new colours, so removing the override there would let
 * the transitions start after all.
 */
function suppressTransitions(): void {
  const style = document.createElement('style');
  style.append(document.createTextNode('*,*::before,*::after{transition:none !important}'));
  document.head.append(style);

  // Read for the flush, not for the value.
  void document.body.offsetHeight;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => style.remove());
  });
}

type ThemeContextValue = {
  /** What the user asked for, including `system`. */
  theme: ThemePreference;
  /** What is actually painted right now. */
  resolved: 'light' | 'dark';
  /**
   * Applies a theme immediately and, for a signed-in reader, saves it. A save
   * the database refuses puts the theme back; the result is the save's, and
   * `{ ok: true }` when there was nothing to save.
   */
  setTheme: (next: ThemePreference) => Promise<ActionResult>;
  /** Takes the preference the server rendered. `ServerTheme` is its only caller. */
  adoptServerTheme: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/*
 * The stored preference, as an external store.
 *
 * `useSyncExternalStore` rather than state seeded from localStorage, because
 * the theme is now rendered — the segmented control on the settings screen
 * shows which choice is current. Seeded state would make the server render one
 * choice and the first client render another, which is a hydration mismatch;
 * a store hydrates with the server's snapshot and moves to the browser's
 * straight afterwards, which is exactly what is wanted here. Subscribing also
 * means a change in one tab reaches the others.
 */
const listeners = new Set<() => void>();

/**
 * What this page last chose, for a browser that refuses storage.
 *
 * Without it a blocked localStorage would make every snapshot the default and
 * the control would never move, which is a worse failure than not remembering
 * the choice after a reload.
 */
let lastChosen: ThemePreference | null = null;

function subscribeToStoredTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Read the stored preference, tolerating browsers that refuse storage. */
function getStoredTheme(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw !== null) return preferenceFromStored(raw);
  } catch {
    // Storage refused. What this page chose is still what it is showing.
  }
  return lastChosen ?? DEFAULT_THEME;
}

/** The server cannot know what a browser remembers. */
function getStoredThemeOnServer(): ThemePreference {
  return DEFAULT_THEME;
}

function writeStoredTheme(next: ThemePreference): void {
  lastChosen = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // A preference that cannot be persisted still applies to this page: the
    // listeners below are told either way.
  }
  for (const listener of [...listeners]) listener();
}

/**
 * The operating system's colour preference, read as an external store.
 *
 * Subscribing this way rather than mirroring the media query into state keeps
 * the value correct the moment it changes and leaves no stale copy behind when
 * the preference is pinned to light or dark for a while.
 */
function subscribeToSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_MEDIA_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getSystemDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/** The server cannot know the visitor's system preference. */
function getSystemDarkOnServer(): boolean {
  return false;
}

/**
 * Holds the theme preference and keeps `data-theme` on `<html>` in step with it.
 *
 * The provider sits above the authenticated group, so the browser's own
 * localStorage entry is what it starts from — the same value the blocking boot
 * script already used to stamp `data-theme`, which is why the painted theme
 * never changes underneath the reader. With nothing stored anywhere the
 * application is dark; `system` is a choice the user makes, not the starting
 * point.
 *
 * The account's stored preference arrives afterwards, through `ServerTheme`
 * inside the signed-in layout, and it wins: a choice made on one machine
 * follows the reader to the next one. From that point the provider is "server
 * backed", so every later change is saved as well as applied — and on a
 * signed-out screen, where there is no account to save it to, changing the
 * theme still works and stays in this browser.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // Not state: nothing renders differently because of it, and it must be
  // readable by a handler the moment the account's preference has arrived.
  const serverBacked = useRef(false);

  const theme = useSyncExternalStore(
    subscribeToStoredTheme,
    getStoredTheme,
    getStoredThemeOnServer,
  );

  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemDark,
    getSystemDarkOnServer,
  );

  const resolved = resolveTheme(theme, systemDark);

  // One writer for the attribute: every path that changes the theme lands here,
  // including the first commit after the boot script's guess. A layout effect,
  // so the account's theme is stamped in the same frame it arrives rather than
  // one paint of the browser's guess later.
  //
  // Because it is the only writer, it is also the only place that has to stop
  // the switch from smearing — the account menu's control, the palette's
  // "Toggle theme", the settings screen and the operating system's own
  // preference all arrive here. Transitions are suppressed only when the
  // painted theme really changes: on the first commit the boot script has
  // already stamped the right value, and there is nothing to smear.
  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    if (root.getAttribute('data-theme') === resolved) return;
    suppressTransitions();
    root.setAttribute('data-theme', resolved);
  }, [resolved]);

  const adoptServerTheme = useCallback((next: ThemePreference) => {
    serverBacked.current = true;
    // Written rather than held, so the boot script paints the account's theme
    // on the next load instead of the one this browser last used.
    if (next !== getStoredTheme()) writeStoredTheme(next);
  }, []);

  const setTheme = useCallback(async (next: ThemePreference): Promise<ActionResult> => {
    const previous = getStoredTheme();
    writeStoredTheme(next);
    if (!serverBacked.current) return { ok: true };

    // A theme the database did not accept must not stay on the screen: the
    // reader would carry on in a theme their account does not have, and see it
    // undone by the next reload. `settle` reads what is showing when the save
    // comes back rather than assuming it is still this call's choice: the
    // command palette changes the theme without waiting on anything, so a slow
    // failure here must not stomp a newer choice.
    function settle(saved: boolean): void {
      const current = getStoredTheme();
      const settled = nextThemeAfterSave(previous, next, saved, current);
      if (settled !== current) writeStoredTheme(settled);
    }

    let result: ActionResult;
    try {
      result = await updatePreferencesAction({ theme: next });
    } catch (error) {
      settle(false);
      // The runtime turns a thrown action into its own message; nothing is
      // added here beyond putting the theme back.
      throw error;
    }
    settle(result.ok);
    return result;
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme, adoptServerTheme }),
    [theme, resolved, setTheme, adoptServerTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}

/**
 * Hands the account's stored theme to the provider above it.
 *
 * The provider is mounted in the root layout, which knows nothing about
 * accounts; this renders nothing and exists so the authenticated layout, which
 * does, can pass down the preference it loaded. A layout effect, so a browser
 * that has never seen this account adopts its theme before the first paint
 * instead of flashing the default.
 */
export function ServerTheme({ theme }: { theme: ThemePreference }) {
  const { adoptServerTheme } = useTheme();

  useIsomorphicLayoutEffect(() => {
    adoptServerTheme(theme);
  }, [theme, adoptServerTheme]);

  return null;
}

/**
 * The theme control behind both places one is offered: the account menu and
 * the settings screen.
 *
 * Choosing applies the theme at once and saves it, and the save reports through
 * the runtime like any other action, so the reader gets the same confirmation
 * and the same error they would get anywhere else. Only usable inside the
 * signed-in shell, where that runtime exists.
 */
export function useThemeChoice(): {
  theme: ThemePreference;
  choose: (next: ThemePreference) => void;
} {
  const { theme, setTheme } = useTheme();
  const { run } = useRuntime();

  const choose = useCallback(
    (next: ThemePreference) => {
      void run('theme', async () => {
        const result = await setTheme(next);
        return result.ok ? { ok: true, message: 'Theme saved.' } : result;
      });
    },
    [run, setTheme],
  );

  return { theme, choose };
}
