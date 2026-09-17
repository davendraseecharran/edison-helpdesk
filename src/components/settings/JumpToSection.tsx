'use client';

import { useEffect } from 'react';

/**
 * Lands the page on the section the URL names, once that section exists.
 *
 * The router scrolls to a hash only when the element is already on the page
 * as the navigation commits. Settings streams in behind its data, so a link
 * such as "Manage quick tickets" (`/settings#quick-tickets`) arrived at the
 * heading before the sections had rendered and scrolled to nothing. This
 * looks again after the sections are on the page, and again whenever the hash
 * changes while the page is open. The sections carry `scroll-margin-top`, so
 * the heading lands under the top bar rather than behind it.
 */
export function JumpToSection() {
  useEffect(() => {
    function jump() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id === '') return;
      const target = document.getElementById(id);
      if (!target) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
    jump();
    window.addEventListener('hashchange', jump);
    return () => window.removeEventListener('hashchange', jump);
  }, []);
  return null;
}
