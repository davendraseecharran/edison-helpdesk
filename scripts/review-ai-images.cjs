#!/usr/bin/env node
/**
 * Pastes a picture into the assistant's composer and reads what goes on the
 * wire.
 *
 * Three things a screenshot cannot show on its own, asserted rather than
 * looked at:
 *
 *   1. a pasted image becomes a chip with a thumbnail in it;
 *   2. sending puts exactly one picture in the request body, as a data URL of
 *      a type the Responses API reads (the route turns that into the
 *      `input_image` part, which `tests/ai/route.test.ts` asserts);
 *   3. the picture is in the transcript where it was sent, so the conversation
 *      can be read back.
 *
 * It runs against `/dev/ai-demo?scenario=pictures`, which is the panel with a
 * connected status and the REAL transport, and it intercepts `/api/ai/chat`
 * itself — so no ChatGPT account and no database fixtures are involved.
 *
 * Development tooling, not part of the build. Needs a dev server already
 * running and Playwright with Chromium, which on this machine lives outside
 * the repo:
 *
 *   PLAYWRIGHT_MODULE=/home/tanavm/LMS/node_modules/playwright \
 *   REVIEW_BASE_URL=http://127.0.0.1:3005 \
 *   REVIEW_OUTPUT_DIR=/tmp/edison-overhaul-review/p2-4b \
 *   node scripts/review-ai-images.cjs
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node/Playwright runner, outside the bundler. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:3000';
if (!LOOPBACK.includes(new URL(base).hostname)) throw new Error('Local preview only');

const out = process.env.REVIEW_OUTPUT_DIR || '/tmp/edison-overhaul-review/p2-4b';
fs.mkdirSync(out, { recursive: true });

const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
];

const problems = [];
let stage = 'start';

/**
 * A small PNG, drawn rather than shipped: a repository should not carry a
 * binary fixture for a test that can make its own. 320x200 so the downscale
 * has nothing to do and the bytes the browser sends are the bytes made here.
 */
function pngFixture() {
  const zlib = require('node:zlib'); // eslint-disable-line @typescript-eslint/no-require-imports
  const width = 320;
  const height = 200;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0; // filter: none
    at += 1;
    for (let x = 0; x < width; x += 1) {
      raw[at] = (x * 255) / width;
      raw[at + 1] = (y * 255) / height;
      raw[at + 2] = 160;
      at += 3;
    }
  }

  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const FIXTURE = `data:image/png;base64,${pngFixture().toString('base64')}`;

/** One NDJSON reply, so the panel renders a complete turn. */
function scriptedReply() {
  return [
    { type: 'conversation', id: 'review' },
    { type: 'phase', phase: 'writing' },
    { type: 'delta', text: 'That is a cracked panel, top right. Raise a repair ticket for it?' },
    { type: 'done' },
  ]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join('');
}

async function assertNoOverflow(page, where) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  if (widths.scroll > widths.inner) {
    problems.push(`${where}: horizontal overflow (${widths.scroll} > ${widths.inner})`);
  }
}

/** Puts a file on the clipboard and pastes it into the focused field. */
async function pasteImage(page, dataUrl, name) {
  await page.locator('.ai-composer-field').click();
  await page.evaluate(
    async ([url, filename]) => {
      const bytes = await fetch(url).then((response) => response.blob());
      const file = new File([bytes], filename, { type: bytes.type });
      const data = new DataTransfer();
      data.items.add(file);
      const field = document.querySelector('.ai-composer-field');
      field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [dataUrl, name],
  );
}

(async () => {
  stage = 'browser';
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });

  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        const label = `${theme}/${viewport.name}`;
        stage = label;

        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await context.addInitScript(
          ([key, value]) => {
            try {
              window.localStorage.setItem(key, value);
            } catch {
              /* a browser that blocks storage still renders, in the default theme */
            }
          },
          ['edison.theme', theme],
        );
        const page = await context.newPage();
        page.setDefaultTimeout(45000);
        page.on('pageerror', (error) =>
          problems.push(`${label}: runtime error: ${error.message.split('\n')[0]}`),
        );
        page.on('console', (message) => {
          if (message.type() === 'error') {
            problems.push(`${label}: console error: ${message.text().split('\n')[0]}`);
          }
        });

        // The route, intercepted: what the composer put on the wire is read
        // here, and a scripted reply goes back so the turn completes.
        let sent = null;
        await page.route('**/api/ai/chat', async (route) => {
          try {
            sent = route.request().postDataJSON();
          } catch {
            sent = 'unreadable';
          }
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
            body: scriptedReply(),
          });
        });

        stage = `${label} open`;
        await page.goto(`${base}/dev/ai-demo?scenario=pictures&theme=${theme}`);
        await page.locator('.ai-composer-field').waitFor();
        await page.evaluate(() => document.fonts.ready);

        stage = `${label} paste`;
        await pasteImage(page, FIXTURE, 'cracked-screen.png');
        const chip = page.locator('.ai-attachment');
        await chip.first().waitFor();
        if ((await chip.count()) !== 1) {
          problems.push(`${label}: pasting one picture made ${await chip.count()} chips`);
        }
        const thumb = page.locator('.ai-attachment-thumb').first();
        const thumbBox = await thumb.boundingBox();
        if (!thumbBox || Math.round(thumbBox.width) !== 40 || Math.round(thumbBox.height) !== 40) {
          problems.push(`${label}: the thumbnail is ${JSON.stringify(thumbBox)}, not 40x40`);
        }
        await page.locator('.ai-composer-field').fill('What is wrong with this screen?');
        await page.waitForTimeout(200);
        await assertNoOverflow(page, `${label} composer with a chip`);
        await page.screenshot({
          path: path.join(out, `${theme}-${viewport.name}-composer-chip.png`),
          fullPage: true,
        });

        stage = `${label} send`;
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('.ai-bubble-image').length > 0);
        await page.waitForTimeout(600);

        // 1. One picture, once.
        if (!sent || sent === 'unreadable' || !Array.isArray(sent.images)) {
          problems.push(`${label}: the request carried no pictures`);
        } else if (sent.images.length !== 1) {
          problems.push(`${label}: the request carried ${sent.images.length} pictures, not 1`);
        } else {
          const only = sent.images[0];
          if (!String(only.dataUrl).startsWith('data:image/png;base64,')) {
            problems.push(`${label}: the picture is not a PNG data URL`);
          }
          if (only.name !== 'cracked-screen.png') {
            problems.push(`${label}: the picture lost its name (${only.name})`);
          }
          if (sent.message !== 'What is wrong with this screen?') {
            problems.push(`${label}: the words did not travel with the picture`);
          }
        }

        // 2. The chips are gone once the turn is sent, and the picture is in
        //    the transcript instead.
        if ((await page.locator('.ai-attachment').count()) !== 0) {
          problems.push(`${label}: the chip stayed in the composer after sending`);
        }
        if ((await page.locator('.ai-bubble-image').count()) !== 1) {
          problems.push(`${label}: the sent picture is not in the transcript`);
        }
        await assertNoOverflow(page, `${label} transcript`);
        await page.screenshot({
          path: path.join(out, `${theme}-${viewport.name}-sent.png`),
          fullPage: true,
        });

        // 3. The fifth picture is refused, in a sentence.
        stage = `${label} fifth`;
        for (let n = 0; n < 5; n += 1) await pasteImage(page, FIXTURE, `angle-${n}.png`);
        await page.locator('.ai-composer-notice').waitFor();
        const notice = (await page.locator('.ai-composer-notice').textContent()) ?? '';
        if (!notice.toLowerCase().includes('4 pictures')) {
          problems.push(`${label}: the fifth picture was refused with "${notice}"`);
        }
        if ((await page.locator('.ai-attachment').count()) !== 4) {
          problems.push(`${label}: ${await page.locator('.ai-attachment').count()} chips after offering five`);
        }
        await assertNoOverflow(page, `${label} four chips`);
        await page.screenshot({
          path: path.join(out, `${theme}-${viewport.name}-four-and-a-refusal.png`),
          fullPage: true,
        });

        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  stage = 'report';
  const captures = fs.readdirSync(out).filter((name) => name.endsWith('.png')).length;
  console.log(`Captures: ${captures} PNGs in ${out}`);
  if (problems.length) {
    console.error(`FAIL ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS pictures paste, send as one attachment, and come back in the transcript');
})().catch((error) => {
  const message = String(error && error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]');
  console.error(`Image review failed at ${stage}: ${message}`);
  process.exitCode = 1;
});
