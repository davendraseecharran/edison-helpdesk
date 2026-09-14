#!/usr/bin/env node
/**
 * Photographs the assistant: the orb gallery in every state on both themes,
 * the panel in every scripted scenario at desktop and phone widths, and,
 * when credentials are supplied, the real panel on /queue.
 *
 * Development tooling, not part of the build. Needs the dev server running
 * (`npm run dev -- -p 3005`) and Playwright with Chromium, which on this
 * machine lives outside the repo:
 *
 *   PLAYWRIGHT_MODULE=/home/tanavm/LMS/node_modules/playwright \
 *   REVIEW_BASE_URL=http://127.0.0.1:3005 \
 *   node scripts/orb-preview.cjs
 *
 * Optional: REVIEW_EMAIL and REVIEW_PASSWORD sign in and photograph /queue
 * with the panel open; REVIEW_ONLY=orb|demo|live limits the run, and
 * REVIEW_SCENARIOS=welcome,approval limits the demo to those scenarios.
 * Output: /tmp/edison-overhaul-review/task27/ (REVIEW_OUTPUT_DIR overrides).
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node/Playwright runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:3005';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Local preview only');
}
const out = process.env.REVIEW_OUTPUT_DIR || '/tmp/edison-overhaul-review/task27';
const only = process.env.REVIEW_ONLY || 'all';
fs.mkdirSync(out, { recursive: true });

const THEMES = ['dark', 'light'];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Scenario → what to wait for before the frames, and how many frames. */
const SCENARIOS = {
  welcome: { wait: '.ai-welcome .ai-example', frames: 1 },
  streaming: { wait: '.ai-md-live', frames: 2, gap: 900 },
  reasoning: { wait: '.ai-thinking[data-live]', frames: 2, gap: 700 },
  tools: { wait: '.ai-chip', frames: 3, gap: 1400 },
  approval: { wait: '.ai-approval', frames: 2, gap: 600 },
  error: { wait: '.ai-error', frames: 1, settle: 600 },
  notice: { wait: '.ai-md', frames: 1, settle: 2500 },
  history: { wait: '.ai-turns', frames: 1, settle: 400 },
  conversations: { wait: '.ai-conversation-row', frames: 1, before: 'conversations' },
  connect: { wait: '.ai-connect', frames: 1, settle: 500 },
  pairing: { wait: '.ai-code', frames: 2, gap: 700 },
  disabled: { wait: '.ai-note', frames: 1, settle: 500 },
  listening: { wait: '.ai-composer', frames: 2, gap: 700, before: 'listen' },
  menu: { wait: '.ai-welcome', frames: 1, before: 'menu' },
};

const errors = [];

async function frames(page, file, count, gap) {
  for (let i = 0; i < count; i += 1) {
    await page.screenshot({ path: path.join(out, count > 1 ? `${file}-${i + 1}.png` : `${file}.png`) });
    if (i < count - 1) await page.waitForTimeout(gap);
  }
}

async function orbGallery(browser) {
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`orb/${theme}: ${error.message}`));
    await page.goto(`${base}/dev/orb?theme=${theme}`);
    await page.waitForSelector('[data-moment-card="error"] canvas');
    await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
    await page.waitForTimeout(600);
    await frames(page, `orb-${theme}`, 3, 400);
    await context.close();
  }
}

async function runScenario(browser, name, theme, viewport, tag) {
  const spec = SCENARIOS[name];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: viewport === PHONE });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}/${theme}/${tag}: ${error.message}`));
  await page.goto(`${base}/dev/ai-demo?scenario=${name}&theme=${theme}`);
  await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
  await page.waitForSelector('.ai-panel', { timeout: 15000 });
  // Let the spring finish: a frame taken mid-slide shows a panel half off
  // the edge and an orb that has not painted yet.
  await page.waitForFunction(() => {
    const panel = document.querySelector('.ai-panel');
    if (!panel) return false;
    const transform = getComputedStyle(panel).transform;
    return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
  }, undefined, { timeout: 10000 });
  await page.waitForSelector('.ai-panel canvas', { timeout: 10000 });
  await page.waitForTimeout(250);
  if (spec.before === 'listen') {
    await page.waitForSelector('.ai-mic');
    await page.click('.ai-mic');
    await page.waitForTimeout(1200);
  }
  if (spec.before === 'menu' || spec.before === 'conversations') {
    await page.waitForSelector('[aria-label="Assistant menu"]');
    await page.click('[aria-label="Assistant menu"]');
    await page.waitForSelector('.ai-menu');
  }
  if (spec.before === 'conversations') {
    await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  }
  await page.waitForSelector(spec.wait, { timeout: 20000 });
  if (spec.settle) await page.waitForTimeout(spec.settle);
  await frames(page, `demo-${name}-${theme}-${tag}`, spec.frames, spec.gap || 400);
  await context.close();
}

async function demo(browser) {
  const wanted = (process.env.REVIEW_SCENARIOS || '').split(',').filter(Boolean);
  for (const name of Object.keys(SCENARIOS)) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    for (const theme of THEMES) {
      for (const [viewport, tag] of [[DESKTOP, '1440'], [PHONE, '390']]) {
        try {
          await runScenario(browser, name, theme, viewport, tag);
        } catch (error) {
          errors.push(`${name}/${theme}/${tag}: ${error.message}`);
        }
      }
    }
  }
}

async function live(browser) {
  const email = process.env.REVIEW_EMAIL;
  const password = process.env.REVIEW_PASSWORD;
  if (!email || !password) {
    console.log('skip live: REVIEW_EMAIL and REVIEW_PASSWORD not set');
    return;
  }
  for (const [viewport, tag] of [[DESKTOP, '1440'], [PHONE, '390']]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: viewport === PHONE });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`live/${tag}: ${error.message}`));
    await page.goto(`${base}/login`);
    // The password form sits in a disclosure under the Google button.
    await page.locator('.auth-disclosure summary').click();
    await page.getByLabel('School email', { exact: true }).fill(email);
    await page.getByLabel('App password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/queue', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `live-queue-closed-${tag}.png`) });
    await page.keyboard.press('Control+j');
    await page.waitForSelector('.ai-panel', { timeout: 10000 });
    await page.waitForSelector('.ai-connect, .ai-note, .ai-welcome', { timeout: 15000 });
    await page.waitForTimeout(700);
    await frames(page, `live-queue-open-${tag}`, 2, 700);
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    if (only === 'all' || only === 'orb') await orbGallery(browser);
    if (only === 'all' || only === 'demo') await demo(browser);
    if (only === 'all' || only === 'live') await live(browser);
  } finally {
    await browser.close();
  }
  if (errors.length > 0) {
    console.error('Problems:');
    for (const line of errors) console.error(` - ${line}`);
    process.exitCode = 1;
  }
  console.log(`Screenshots in ${out}`);
})();
