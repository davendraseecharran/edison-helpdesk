import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Edison Helpdesk',
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
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
