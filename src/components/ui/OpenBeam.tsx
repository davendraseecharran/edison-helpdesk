'use client';

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { BorderBeam } from 'border-beam';
import { useReducedMotion } from './media';

/**
 * Seconds per rotation of the beam. `border-beam`'s `md` preset rotates in
 * 1.96s by default; an opening flourish wants it quicker than that, and 1.4s
 * is the pace the plan settled on.
 */
export const BEAM_CYCLE_S = 1.4;

/*
 * The layer sits 1px outside the surface it covers, so the stroke runs on the
 * surface's own border rather than just inside it. `strength` stays the 0.6
 * the plan asks for; it scales the library's inner glow and bloom, which are
 * lifted a little because the `mono` preset is tuned for a card, not a dialog.
 */
const LAYER_STYLE = {
  position: 'absolute',
  inset: '-1px',
  zIndex: 2,
  pointerEvents: 'none',
  '--beam-bloom-opacity': 3,
  '--beam-inner-opacity': 1.5,
} as CSSProperties;

/** The stroke: a 2px ring on the surface's border, lit where the beam's head is. */
function strokeRule(id: string): string {
  const ring = 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)';
  return `[data-beam="${id}"][data-active]::after, [data-beam="${id}"][data-fading]::after {
  padding: 2px;
  background: conic-gradient(
    from var(--beam-angle-${id}),
    var(--line) 0 54%,
    color-mix(in srgb, var(--ink) 85%, var(--line)) 62% 70%,
    var(--line) 78% 100%
  );
  -webkit-mask: ${ring};
  -webkit-mask-composite: xor;
  mask: ${ring};
  mask-composite: exclude;
  opacity: var(--beam-opacity-${id});
}`;
}

function subscribeToThemeAttribute(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function readTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** The painted theme, read from the root attribute the ThemeProvider stamps. Dark on the server, as the boot script is. */
function readThemeOnServer(): 'dark' | 'light' {
  return 'dark';
}

/**
 * A traveling light around a surface as it opens, then nothing.
 *
 * The beam plays for `cycles` rotations after mount and fades out; once its
 * fade has finished the layer is removed, and the wrapper is inert. It is a
 * sibling layer over the children rather than a wrapper around them, so
 * removing it never remounts what is underneath (a palette input would lose
 * its focus and text otherwise). The layer ignores the pointer.
 *
 * Two moments use it: the command palette opening and the assistant panel
 * opening. Under `prefers-reduced-motion` the layer is never rendered.
 */
export function OpenBeam({
  children,
  cycles = 2,
  className,
}: {
  children: ReactNode;
  cycles?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const theme = useSyncExternalStore(subscribeToThemeAttribute, readTheme, readThemeOnServer);
  const [phase, setPhase] = useState<'on' | 'off' | 'gone'>('on');
  const ghostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setPhase('off'), cycles * BEAM_CYCLE_S * 1000);
    return () => window.clearTimeout(timer);
  }, [cycles, reduced]);

  // The stroke the library draws is a semi-transparent gradient, and inside
  // this page's overlay it paints at a fraction of its alpha (an opaque band
  // in the same place paints at full strength). So the stroke is restated
  // here in opaque token colours: the band fades to the border colour rather
  // than to transparent, which looks the same on a border. The rule has to
  // name the instance, because the library's animated angle and opacity are
  // custom properties named after it, so it is written once the id is known
  // and sits after the library's own stylesheet, which is what lets it win.
  useEffect(() => {
    const ghost = ghostRef.current;
    const id = ghost?.parentElement?.getAttribute('data-beam');
    if (!ghost || !id) return;
    const style = document.createElement('style');
    style.textContent = strokeRule(id);
    ghost.appendChild(style);
    return () => style.remove();
  }, [reduced]);

  return (
    <div className={className ? `open-beam ${className}` : 'open-beam'}>
      {children}
      {!reduced && phase !== 'gone' ? (
        <BorderBeam
          className="open-beam-layer"
          // Inline, because the library injects its own `[data-beam]` rules
          // after the stylesheet and would otherwise make the layer static.
          style={LAYER_STYLE}
          size="md"
          colorVariant="mono"
          theme={theme}
          strength={0.6}
          duration={BEAM_CYCLE_S}
          staticColors
          active={phase === 'on'}
          onDeactivate={() => setPhase('gone')}
          aria-hidden="true"
        >
          <div ref={ghostRef} className="open-beam-ghost" />
        </BorderBeam>
      ) : null}
    </div>
  );
}
