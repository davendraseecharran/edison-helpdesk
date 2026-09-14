import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { OrbGallery } from './OrbGallery';

/**
 * Every orb state, both sizes, on the current theme. Development only: it
 * exists so `scripts/orb-preview.cjs` can photograph the orb and so a
 * person can look at it. In production it is a 404.
 */
export const dynamic = 'force-dynamic';

export default function OrbPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <Suspense fallback={null}>
      <OrbGallery />
    </Suspense>
  );
}
