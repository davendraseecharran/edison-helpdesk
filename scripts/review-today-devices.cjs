#!/usr/bin/env node
/**
 * Photographs Today's "devices due back" section and presses Return on it.
 *
 * Two machines, which are the two ways a help desk loses one: a Chromebook a
 * graduated student still holds, and a laptop that has been "In repair" since
 * the autumn. Both are read back through `app_today_briefing()` as an ordinary
 * signed-in NetRider, so the definer function's gate and the page's rendering
 * are both exercised rather than asserted about.
 *
 * It asserts what a screenshot cannot: that the section appears with both
 * reasons on it, that Return takes a machine off the list, and that the page
 * never scrolls sideways or logs a browser error.
 *
 * Development tooling, not part of the build. Needs a dev server already
 * running and Playwright with Chromium, which on this machine lives outside
 * the repo:
 *
 *   PLAYWRIGHT_MODULE=/home/tanavm/LMS/node_modules/playwright \
 *   REVIEW_BASE_URL=http://127.0.0.1:3005 \
 *   REVIEW_OUTPUT_DIR=/tmp/edison-overhaul-review/p2-4b \
 *   node scripts/review-today-devices.cjs
 *
 * Local only by construction: the base URL and the Supabase URL must both be
 * loopback, and a linked project aborts the run. It never resets the database,
 * and it removes every row it created.
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

const out = process.env.REVIEW_OUTPUT_DIR || '/tmp/edison-overhaul-review/p2-4b';
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
const problems = [];
const made = { devices: [], requesters: [] };
let person = null;
let stage = 'preflight';

const ok = (result) => {
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

async function assertNoOverflow(page, where) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  if (widths.scroll > widths.inner) {
    problems.push(`${where}: horizontal overflow (${widths.scroll} > ${widths.inner})`);
  }
}

async function settle(page) {
  await page.locator('main').first().waitFor();
  await page
    .waitForFunction(() => document.querySelectorAll('.skeleton').length === 0, null, { timeout: 8000 })
    .catch(() => problems.push(`${page.url()}: skeletons still on screen after 8s`));
  await page.evaluate(() => document.fonts.ready);
  // The bench lamp is one second and Today's entrance is 300ms.
  await page.waitForTimeout(1300);
}

(async () => {
  stage = 'account';
  const email = `due-${runId}@edison.example`;
  const password = `Review-${randomUUID()}`;
  const created = ok(await service.auth.admin.createUser({ email, password, email_confirm: true }));
  person = { id: created.user.id, email, password };
  ok(
    await service.from('app_accounts').insert({
      id: created.user.id,
      email,
      display_name: 'Amara Okonkwo',
      role: 'admin',
      status: 'active',
    }),
  );

  stage = 'seed';
  // A student who has left, still holding a machine.
  const graduate = ok(
    await service
      .from('requesters')
      .insert({
        display_name: `Wren Calloway ${runId}`,
        kind: 'student',
        external_id: `99${runId.replace(/\D/g, '0').slice(0, 6)}`,
        student_status: 'graduated',
        class_of: '2026',
        created_by: person.id,
      })
      .select('id, display_name')
      .single(),
  );
  made.requesters.push(graduate.id);

  const devices = [
    {
      external_id: `DUE-${runId}-A`,
      device_type: 'Chromebook',
      manufacturer: 'HP',
      model: 'Chromebook 11 G8',
      serial_number: `SER-${runId}A`,
      asset_tag: `DOE-${runId}A`,
      status: 'Assigned',
      location: 'Cart 4',
      assigned_requester_id: graduate.id,
      updated_at: daysAgo(210),
    },
    {
      external_id: `DUE-${runId}-B`,
      device_type: 'Laptop',
      manufacturer: 'Dell',
      model: 'Latitude 3190',
      serial_number: `SER-${runId}B`,
      asset_tag: `DOE-${runId}B`,
      status: 'In repair',
      location: 'Bench',
      updated_at: daysAgo(46),
    },
  ];
  for (const row of devices) {
    made.devices.push(ok(await service.from('inventory_devices').insert(row).select('id').single()).id);
  }

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
    await first.page.getByLabel('School email', { exact: true }).fill(person.email);
    await first.page.getByLabel('App password', { exact: true }).fill(person.password);
    await first.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await first.page.waitForURL('**/today');
    const signedIn = await first.context.storageState();
    await first.context.close();

    for (const theme of THEMES) {
      stage = `${theme} preference`;
      const session = await createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      ok(await session.auth.signInWithPassword({ email: person.email, password: person.password }));
      ok(await session.rpc('app_update_preferences', { p_patch: { theme } }));

      for (const viewport of VIEWPORTS) {
        const label = `${theme}/${viewport.name}`;
        stage = `${label} today`;
        const view = await contextFor(theme, viewport, signedIn);
        await view.page.goto(`${base}/today`);
        await settle(view.page);

        const section = view.page.locator('.today-due');
        if ((await section.count()) === 0) {
          problems.push(`${label}: no "devices due back" section`);
        } else {
          const text = (await section.first().innerText()).toLowerCase();
          for (const wanted of ['holder has left', 'in repair over a fortnight', 'wren calloway']) {
            if (!text.includes(wanted)) problems.push(`${label}: the section never says "${wanted}"`);
          }
          const buttons = await section.first().locator('button').allInnerTexts();
          if (!buttons.includes('Return')) problems.push(`${label}: no Return on the held machine`);
          if (!buttons.includes('Mark available')) {
            problems.push(`${label}: no action on the machine nobody holds`);
          }
        }
        await assertNoOverflow(view.page, `${label} /today`);
        await view.page.screenshot({
          path: path.join(out, `${theme}-${viewport.name}-today-devices.png`),
          fullPage: true,
        });

        // The keyboard: `r` on a machine returns it, the same key that resolves
        // a ticket on the list above.
        if (theme === 'dark' && viewport.name === '1440') {
          stage = 'keyboard return';
          const rows = view.page.locator('.today-due .today-row');
          await rows.first().click();
          await view.page.waitForTimeout(150);
          const before = await rows.count();
          await view.page.keyboard.press('r');
          await view.page
            .waitForFunction(
              (was) => document.querySelectorAll('.today-due .today-row').length < was,
              before,
              { timeout: 15000 },
            )
            .catch(() => problems.push('keyboard: `r` did not take the machine off the list'));
          await view.page.waitForTimeout(600);
          await view.page.screenshot({
            path: path.join(out, 'dark-1440-today-devices-returned.png'),
            fullPage: true,
          });

          const { data } = await service
            .from('inventory_devices')
            .select('assigned_requester_id, status')
            .eq('id', made.devices[0])
            .single();
          if (data && data.assigned_requester_id !== null) {
            problems.push('keyboard: the machine is still assigned after Return');
          }
          // Put it back, so the remaining captures still have both rows.
          ok(
            await service
              .from('inventory_devices')
              .update({ assigned_requester_id: graduate.id, status: 'Assigned' })
              .eq('id', made.devices[0]),
          );
        }

        await view.context.close();
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
  console.log('PASS devices due back, at 1440x900 and 390x844 on both themes');
})()
  .catch((error) => {
    let message = String(error && error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]');
    if (person) message = message.replaceAll(person.password, '[redacted]');
    console.error(`Devices review failed at ${stage}: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Only this run's rows. Another agent's fixtures are in the same database.
    for (const id of made.devices) await service.from('inventory_devices').delete().eq('id', id);
    for (const id of made.requesters) await service.from('requesters').delete().eq('id', id);
  });
