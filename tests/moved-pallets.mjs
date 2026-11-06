/*
 * Found in a different bin. A pallet counted somewhere other than where the
 * report has it is a move, not a miscount: it goes on its own report, aisle
 * by aisle, with a CSV and a sheet in Export everything, and is left out of
 * the second counts - unless the count asks for a second count of the
 * report's bin (Settings → Scanners). The gun's bin check has a setting
 * of its own there too.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession, expandSubTabs } from './helpers.mjs';

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

const S = (await pj('/api/admin/sessions', { name: 'Moved pallets' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\nF02A001,Freezer,F02\nF02A002,Freezer,F02\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Variant,Qty,Location\nP1,SKU-A,Chicken breast,DIST,40,F01A001\nP2,SKU-B,Peas,REWORK,96,F01A002\nP3,SKU-C,Mango chunks,,8,F02A001\nP4,SKU-D,Corn,,50,F02A002\n' });
await pj(`/api/admin/sessions/${S}/settings`, { autoRecount: false });
const dev = await pj('/api/admin/devices', { name: 'MOVED-01' });
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
await fetch(`${BASE}/api/sessions/${S}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ team: '3', employees: ['E1'], deviceId: 'MOVED-01' }) });
/* P1 where it should be; P2 found in F02A002 with the report's quantity; P3 found in F01A003 with 6, not 8; P4 not found; F01A002 and F02A001 empty */
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 'm1', palletId: 'P1', qty: 40, location: 'F01A001', team: '3', employees: ['E1'], deviceId: 'MOVED-01' },
  { clientId: 'm2', palletId: 'P2', qty: 96, location: 'F02A002', team: '3', employees: ['E1'], deviceId: 'MOVED-01', overrideReason: 'Not where the report said' },
  { clientId: 'm3', palletId: 'P3', qty: 6, location: 'F01A003', team: '3', employees: ['E1'], deviceId: 'MOVED-01', overrideReason: 'Not where the report said' },
  { clientId: 'm4', palletId: '', qty: 0, location: 'F01A002', team: '3', employees: ['E1'], deviceId: 'MOVED-01', emptyBin: true },
  { clientId: 'm5', palletId: '', qty: 0, location: 'F02A001', team: '3', employees: ['E1'], deviceId: 'MOVED-01', emptyBin: true }]) });

/* ---------------- the report ---------------- */
let d = await get(`/api/admin/sessions/${S}/moved`);
check('Two pallets were found in a bin other than the report\'s', d.total === 2 && d.rows.map((r) => r.pallet_id).sort().join() === 'P2,P3', JSON.stringify(d.rows.map((r) => r.pallet_id)));
const p2 = d.rows.find((r) => r.pallet_id === 'P2'), p3 = d.rows.find((r) => r.pallet_id === 'P3');
check('Each row: where the report had it and where it is, both with their aisles', p2.expected_location === 'F01A002' && p2.expected_aisle === 'F01' && p2.found_location === 'F02A002' && p2.found_aisle === 'F02', JSON.stringify(p2));
check('…the quantities: the report\'s, what was counted, the difference', p2.counted_qty === 96 && p2.variance_qty === 0 && p3.counted_qty === 6 && p3.variance_qty === -2 && d.sameQty === 1, `${p3.counted_qty} vs ${p3.expected_qty}`);
check('…who found it and when', p2.teams === '3' && p2.last_scan, p2.teams);
check('…the item, for the person keying the move', p3.sku === 'SKU-C' && p3.description === 'Mango chunks' && p2.variant === 'REWORK');
check('Sorted by the aisle it was found in, with a count per aisle', d.rows[0].pallet_id === 'P3' && d.byAisle.map((a) => `${a.aisle}:${a.n}`).join() === 'F01:1,F02:1', JSON.stringify(d.byAisle));
check('The pallet report still calls them WRONG BIN', (await get(`/api/admin/sessions/${S}/pallets`)).rows.filter((r) => r.status === 'WRONG BIN').length === 2);

/* ---------------- left out of the second counts ---------------- */
let gen = await pj(`/api/admin/sessions/${S}/recounts/generate`, {});
let recs = await get(`/api/admin/sessions/${S}/recounts`);
check('Generate second counts: the two moves are left alone and the message says so; the missing P4 gets one', gen.skippedMoved === 2 && gen.created === 1 && recs.length === 1 && recs[0].pallet_id === 'P4', JSON.stringify({ gen, bins: recs.map((r) => r.bin) }));
check('…so no second count is raised for the report\'s bin or the bin it was found in', !recs.some((r) => ['F01A002', 'F02A002', 'F01A003', 'F02A001'].includes(r.bin) && r.pallet_id !== 'P4'), recs.map((r) => r.bin).join());
/* the option: a second count of the report's bin too */
let s = await pj(`/api/admin/sessions/${S}/settings`, { recountWrongBin: true });
check('Settings: Second count the report\'s bin is saved on the count', s.recount_wrong_bin === 1 || s.recountWrongBin === true || (await get('/api/admin/sessions')).find((x) => x.id === S).recount_wrong_bin === 1);
gen = await pj(`/api/admin/sessions/${S}/recounts/generate`, {});
recs = await get(`/api/admin/sessions/${S}/recounts`);
check('With it on, Generate raises second counts of the report\'s bins (and of the bins they were found in)', gen.created >= 2 && !gen.skippedMoved && recs.filter((r) => ['F01A002', 'F02A001'].includes(r.bin)).length === 2, JSON.stringify({ gen, bins: recs.map((r) => r.bin) }));
await pj(`/api/admin/sessions/${S}/settings`, { recountWrongBin: false });

/* ---------------- the files ---------------- */
const f = await fetch(`${BASE}/api/admin/sessions/${S}/export/moved.csv`, { headers: A });
const text = (await f.text()).replace(/^\ufeff/, '');
check('Found in a different bin CSV: a file of its own, with the columns an office needs', f.status === 200 && /found-in-a-different-bin/.test(f.headers.get('content-disposition')) && text.split(/\r?\n/)[0] === 'Pallet,System,Item,Description,Variant,Report bin,Report aisle,Found in,Found aisle,Report qty,Counted qty,Difference,Counted by,Last scan,Comments' && text.includes('P2,') && text.includes('F02A002'), text.split(/\r?\n/)[0]);
const ev = await get(`/api/admin/sessions/${S}/export/everything`);
const names = ev.sheets.map((x) => x.name);
const sh = ev.sheets.find((x) => x.name === 'Found in a different bin');
check('Export everything has a Found in a different bin sheet, after Not on the report', sh && names.indexOf('Found in a different bin') === names.indexOf('Not on the report') + 1 && sh.rows.length === 2, names.join(' | '));
check('The log records the export', (await get('/api/admin/audit?limit=20')).some((r) => /found in a different bin/.test(r.action)));

/* ---------------- bin check setting ---------------- */
s = await pj(`/api/admin/sessions/${S}/settings`, { binMode: 'strict' });
const pubOf = async () => (await j(await fetch(`${BASE}/api/sessions`, { headers: D }))).find((x) => x.id === S);
let pub = await pubOf();
check('Settings: the bin check mode is saved and sent to the guns', pub.binMode === 'strict', JSON.stringify(pub.binMode));
await pj(`/api/admin/sessions/${S}/settings`, { binMode: 'nonsense' });
pub = await pubOf();
check('…a mode that is not one is ignored', pub.binMode === 'strict');
await pj(`/api/admin/sessions/${S}/settings`, { binMode: 'warn' });
check('…and back to warn', (await pubOf()).binMode === 'warn');

/* ---------------- the pages ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/admin#reports`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#movedTable tbody tr', { timeout: 10000 }); await page.waitForTimeout(300);
check('Reports → Found in a different bin: the two moves, with where the report had them and where they are', (await page.locator('#movedTable tbody tr').count()) === 2 && /2 pallets the report had somewhere else/.test(clean(await page.textContent('#movedSub'))) && /F01A002/.test(clean(await page.textContent('#movedTable'))) && /F02A002/.test(clean(await page.textContent('#movedTable'))), clean(await page.textContent('#movedSub')));
check('…the numbers: how many, how many with the same quantity, and the aisles they were found in', /1/.test(clean(await page.textContent('#movedStats'))) && /Found in: F01 \(1\) · F02 \(1\)/.test(clean(await page.textContent('#movedAisles'))), clean(await page.textContent('#movedAisles')));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportMoved')]);
check('…and the CSV button downloads it', /found-in-a-different-bin/.test(dl.suggestedFilename()), dl.suggestedFilename());
await page.goto(`${BASE}/settings#gun`); await page.waitForSelector('#sessionPick .sess-btn, #fSessionPick'); await pickSession(page, S); await page.waitForSelector('#fRecountWrongBin'); await page.waitForTimeout(600);
check('Settings → Scanners: the bin check and the second-count option, read back from the count', (await page.inputValue('#fBinMode')) === 'warn' && !(await page.isChecked('#fRecountWrongBin')));
await page.selectOption('#fBinMode', 'strict'); await page.check('#fRecountWrongBin'); await page.click('#btnSaveSettings'); await page.waitForTimeout(900);
const row = (await get('/api/admin/sessions')).find((x) => x.id === S);
check('Save: both on the count', row.bin_mode === 'strict' && row.recount_wrong_bin === 1, JSON.stringify({ bin_mode: row.bin_mode, recount_wrong_bin: row.recount_wrong_bin }));
await page.reload(); await page.waitForSelector('#fRecountWrongBin'); await page.waitForTimeout(800);
check('…and read back after a reload', (await page.inputValue('#fBinMode')) === 'strict' && (await page.isChecked('#fRecountWrongBin')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
