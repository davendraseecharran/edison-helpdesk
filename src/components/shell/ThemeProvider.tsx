'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
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
  setTheme: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Read the stored preference, tolerating browsers that refuse storage.
 * Nothing stored, or nothing usable, means the default theme.
 */
function readStoredPreference(): ThemePreference {
  try {
    return preferenceFromStored(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function writeStoredPreference(next: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // A preference that cannot be persisted still applies to this page.
  }
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
 * `initialTheme` is the preference stored server side; when it is present it
 * wins over localStorage, so an account's choice follows it to a new browser.
 * Without it the first client render falls back to localStorage, which is the
 * same value the blocking boot script already used to stamp `data-theme`, so
 * the painted theme never changes underneath the reader during hydration.
 * With nothing stored anywhere the application is dark; `system` is a choice
 * the user makes, not the starting point.
 */
export function ThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme?: ThemePreference;
  children: ReactNode;
}) {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    if (initialTheme) return initialTheme;
    if (typeof window === 'undefined') return DEFAULT_THEME;
    return readStoredPreference();
  });

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

  // The server preference is authoritative, so mirror it into storage for the
  // boot script to read on the next load.
  useEffect(() => {
    if (initialTheme) writeStoredPreference(initialTheme);
  }, [initialTheme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    writeStoredPreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
