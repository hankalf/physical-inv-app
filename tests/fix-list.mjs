/*
 * The fix list: what the floor found that somebody has to go and put right.
 *
 * One button on the gun - damaged pallet, bent beam, leaking product, a bin
 * blocked by a trailer - lands on a list with the labels that would not scan,
 * and stays there until a supervisor marks it fixed. Offline it queues.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) })).json()).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p, h = A) => (await fetch(BASE + p, { headers: h })).json();
const post = async (p, body = {}, h = A) => (await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();

const sess = await post('/api/admin/sessions', { name: 'Fix list test' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\nX-1,S,Chicken,40,F01A001\nX-2,S,Peas,30,F01A002\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { guided: false, askComments: false });
const dev = await post('/api/admin/devices', { name: 'FIX-01' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await ctx.newPage();
const errors = [];
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
await gun.fill('#fTeam', '2'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E2'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrScan.active', { timeout: 8000 });
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(400); };

check('The counting screen has "Report a problem"', await gun.isVisible('#btnIssue'));
await scan('X-1');
await gun.click('#btnIssue');
await gun.waitForTimeout(400);
check('It opens on the pallet and bin in hand', await gun.isVisible('#scrIssue') && /X-1/.test(await gun.textContent('#issueWhere')));
const kinds = await gun.$$eval('#issueKinds button', (bs) => bs.map((b) => b.textContent));
check('…asking what was found: damaged pallet, rack, product, a blocked bin, something else', kinds.length === 5 && /Damaged pallet/.test(kinds[0]) && /blocked/.test(kinds[3]), kinds.join(' | '));
await gun.click('#issueKinds button:has-text("Damaged pallet")');
await gun.waitForTimeout(200);
const reasons = await gun.$$eval('#issueReasons button', (bs) => bs.map((b) => b.textContent));
check('…then what is wrong with it', reasons.includes('Broken boards') && reasons.includes('Leaning or unstable'), reasons.join(' | '));
await gun.fill('#fIssueNote', 'bottom deck gone');
await gun.click('#issueReasons button:has-text("Broken boards")');
await gun.waitForTimeout(300);
check('One tap sends it, and says so without any fuss', /On the fix list/.test(await gun.textContent('#issueMsg')) && /Broken boards/.test(await gun.textContent('#issueMsg')));
await gun.waitForTimeout(2200);
check('…and goes back to counting by itself, where it was', await gun.isVisible('#scrScan') && /QUANTITY/.test(await gun.textContent('#prompt')));
await scan('40'); await scan('F01A001');
await wait(1500);
let list = await get(`/api/admin/sessions/${sess.id}/fixlist`);
const first = list.rows.find((r) => r.kind === 'damage');
check('It is on the fix list with the pallet, the bin, the note and who saw it', first && first.pallet_id === 'X-1' && first.reason === 'Broken boards' && first.note === 'bottom deck gone' && first.team === '2' && first.device_id === 'FIX-01',
  JSON.stringify(first));

/* a blocked bin, reported with no signal */
await ctx.setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await scan('X-2');
await gun.click('#btnIssue'); await gun.waitForTimeout(300);
await gun.click('#issueKinds button:has-text("blocked")'); await gun.waitForTimeout(200);
await gun.click('#issueReasons button:has-text("Trailer")'); await gun.waitForTimeout(300);
check('With no signal it is still taken, and kept', /On the fix list/.test(await gun.textContent('#issueMsg')));
await gun.waitForTimeout(2200);
list = await get(`/api/admin/sessions/${sess.id}/fixlist`);
check('(the server has not got it yet)', list.rows.filter((r) => r.kind === 'blocked').length === 0);
await ctx.setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
let landed = false;
for (let t = 0; t < 25000 && !landed; t += 1000) { await wait(1000); landed = (await get(`/api/admin/sessions/${sess.id}/fixlist`)).rows.some((r) => r.kind === 'blocked'); }
check('…and it lands the moment there is signal', landed);
await gun.click('#btnBack'); await gun.waitForTimeout(200);

/* a label that would not scan joins the same list */
await scan('X-2'); await scan('30');
await gun.click('#btnNoScan'); await gun.click('#btnNoScanType'); await gun.waitForTimeout(200);
await scan('F01A002');
await wait(1500);
list = await get(`/api/admin/sessions/${sess.id}/fixlist`);
check('A rack label that would not scan is on the same list', list.rows.some((r) => r.kind === 'label' && r.bin === 'F01A002'), list.rows.map((r) => r.kind + ':' + r.bin).join(','));
check('…and the summary counts each kind', list.summary.damage === 1 && list.summary.blocked === 1 && list.summary.labels === 1 && list.summary.open === 3, JSON.stringify(list.summary));

/* ---------------- the dashboard ---------------- */
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('new pallet underneath') : d.accept()).catch(() => {}));
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(800);
check('The Fix list card is on Reports, with the counts', await page.isVisible('#fixCard') && /3 to put right/.test(clean(await page.textContent('#fixSub'))), clean(await page.textContent('#fixSub')));
const rows = await page.$$eval('#fixTable tbody tr', (trs) => trs.map((tr) => tr.textContent));
check('…one row each: the damage, the blocked bin, the label', rows.length === 3 && rows.some((r) => /Broken boards/.test(r)) && rows.some((r) => /Trailer/.test(r)) && rows.some((r) => /F01A002/.test(r)), rows.join(' | ').slice(0, 240));
await page.click('#fixTable tr:has-text("Broken boards") button:has-text("Fixed")');
await page.waitForTimeout(900);
list = await get(`/api/admin/sessions/${sess.id}/fixlist`);
const fixed = list.rows.find((r) => r.kind === 'damage');
check('"Fixed" closes it with who and what', fixed.status === 'fixed' && !!fixed.fixed_by && fixed.outcome === 'new pallet underneath', `${fixed.status} ${fixed.fixed_by} ${fixed.outcome}`);
await page.click('#fixFilter button[data-status="open"]');
await page.waitForTimeout(500);
check('The list can show only what is still open', (await page.$$('#fixTable tbody tr')).length === 2);
const csvText = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/fixlist.csv`, { headers: A })).text();
check('It downloads as a readable CSV', /Kind,What,Bin,Aisle,Pallet,Problem/.test(csvText) && /Damage,Pallet,F01A001,F01,X-1,Broken boards,bottom deck gone/.test(csvText), csvText.split('\n')[1]);
const ev = await get(`/api/admin/sessions/${sess.id}/export/everything`);
check('…and has a sheet in Export everything', ev.sheets.some((s) => s.name === 'Fix list' && s.rows.length === 3));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} fix-list checks passed`);
process.exit(failed ? 1 : 0);
