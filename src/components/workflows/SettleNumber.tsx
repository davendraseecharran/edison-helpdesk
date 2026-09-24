'use client';

/**
 * A count that turns over when it changes, and settles.
 *
 * Keyed by the value, so each change mounts one new span whose entrance comes
 * from the direction the number went: up from below, down from above. CSS
 * only (`workflows.css`), transform and opacity, and nothing under reduced
 * motion.
 */

import { useState } from 'react';

export function SettleNumber({ value, className }: { value: number; className?: string }) {
  // The first value is simply there; only a change turns over.
  const [shown, setShown] = useState<{ value: number; dir?: 'up' | 'down' }>({ value });
  if (shown.value !== value) {
    setShown({ value, dir: value > shown.value ? 'up' : 'down' });
  }
  return (
    <span className={className ? `wf-settle ${className}` : 'wf-settle'}>
      <span key={value} className="wf-settle-value num" data-dir={shown.dir}>
        {value}
      </span>
    </span>
  );
}
