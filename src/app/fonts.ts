import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';

/**
 * Self-hosted application typefaces.
 *
 * Both are exposed as CSS variables rather than class names so a single
 * stylesheet decides where each is used: `--font-sans` for the interface and
 * `--font-mono` for identifiers. `display: 'swap'` keeps text readable while
 * the files load.
 */
export const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});
