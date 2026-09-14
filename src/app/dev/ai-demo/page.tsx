import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { AiDemo } from './AiDemo';

/**
 * The assistant panel fed by scripted streams, so every state can be seen
 * without a ChatGPT account: welcome, reasoning, writing, tools, an
 * approval, an error, the connection flow, the disabled note, dictation.
 * Development only; a 404 in production.
 */
export const dynamic = 'force-dynamic';

export default function AiDemoPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <Suspense fallback={null}>
      <AiDemo />
    </Suspense>
  );
}
