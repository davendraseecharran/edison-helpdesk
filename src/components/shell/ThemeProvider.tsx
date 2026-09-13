'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useRuntime } from '@/components/AppRuntime';
import { updatePreferencesAction } from '@/lib/data/preferences-actions';
import type { ActionResult } from '@/lib/data/actions';
import type { ThemePreference } from './theme-script';
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  preferenceFromStored,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './theme-script';

type ThemeContextValue = {
  /** What the user asked for, including `system`. */
  theme: ThemePreference;
  /** What is actually painted right now. */
  resolved: 'light' | 'dark';
  /**
   * Applies a theme immediately and, for a signed-in reader, saves it. The
   * result is the save's: `{ ok: true }` when there is nothing to save.
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
    return preferenceFromStored(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function writeStoredTheme(next: ThemePreference): void {
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
 * The account's stored preference arrives afterwards, either as `initialTheme`
 * or through `ServerTheme` inside the signed-in layout, and it wins: a choice
 * made on one machine follows the reader to the next one. From that point the
 * provider is "server backed", so every later change is saved as well as
 * applied — and on a signed-out screen, where there is no account to save it
 * to, changing the theme still works and stays in this browser.
 */
export function ThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme?: ThemePreference;
  children: ReactNode;
}) {
  // Not state: nothing renders differently because of it, and it must be
  // readable by a handler the moment the account's preference has arrived.
  const serverBacked = useRef(initialTheme !== undefined);

  const getThemeOnServer = useCallback(() => initialTheme ?? DEFAULT_THEME, [initialTheme]);
  const theme = useSyncExternalStore(subscribeToStoredTheme, getStoredTheme, getThemeOnServer);

  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemDark,
    getSystemDarkOnServer,
  );

  const resolved = resolveTheme(theme, systemDark);

  // One writer for the attribute: every path that changes the theme lands here,
  // including the first commit after the boot script's guess.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const adoptServerTheme = useCallback((next: ThemePreference) => {
    serverBacked.current = true;
    // Written rather than held, so the boot script paints the account's theme
    // on the next load instead of the one this browser last used.
    if (next !== getStoredTheme()) writeStoredTheme(next);
  }, []);

  useEffect(() => {
    if (initialTheme) adoptServerTheme(initialTheme);
  }, [initialTheme, adoptServerTheme]);

  const setTheme = useCallback(async (next: ThemePreference): Promise<ActionResult> => {
    writeStoredTheme(next);
    if (!serverBacked.current) return { ok: true };
    return updatePreferencesAction({ theme: next });
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
 * does, can pass down the preference it loaded.
 */
export function ServerTheme({ theme }: { theme: ThemePreference }) {
  const { adoptServerTheme } = useTheme();

  useEffect(() => {
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
