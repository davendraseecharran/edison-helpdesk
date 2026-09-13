import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
import { THEME_BOOT_SCRIPT } from '@/components/shell/theme-script';
import { plexMono, plexSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Edison Helpdesk',
  applicationName: 'Edison Helpdesk',
  description: 'Internal helpdesk for Edison technicians.',
  // An internal tool with real accounts should not be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout.
 *
 * Deliberately holds no identity provider and no data store: authentication
 * state is resolved per request on the server, so there is no long-lived client
 * store that could survive a sign-out or leak between accounts.
 *
 * The one inline script stamps `data-theme` on `<html>` before the first paint,
 * which is the only way to avoid a light flash on a dark-theme reload; it reads
 * nothing but the theme preference. `suppressHydrationWarning` covers the
 * attribute it adds, which the server render cannot know about.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
