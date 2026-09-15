import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BOOT_LAMP_SCRIPT } from '@/components/shell/boot-lamp-script';
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
 * The two inline scripts stamp attributes on `<html>` before the first paint,
 * which is the only way to decide anything a CSS rule reads on the first frame:
 * `data-theme`, without which a dark-theme reload flashes white, and
 * `data-boot-seen`, without which the arrival moment plays a second time in a
 * session that has already had it. Each reads one key of storage and writes
 * nothing. `suppressHydrationWarning` covers the attributes they add, which the
 * server render cannot know about.
 *
 * They are here rather than beside the components that care because a
 * `<script>` rendered inside a component is a browser error on every page —
 * React warns about every one it encounters — and because the head is the only
 * place early enough for either to be worth running.
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
        <script dangerouslySetInnerHTML={{ __html: BOOT_LAMP_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
