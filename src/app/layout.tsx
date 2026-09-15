import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
import { THEME_BOOT_SCRIPT } from '@/components/shell/theme-script';
import { mono, sans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Edison Helpdesk',
  applicationName: 'Edison Helpdesk',
  description: 'Internal helpdesk for the Edison NetRiders.',
  // An internal tool with real accounts should not be indexed.
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Edison',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The colour the browser paints its own chrome with, which should be the
  // page's ground and not the black and white either theme stopped short of.
  // These are `--bg` from `tokens.css`, the one place a value may be typed.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfc' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0f10' },
  ],
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
      className={`${sans.variable} ${mono.variable}`}
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
