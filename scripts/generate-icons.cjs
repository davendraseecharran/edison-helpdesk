#!/usr/bin/env node
/**
 * Generates the PWA icon set for Edison Helpdesk.
 *
 * The mark is the wordmark: "Edison" in medium over "Helpdesk" in regular, set
 * in Geist on the interface's own ground, in the interface's own ink. It
 * replaces a brass square holding a capital E — a boxed initial is the house
 * style of every generated product, and a letter in a coloured tile says
 * nothing about what this is. A lamp glyph was drawn first and thrown away: a
 * dot over a rule reads as a bullet point, and a mark that could belong to
 * anything is worth less than the name.
 *
 * Geist is embedded from the `geist` package as base64, so the headless
 * browser sets the real typeface rather than falling back to a system sans and
 * producing an icon that does not match the application.
 *
 * Rendered as an inline SVG page in headless Chromium and screenshotted to
 * PNG. This is a one-off generation script: run it and commit the resulting
 * PNGs under public/icons/. It is not part of the build.
 *
 * Two background styles:
 *  - "rounded": a rounded square (22% corner radius) rendered on a
 *    transparent page background, screenshotted with the background omitted,
 *    so the corners outside the rounded square are transparent (RGBA). Used
 *    for icon-192.png and icon-512.png.
 *  - "full-bleed": the ground fills the canvas edge to edge with no rounding
 *    and no transparency (the OS applies its own mask shape), and the glyph is
 *    drawn inside an 80%-of-canvas safe zone so it survives whatever mask is
 *    applied. Used for icon-maskable-512.png and apple-touch-icon.png — iOS
 *    rounds the touch icon itself, so a transparent-cornered icon there would
 *    show black in the corners.
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

/* The dark theme's ground and its primary ink, from src/styles/tokens.css. */
const GROUND = '#0f0f10';
const INK = '#f2f2f3';

const SAFE_ZONE_RATIO = 0.8; // fraction of the canvas guaranteed visible under any mask
const CORNER_RADIUS_RATIO = 0.22;

/* The wordmark, as fractions of the square it is drawn inside. */
const WORD_SIZE_RATIO = 0.18; // cap height of each line
const LINE_GAP_RATIO = 1.16; // baseline to baseline, as a multiple of the size
const TRACKING = '-0.03em';

/** Geist, embedded, so the headless browser sets the real typeface. */
function fontFace(file, weight) {
  const data = fs
    .readFileSync(path.join(__dirname, '..', 'node_modules', 'geist', 'dist', 'fonts', 'geist-sans', file))
    .toString('base64');
  return `@font-face {
        font-family: 'Geist Icon';
        font-weight: ${weight};
        font-style: normal;
        src: url(data:font/woff2;base64,${data}) format('woff2');
      }`;
}

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
  const background = `<rect x="0" y="0" width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${GROUND}" />`;

  // The wordmark is laid out inside `square`, which is the whole canvas for a
  // rounded icon and the safe zone for a full-bleed one, then centred.
  const square = fullBleed ? size * SAFE_ZONE_RATIO : size;
  const fontSize = square * WORD_SIZE_RATIO;
  const lineGap = fontSize * LINE_GAP_RATIO;
  const mid = size / 2;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${fontFace('Geist-Medium.woff2', 500)}
      ${fontFace('Geist-Regular.woff2', 400)}
      html, body { margin: 0; padding: 0; background: transparent; }
      svg { display: block; }
      text { font-family: 'Geist Icon', system-ui, sans-serif; letter-spacing: ${TRACKING}; }
    </style>
  </head>
  <body>
    <svg id="mark" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${background}
      <text
        x="${mid}"
        y="${mid - lineGap / 2}"
        text-anchor="middle"
        dominant-baseline="central"
        font-size="${fontSize}"
        font-weight="500"
        fill="${INK}"
      >Edison</text>
      <text
        x="${mid}"
        y="${mid + lineGap / 2}"
        text-anchor="middle"
        dominant-baseline="central"
        font-size="${fontSize}"
        font-weight="400"
        fill="${INK}"
        opacity="0.72"
      >Helpdesk</text>
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
