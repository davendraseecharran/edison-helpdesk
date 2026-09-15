#!/usr/bin/env node
/**
 * Photographs the Today screen, the keyboard model and the palette's paste
 * recogniser, and asserts the three things a screenshot cannot show on its
 * own: that no page scrolls sideways, that no page logs a browser error, and
 * that exactly one element on the screen wears the lamp.
 *
 * Development tooling, not part of the build. It needs the dev server already
 * running and Playwright with Chromium, which on this machine lives outside
 * the repo:
 *
 *   PLAYWRIGHT_MODULE=/home/tanavm/LMS/node_modules/playwright \
 *   REVIEW_BASE_URL=http://127.0.0.1:3005 \
 *   REVIEW_OUTPUT_DIR=/tmp/edison-overhaul-review/p2-4 \
 *   node scripts/review-today.cjs
 *
 * It creates its own synthetic administrator through the LOCAL Supabase admin
 * API and seeds tickets through the ordinary RPCs, so row-level security is
 * exercised rather than bypassed. Local only by construction: the base URL and
 * the Supabase URL must both be loopback, and a linked project aborts the run.
 * It never resets the database.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node/Playwright runner, outside the bundler. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.resolve(__dirname, '..');
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:3000';
if (!LOOPBACK.includes(new URL(base).hostname)) throw new Error('Local preview only');

for (const marker of ['project-ref', 'remote-db-url', 'pooler-url']) {
  if (fs.existsSync(path.join(root, 'supabase', '.temp', marker))) {
    throw new Error('Refusing a linked project');
  }
}

/** `.env.local` as a plain object. Values are secret; nothing here prints one. */
function readEnvLocal() {
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) throw new Error('No .env.local — copy .env.example and fill it in');
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnvLocal();
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) throw new Error(`.env.local is missing ${key}`);
}
if (!LOOPBACK.includes(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname)) {
  throw new Error('Local database only');
}

const out = process.env.REVIEW_OUTPUT_DIR || '/tmp/edison-overhaul-review/p2-4';
fs.mkdirSync(out, { recursive: true });

const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
];

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const runId = randomUUID().slice(0, 8);
const people = {};
const problems = [];
let stage = 'preflight';

const ok = (result) => {
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

async function makeAccount(key, role, displayName) {
  const email = `today-${key}-${runId}@edison.example`;
  const password = `Review-${randomUUID()}`;
  const created = ok(await service.auth.admin.createUser({ email, password, email_confirm: true }));
  ok(
    await service
      .from('app_accounts')
      .insert({ id: created.user.id, email, display_name: displayName, role, status: 'active' }),
  );
  people[key] = { id: created.user.id, email, password, displayName };
  return people[key];
}

async function sessionFor(key) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ok(await client.auth.signInWithPassword({ email: people[key].email, password: people[key].password }));
  return client;
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

/** Every element wearing `--edge-light`, read from a probe rather than by colour. */
async function litElements(page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.boxShadow = 'var(--edge-light)';
    document.body.append(probe);
    const lamp = getComputedStyle(probe).boxShadow;
    probe.remove();
    const lit = [];
    for (const element of document.querySelectorAll('body *')) {
      if (getComputedStyle(element).boxShadow !== lamp) continue;
      const classes = (element.getAttribute('class') || '').trim();
      lit.push(element.tagName.toLowerCase() + (classes ? `.${classes.split(/\s+/).join('.')}` : ''));
    }
    return lit;
  });
}

async function assertOneLamp(page, where) {
  const lit = await litElements(page);
  if (lit.length > 1) problems.push(`${where}: ${lit.length} elements wear the lamp (${lit.join(', ')})`);
}

async function settle(page) {
  await page.locator('main').first().waitFor();
  await page
    .waitForFunction(() => document.querySelectorAll('.skeleton').length === 0, null, { timeout: 8000 })
    .catch(() => problems.push(`${page.url()}: skeletons still on screen after 8s`));
  await page.evaluate(() => document.fonts.ready);
  // The bench lamp is one second and Today's entrance is 300ms; both have to
  // be finished before the shutter, or the PNG is a half-drawn frame.
  await page.waitForTimeout(1300);
}

async function shoot(page, theme, viewport, slug) {
  await page.screenshot({ path: path.join(out, `${theme}-${viewport.name}-${slug}.png`), fullPage: true });
}

(async () => {
  stage = 'accounts';
  await makeAccount('admin', 'admin', 'Amara Okonkwo');

  stage = 'seed';
  const admin = await sessionFor('admin');

  // Three unclaimed tickets at different priorities and ages, one of the
  // administrator's own stopped on a reply, and one they are simply working:
  // enough for the ranking to have something to rank.
  // Three reports of the one dead projector, so the grouped row has something
  // to group, plus two other problems.
  const unclaimed = [
    ['Projector shows no signal in room 118', 'urgent', 'projector_display'],
    ['Projector shows no signal in room 118', 'urgent', 'projector_display'],
    ['Projector shows no signal in room 118', 'high', 'projector_display'],
    ['Cart 3 will not charge overnight', 'high', 'chromebook'],
    ['Wi-Fi drops in the library', 'normal', 'network'],
  ];
  const created = [];
  for (const [title, priority, category] of unclaimed) {
    created.push(ok(
      await admin.rpc('app_create_ticket', {
        p_title: title,
        p_issue: `${title}. Reported at the desk.`,
        p_channel: 'walk_in',
        p_category: category,
        p_priority: priority,
        p_requester_unknown: true,
        p_location: 'Room 118',
      }),
    ));
  }

  const waiting = ok(
    await admin.rpc('app_create_ticket', {
      p_title: 'Replacement keyboard ordered for a Latitude',
      p_issue: 'Half the keys are dead. Part is on order.',
      p_channel: 'email',
      p_category: 'laptop_desktop',
      p_owner_id: people.admin.id,
      p_requester_unknown: true,
      p_location: 'Room 214',
    }),
  );
  ok(await admin.rpc('app_set_waiting', { p_ticket: waiting, p_reason: 'Waiting on the vendor' }));
  created.push(waiting);

  created.push(ok(
    await admin.rpc('app_create_ticket', {
      p_title: 'Printer queue stuck in the main office',
      p_issue: 'Jobs queue but never print.',
      p_channel: 'phone_call',
      p_category: 'printer',
      p_owner_id: people.admin.id,
      p_requester_unknown: true,
      p_location: 'Main office',
    }),
  ));

  stage = 'browser';
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });

  const contextFor = async (theme, viewport, storageState) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ...(storageState ? { storageState } : {}),
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
      problems.push(`${theme}/${viewport.name}: runtime error: ${error.message.split('\n')[0]}`),
    );
    page.on('console', (message) => {
      if (message.type() === 'error') {
        problems.push(`${theme}/${viewport.name}: console error: ${message.text().split('\n')[0]}`);
      }
    });
    return { context, page };
  };

  try {
    stage = 'sign in';
    const first = await contextFor('dark', VIEWPORTS[0]);
    await first.page.goto(`${base}/login`);
    await first.page.locator('.auth-disclosure summary').click();
    await first.page.getByLabel('School email', { exact: true }).fill(people.admin.email);
    await first.page.getByLabel('App password', { exact: true }).fill(people.admin.password);
    await first.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Signing in lands on Today, which is the point of the task.
    await first.page.waitForURL('**/today');
    const signedIn = await first.context.storageState();
    await first.context.close();

    for (const theme of THEMES) {
      stage = `${theme} preference`;
      ok(await admin.rpc('app_update_preferences', { p_patch: { theme } }));

      for (const viewport of VIEWPORTS) {
        const label = `${theme}/${viewport.name}`;
        const session = await contextFor(theme, viewport, signedIn);

        // 1. Today, first visit of the session: the entrance plays and the
        //    first-sign-in note is on screen.
        stage = `${label} today first`;
        await session.page.goto(`${base}/today`);
        await settle(session.page);
        await assertNoOverflow(session.page, `${label} /today`);
        await assertOneLamp(session.page, `${label} /today`);
        await shoot(session.page, theme, viewport, 'today-first');

        // 2. Today with the keyboard on the second row: the lamp moves off the
        //    rail and onto the row, which is the whole identity.
        stage = `${label} today keyboard`;
        await session.page.getByRole('button', { name: 'Got it' }).click();
        await session.page.keyboard.press('j');
        await session.page.keyboard.press('j');
        await session.page.locator('.today-row[data-focused]').waitFor();
        // A settled frame, not the first one: in development the stylesheet can
        // still be arriving, and the lamp is a rule rather than a paint.
        await session.page.waitForTimeout(300);
        await assertOneLamp(session.page, `${label} /today keyboard`);
        await shoot(session.page, theme, viewport, 'today-keyboard');

        // 3. The palette, given an asset tag rather than a word.
        stage = `${label} palette paste`;
        await session.page.keyboard.press('Control+k');
        await session.page.locator('.palette-input').waitFor();
        await session.page.locator('.palette-input').fill('a91001');
        await session.page.waitForTimeout(600);
        await assertNoOverflow(session.page, `${label} palette`);
        await shoot(session.page, theme, viewport, 'palette-asset-tag');
        await session.page.keyboard.press('Escape');
        await session.page.locator('.palette').waitFor({ state: 'detached' });

        // 4. The queue, driven from the keyboard, with the three reports of one
        //    dead projector folded into a single row.
        stage = `${label} queue keyboard`;
        await session.page.goto(`${base}/queue`);
        await settle(session.page);
        await session.page.keyboard.press('j');
        // Attached rather than visible: both layouts carry the row attributes
        // and the stylesheet hides the one this width is not using.
        await session.page
          .locator('[data-row-key][data-focused]')
          .first()
          .waitFor({ state: 'attached' });
        await session.page.waitForTimeout(300);
        await assertNoOverflow(session.page, `${label} /queue`);
        await assertOneLamp(session.page, `${label} /queue keyboard`);
        await shoot(session.page, theme, viewport, 'queue-keyboard');

        // 5. Intake: the suggestions read off the sentence, and the duplicate
        //    warning for a problem that is already open.
        stage = `${label} intake`;
        await session.page.goto(`${base}/tickets/new`);
        await settle(session.page);
        await session.page.locator('#title').fill('Projector shows no signal in room 118');
        await session.page
          .locator('#issue')
          .fill('Regents testing today and the room projector will not pick up the laptop.');
        await session.page.waitForTimeout(900);
        await assertNoOverflow(session.page, `${label} /tickets/new`);
        await shoot(session.page, theme, viewport, 'intake-suggestions');

        // 6. The assistant panel, unconnected: the composer is open and typing
        //    into it is what opens the connect card.
        stage = `${label} assistant`;
        const toggle = session.page.locator('[data-ai-toggle]');
        if (await toggle.first().isVisible()) await toggle.first().click();
        else await session.page.getByRole('button', { name: 'Ask', exact: true }).click();
        await session.page.locator('.ai-panel').waitFor();
        await session.page.waitForTimeout(400);
        await shoot(session.page, theme, viewport, 'assistant-idle');

        const composer = session.page.locator('.ai-composer textarea');
        if (await composer.count()) {
          await composer.first().fill('Summarise what is waiting in the queue');
          await session.page.waitForTimeout(500);
          await assertNoOverflow(session.page, `${label} assistant typing`);
          await shoot(session.page, theme, viewport, 'assistant-connect-inline');
        } else {
          problems.push(`${label}: the assistant composer is not reachable before connecting`);
        }

        await session.context.close();
      }
    }

    // 6. Today with nothing left: the cleared state and its next best action.
    // Only this run's own tickets are closed. Another agent's review fixtures
    // are sitting in the same database, and a capture script that empties
    // somebody else's queue is a capture script that breaks their screenshots.
    stage = 'today cleared';
    const cleaning = await sessionFor('admin');
    for (const id of created) {
      const detail = ok(await cleaning.rpc('app_ticket_detail', { p_ticket: id }));
      const status = detail && detail.ticket ? detail.ticket.status : null;
      if (status === null || status === 'resolved' || status === 'cancelled') continue;
      if (!detail.ticket.owner_id) ok(await cleaning.rpc('app_claim_ticket', { p_ticket: id }));
      if (status === 'waiting') ok(await cleaning.rpc('app_resume_work', { p_ticket: id }));
      ok(await cleaning.rpc('app_resolve_ticket', { p_ticket: id, p_solution: 'Closed for the review capture.' }));
    }
    for (const theme of THEMES) {
      ok(await admin.rpc('app_update_preferences', { p_patch: { theme } }));
      const session = await contextFor(theme, VIEWPORTS[0], signedIn);
      await session.page.goto(`${base}/today`);
      await settle(session.page);
      await assertNoOverflow(session.page, `${theme} /today cleared`);
      await shoot(session.page, theme, VIEWPORTS[0], 'today-clear');
      await session.context.close();
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
  console.log('PASS Today, the keyboard model and the palette at 1440x900 and 390x844 on both themes');
})().catch((error) => {
  let message = String(error && error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]');
  for (const person of Object.values(people)) message = message.replaceAll(person.password, '[redacted]');
  console.error(`Today review failed at ${stage}: ${message}`);
  process.exitCode = 1;
});
