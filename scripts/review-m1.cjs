/* Optional browser regression checks. Supply PLAYWRIGHT_MODULE and CHROME_PATH
 * when Playwright/Chromium are supplied by an external runtime. */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node browser-check runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:3100';
const output = process.env.REVIEW_OUTPUT_DIR || '/tmp/edison-m1-review';
fs.mkdirSync(output, { recursive: true });
(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
 const context = await browser.newContext({viewport:{width:1360,height:900}, timezoneId:'America/Los_Angeles'});
 const page = await context.newPage();
 page.setDefaultTimeout(10000);
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const card=(heading)=>page.locator('.card').filter({has:page.getByRole('heading',{name:heading,exact:true})});
 const settle=()=>page.waitForTimeout(350); // demo's documented 260 ms simulated latency
 const nav=async(name)=>{await page.getByRole('navigation').getByRole('link',{name:new RegExp('^'+name)}).click();await page.getByRole('heading',{name,exact:true}).waitFor();};
 const login=async(name)=>{await page.goto(base+'/login'); await page.getByRole('button',{name:new RegExp(name)}).click(); await page.getByRole('heading',{name:'Open Queue',exact:true}).waitFor();};
 const switchTo=async(name)=>{await page.getByRole('button',{name:'Switch user',exact:true}).click();await page.getByRole('button',{name:new RegExp(name)}).click();await page.getByRole('heading',{name:'Open Queue',exact:true}).waitFor();};
 try {
  await login('Morgan Ellis');
  await page.screenshot({path:output+'/desktop-queue.png',fullPage:true});
  // Reset while claim is delayed must leave all three original open tickets.
  await page.evaluate(()=>{document.querySelector('tbody button').click(); [...document.querySelectorAll('button')].find(b=>b.textContent==='Reset demo data').click();});
  await settle(); assert.equal(await page.locator('tbody tr').count(),3);
  // Changing identity while claiming must also cancel that old write.
  await page.evaluate(()=>{document.querySelector('tbody button').click(); [...document.querySelectorAll('button')].find(b=>b.textContent==='Switch user').click();});
  await page.getByRole('button',{name:/Priya Raman/}).click();await settle();assert.equal(await page.locator('tbody tr').count(),3);
  console.log('PASS delayed claim cancelled by reset and identity change');
  while(await page.getByRole('button',{name:'Claim',exact:true}).count()) {await page.getByRole('button',{name:'Claim',exact:true}).first().click();await settle();}
  await page.getByText('The open queue is clear',{exact:true}).waitFor();
  await nav('My Tickets'); assert.equal(await page.locator('tbody tr').count(),6);
  console.log('PASS claim membership and empty queue');
  await page.getByRole('button',{name:'Reset demo data'}).click();
  await nav('Collaborating');await page.locator('tbody .cell-title a').first().click();
  const solution=card('Resolve');await solution.getByRole('button',{name:'Resolve ticket'}).click();await settle();
  await solution.getByText('A solution is required to resolve a ticket.',{exact:true}).waitFor();
  await solution.getByLabel('Solution',{exact:true}).fill('Browser review fix verified with the requester.');
  await solution.getByRole('button',{name:'Resolve ticket'}).click();await settle();
  assert.match(await card('Solution').innerText(),/Resolved by Priya Raman/);
  assert.match(await card('People').innerText(),/Dev Okafor/);
  console.log('PASS collaborator resolution, nonblank solution, owner preserved');
  await switchTo('Sam Whitaker');await nav('Resolved');assert.doesNotMatch(await page.locator('main').innerText(),/Browser review fix verified/);
  await page.locator('.topbar').getByRole('link',{name:'New ticket'}).click();
  assert.equal(await page.locator('#owner-fixed').inputValue(),'Sam Whitaker');
  assert.equal(await page.locator('#channel-fixed').inputValue(),'Walk-in');
  await page.getByLabel('Requester',{exact:true}).selectOption('unknown');
  await page.getByLabel('Short title').fill('Review walk-in without a time log');await page.getByLabel('Issue',{exact:true}).fill('Synthetic walk-in for regression verification.');
  await page.getByRole('button',{name:'Create ticket',exact:true}).click();await card('Resolve').waitFor();
  await card('Work notes').getByLabel('Add a work note').fill('Checked the charger; replacement needed.');
  await card('Work notes').getByRole('button',{name:'Add note',exact:true}).click();await settle();
  await card('People').getByRole('button',{name:'Return to Open Queue',exact:true}).click();await settle();
  await card('People').getByRole('button',{name:'Claim',exact:true}).waitFor();
  assert.match(await card('Work notes').innerText(),/Checked the charger; replacement needed/);
  assert.match(await card('Activity history').innerText(),/Sam Whitaker returned the ticket to the Open Queue/);
  await card('People').getByRole('button',{name:'Claim',exact:true}).click();await settle();
  console.log('PASS technician return to queue preserves notes and records the return');
  await card('Resolve').getByLabel('Solution',{exact:true}).fill('Restarted and confirmed normal operation.');
  await card('Resolve').getByRole('button',{name:'Resolve ticket'}).click();await settle();
  assert.match(await card('Solution').innerText(),/No time was recorded/);
  console.log('PASS technician intake and resolution without time');
  await switchTo('Morgan Ellis');await page.getByRole('button',{name:'Reset demo data'}).click();await nav('All Tickets');
  await page.locator('tbody tr').filter({hasText:'EDT-1004'}).locator('.cell-title a').click();
  await card('Progress').getByRole('button',{name:'Put on hold'}).click();
  await card('Progress').getByRole('button',{name:'Set to Waiting'}).click();await settle();assert.match(await card('Progress').innerText(),/Waiting\./);
  await card('Progress').getByRole('button',{name:'Resume work'}).click();await settle();assert.equal(await card('Progress').getByRole('button',{name:'Put on hold'}).count(),1);
  await card('Administration').getByLabel('Primary owner',{exact:true}).selectOption('acct_sam');
  await card('Administration').getByRole('button',{name:'Apply ownership change'}).click();await settle();assert.match(await card('People').innerText(),/Sam Whitaker/);
  await card('Administration').getByRole('button',{name:'Cancel ticket',exact:true}).click();
  await card('Administration').getByLabel('Reason for cancelling').fill('Synthetic duplicate request');
  await card('Administration').getByRole('button',{name:'Confirm cancellation'}).click();await settle();
  assert.match(await card('Resolve').innerText(),/Synthetic duplicate request/);
  await card('Administration').getByRole('button',{name:'Reopen ticket',exact:true}).click();await card('Administration').getByLabel('Reason for reopening').fill('Issue returned');
  await card('Administration').getByRole('button',{name:'Reopen ticket',exact:true}).click();await settle();
  await card('Administration').getByLabel('Primary owner',{exact:true}).selectOption('');await card('Administration').getByRole('button',{name:'Apply ownership change'}).click();await settle();
  await card('People').getByRole('button',{name:'Claim',exact:true}).waitFor();
  console.log('PASS waiting/resume, reassign, cancel/reopen, return to queue');
  await card('People').getByRole('button',{name:'Claim',exact:true}).click();await settle();
  assert.equal(await card('Administration').getByLabel('Primary owner',{exact:true}).inputValue(),'acct_admin');
  await card('Work notes').getByLabel('Add a work note').fill('Overlapping write regression note.');
  await card('Resolve').getByLabel('Solution',{exact:true}).fill('Regression resolution after saved note.');
  await page.evaluate(()=>{
    const buttons=[...document.querySelectorAll('button')];
    buttons.find(b=>b.textContent==='Add note').click();
    buttons.find(b=>b.textContent==='Resolve ticket').click();
  });
  await settle();
  assert.match(await card('Work notes').innerText(),/Overlapping write regression note/);
  await card('Resolve').waitFor();
  await card('Resolve').getByRole('button',{name:'Resolve ticket'}).click();await settle();
  await card('Solution').waitFor();
  assert.match(await card('Work notes').innerText(),/Overlapping write regression note/);
  console.log('PASS owner selector refresh and overlapping writes preserve notes');
  await page.setViewportSize({width:375,height:812});
  await page.screenshot({path:output+'/phone-detail.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Phone detail horizontal overflow');
  await nav('Open Queue'); await page.screenshot({path:output+'/phone-queue.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Phone queue horizontal overflow');
  console.log('PASS phone queue/detail layout widths');
  await page.goto(base+'/set-password');await page.getByLabel('New app password',{exact:true}).fill('Example123456');
  assert.equal(await page.getByText('Different from your school password',{exact:true}).count(),0);
  await page.getByText(/The helpdesk cannot check your school password/).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS setup guidance and no browser runtime errors');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
