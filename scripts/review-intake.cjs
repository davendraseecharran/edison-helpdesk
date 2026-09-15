/* eslint-disable @typescript-eslint/no-require-imports -- standalone local browser review. */
//
// RETIRED. Kept as the record of what the owner's intake screen asserted; it
// can no longer pass, and it is not fixed in place because every surface it
// drives has been replaced rather than changed.
//
// Four things it depends on are gone: the sign-in form's "Email" and
// "Password" labels (they are "School email" and "App password", inside a
// disclosure under the Google button); the landing page after sign-in (Today,
// not the queue); the owner's intake markup (`#requester-mode`,
// `#requester-kind`, `.intake-device-drafts`, "No intake notes." — the form is
// now PersonPicker and DevicePicker over `requesters` and `inventory_devices`,
// and it drafts a category and a priority and warns about a likely duplicate);
// and Administration → Access, where a role is a set of chips rather than one
// combobox, so "Role changed to administrator." is no longer said.
//
// What covers it now: `scripts/review-overhaul.cjs` walks intake, the ticket,
// Access and the sign-in page at three widths on both themes;
// `tests/db/intake.test.ts` holds the seventeen-argument `app_create_ticket`;
// `tests/intake-*.test.ts` hold the drafting, the suggestions and the duplicate
// warning; `tests/db/roles-set.test.ts` holds the role matrix.
//
// Below this line is the September 2026 original, unchanged.
console.error(
  'review-intake.cjs is retired: the sign-in labels, the landing page, the intake markup and the role editor it drives have all been replaced. Use scripts/review-overhaul.cjs.',
);
process.exit(1);

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const base = process.env.REVIEW_BASE_URL || 'http://localhost:3000';
const localHosts = ['localhost', '127.0.0.1', '[::1]'];
if (!localHosts.includes(new URL(base).hostname)) throw Error('Local preview only');
for (const marker of ['project-ref', 'remote-db-url', 'pooler-url']) {
  if (fs.existsSync(path.join(root, 'supabase', '.temp', marker))) throw Error('Refusing linked project');
}
const status = JSON.parse(
  execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
if (!localHosts.includes(new URL(status.API_URL).hostname)) throw Error('Local database only');

const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const runId = randomUUID();
const people = {};
let stage = 'preflight';
const checked = (result) => {
  if (result.error) throw Error(result.error.message);
  return result.data;
};

async function seed() {
  const adminPassword = `Review-${randomUUID()}`;
  const techPassword = `Review-${randomUUID()}`;
  for (const [key, role, password] of [
    ['admin', 'admin', adminPassword],
    ['tech', 'technician', techPassword],
  ]) {
    const email = `${key}-${runId}@edison.example`;
    const user = checked(await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })).user;
    checked(await service.from('app_accounts').insert({
      id: user.id,
      email,
      display_name: `Review ${key}`,
      role,
      status: 'active',
    }));
    people[key] = { id: user.id, email, password };
  }

  const staff = checked(await service.from('requesters').insert({
    display_name: `Review Staff ${runId.slice(0, 8)}`,
    kind: 'staff',
    external_id: `REVIEW-STAFF-${runId}`,
    created_by: people.admin.id,
  }).select('id,display_name,external_id').single());
  const student = checked(await service.from('requesters').insert({
    display_name: `Review Student ${runId.slice(0, 8)}`,
    kind: 'student',
    external_id: `REVIEW-OSIS-${runId}`,
    created_by: people.admin.id,
  }).select('id,display_name,external_id').single());

  checked(await service.from('device_catalog').upsert(
    { device_type: 'Laptop', manufacturer: 'Lenovo', model: '300w' },
    { onConflict: 'device_type,manufacturer,model' },
  ));
  const makeDevice = async (requester, number) => checked(await service.from('inventory_devices').insert({
    external_id: `REVIEW-DEVICE-${runId}-${number}`,
    device_type: 'Laptop',
    manufacturer: 'Lenovo',
    model: '300w',
    serial_number: `REVIEW-SERIAL-${runId}-${number}`,
    asset_tag: `REVIEW-ASSET-${number}`,
    os_version: 'Synthetic OS',
    status: 'assigned',
    assigned_requester_id: requester.id,
  }).select('id,serial_number').single());
  return {
    staff,
    student,
    staffDevice: await makeDevice(staff, 'staff'),
    studentDevice: await makeDevice(student, 'student'),
  };
}

(async () => {
  let browser;
  const runtimeErrors = [];
  try {
    const fixtures = await seed();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', () => runtimeErrors.push('browser runtime error'));
    const login = async () => {
      await page.goto(`${base}/login`);
      await page.getByLabel('Email', { exact: true }).fill(people.admin.email);
      await page.getByLabel('Password', { exact: true }).fill(people.admin.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/queue');
    };
    const waitCatalog = async () => {
      await page.locator('.intake-device-empty').waitFor();
      await page.waitForFunction(() => !document.body.innerText.includes('Loading device catalog'));
    };
    const selectSearchOption = async (input, text) => {
      await input.fill(text);
      const option = page.getByRole('option', { name: text, exact: false }).first();
      await option.waitFor();
      await option.click();
    };

    stage = 'login card';
    await page.goto(`${base}/login`);
    const delta = await page.locator('.auth-card').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.left + box.width / 2 - window.innerWidth / 2);
    });
    assert(delta < 2, `login card center delta ${delta}`);
    assert.equal(await page.getByLabel('Email', { exact: true }).getAttribute('placeholder'), null);
    assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('placeholder'), null);
    assert.equal(await page.getByText(/forgot password/i).count(), 0);

    stage = 'admin login';
    await login();
    stage = 'staff intake';
    await page.goto(`${base}/tickets/new`);
    await page.getByRole('heading', { name: 'Record a request', exact: true }).waitFor();
    await waitCatalog();
    assert.deepEqual(await page.locator('#requester-mode option').allTextContents(), [
      'Existing requester',
      'Unknown requester',
    ]);
    assert.equal(await page.getByLabel(/remote/i).count(), 0);
    assert.equal(await page.getByText(/new requester/i).count(), 0);
    await page.locator('#requester-search').fill(fixtures.staff.display_name);
    await page.getByRole('option', { name: new RegExp(fixtures.staff.display_name) }).waitFor();
    await page.getByRole('option', { name: new RegExp(fixtures.staff.display_name) }).click();
    const assigned = page.locator('.intake-assigned-devices');
    await assigned.getByText(`Assigned to ${fixtures.staff.display_name}`, { exact: true }).waitFor();
    const addAssigned = assigned.getByRole('button', { name: 'Add', exact: true });
    await addAssigned.waitFor();
    await addAssigned.click();
    assert.equal(await assigned.getByRole('button', { name: 'Added', exact: true }).count(), 1);
    await page.locator('#title').fill(`Staff intake ${runId}`);
    assert.equal(await page.locator('#issue').inputValue(), '');
    await page.getByRole('button', { name: 'Create ticket', exact: true }).click();

    stage = 'staff ticket detail';
    await page.getByRole('heading', { name: `Staff intake ${runId}`, exact: true }).waitFor();
    await page.getByText('No intake notes.', { exact: true }).waitFor();
    const device = page.locator('.device').filter({ hasText: fixtures.staffDevice.serial_number });
    await device.waitFor();
    await device.getByText('Lenovo 300w', { exact: true }).waitFor();
    await device.getByText(fixtures.staffDevice.serial_number, { exact: true }).waitFor();
    fs.mkdirSync('/tmp/edison-intake-review', { recursive: true });
    await page.screenshot({ path: '/tmp/edison-intake-review/staff-detail.png', fullPage: true });

    stage = 'student lookup and draft reset';
    await page.goto(`${base}/tickets/new`);
    await page.getByRole('heading', { name: 'Record a request', exact: true }).waitFor();
    await waitCatalog();
    await page.locator('#requester-kind').selectOption('student');
    await page.locator('#requester-search').fill(fixtures.student.external_id);
    await page.getByRole('option', { name: new RegExp(fixtures.student.external_id) }).waitFor();
    await page.getByRole('option', { name: new RegExp(fixtures.student.external_id) }).click();
    const studentAssigned = page.locator('.intake-assigned-devices');
    await studentAssigned.getByText(`Assigned to ${fixtures.student.display_name}`, { exact: true }).waitFor();
    await studentAssigned.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.intake-device-drafts fieldset').waitFor();
    await page.locator('#requester-kind').selectOption('staff');
    await page.locator('.intake-device-drafts fieldset').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.intake-device-drafts fieldset').count(), 0);

    // Select the staff requester again so the manual-device checks are tested
    // with a complete requester and can distinguish serial validation.
    await page.locator('#requester-search').fill(fixtures.staff.display_name);
    const staffOptionAgain = page.getByRole('option', { name: new RegExp(fixtures.staff.display_name) });
    await staffOptionAgain.waitFor();
    await staffOptionAgain.click();
    await page.getByRole('button', { name: 'Add device', exact: true }).click();
    const draft = page.locator('.intake-device-drafts fieldset').last();
    await selectSearchOption(draft.locator('input[id^="device-type-"]'), 'Laptop');
    await selectSearchOption(draft.locator('input[id^="device-manufacturer-"]'), 'Lenovo');
    await selectSearchOption(draft.locator('input[id^="device-model-"]'), '300w');
    const create = page.getByRole('button', { name: 'Create ticket', exact: true });
    assert.equal(await create.isDisabled(), true);
    await draft.locator('input[id^="device-serial-"]').fill(`REVIEW-MANUAL-${runId}`);
    assert.equal(await create.isDisabled(), false);
    await draft.locator('input[id^="device-model-"]').fill('Invalid model');
    await draft.getByText('No matching model.', { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), true);
    assert.equal(new URL(page.url()).pathname, '/tickets/new');

    stage = 'phone layout';
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    fs.mkdirSync('/tmp/edison-intake-review', { recursive: true });
    await page.screenshot({ path: '/tmp/edison-intake-review/phone-intake.png', fullPage: true });
    stage = 'role administration';
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${base}/admin`);
    const technicianRow = page.locator('tr').filter({ hasText: people.tech.email });
    await technicianRow.getByRole('combobox').selectOption('admin');
    await page.getByText('Role changed to administrator.', { exact: true }).waitFor();
    const changed = checked(await service.from('app_accounts').select('role').eq('id', people.tech.id).single());
    assert.equal(changed.role, 'admin');
    assert.deepEqual(runtimeErrors, []);
    console.log('PASS local intake browser review: login, directory/device intake, snapshots, validation, phone layout, and role administration');
  } finally {
    if (browser) await browser.close();
  }
})().catch((error) => {
  let message = String(error && error.message ? error.message : error)
    .split('\n')[0]
    .replace(/https?:\/\/\S+/g, '[URL]');
  for (const person of Object.values(people)) {
    message = message.replaceAll(person.email, '[email]').replaceAll(person.password, '[redacted]');
  }
  console.error(`INTAKE browser review failed at ${stage}: ${message}`);
  process.exitCode = 1;
});
