#!/usr/bin/env node
/**
 * Generates the PWA icon set for Edison Helpdesk.
 *
 * Renders the brand mark — a brass rounded square with an ink "E" — as an
 * inline SVG page in headless Chromium (via the Playwright install at
 * /home/tanavm/LMS/node_modules/playwright) and screenshots it to PNG. This
 * is a one-off generation script: run it and commit the resulting PNGs under
 * public/icons/. It is not part of the build.
 *
 * Rather than trust a guessed font-size to land the "E" at the right visual
 * height, this script measures the glyph's actual rendered bounding box
 * (SVGGraphicsElement#getBBox) and solves for a font-size that hits the
 * target height, then re-measures and translates the glyph to the exact
 * geometric centre. That keeps the mark correct whether IBM Plex Sans is
 * available to the headless browser or it falls back to a system sans.
 *
 * Usage: node scripts/generate-icons.cjs
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS generation script, not part of the app build. */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('/home/tanavm/LMS/node_modules/playwright');
/* eslint-enable @typescript-eslint/no-require-imports */

const BRASS = '#d4a72c';
const INK = '#0f1f3d';
const LETTER_HEIGHT_RATIO = 0.55; // of the "square" (full icon for regular, safe zone for maskable)
const MASKABLE_SAFE_ZONE_RATIO = 0.8; // fraction of the canvas that is guaranteed visible
const CORNER_RADIUS_RATIO = 0.22;

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/** @type {Array<{ file: string, size: number, maskable: boolean }>} */
const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

function pageHtml(size, maskable) {
  const rx = maskable ? 0 : Math.round(size * CORNER_RADIUS_RATIO);
  const background = maskable
    ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${BRASS}" />`
    : `<rect x="0" y="0" width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${BRASS}" />`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      svg { display: block; }
    </style>
  </head>
  <body>
    <svg id="mark" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${background}
      <text
        id="letter"
        x="50%"
        y="50%"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="'IBM Plex Sans', system-ui, sans-serif"
        font-weight="600"
        font-size="${Math.round(size * 0.6)}"
        fill="${INK}"
      >E</text>
    </svg>
  </body>
</html>`;
}

async function renderIcon(browser, { size, maskable }) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });

  await page.setContent(pageHtml(size, maskable), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const targetHeight = maskable
    ? size * MASKABLE_SAFE_ZONE_RATIO * LETTER_HEIGHT_RATIO
    : size * LETTER_HEIGHT_RATIO;

  await page.evaluate(
    ({ targetHeight, size }) => {
      const text = document.getElementById('letter');

      // Solve for the font-size that makes the glyph's tight bounding box
      // hit the target height, then translate the glyph so its bbox centre
      // lands exactly on the canvas centre.
      const currentSize = parseFloat(text.getAttribute('font-size'));
      const bbox1 = text.getBBox();
      const scale = targetHeight / bbox1.height;
      text.setAttribute('font-size', String(currentSize * scale));

      const bbox2 = text.getBBox();
      const cx = bbox2.x + bbox2.width / 2;
      const cy = bbox2.y + bbox2.height / 2;
      const dx = size / 2 - cx;
      const dy = size / 2 - cy;
      text.setAttribute('transform', `translate(${dx} ${dy})`);
    },
    { targetHeight, size },
  );

  const svgHandle = await page.$('#mark');
  const buffer = await svgHandle.screenshot({ omitBackground: false });
  await page.close();
  return buffer;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const icon of ICONS) {
      const buffer = await renderIcon(browser, icon);
      const outPath = path.join(OUT_DIR, icon.file);
      fs.writeFileSync(outPath, buffer);
      console.log(`wrote ${path.relative(process.cwd(), outPath)} (${icon.size}x${icon.size}${icon.maskable ? ', maskable' : ''})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
