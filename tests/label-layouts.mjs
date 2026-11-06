/*
 * Validating what the gun is handed. A count can refuse bins that are not on
 * the list outright (Bin check: no overrides), and the site can describe each
 * system's pallet label layout so a scan that fits none is called a misread
 * rather than counted as a new pallet. The layouts are suggested from the
 * report itself.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

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
const post = async (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const pj = async (p, b = {}) => j(await post(p, b));

/* two systems on one report: LIVE prints FR + 8 digits, TEST prints T + 6 digits; one hand-typed oddity */
const S = (await pj('/api/admin/sessions', { name: 'Label layouts' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\n' });
let pal = 'Pallet ID,SKU,Description,Qty,Location,System\n';
for (let i = 0; i < 60; i++) pal += `FR1028${String(4000 + i).padStart(4, '0')},SKU-${i},Item ${i},10,F01A001,LIVE\n`;
for (let i = 0; i < 20; i++) pal += `T${String(500000 + i)},TSK-${i},Test item ${i},5,F01A002,TEST\n`;
pal += 'HANDWRITTEN,SKU-X,Odd one,1,F01A003,LIVE\n';
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: pal });
await pj(`/api/admin/sessions/${S}/settings`, { autoRecount: false, askComments: false, guided: false });

/* ---------------- suggested from the report ---------------- */
let sug = (await get(`/api/admin/sessions/${S}/label-layouts/suggest`)).systems;
const live = sug.find((s) => s.system === 'LIVE'), test = sug.find((s) => s.system === 'TEST');
check('The report suggests a layout a system: LIVE is FR + 8 digits, TEST is T + 6 digits', live && live.suggested.join() === 'FR99999999' && test && test.suggested.join() === 'T999999', JSON.stringify(sug.map((s) => [s.system, s.suggested])));
check('…in words, with how much of the system each mask covers', live.masks[0].words === 'FR + 8 digits' && live.masks[0].pct > 95 && live.total === 61, JSON.stringify(live.masks[0]));
check('…and the one hand-typed label is listed but not suggested (under 2%)', live.masks.some((m) => m.n === 1 && !m.suggested) && live.masks.length === 2, JSON.stringify(live.masks.map((m) => [m.mask, m.suggested])));

/* ---------------- saved, read back, sent to the guns ---------------- */
let saved = await pj('/api/admin/label-layouts', { on: true, layouts: [{ system: 'live', masks: 'FR99999999', note: 'the receiving labels' }, { system: 'TEST', masks: ['T999999', 't999999'] }, { system: 'EMPTY', masks: '' }] });
check('Saved: systems upper-cased, masks de-duplicated, a system with no mask dropped, the check on', saved.on && saved.layouts.length === 2 && saved.layouts[0].system === 'LIVE' && saved.layouts[1].masks.join() === 'T999999' && saved.layouts[0].note === 'the receiving labels', JSON.stringify(saved));
check('A mask too long is refused', (await post('/api/admin/label-layouts', { layouts: [{ system: 'X', masks: '9'.repeat(41) }] })).status === 400);
const dev = await pj('/api/admin/devices', { name: 'LAYOUT-01' });
const D = { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const pubOf = async () => (await j(await fetch(`${BASE}/api/sessions`, { headers: D }))).find((x) => x.id === S);
let pub = await pubOf();
check('The gun is told the layouts, in words', pub.labelLayouts.length === 2 && pub.labelLayouts[0].words === 'FR + 8 digits' && pub.labelLayouts[1].system === 'TEST', JSON.stringify(pub.labelLayouts));
await pj('/api/admin/label-layouts', { on: false });
check('Switched off, the guns get none, and the layouts are kept', (await pubOf()).labelLayouts.length === 0 && (await get('/api/admin/label-layouts')).layouts.length === 2 && !(await get('/api/admin/label-layouts')).on);
await pj('/api/admin/label-layouts', { on: true });
check('The log says the layouts changed', (await get('/api/admin/audit?limit=20')).some((r) => r.action === 'changed the pallet label layouts'));

/* ---------------- on the gun ---------------- */
await pj(`/api/admin/sessions/${S}/settings`, { palletMode: 'strict', binMode: 'strict' });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (dd) => dd.accept());
const signOn = async () => {
  await gun.goto(`${BASE}/?d=${dev.uid}`);
  await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
  await gun.selectOption('#fSession', String(S));
  await gun.fill('#fTeam', '1');
  await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
  await gun.click('#btnStart'); await gun.waitForSelector('#scrScan.active, #scrAssign.active', { timeout: 90000 }); await gun.waitForTimeout(500);
  if (await gun.$('#scrAssign.active')) { await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); }
};
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(500); };
await signOn();
/* no overrides on this count: refused outright, nothing recorded */
await scan('FR1O284335');     // an O for a 0: the kind of thing a worn label scans as
check('No overrides on the count: a label fitting no layout is refused outright, naming the layouts', /not a pallet label of any system/.test(clean(await gun.textContent('#scanMsg'))) && /FR \+ 8 digits/.test(clean(await gun.textContent('#scanMsg'))) && !(await gun.isVisible('#ovTitle')), clean(await gun.textContent('#scanMsg')));
await scan('FR10284000'); await scan('10');
await scan('F01A999');
check('Bin check with no overrides: a bin not on the list is refused on the spot, with what to do', /F01A999 is not on the bin list/.test(clean(await gun.textContent('#scanMsg'))) && /Nothing is counted against it/.test(clean(await gun.textContent('#scanMsg'))) && !(await gun.isVisible('#ovTitle')), clean(await gun.textContent('#scanMsg')).slice(0, 160));
await scan('F01A001'); await gun.waitForTimeout(2500);
const lines = (await get(`/api/admin/sessions/${S}/export/everything`)).sheets.find((x) => x.name === 'Count lines').rows;
check('…the right bin then takes the pallet; nothing was recorded against the refused bin', lines.length === 1 && lines[0].Bin === 'F01A001' && !lines.some((l) => l.Bin === 'F01A999'), JSON.stringify(lines.map((l) => l.Bin)) + ' | ' + clean(await gun.textContent('#scanMsg')) + ' | ' + clean(await gun.textContent('#prompt')));
/* overrides allowed: the questions, with the layouts in them */
await pj(`/api/admin/sessions/${S}/settings`, { palletMode: 'warn', binMode: 'warn' });
await signOn();
await scan('FR1O284335');
check('A label that fits no system\'s layout: the gun asks "Not a pallet label?", says what labels look like, and offers a rescan', await gun.isVisible('#ovTitle') && /Not a pallet label\?/.test(clean(await gun.textContent('#ovTitle'))) && /LIVE: FR \+ 8 digits/.test(clean(await gun.textContent('#ovWhy'))) && await gun.isVisible('#ovYesNo'), clean(await gun.textContent('#ovWhy')).slice(0, 160));
await gun.click('#btnOvNo'); await gun.waitForTimeout(400);
check('…No / rescan: back to the pallet prompt, nothing recorded', await gun.isVisible('#scrScan.active') && !(await gun.isVisible('#ovTitle')), clean(await gun.textContent('#prompt')));
await scan('FR10289999');
check('A label that fits LIVE but is not on the file: the usual "Pallet not on the list", noting it looks like a LIVE label', /Pallet not on the list/.test(clean(await gun.textContent('#ovTitle'))) && /looks like a LIVE label/.test(clean(await gun.textContent('#ovWhy'))), clean(await gun.textContent('#ovWhy')));
await gun.click('#btnOvNo'); await gun.waitForTimeout(400);
check('No gun page errors', !errors.length, errors.join(' | '));

/* ---------------- the settings card ---------------- */
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push('settings: ' + e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/settings#gun`);
await signIn(page);
await pickSession(page, S);
await page.waitForSelector('#layoutsTable'); await page.waitForTimeout(600);
check('Settings → Scanners → Pallet label layouts: the saved rows, the check ticked', (await page.locator('#layoutsTable input[data-layout-system]').count()) === 2 && await page.isChecked('#fLayoutsOn') && /FR \+ 8 digits/.test(clean(await page.textContent('#layoutsTable'))), clean(await page.textContent('#layoutsTable')).slice(0, 160));
await pj('/api/admin/label-layouts', { on: false, layouts: [] });
await page.reload(); await page.waitForSelector('#layoutsTable'); await page.waitForTimeout(800);
await page.click('#btnLayoutsSuggest'); await page.waitForTimeout(900);
check('Suggest from the report fills a row a system from the count\'s pallet file', (await page.locator('#layoutsTable input[data-layout-system]').count()) === 2 && (await page.inputValue('#layoutsTable input[data-layout-masks="0"]')) === 'FR99999999' && /Suggested from 81 pallets/.test(clean(await page.textContent('#layoutsMsg'))), clean(await page.textContent('#layoutsMsg')));
await page.check('#fLayoutsOn'); await page.click('#btnSaveLayouts'); await page.waitForTimeout(900);
const after = await get('/api/admin/label-layouts');
check('Save: on, with the two systems', after.on && after.layouts.length === 2 && after.layouts.find((l) => l.system === 'TEST').masks.join() === 'T999999', JSON.stringify(after));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
