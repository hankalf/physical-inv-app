/*
 * Location-first, and the quantity typed. The gun ships asking for the bin,
 * then the pallet, then the quantity - and the quantity comes from the
 * keypad only: a burst of keystrokes the way a scanner delivers a barcode is
 * refused as a scan, as is a bin, a pallet on the file, or anything that
 * fits a system's label layout.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const pj = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));

const S = (await pj('/api/admin/sessions', { name: 'Typed quantities' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location,System\nFR10284301,SKU-1,Chicken,40,F01A001,LIVE\n10284302,SKU-2,Peas,30,F01A002,LIVE\n' });
await pj(`/api/admin/sessions/${S}/settings`, { guided: false, askComments: false, autoRecount: false });
await pj('/api/admin/label-layouts', { on: true, layouts: [{ system: 'LIVE', masks: 'FR99999999, 99999999' }] });
const dev = await pj('/api/admin/devices', { name: 'QTY-01' });

check('The site ships location-first: bin, pallet, quantity', (await get('/api/admin/scanner-layout')).order.slice(0, 3).join() === 'bin,pallet,qty');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
gun.on('pageerror', (e) => errors.push(e.message));
gun.on('dialog', (dd) => dd.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', '1'); await gun.fill('#fEmployee', 'E1'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrScan.active, #scrAssign.active', { timeout: 90000 }); await gun.waitForTimeout(500);
if (await gun.$('#scrAssign.active')) { await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); }
const prompt = async () => clean(await gun.textContent('#prompt'));
const msg = async () => clean(await gun.textContent('#scanMsg'));
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
/* a scanner delivers the whole barcode in a few milliseconds; a person takes longer between keys */
const scanned = async (v) => { await gun.focus('#fScan'); await gun.keyboard.type(v, { delay: 2 }); await gun.keyboard.press('Enter'); await gun.waitForTimeout(450); };
const typed = async (v) => { await gun.focus('#fScan'); await gun.keyboard.type(v, { delay: 120 }); await gun.keyboard.press('Enter'); await gun.waitForTimeout(450); };

check('The gun asks for the bin first', /Scan BIN LOCATION/i.test(await prompt()), await prompt());
await scan('F01A001');
check('…then the pallet', /Scan PALLET ID/i.test(await prompt()), await prompt());
await scan('FR10284301');
check('…then the quantity', /Enter QUANTITY/i.test(await prompt()), await prompt());
await scanned('10284302');
check('A barcode scanned into the quantity - digits only, the way a scanner delivers it - is refused as a scan', /is a scan, not a quantity|is a pallet label, not a quantity/.test(await msg()) && /Enter QUANTITY/i.test(await prompt()), await msg());
await scanned('40');
check('…even a short one', /is a scan, not a quantity/.test(await msg()) && /Enter QUANTITY/i.test(await prompt()), await msg());
await scan('F01A002');
check('A bin scanned there is refused as a bin', /That is a bin, not a quantity/.test(await msg()), await msg());
await scan('FR10284399');
check('A label that fits the system layout is refused as a pallet label, on the file or not', /That is a pallet label, not a quantity/.test(await msg()), await msg());
await typed('40');
check('A number typed on the keypad goes in, and the line is complete', /Counted FR10284301/.test(await msg()) && /Scan BIN LOCATION/i.test(await prompt()), `${await msg()} | ${await prompt()}`);
await gun.waitForTimeout(2500);
const lines = (await get(`/api/admin/sessions/${S}/export/everything`)).sheets.find((x) => x.name === 'Count lines').rows;
check('…the one line on the server: 40 of FR10284301 in F01A001', lines.length === 1 && lines[0].Quantity === 40 && lines[0].Bin === 'F01A001' && lines[0].Pallet === 'FR10284301', JSON.stringify(lines.map((l) => [l.Pallet, l.Quantity, l.Bin])));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
