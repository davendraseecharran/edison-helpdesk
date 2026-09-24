'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { HoverGlide } from './HoverGlide';
import { RollingNumber } from './RollingNumber';

export interface TabItem {
  href: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  /** Accessible name for the set, for example "Administration sections". */
  label: string;
}

function pathOf(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * Where each strip's underline last stood, by the strip's name.
 *
 * Administration renders its tabs inside each page, so every tab press mounts
 * a new strip. Without a memory the underline would be born under the new
 * tab and never be seen to travel. A strip mounted within a moment of the
 * last one with the same name starts where that one's underline was and
 * travels from there; anything older is a fresh visit and starts in place.
 */
const lastUnderline = new Map<string, { x: number; w: number; at: number }>();
const REMEMBER_MS = 2000;

/**
 * Link tabs for the sections of one page.
 *
 * Each tab is a real link so it works with the URL, the back button and
 * middle-click. The current one is marked with `aria-current="page"`; counts
 * sit in a quiet pill after the label and roll when they change.
 *
 * The underline is one element that travels, on the segmented control's two
 * clocks: the leading edge sets off at once and the trailing edge follows,
 * so between tabs it stretches and snaps shut. It moves on the press, before
 * the next page has arrived — the press is answered at once, and the page
 * catches up under it. The hover is the shared gliding highlight. Under
 * reduced motion both jump.
 */
export function Tabs({ items, label }: TabsProps) {
  const pathname = usePathname();
  const strip = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLAnchorElement | null)[]>([]);
  // The tab pressed, until the path moves on from where it was pressed.
  const [pressed, setPressed] = useState<{ href: string; from: string } | null>(null);
  const current = items.findIndex((item) => pathname === pathOf(item.href));
  const pending =
    pressed && pressed.from === pathname ? items.findIndex((item) => item.href === pressed.href) : -1;
  const at = pending >= 0 ? pending : current;

  const [line, setLine] = useState<{ x: number; w: number } | null>(null);
  const [dir, setDir] = useState<'right' | 'left'>('right');
  const [ready, setReady] = useState(false);
  const lastX = useRef<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const tab = at >= 0 ? tabs.current[at] : null;
      if (!tab) {
        setLine(null);
        return;
      }
      const next = { x: tab.offsetLeft, w: tab.offsetWidth };
      if (lastX.current !== null && lastX.current !== next.x) setDir(next.x > lastX.current ? 'right' : 'left');
      lastX.current = next.x;
      lastUnderline.set(label, { ...next, at: Date.now() });
      setLine(next);
    };

    // A strip that has just replaced one with the same name: begin where that
    // one's underline stood, then travel on the next frame.
    if (lastX.current === null) {
      const remembered = lastUnderline.get(label);
      if (remembered && Date.now() - remembered.at < REMEMBER_MS) {
        lastX.current = remembered.x;
        setLine({ x: remembered.x, w: remembered.w });
        setReady(true);
        let frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(measure);
        });
        return () => cancelAnimationFrame(frame);
      }
    }
    measure();
    if (typeof ResizeObserver === 'undefined' || !strip.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [at, label, items.length]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  function onPress(event: MouseEvent<HTMLAnchorElement>, href: string) {
    // A new tab or window is not this page changing.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    setPressed({ href, from: pathname });
  }

  const style = line
    ? ({ '--tab-x': `${line.x}px`, '--tab-w': `${line.w}px` } as CSSProperties)
    : undefined;

  return (
    <HoverGlide
      as="nav"
      ref={strip}
      kind="tab"
      className="tabs"
      aria-label={label}
      data-ready={ready && line ? '' : undefined}
      data-dir={dir}
      style={style}
    >
      {items.map((item, index) => (
        <Link
          key={item.href}
          ref={(node) => {
            tabs.current[index] = node;
          }}
          href={item.href}
          className="tab"
          data-glide-item=""
          data-shown={index === at ? '' : undefined}
          aria-current={index === current ? 'page' : undefined}
          onClick={(event) => onPress(event, item.href)}
        >
          <span>{item.label}</span>
          {typeof item.count === 'number' ? (
            <span className="count-pill count-pill-quiet">
              <RollingNumber value={item.count} />
            </span>
          ) : null}
        </Link>
      ))}
      <span className="tabs-line" aria-hidden="true" />
    </HoverGlide>
  );
}
