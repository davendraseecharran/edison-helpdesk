'use client';

/**
 * The lookup cluster's goo, drawn on the GPU instead of filtered.
 *
 * The liquid-gooey cluster makes its silhouette with an SVG filter stack
 * (Gaussian blurs and a contrast matrix over the whole 240×200 box). Chromium
 * runs that on the GPU; WebKit — every browser on an iPhone or iPad, and Safari
 * — rasterises filters on the CPU, every frame, so on an iPhone the opening
 * stuttered. This draws the same idea as vector shapes: the core, each
 * satellite, and between them the stretched "metaball" bridge (two cubic
 * curves hugging both circles, after Hiroyuki Sato's construction as written
 * up by Varun Vachhar), rebuilt each frame from spring physics. The bridge
 * thins as a satellite leaves and snaps once it is far enough out, and pours
 * back in on close. One small path per frame; no filter anywhere.
 *
 * Geometry matches the gooey cluster exactly (same core, same landing spots,
 * same labels), so the two read as one design on different engines.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { Icon, type LucideIcon } from '@/components/ui/Icon';
import { IconSwap } from '@/components/ui/Motion';

export interface MetaballAction {
  key: string;
  label: string;
  icon: LucideIcon;
  glyph?: React.ReactNode;
  href?: string;
  onSelect?: () => void;
}

const BOX_W = 240;
const BOX_H = 200;
/** The shared centre: 48px above the bar's bottom edge, as in shell.css. */
const CX = BOX_W / 2;
const CY = BOX_H - 48;
const CORE_R = 26;
const SAT_R = 22;
const STAGGER_MS = 40;
/** Bouncy on the way out, a little firmer back in. */
const OPEN = { stiffness: 320, damping: 17 };
const CLOSE = { stiffness: 420, damping: 30 };

type Point = [number, number];

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleOf = (a: Point, b: Point) => Math.atan2(a[1] - b[1], a[0] - b[0]);
const vec = (c: Point, a: number, r: number): Point => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
const fmt = (p: Point) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;

function circle(c: Point, r: number): string {
  return `M ${(c[0] - r).toFixed(2)} ${c[1].toFixed(2)} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

/** The bridge between two circles, or '' once they are too far apart. */
export function metaballBridge(r1: number, r2: number, c1: Point, c2: Point, handle = 2.4, v = 0.5): string {
  const d = dist(c1, c2);
  const maxDist = r1 + r2 * 2.5;
  if (r1 === 0 || r2 === 0 || d > maxDist || d <= Math.abs(r1 - r2)) return '';
  let u1 = 0;
  let u2 = 0;
  if (d < r1 + r2) {
    u1 = Math.acos((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d));
    u2 = Math.acos((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d));
  }
  const between = angleOf(c2, c1);
  const maxSpread = Math.acos((r1 - r2) / d);
  const a1 = between + u1 + (maxSpread - u1) * v;
  const a2 = between - u1 - (maxSpread - u1) * v;
  const a3 = between + Math.PI - u2 - (Math.PI - u2 - maxSpread) * v;
  const a4 = between - Math.PI + u2 + (Math.PI - u2 - maxSpread) * v;
  const p1 = vec(c1, a1, r1);
  const p2 = vec(c1, a2, r1);
  const p3 = vec(c2, a3, r2);
  const p4 = vec(c2, a4, r2);
  const total = r1 + r2;
  const d2 = Math.min(v * handle, dist(p1, p3) / total) * Math.min(1, (d * 2) / total);
  const h1 = vec(p1, a1 - Math.PI / 2, r1 * d2);
  const h2 = vec(p2, a2 + Math.PI / 2, r1 * d2);
  const h3 = vec(p3, a3 + Math.PI / 2, r2 * d2);
  const h4 = vec(p4, a4 - Math.PI / 2, r2 * d2);
  return `M ${fmt(p1)} C ${fmt(h1)} ${fmt(h3)} ${fmt(p3)} A ${r2} ${r2} 0 ${d > r1 ? 1 : 0} 0 ${fmt(p4)} C ${fmt(h4)} ${fmt(h2)} ${fmt(p2)} Z`;
}

/*
 * The goo on the GPU. A fragment shader measures every pixel's distance to the
 * core and the three satellites, blends those distances with a smooth minimum
 * (so two circles within ~16px of each other melt into one shape, exactly as
 * blur-then-contrast does), and paints the silhouette with an anti-aliased
 * edge and a soft shadow underneath. WebGL runs on the GPU on every phone, so
 * an iPhone and an Android draw the identical thing at full frame rate. Where
 * WebGL is unavailable the SVG path below stands in.
 */
const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;
const FRAG = `precision mediump float;
uniform vec2 res;uniform float dpr;uniform vec3 c[4];uniform vec4 fill;uniform vec4 shade;
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float field(vec2 p){float d=length(p-c[0].xy)-c[0].z;for(int i=1;i<4;i++){if(c[i].z>0.){d=smin(d,length(p-c[i].xy)-c[i].z,16.);}}return d;}
void main(){vec2 p=vec2(gl_FragCoord.x,res.y-gl_FragCoord.y)/dpr;
float d=field(p);float s=field(p-vec2(0.,3.));
float a=1.-smoothstep(-.6,.6,d);float sa=(1.-smoothstep(-2.,9.,s))*shade.a;
vec4 base=vec4(shade.rgb*sa,sa);gl_FragColor=vec4(fill.rgb*a,a)+base*(1.-a);}`;

function parseColor(value: string): [number, number, number, number] {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [0.1, 0.1, 0.1, 1];
  probe.fillStyle = value || '#1a1a1a';
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}

interface GooGl {
  draw: (circles: Array<[number, number, number]>) => void;
  recolor: () => void;
  dispose: () => void;
}

function createGooGl(canvas: HTMLCanvasElement): GooGl | null {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = BOX_W * dpr;
  canvas.height = BOX_H * dpr;
  const shader = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(gl.getUniformLocation(program, 'res'), canvas.width, canvas.height);
  gl.uniform1f(gl.getUniformLocation(program, 'dpr'), dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const uC = gl.getUniformLocation(program, 'c');
  const uFill = gl.getUniformLocation(program, 'fill');
  const uShade = gl.getUniformLocation(program, 'shade');
  const recolor = () => {
    const styles = getComputedStyle(canvas);
    const fill = parseColor(styles.getPropertyValue('--surface').trim());
    gl.uniform4f(uFill, fill[0], fill[1], fill[2], 1);
    const dark = fill[0] + fill[1] + fill[2] < 1.2;
    // Darker, stronger lift on a dark ground; a light grey whisper on paper.
    gl.uniform4f(uShade, 0, 0, 0, dark ? 0.5 : 0.16);
  };
  recolor();
  return {
    draw(circles) {
      const data = new Float32Array(12);
      circles.slice(0, 4).forEach((circle, i) => data.set(circle, i * 3));
      gl.uniform3fv(uC, data);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    recolor,
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export function MetaballCluster({
  open,
  onToggle,
  actions,
  onSelect,
  positions,
}: {
  open: boolean;
  onToggle: () => void;
  actions: MetaballAction[];
  onSelect: () => void;
  positions: Array<{ x: number; y: number }>;
}) {
  const shape = useRef<SVGPathElement>(null);
  const shade = useRef<SVGPathElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gl = useRef<GooGl | null>(null);
  const [gpu, setGpu] = useState(false);

  // One WebGL context for the life of the cluster, recoloured when the theme
  // changes; the SVG path is the fallback where there is no WebGL.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const goo = createGooGl(el);
    if (!goo) return;
    gl.current = goo;
    goo.draw([[CX, CY, CORE_R]]);
    setGpu(true);
    const observer = new MutationObserver(() => {
      goo.recolor();
      goo.draw([[CX, CY, CORE_R]]);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => {
      observer.disconnect();
      goo.dispose();
      gl.current = null;
    };
  }, []);
  const items = useRef<Array<HTMLElement | null>>([]);
  // Per satellite: progress 0 (under the core) .. 1 (landed), and velocity.
  const state = useRef(actions.map(() => ({ p: 0, v: 0 })));
  const frame = useRef(0);

  useEffect(() => {
    const target = open ? 1 : 0;
    const spring = open ? OPEN : CLOSE;
    const started = performance.now();
    let last = started;

    const draw = () => {
      const core: Point = [CX, CY];
      const circles: Array<[number, number, number]> = [[CX, CY, CORE_R]];
      let d = circle(core, CORE_R);
      state.current.forEach((s, i) => {
        const at = positions[i];
        const c: Point = [CX + at.x * s.p, CY + at.y * s.p];
        circles.push([c[0], c[1], s.p > 0.001 ? SAT_R : 0]);
        if (s.p > 0.001 && !gl.current) {
          d += ` ${circle(c, SAT_R)} ${metaballBridge(CORE_R, SAT_R, core, c)}`;
        }
        const el = items.current[i];
        if (el) {
          el.style.transform = `translate3d(${(at.x * s.p).toFixed(2)}px, ${(at.y * s.p).toFixed(2)}px, 0)`;
          el.style.opacity = String(Math.min(1, Math.max(0, (s.p - 0.35) / 0.4)));
        }
      });
      if (gl.current) {
        gl.current.draw(circles);
      } else {
        shape.current?.setAttribute('d', d);
        shade.current?.setAttribute('d', d);
      }
    };

    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      let moving = false;
      state.current.forEach((s, i) => {
        // Stagger out in order, back in the reverse order.
        const order = open ? i : state.current.length - 1 - i;
        if (now - started < order * (open ? STAGGER_MS : STAGGER_MS / 2)) {
          moving = true;
          return;
        }
        const force = -spring.stiffness * (s.p - target) - spring.damping * s.v;
        s.v += force * dt;
        s.p += s.v * dt;
        if (Math.abs(s.p - target) > 0.0005 || Math.abs(s.v) > 0.005) moving = true;
        else {
          s.p = target;
          s.v = 0;
        }
      });
      draw();
      frame.current = moving ? requestAnimationFrame(step) : 0;
    };

    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [open, positions]);

  return (
    <div className="fab fab-metaball" data-open={open ? 'true' : 'false'}>
      <canvas ref={canvas} className="fab-goo fab-goo-gl" aria-hidden="true" />
      <svg
        className="fab-goo"
        style={gpu ? { display: 'none' } : undefined}
        width={BOX_W}
        height={BOX_H}
        viewBox={`0 0 ${BOX_W} ${BOX_H}`}
        aria-hidden="true"
        focusable="false"
      >
        {/* A soft edge without a blur: the same shape a little lower and
            fainter underneath, which is all the lift the silhouette needs. */}
        <path ref={shade} className="fab-goo-shade" d={circle([CX, CY], CORE_R)} />
        <path ref={shape} className="fab-goo-fill" d={circle([CX, CY], CORE_R)} />
      </svg>
      {actions.map((action, index) => {
        const content = action.glyph ?? <Icon icon={action.icon} size={20} weight="medium" />;
        const common = {
          className: 'fab-satellite fab-metaball-satellite',
          'aria-label': action.label,
          tabIndex: open ? 0 : -1,
          'aria-hidden': !open,
          style: { opacity: 0 } as CSSProperties,
        };
        return action.href ? (
          <Link
            key={action.key}
            href={action.href}
            {...common}
            ref={(el) => {
              items.current[index] = el;
            }}
            onClick={onSelect}
          >
            {content}
          </Link>
        ) : (
          <button
            key={action.key}
            type="button"
            {...common}
            ref={(el) => {
              items.current[index] = el;
            }}
            onClick={() => {
              onSelect();
              action.onSelect?.();
            }}
          >
            {content}
          </button>
        );
      })}
      <button
        type="button"
        className="fab-core fab-metaball-core"
        aria-label={open ? 'Close lookup' : 'Lookup'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={onToggle}
      >
        <IconSwap token={open ? 'close' : 'open'}>
          <Icon icon={open ? X : Search} size={24} weight="medium" />
        </IconSwap>
      </button>
      {actions.map((action, index) => (
        <span
          key={action.key}
          className="fab-label"
          aria-hidden="true"
          style={{
            left: `calc(50% + ${positions[index].x}px)`,
            bottom: `${-positions[index].y + 48 + 28}px`,
          }}
        >
          {action.label}
        </span>
      ))}
    </div>
  );
}
