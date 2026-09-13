import type { MetadataRoute } from 'next';

/**
 * Web app manifest.
 *
 * Makes Edison Helpdesk installable on phones and Chromebooks. There is no
 * service worker: this app is online-only, so the manifest exists purely for
 * install metadata (name, icons, theme) and not offline support.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Edison Helpdesk',
    short_name: 'Edison',
    description: 'Tickets, people and devices for the NetRiders IT team.',
    start_url: '/queue',
    display: 'standalone',
    background_color: '#0d1526',
    theme_color: '#0f1f3d',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
