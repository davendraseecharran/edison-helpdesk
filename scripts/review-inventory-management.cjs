/* eslint-disable @typescript-eslint/no-require-imports -- standalone local browser review. */
// Run after the local DB has been migrated and the app is serving locally.
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

(async()=>{
 let browser; let page;
 try {
  const password=`Review-${randomUUID()}`;
  const email=`inventory-${runId}@edison.example`;
  const user=checked(await service.auth.admin.createUser({email,password,email_confirm:true})).user;
  checked(await service.from('app_accounts').insert({id:user.id,email,display_name:'Inventory Review Tech',role:'technician',status:'active'}));
  people.tech={email,password};
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',()=>errors.push('Runtime error'));
  stage='login';await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/queue');
  assert.equal(await page.locator('.nav-label').filter({hasText:/^Inventory$/}).count(),1);
  const studentName=`Browser Student ${runId.slice(0,8)}`;
  const staffName=`Browser Staff ${runId.slice(0,8)}`;
  const osis='0'+Date.now().toString().slice(-8);
  stage='student creation';await page.getByRole('link',{name:'Students',exact:true}).click();await page.getByRole('button',{name:'Add student',exact:true}).first().click();
  await page.locator('#person-display-name').fill(studentName);
  await page.locator('#person-external-id').fill('invalid');assert.equal(await page.locator('#person-external-id').evaluate(el=>el.checkValidity()),false);
  await page.locator('#person-external-id').fill(osis);await page.locator('#person-email').fill('invalid');assert.equal(await page.locator('#person-email').evaluate(el=>el.checkValidity()),false);
  await page.locator('#person-email').fill('student@school.example');
  await page.locator('#person-guardian-name').fill('Synthetic Guardian');await page.locator('#person-address').fill('10 Synthetic Street');await page.locator('#person-notes').fill('Synthetic contact note');
  assert.equal(await page.locator('#person-external-id').inputValue(),osis);
  assert.equal(await page.locator('.inventory-editor-form').evaluate(f=>f.checkValidity()),true);
  await page.getByRole('button',{name:'Add record',exact:true}).click();stage='student saved notification';await page.getByText('Student record saved.',{exact:true}).waitFor();await page.getByRole('heading',{name:'Edit student',exact:true}).waitFor();
  const student=checked(await service.from('requesters').select('id,guardian_name,address').eq('external_id',osis).single());assert.equal(student.guardian_name,'Synthetic Guardian');
  await page.locator('#person-notes').fill('Updated synthetic contact note');await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Student record saved.',{exact:true}).waitFor();
  stage='staff creation';await page.getByRole('link',{name:'Staff',exact:true}).click();await page.getByRole('button',{name:'Add staff',exact:true}).first().click();
  await page.locator('#person-display-name').fill(staffName);const prefix='staff.'+runId.slice(0,8);await page.locator('#person-email').fill(prefix+'@school.example');assert.equal(await page.locator('#person-external-id').inputValue(),prefix);
  await page.locator('#person-department').fill('Synthetic Browser Department');await page.locator('#person-staff-role').fill('Synthetic Browser Role');
  assert.ok(await page.locator('#person-department').getAttribute('list'));assert.ok(await page.locator('#person-staff-role').getAttribute('list'));
  await page.getByRole('button',{name:'Add record',exact:true}).click();await page.getByText('Staff record saved.',{exact:true}).waitFor();await page.getByRole('heading',{name:'Edit staff',exact:true}).waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('datalist option')).some(o=>o.value==='Synthetic Browser Department')&&Array.from(document.querySelectorAll('datalist option')).some(o=>o.value==='Synthetic Browser Role'));

  stage='device creation and assignment';await page.getByRole('link',{name:'Master Inventory',exact:true}).click();await page.getByRole('button',{name:'Add device',exact:true}).first().click();
  for(const [id,value] of [['device-type','Browser Tablet'],['device-manufacturer','Example'],['device-model','Browser Model'],['device-serial','BROWSER-'+runId],['device-location','Synthetic Lab']])await page.locator('#'+id).fill(value);
  await page.locator('#device-assignment-kind').selectOption('student');await page.locator('#device-assignment-search').fill(osis);await page.getByRole('option',{name:new RegExp(osis)}).click();
  await page.locator('.inventory-editor-form').getByRole('button',{name:'Add device',exact:true}).click();await page.getByText('Device record saved.',{exact:true}).waitFor();await page.getByRole('heading',{name:'Edit device',exact:true}).waitFor();
  const device=checked(await service.from('inventory_devices').select('assigned_requester_id').eq('serial_number','BROWSER-'+runId).single());assert.equal(device.assigned_requester_id,student.id);
  stage='assigned devices on student profile';await page.getByRole('link',{name:'Students',exact:true}).click();
  await page.getByRole('heading',{name:'Students',exact:true}).waitFor();
  await page.getByRole('searchbox').fill(osis);await page.getByText('1 record',{exact:true}).waitFor();assert.equal(await page.getByRole('searchbox').inputValue(),osis);await page.getByRole('button',{name:studentName,exact:true}).click();await page.locator('.inventory-assigned-detail').getByText('Browser Tablet',{exact:true}).waitFor();
  assert.equal(await page.locator('#person-notes').inputValue(),'Updated synthetic contact note');
  fs.mkdirSync('/tmp/edison-inventory-management',{recursive:true});await page.screenshot({path:'/tmp/edison-inventory-management/desktop.png',fullPage:true});
  stage='mobile';await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/tmp/edison-inventory-management/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);stage='done';console.log('PASS technician Inventory navigation, student/staff/device create/edit, validation, ID derivation, assignments, search, and mobile layout');
 } finally {if(page && stage!=='done'){console.error('Page alerts:',await page.locator('[role=alert]').allTextContents());console.error('Headings:',await page.locator('h2').allTextContents());}if(browser)await browser.close();}
})().catch(error=>{let message=String(error?.message??error).split('\n')[0];for(const person of Object.values(people))message=message.replaceAll(person.email,'[email]').replaceAll(person.password,'[redacted]');console.error(`Inventory management review failed at ${stage}: ${message}`);process.exitCode=1;});
