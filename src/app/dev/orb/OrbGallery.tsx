'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from '@/components/shell/ThemeProvider';
import { Orb } from '@/components/ai/Orb';
import { MOMENTS, orbStateFor } from '@/components/ai/orb-state';
import '@/styles/ai.css';

const PAGE: CSSProperties = {
  minHeight: '100dvh',
  padding: '32px',
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-sans)',
};

const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: '16px',
};

const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '12px',
  padding: '20px 12px 16px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-2)',
  background: 'var(--surface)',
  textAlign: 'center',
};

const LABEL: CSSProperties = { fontSize: 'var(--fs-1)', fontWeight: 600 };
const NOTE: CSSProperties = { color: 'var(--ink-3)', fontSize: 'var(--fs-0)' };
const PAIR: CSSProperties = { display: 'flex', alignItems: 'center', gap: '16px' };

/** A gentle synthetic level so the listening card moves the way the composer would. */
function useDemoLevel(): number {
  const [level, setLevel] = useState(0.3);
  useEffect(() => {
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      const t = (performance.now() - started) / 1000;
      setLevel(0.35 + 0.25 * Math.sin(t * 2.2) + 0.1 * Math.sin(t * 7.1));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return level;
}

export function OrbGallery() {
  const params = useSearchParams();
  const wanted = params.get('theme');
  const { resolved, setTheme } = useTheme();
  const level = useDemoLevel();

  useEffect(() => {
    if (wanted === 'dark' || wanted === 'light') void setTheme(wanted);
  }, [wanted, setTheme]);

  return (
    <main style={PAGE} data-theme-shown={resolved}>
      <h1 style={{ fontSize: 'var(--fs-4)', marginBottom: '4px' }}>Thinking orb</h1>
      <p style={{ ...NOTE, marginBottom: '24px' }}>
        Every moment the panel knows, at 64 and 20, on the {resolved} theme. Add ?theme=light or
        ?theme=dark to pin one.
      </p>
      <div style={GRID}>
        {MOMENTS.map((moment) => (
          <div key={moment} style={CARD} data-moment-card={moment}>
            <div style={PAIR}>
              <Orb
                moment={moment}
                size={64}
                level={moment === 'listening' || moment === 'speaking' ? level : undefined}
              />
              <Orb moment={moment} size={20} />
            </div>
            <span style={LABEL}>{moment}</span>
            <span style={NOTE}>{orbStateFor(moment)}{moment === 'error' ? ', paused' : ''}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
