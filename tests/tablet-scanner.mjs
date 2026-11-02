/*
 * An Android tablet as a backup scanner.
 *
 * Registered like a scanner, with Type: Tablet or phone. On the tablet each box
 * that takes a scan has a Camera button, and what the camera reads goes in as a
 * trigger scan would; the quantity brings the keypad up by itself. A Zebra is
 * untouched: no camera buttons, no keypad it did not ask for.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));

const S = (await post('/api/admin/sessions', { name: 'Tablet count' })).id;
const bins = ['W01A001', 'W01A002', 'W01A003'];
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Dry,W01`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\n' + bins.map((b, i) => `WP-${i + 1},SKU-${i + 1},Item,${10 + i},${b}`).join('\n') + '\n' });
await post('/api/admin/scanner-layout', { order: ['bin', 'pallet', 'qty'] });
await post(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false, autoRecount: false });
await post(`/api/admin/sessions/${S}/assignments`, { team: '4', aisles: 'W01', levels: 'A-F', force: true });

const tab = await post('/api/admin/devices', { name: 'TABLET-01', kind: 'tablet' });
const gun = await post('/api/admin/devices', { name: 'SCANNER-31' });
check('A tablet is registered like a scanner, typed as a tablet; a scanner stays a Zebra', tab.kind === 'tablet' && gun.kind === 'gun', `${tab.kind} / ${gun.kind}`);
const list = (await j(await fetch(`${BASE}/api/admin/devices`, { headers: A }))).devices;
check('…the list says which is which', list.find((d) => d.name === 'TABLET-01').kind === 'tablet' && list.find((d) => d.name === 'SCANNER-31').kind === 'gun');
const enrol = await j(await fetch(`${BASE}/api/devices/${tab.uid}`, { method: 'POST', headers: hdr, body: '{}' }));
check('Opening its link tells the device it is a tablet', enrol.kind === 'tablet');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const t = await browser.newPage({ viewport: { width: 800, height: 1280 } });
t.on('pageerror', (e) => errors.push('tablet: ' + e.message));
await t.goto(`${BASE}/?d=${tab.uid}`);
await t.waitForSelector('#scrSignon.active'); await t.waitForTimeout(700);
check('The tablet shows Camera buttons for the team number and the badge', await t.evaluate(() => document.body.classList.contains('tablet')) && await t.isVisible('#cam_fTeam') && await t.isVisible('#cam_fEmployee'));
/* no camera barcode reader in this test browser: Camera says so and brings the keyboard up */
await t.click('#cam_fTeam'); await t.waitForTimeout(400);
check('Where the browser cannot read barcodes, Camera says so and offers the keyboard', /cannot read barcodes with its camera/.test(clean(await t.textContent('#signonMsg'))), clean(await t.textContent('#signonMsg')));
/* what the camera reads goes in as a scan */
await t.selectOption('#fSession', String(S));
await t.evaluate(() => window.__deliverScan('fTeam', '4'));
await t.evaluate(() => window.__deliverScan('fEmployee', 'E4001'));
await t.waitForTimeout(400);
check('A badge read by the camera lands like a scan', /E4001/.test(clean(await t.textContent('#employeeChips'))), clean(await t.textContent('#employeeChips')));
await t.click('#btnStart'); await t.waitForSelector('#scrAssign.active'); await t.waitForTimeout(500);
await t.click('#btnCount'); await t.waitForSelector('#scrScan.active'); await t.waitForTimeout(400);
check('The counting screen has a Camera button under the scan box', await t.isVisible('#cam_fScan'));
await t.evaluate(() => window.__deliverScan('fScan', 'W01A001')); await t.waitForTimeout(400);
await t.evaluate(() => window.__deliverScan('fScan', 'WP-1')); await t.waitForTimeout(500);
check('…the quantity step: no Camera, and the box asks for the number keypad', !(await t.isVisible('#cam_fScan')) && await t.$eval('#fScan', (f) => f.inputMode) === 'decimal', `${await t.isVisible('#cam_fScan')} ${await t.$eval('#fScan', (f) => f.inputMode)}`);
await t.fill('#fScan', '10'); await t.press('#fScan', 'Enter'); await t.waitForTimeout(1200);
check('…the line is counted, and the next scan step has the Camera again', await t.isVisible('#cam_fScan') && /W01A002/.test(clean(await t.textContent('#nextBin'))), clean(await t.textContent('#nextBin')));
await t.evaluate(() => window.dispatchEvent(new Event('online'))); await t.waitForTimeout(1500);
const rows = (await j(await fetch(`${BASE}/api/admin/sessions/${S}/pallets?limit=10`, { headers: A }))).rows;
check('…and the office has it, from TABLET-01', rows.find((r) => r.pallet_id === 'WP-1') && rows.find((r) => r.pallet_id === 'WP-1').status === 'MATCH', JSON.stringify(rows.find((r) => r.pallet_id === 'WP-1')));
await t.screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});

/* a Zebra: untouched */
const g = await browser.newPage({ viewport: { width: 480, height: 800 } });
g.on('pageerror', (e) => errors.push('gun: ' + e.message));
await g.goto(`${BASE}/?d=${gun.uid}`);
await g.waitForSelector('#scrSignon.active'); await g.waitForTimeout(600);
check('A Zebra scanner has no Camera buttons', !(await g.$('#cam_fTeam')) && !(await g.evaluate(() => document.body.classList.contains('tablet'))));

/* Settings: the type is chosen when adding, and can be changed */
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => errors.push('settings: ' + e.message));
await page.goto(`${BASE}/settings`);
await signIn(page);
await page.evaluate(() => window.appApi && window.appApi.showSub && window.appApi.showSub('gun')); await page.waitForTimeout(800);
await page.fill('#fDevName', 'TABLET-02'); await page.selectOption('#fDevKind', 'tablet'); await page.click('#btnAddDevice'); await page.waitForTimeout(800);
check('Settings: Add scanner with Type Tablet or phone, and it says to allow the camera', /allow the camera/.test(clean(await page.textContent('#deviceMsg'))) && (await j(await fetch(`${BASE}/api/admin/devices`, { headers: A }))).devices.find((d) => d.name === 'TABLET-02').kind === 'tablet', clean(await page.textContent('#deviceMsg')));
await page.selectOption(`#deviceTable select[data-uid="${gun.uid}"]`, 'tablet'); await page.waitForTimeout(700);
check('…and a scanner\'s type can be changed on its row', (await j(await fetch(`${BASE}/api/admin/devices`, { headers: A }))).devices.find((d) => d.name === 'SCANNER-31').kind === 'tablet');

check('No page errors', !errors.length, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
