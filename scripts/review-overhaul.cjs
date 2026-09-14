#!/usr/bin/env node
/**
 * Photographs the whole overhauled application and asserts the two things a
 * screenshot cannot show on its own: that no page scrolls sideways, and that
 * no page logs a browser error.
 *
 * It creates its own synthetic administrator and technician through the LOCAL
 * Supabase admin API, seeds a handful of people, devices and tickets through
 * the ordinary RPCs (so row-level security is exercised rather than bypassed),
 * signs in with the password form, and then walks every route at three widths
 * on both themes.
 *
 * Development tooling, not part of the build. It needs the dev server already
 * running and Playwright with Chromium, which on this machine lives outside
 * the repo:
 *
 *   PLAYWRIGHT_MODULE=/home/tanavm/LMS/node_modules/playwright \
 *   REVIEW_BASE_URL=http://127.0.0.1:3005 \
 *   node scripts/review-overhaul.cjs
 *
 * Environment: REVIEW_BASE_URL (default http://127.0.0.1:3000) is the running
 * app; PLAYWRIGHT_MODULE and CHROME_PATH point at a Playwright install and a
 * Chromium binary when they are not resolvable from here; REVIEW_OUTPUT_DIR
 * overrides the PNG folder.
 *
 * Local only, by construction: the base URL and the Supabase URL from
 * `.env.local` must both be loopback, and a linked Supabase project aborts the
 * run. It leaves its synthetic fixtures behind; they use invented names on the
 * edison.example domain. Run it after the DB and auth suites, never during a
 * database reset.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node/Playwright runner, outside the bundler. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.resolve(__dirname, '..');
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:3000';
if (!LOOPBACK.includes(new URL(base).hostname)) throw new Error('Local preview only');

// The same refusal review-m3.cjs makes: if the CLI has been linked to a hosted
// project, nothing here runs, because this script creates accounts.
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

const out = process.env.REVIEW_OUTPUT_DIR || '/tmp/edison-overhaul-review/final';
fs.mkdirSync(out, { recursive: true });

const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const runId = randomUUID().slice(0, 8);
// A nine-digit OSIS that does not collide with a previous run's fixture.
const runOsis = `2${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const people = {};
const problems = [];
let stage = 'preflight';

/** Unwrap a PostgREST result, raising the database's own message. */
const ok = (result) => {
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

/** A synthetic account: auth user plus the app row that decides role and status. */
async function makeAccount(key, role, displayName) {
  const email = `overhaul-${key}-${runId}@edison.example`;
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

/** A Supabase client carrying that account's own JWT, so every RPC runs under RLS. */
async function sessionFor(key) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ok(await client.auth.signInWithPassword({ email: people[key].email, password: people[key].password }));
  return client;
}

/* --- The walk ------------------------------------------------------------ */

/** Every route the review visits, in the order a reviewer would read them. */
function routes(seed) {
  return [
    { slug: 'queue', path: '/queue', title: 'Queue — Edison Helpdesk' },
    { slug: 'ticket-detail', path: `/tickets/${seed.workedTicket}`, title: 'Ticket — Edison Helpdesk' },
    { slug: 'ticket-new', path: '/tickets/new' },
    { slug: 'my-tickets', path: '/my-tickets', title: 'My tickets — Edison Helpdesk' },
    { slug: 'people', path: '/people', title: 'People — Edison Helpdesk' },
    { slug: 'person', path: `/people/${seed.student}`, title: 'Person — Edison Helpdesk' },
    { slug: 'devices', path: '/devices', title: 'Devices — Edison Helpdesk' },
    { slug: 'device', path: `/devices/${seed.chromebook}`, title: 'Device — Edison Helpdesk' },
    { slug: 'insights', path: '/insights', title: 'Insights — Edison Helpdesk' },
    { slug: 'admin-access', path: '/admin', title: 'Administration — Edison Helpdesk' },
    { slug: 'admin-import', path: '/admin/import', title: 'Import — Edison Helpdesk' },
    { slug: 'admin-audit', path: '/admin/audit', title: 'Audit log — Edison Helpdesk' },
    { slug: 'settings', path: '/settings', title: 'Settings — Edison Helpdesk' },
    { slug: 'notifications', path: '/notifications', title: 'Notifications — Edison Helpdesk' },
  ];
}

/** No page may scroll sideways, at any width, on either theme. */
async function assertNoOverflow(page, where) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  if (widths.scroll > widths.inner) {
    problems.push(`${where}: horizontal overflow (${widths.scroll} > ${widths.inner})`);
  }
}

/** Wait for the streaming skeletons to be replaced by the real thing. */
async function settle(page) {
  await page.locator('main').first().waitFor();
  await page
    .waitForFunction(() => document.querySelectorAll('.skeleton').length === 0, null, { timeout: 8000 })
    .catch(() => problems.push('skeletons still on screen after 8s'));
  // Fonts and the one allowed reveal animation, so the PNG is not a half-drawn frame.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function shoot(page, theme, viewport, slug) {
  await page.screenshot({ path: path.join(out, `${theme}-${viewport.name}-${slug}.png`), fullPage: true });
}

/* --- Run ----------------------------------------------------------------- */

(async () => {
  stage = 'accounts';
  await makeAccount('admin', 'admin', 'Review Admin');
  await makeAccount('tech', 'technician', 'Review Technician');

  stage = 'seed';
  const admin = await sessionFor('admin');
  const tech = await sessionFor('tech');

  const student = ok(
    await admin.rpc('app_upsert_person', {
      p_person: {
        kind: 'student',
        first_name: 'Nia',
        last_name: 'Okonkwo',
        osis: runOsis,
        official_class: '9A',
        class_of: '2029',
        department: 'Grade 9',
      },
    }),
  );
  const staff = ok(
    await admin.rpc('app_upsert_person', {
      p_person: {
        kind: 'staff',
        first_name: 'Marcus',
        last_name: 'Ellery',
        email: `marcus.ellery-${runId}@edison.example`,
        staff_id: `S-${runId}`,
        department: 'Science',
        role_title: 'Teacher',
      },
    }),
  );
  const chromebook = ok(
    await admin.rpc('app_upsert_device', {
      p_device: {
        device_id: `TAEHS-CB-${runId}`,
        serial_number: `5CD${runId}`,
        asset_tag: `A-${runId}`,
        type: 'Chromebook',
        manufacturer: 'HP',
        model: 'Fortis 14 G10',
        os: 'ChromeOS 128',
        status: 'in_stock',
        location: 'Room 214',
      },
    }),
  );
  ok(
    await admin.rpc('app_upsert_device', {
      p_device: {
        asset_tag: `A-${runId}-B`,
        type: 'Laptop',
        manufacturer: 'Dell',
        model: 'Latitude 3540',
        status: 'in_repair',
        location: 'Repair bench',
      },
    }),
  );

  // One ticket waiting in the Open Queue for somebody to claim.
  ok(
    await admin.rpc('app_create_ticket', {
      p_title: 'Projector will not show the laptop',
      p_issue: 'The room projector shows no signal from the teaching laptop.',
      p_channel: 'phone_call',
      p_category: 'projector_display',
      p_priority: 'high',
      p_person_id: staff,
      p_location: 'Room 118',
    }),
  );

  // One worked ticket: a requester, a linked machine, a note and recorded time.
  const worked = ok(
    await admin.rpc('app_create_ticket', {
      p_title: 'Chromebook will not hold a charge',
      p_issue: 'Battery drops to zero within an hour of unplugging.',
      p_channel: 'walk_in',
      p_category: 'chromebook',
      p_person_id: student,
      p_owner_id: people.admin.id,
      p_device_ids: [chromebook],
      p_location: 'Room 214',
    }),
  );
  ok(await admin.rpc('app_add_note', { p_ticket: worked, p_body: 'Charger tested on a second machine; the machine is the problem.' }));
  ok(await admin.rpc('app_log_work', { p_ticket: worked, p_minutes: 25, p_work_date: null, p_description: 'Battery report and charge test.' }));

  // One resolved ticket, so the Resolved view and the insights have something.
  const resolved = ok(
    await admin.rpc('app_create_ticket', {
      p_title: 'Printer queue stuck in the main office',
      p_issue: 'Jobs queue but never print.',
      p_channel: 'email',
      p_category: 'printer',
      p_owner_id: people.admin.id,
      p_requester_name: 'Front office',
      p_requester_kind: 'staff',
      p_location: 'Main office',
    }),
  );
  ok(await admin.rpc('app_resolve_ticket', { p_ticket: resolved, p_solution: 'Cleared the queue and restarted the print spooler.' }));

  // The technician's own walk-in, with the administrator invited onto it, so
  // the bell and the notifications page have a real row to show.
  const shared = ok(
    await tech.rpc('app_create_ticket', {
      p_title: 'Classroom network drop is dead',
      p_issue: 'No link light on the wall port.',
      p_channel: 'walk_in',
      p_category: 'network',
      p_requester_unknown: true,
      p_location: 'Room 301',
    }),
  );
  ok(await tech.rpc('app_add_collaborator', { p_ticket: shared, p_account: people.admin.id }));

  const seed = { workedTicket: worked, student, chromebook };

  stage = 'browser';
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });

  /** A context in one theme at one width, watching for browser errors. */
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
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => problems.push(`${theme}/${viewport.name}: runtime error: ${error.message.split('\n')[0]}`));
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
    await first.page.waitForURL('**/queue');
    const signedIn = await first.context.storageState();
    await first.context.close();

    for (const theme of THEMES) {
      // The account's stored preference wins over anything this browser holds
      // (ThemeProvider adopts it inside the signed-in layout), so the theme
      // under review is chosen the way a person chooses it: on the account.
      stage = `${theme} preference`;
      ok(await admin.rpc('app_update_preferences', { p_patch: { theme } }));

      for (const viewport of VIEWPORTS) {
        const label = `${theme}/${viewport.name}`;

        stage = `${label} login`;
        const anon = await contextFor(theme, viewport);
        await anon.page.goto(`${base}/login`);
        await anon.page.locator('.auth-primary').waitFor();
        await settle(anon.page);
        assert.equal(await anon.page.title(), 'Sign in — Edison Helpdesk');
        await assertNoOverflow(anon.page, `${label} /login`);
        await shoot(anon.page, theme, viewport, 'login');
        await anon.context.close();

        const session = await contextFor(theme, viewport, signedIn);
        for (const route of routes(seed)) {
          stage = `${label} ${route.path}`;
          await session.page.goto(base + route.path);
          await settle(session.page);
          assert.equal(
            new URL(session.page.url()).pathname,
            route.path,
            `${label} ${route.path} redirected to ${new URL(session.page.url()).pathname}`,
          );
          if (route.title) assert.equal(await session.page.title(), route.title, `${label} ${route.path} title`);
          await assertNoOverflow(session.page, `${label} ${route.path}`);
          await shoot(session.page, theme, viewport, route.slug);
        }

        // The assistant, unconnected: the top-bar sparkle on wide screens, the
        // Ask tab on a phone. Both open the same panel.
        stage = `${label} assistant`;
        await session.page.goto(`${base}/queue`);
        await settle(session.page);
        const toggle = session.page.locator('[data-ai-toggle]');
        if (await toggle.first().isVisible()) await toggle.first().click();
        else await session.page.getByRole('button', { name: 'Ask', exact: true }).click();
        await session.page.locator('.ai-panel').waitFor();
        await session.page.locator('.ai-connect').waitFor();
        await session.page.waitForTimeout(500);
        await assertNoOverflow(session.page, `${label} assistant panel`);
        await shoot(session.page, theme, viewport, 'assistant');
        await session.context.close();
      }
    }
  } finally {
    await browser.close();
  }

  stage = 'report';
  const captures = fs.readdirSync(out).filter((name) => name.endsWith('.png')).length;
  console.log(`Captures: ${captures} PNGs in ${out}`);
  console.log(`Sign in locally as ${people.admin.email} (password held in memory only).`);
  if (problems.length) {
    console.error(`FAIL ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS every route at 1440x900, 1024x768 and 390x844 on both themes: no horizontal overflow, no console errors');
})().catch((error) => {
  let message = String(error && error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]');
  for (const person of Object.values(people)) message = message.replaceAll(person.password, '[redacted]');
  console.error(`Overhaul review failed at ${stage}: ${message}`);
  process.exitCode = 1;
});
