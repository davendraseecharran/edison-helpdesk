#!/usr/bin/env node
/**
 * Bakes the OpenAI mark into the point cloud `ThinkingLogo` animates, and
 * writes it to `src/components/ai/openai-mark.baked.ts`.
 *
 * Run once, by hand, when the artwork or the sizes we render it at change.
 * The result is checked in, so nothing at build time or at run time ever
 * touches a rasteriser: `thinking-logos` will happily bake in the browser,
 * but that means a canvas, an image decode and a Poisson sampler on the main
 * thread before a 20px glyph in the top bar can draw its first frame.
 *
 * The bake needs a DOM canvas, so it runs inside headless Chromium with the
 * library's own ESM bundle inlined. Playwright lives outside this repository
 * on this machine; point `PLAYWRIGHT_MODULE` at an install.
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
 *   node scripts/bake-openai-mark.cjs
 *
 * Two sets come out, because dots need about two pixels of pitch to resolve
 * as separate marks: one sized for the 20px chrome glyph and one for the
 * 44px connect card. Baking once at the larger count and scaling down turns
 * the knot into a smudge.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node/Playwright runner, outside the bundler. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.resolve(__dirname, '..');

/**
 * OpenAI's mark, the monochrome single-path form, from `@lobehub/icons`
 * (`es/OpenAI/components/Mono.js`, viewBox 0 0 24 24, fill-rule evenodd).
 * Copied rather than imported because this script runs in a browser page
 * with no bundler and the icon package ships JSX.
 */
const OPENAI_PATH =
  'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

/**
 * The two sets, and why each is shaped the way it is.
 *
 * `both` traces the silhouette and then fills behind it. The OpenAI knot is a
 * filigree of thin ribbons: a pure fill at a legible count loses the ribbon
 * edges and reads as a blob, and a pure outline at 20px reads as a ring of
 * loose dots. Tracing first spends the dots where the shape is.
 */
const SETS = [
  { name: 'MARK_SMALL', renderedAt: 20, count: 120, style: 'outline', shell: 'flat', depth: 0.06 },
  { name: 'MARK_LARGE', renderedAt: 44, count: 420, style: 'both', shell: 'dome', depth: 0.34 },
];

async function main() {
  const bundle = fs.readFileSync(
    path.join(root, 'node_modules', 'thinking-logos', 'dist', 'bake.es.js'),
    'utf8',
  );

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>bake</title>');
  await page.addScriptTag({ content: bundle, type: 'module' });
  // The module has no side effect that signals readiness, so hand it the work
  // through a second module that imports nothing and is evaluated after it.
  const baked = await page.evaluate(
    async ({ bundleSource, path: d, sets }) => {
      const url = URL.createObjectURL(new Blob([bundleSource], { type: 'text/javascript' }));
      const { bakeLogo, serializeLogo } = await import(/* webpackIgnore: true */ url);
      const out = {};
      for (const set of sets) {
        const points = await bakeLogo(
          { path: d, viewBox: 24 },
          {
            count: set.count,
            style: set.style,
            shell: set.shell,
            depth: set.depth,
            resolution: 512,
            seed: 7,
          },
        );
        out[set.name] = serializeLogo(points);
      }
      URL.revokeObjectURL(url);
      return out;
    },
    { bundleSource: bundle, path: OPENAI_PATH, sets: SETS },
  );
  await browser.close();

  const header = `// Generated by scripts/bake-openai-mark.cjs — do not edit by hand.
//
// OpenAI's mark, baked into the point cloud \`ThinkingLogo\` animates. Baking
// at run time means a canvas, an image decode and a Poisson sampler before a
// 20px glyph in the top bar draws its first frame, so it happens once here
// and the result is checked in.
//
// Two sets, because dots need roughly two pixels of pitch to resolve as
// separate marks: ${SETS.map((s) => `${s.count} for ${s.renderedAt}px`).join(', ')}.

import { deserializeLogo } from 'thinking-logos/bake';
import type { LogoPointSet } from 'thinking-logos';
`;

  const body = SETS.map((set) => {
    const json = JSON.stringify(baked[set.name]);
    return `
/** The mark at ${set.count} dots, for the ${set.renderedAt}px rendering. */
export const ${set.name}: LogoPointSet = deserializeLogo(
  ${json},
);`;
  }).join('\n');

  const file = path.join(root, 'src', 'components', 'ai', 'openai-mark.baked.ts');
  fs.writeFileSync(file, `${header}${body}\n`);
  const size = fs.statSync(file).size;
  process.stdout.write(`wrote ${path.relative(root, file)} (${Math.round(size / 1024)} kB)\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
