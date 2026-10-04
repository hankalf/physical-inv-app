/*
 * Not in Location: pallets the system has lost track of.
 *
 * The office uploads the list; every scanner watches for them. The moment one
 * is scanned - counting, or moving - it is marked found with the bin, the team
 * and the time, and the counter is told. The list is the site's, across counts.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

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

const up = await (await fetch(`${BASE}/api/admin/missing/import?name=lost-sept.xlsx`, { method: 'POST', headers: csv,
  body: 'Pallet,Item,Description,Qty,Lot,Last known location,Note\nL-1,SKU-8810,Blueberry wild 30lb,24,LOT1,F03B012,not in bin 9/28\nL-2,SKU-4120,Chicken,40,,RECEIVING,off a trailer\nL-3,SKU-2210,Peas,30,,F01A003,\n' })).json();
check('A list uploads: pallet, what it is, last known location', up.added === 3 && up.batch === 'lost-sept', JSON.stringify(up));
const again = await (await fetch(`${BASE}/api/admin/missing/import`, { method: 'POST', headers: csv, body: 'Pallet,Last known location,Note\nL-1,F03B014,seen near dock\n' })).json();
check('Uploading a pallet already on the list updates it, not doubles it', again.added === 0 && again.updated === 1);
let list = await get('/api/admin/missing');
check('…keeping what it already knew', list.rows.find((r) => r.pallet_id === 'L-1').description === 'Blueberry wild 30lb' && list.rows.find((r) => r.pallet_id === 'L-1').last_location === 'F03B014');
const typed = await post('/api/admin/missing', { pallet: 'L-4', description: 'Cod loin', last: 'F02A001' });
check('One can be typed in', typed.added === 1);
const bad = await (await fetch(`${BASE}/api/admin/missing/import`, { method: 'POST', headers: csv, body: 'Pallet,Qty\nL-9,lots\n' })).json();
check('A bad quantity is refused, naming the row', /row 2: "lots" is not a quantity/.test(bad.error || ''), bad.error);

/* a count, with one of them in it */
const sess = await post('/api/admin/sessions', { name: 'Lost test' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\nK-1,S,Chicken,40,F01A001\nL-3,SKU-2210,Peas,30,F01A003\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { guided: false, askComments: false });
const dev = await post('/api/admin/devices', { name: 'LOST-01' });
const D = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${(await post('/api/admin/devices', { name: 'LOST-02' })).uid}`, {}, hdr)).token };
const forGun = await get('/api/missing', D);
check('The gun gets the list to watch for', forGun.pallets.length === 4 && forGun.pallets.some((p) => p[0] === 'L-1' && p[1] === 'F03B014'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const gun = await browser.newPage({ viewport: { width: 360, height: 640 } });
const errors = [];
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
await gun.fill('#fTeam', '6'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E6'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrScan.active', { timeout: 8000 });
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
await scan('K-1');
check('An ordinary pallet says nothing about the list', !/Not in Location/.test(await gun.textContent('#scanMsg')));
await scan('40'); await scan('F01A001');
await scan('L-1');
if (await gun.isVisible('#btnOvYes')) await gun.click('#btnOvYes');     // not on this count's report: count it anyway
await gun.waitForTimeout(400);
check('Scanning a pallet on the list tells the counter it was being looked for, and where it was last seen', /L-1 was on the Not in Location list — found!/.test(await gun.textContent('#scanMsg')) && /Last seen in F03B014/.test(await gun.textContent('#scanMsg')),
  clean(await gun.textContent('#scanMsg')));
await scan('24'); await scan('F01A002');
await wait(2000);
list = await get('/api/admin/missing');
const l1 = list.rows.find((r) => r.pallet_id === 'L-1');
check('The moment the line lands it is marked found — bin, team, scanner, time', l1.status === 'found' && l1.found_bin === 'F01A002' && l1.found_team === '6' && l1.found_device === 'LOST-01' && !!l1.found_at, JSON.stringify(l1));
/* found while moving a pallet back */
await fetch(`${BASE}/api/admin/sessions/${sess.id}/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\nL-4,F01A001,F01A002\n' });
const mv = (await get(`/api/sessions/${sess.id}/moves`, D)).aisles[0].moves[0];
await post(`/api/sessions/${sess.id}/moves/${mv.id}/done`, { team: '6', deviceId: 'LOST-02' }, D);
list = await get('/api/admin/missing');
check('A pallet found while being moved back is found too', list.rows.find((r) => r.pallet_id === 'L-4').status === 'found' && list.rows.find((r) => r.pallet_id === 'L-4').found_how === 'moved');
check('The others are still missing', list.summary.missing === 2 && list.summary.found === 2);

/* the page */
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => errors.push('page: ' + e.message));
page.on('dialog', (d) => d.accept(d.message().includes('found') ? 'F02B004' : 'written off').catch(() => {}));
await page.goto(BASE + '/missing');
await signIn(page);
await page.waitForTimeout(800);
check('Not in Location is a tab in the sidebar', clean(await page.textContent('#navTabs a.tab.current')).includes('Not in Location'));
check('…opening on what is still missing, with the counts', clean(await page.textContent('#msMissing')) === '2' && clean(await page.textContent('#msFound')) === '2' && (await page.$$('#msTable tbody tr')).length === 2);
const row = page.locator('#msTable tr', { hasText: 'L-2' });
check('…each with its details and last known location', /Chicken/.test(await row.textContent()) && /RECEIVING/.test(await row.textContent()) && /off a trailer/.test(await row.textContent()));
await row.locator('button:has-text("Found in")').click();
await page.waitForTimeout(800);
list = await get('/api/admin/missing');
check('"Found in…" marks it found by hand', list.rows.find((r) => r.pallet_id === 'L-2').status === 'found' && list.rows.find((r) => r.pallet_id === 'L-2').found_bin === 'F02B004');
await page.locator('#msTable tr', { hasText: 'L-3' }).locator('button:has-text("Close")').click();
await page.waitForTimeout(800);
list = await get('/api/admin/missing');
check('"Close" writes one off with the outcome', list.rows.find((r) => r.pallet_id === 'L-3').status === 'closed' && list.rows.find((r) => r.pallet_id === 'L-3').outcome === 'written off');
await page.click('#msFilter button[data-status="found"]');
await page.waitForTimeout(500);
check('The Found view lists where and when each turned up', (await page.$$('#msTable tbody tr')).length === 3 && /F01A002.*team 6/.test(await page.textContent('#msTable')));
await page.fill('#fMsSearch', 'L-4');
await page.waitForTimeout(200);
check('…and the box finds one by pallet, item or bin', (await page.$$('#msTable tbody tr')).length === 1);
const csvText = await (await fetch(`${BASE}/api/admin/missing.csv`, { headers: A })).text();
check('It downloads as a readable CSV', /^﻿?Pallet,Item,Description,Qty,UOM,Lot,Last known location/.test(csvText) && /L-1,SKU-8810,Blueberry wild 30lb,24,,LOT1,F03B014,seen near dock,Found,F01A002,team 6/.test(csvText), csvText.split('\n').find((l) => l.startsWith('L-1')));
check('No script errors', errors.length === 0, errors.join(' | '));
/* ---------------- the find desk: on the gun, and on the page ---------------- */
await post('/api/admin/missing', { pallet: 'L-7', sku: 'SKU-7', description: 'Mango chunks', qty: 48, last: 'F02B001' });
await post('/api/admin/missing', { pallet: 'L-8', description: 'Raspberries', last: 'F03A005' });
await post('/api/admin/missing', { pallet: 'L-9', description: 'Nowhere', last: '' });
await post('/api/admin/pallet-system', { url: `${BASE}/board` });
await gun.click('#btnSignoff').catch(() => {});
await gun.goto(`${BASE}/?d=${dev.uid}`); await gun.waitForTimeout(1500);
check('With pallets on the list, sign-on offers "Not in Location"', await gun.isVisible('#btnModeFind') && clean(await gun.textContent('#btnModeFind')) === 'Not in Location');
await gun.click('#btnModeFind'); await gun.waitForTimeout(300);
check('…and asks for a badge alone, no team and no count', await gun.isHidden('#teamBlock') && await gun.isHidden('#fSession'));
await gun.fill('#fEmployee', 'E9'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrFind.active', { timeout: 8000 });
await gun.waitForTimeout(500);
const findAisles = await gun.$$eval('#findAisles button', (bs) => bs.map((b) => b.textContent));
check('The gun asks which aisle to look in, by where each pallet was last seen', findAisles.length === 3 && /F02.*1$/.test(findAisles[0]) && /F03.*1$/.test(findAisles[1]) && /No location known/.test(findAisles[2]), findAisles.join(' | '));
await gun.click('#findAisles button >> nth=0'); await gun.waitForTimeout(300);
check('Picking the aisle opens the desk: the pallet, where it was last seen, what it is', clean(await gun.textContent('#fdPallet')) === 'L-7' && clean(await gun.textContent('#fdLast')) === 'F02B001' && /Mango chunks/.test(await gun.textContent('#fdWhat')) && /qty 48/.test(await gun.textContent('#fdWhat')), clean(await gun.textContent('#fdWhat')));
check('…with the pallet system framed under it, and no scan box', await gun.isVisible('#findSys') && (await gun.getAttribute('#findFrame', 'src')) === `${BASE}/board` && (await gun.$('#fFindScan')) === null);
await gun.click('#btnFindFound'); await gun.waitForTimeout(1500);
list = await get('/api/admin/missing');
const l7 = list.rows.find((r) => r.pallet_id === 'L-7');
check('"Found — next" marks it found on the server: badge, scanner, how', l7.status === 'found' && l7.found_team === 'E9' && l7.found_device === 'LOST-01' && l7.found_how === 'found', JSON.stringify(l7));
check('…and, the aisle done, the gun is back at the aisle list', await gun.isHidden('#findTask') && (await gun.$$eval('#findAisles button', (bs) => bs.length)) === 2 && /Found L-7/.test(await gun.textContent('#findDoneMsg')));

/* the office desk */
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1500);
check('The page has the same desk: the newest missing pallet first, the system framed below', clean(await page.textContent('#fdDeskPallet')) === 'L-9' && /1 of 2 missing/.test(await page.textContent('#fdDeskCount')) && (await page.getAttribute('#fdDeskFrame', 'src')) === `${BASE}/board`, [await page.textContent('#fdDeskPallet'), await page.textContent('#fdDeskCount')].join(' | '));
await page.click('#fdDeskNext'); await page.waitForTimeout(200);
check('› steps to the next, with where it was last seen', clean(await page.textContent('#fdDeskPallet')) === 'L-8' && clean(await page.textContent('#fdDeskLast')) === 'F03A005');
check('…framed at handheld size, with Full width to open it out', Math.round(await page.$eval('#fdDeskFrame', (f) => f.getBoundingClientRect().width)) === 360 && await page.$eval('#fdDeskWide', (b) => b.textContent === 'Full width'));
await page.fill('#fdDeskBin', 'f03a006'); await page.click('#fdDeskFound'); await page.waitForTimeout(800);
list = await get('/api/admin/missing');
check('Found from the desk marks it, with the bin, by hand', list.rows.find((r) => r.pallet_id === 'L-8').status === 'found' && list.rows.find((r) => r.pallet_id === 'L-8').found_bin === 'F03A006' && /L-8 found in F03A006/.test(await page.textContent('#fdDeskMsg')));
check('…and the desk moves on to the one left', clean(await page.textContent('#fdDeskPallet')) === 'L-9' && list.summary.missing === 1);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} Not in Location checks passed`);
process.exit(failed ? 1 : 0);
