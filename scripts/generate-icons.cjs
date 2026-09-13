#!/usr/bin/env node
/**
 * Generates the PWA icon set for Edison Helpdesk.
 *
 * Renders the brand mark — a brass square with an ink "E" — as an inline SVG
 * page in headless Chromium and screenshots it to PNG. This is a one-off
 * generation script: run it and commit the resulting PNGs under
 * public/icons/. It is not part of the build.
 *
 * Rather than trust a guessed font-size to land the "E" at the right visual
 * height, this script measures the glyph's actual rendered bounding box
 * (SVGGraphicsElement#getBBox) and solves for a font-size that hits the
 * target height, then re-measures and translates the glyph to the exact
 * geometric centre. That keeps the mark correct whether IBM Plex Sans is
 * available to the headless browser or it falls back to a system sans.
 *
 * Two background styles:
 *  - "rounded": a rounded square (22% corner radius) rendered on a
 *    transparent page background, screenshotted with the background
 *    omitted, so the corners outside the rounded square are transparent
 *    (RGBA). Used for icon-192.png and icon-512.png.
 *  - "full-bleed": brass fills the entire canvas edge to edge with no
 *    rounding and no transparency (the OS applies its own mask shape), and
 *    the letter is sized to sit inside an 80%-of-canvas safe zone so it
 *    survives whatever mask is applied. Used for icon-maskable-512.png and
 *    apple-touch-icon.png — iOS applies its own rounding to the touch icon,
 *    so a transparent-cornered icon there would show a black background
 *    instead of brass.
 *
 * Usage (this machine — Playwright lives outside this repo):
 *   PLAYWRIGHT_MODULE=/home/tanavm/LMS/node_modules/playwright node scripts/generate-icons.cjs
 * Elsewhere, with Playwright installed as a normal dependency, just:
 *   node scripts/generate-icons.cjs
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS generation script, not part of the app build. */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
/* eslint-enable @typescript-eslint/no-require-imports */

const BRASS = '#d4a72c';
const INK = '#0f1f3d';
const LETTER_HEIGHT_RATIO = 0.55; // of the "square" (full icon for rounded, safe zone for full-bleed)
const SAFE_ZONE_RATIO = 0.8; // fraction of the canvas that is guaranteed visible under any mask
const CORNER_RADIUS_RATIO = 0.22;

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/** @type {Array<{ file: string, size: number, fullBleed: boolean, transparent: boolean }>} */
const ICONS = [
  { file: 'icon-192.png', size: 192, fullBleed: false, transparent: true },
  { file: 'icon-512.png', size: 512, fullBleed: false, transparent: true },
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true, transparent: false },
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true, transparent: false },
];

function pageHtml(size, fullBleed) {
  const rx = fullBleed ? 0 : Math.round(size * CORNER_RADIUS_RATIO);
  const background = `<rect x="0" y="0" width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${BRASS}" />`;

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
      <!-- font-family falls back to system-ui/sans-serif when IBM Plex Sans isn't installed for this headless browser -->
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

async function renderIcon(browser, { size, fullBleed, transparent }) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });

  await page.setContent(pageHtml(size, fullBleed), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const targetHeight = fullBleed
    ? size * SAFE_ZONE_RATIO * LETTER_HEIGHT_RATIO
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
  const buffer = await svgHandle.screenshot({ omitBackground: transparent });
  await page.close();
  return buffer;
}

/** Reads the PNG IHDR colour type (2 = RGB, 6 = RGBA) straight from the file bytes. */
function pngColorType(buffer) {
  return buffer.readUInt8(25);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const icon of ICONS) {
      const buffer = await renderIcon(browser, icon);
      const outPath = path.join(OUT_DIR, icon.file);
      fs.writeFileSync(outPath, buffer);
      const colorType = pngColorType(buffer);
      console.log(
        `wrote ${path.relative(process.cwd(), outPath)} (${icon.size}x${icon.size}${icon.fullBleed ? ', full-bleed' : ', rounded'}, colour type ${colorType}${colorType === 6 ? '/RGBA' : colorType === 2 ? '/RGB' : ''})`,
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
