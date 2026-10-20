/*
 * The ERP, an aisle at a time: inventory control downloads an aisle's Excel
 * sheet - every pallet in it, the latest count, the difference - fills in the
 * "Uploaded to ERP" column as the lines go in, and uploads the sheet back to
 * mark those lines here. A line counted again afterwards is flagged.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
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
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const sandbox = { window: {}, self: {}, console };
vm.runInNewContext(readFileSync(new URL('../public/vendor/xlsx.full.min.js', import.meta.url), 'utf8'), sandbox);
const XLSX = sandbox.XLSX || sandbox.window.XLSX || sandbox.self.XLSX;

const F01 = ['F01A001', 'F01A002', 'F01A003', 'F01A004'];
const F02 = ['F02A001', 'F02A002'];
const s = await j(await post('/api/admin/sessions', { name: 'Aisle by aisle' }));
const S = s.id;
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + [...F01, ...F02].map((b) => `${b},Freezer,${b.slice(0, 3)}`).join('\n') + '\n', csv);
await post(`/api/admin/sessions/${S}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\n'
  + [...F01, ...F02].map((b, i) => `P-${i + 1},S${i},Mango,40,${b}`).join('\n') + '\n', csv);
const d = await j(await post('/api/admin/devices', { name: 'ERP-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${d.uid}`, {}, hdr))).token };
let n = 0;
const line = (pallet, qty, bin, team = '1', extra = {}) => ({ clientId: `e${++n}`, palletId: pallet, qty, location: bin, team, deviceId: 'ERP-01', scannedAt: new Date().toISOString(), ...extra });
const send = (rows) => post(`/api/sessions/${S}/counts`, rows, G);
// F01: two match, one short, one not found yet; P-9 is not on the report at all
await send([line('P-1', 40, 'F01A001'), line('P-2', 40, 'F01A002'), line('P-3', 36, 'F01A003'), line('P-9', 12, 'F01A004')]);
await send([line('P-5', 40, 'F02A001')]);

let a = (await get(`/api/admin/sessions/${S}/erp-entries/aisles`)).aisles;
const f01 = a.find((x) => x.aisle === 'F01');
check('Every aisle listed with its lines, counted, differences and nothing uploaded yet', a.map((x) => x.aisle).join() === 'F01,F02' && f01.lines === 5 && f01.counted === 4 && f01.differences === 3 && f01.uploaded === 0 && f01.state === 'none', JSON.stringify(f01));
check('…and what is still being counted: open second counts', f01.openRecounts >= 1, JSON.stringify(f01));

const sheet = await get(`/api/admin/sessions/${S}/export/erp-aisle?aisle=F01`);
const rows = sheet.sheets[0].rows;
const by = (p) => rows.find((r) => r.Pallet === p);
check('The aisle sheet: every pallet in the aisle, matches included, and an Uploaded to ERP column', sheet.sheets[0].name === 'Aisle F01' && rows.length === 5 && sheet.sheets[0].columns.includes('Uploaded to ERP') && /aisle-F01-for-ERP/.test(sheet.filename), rows.map((r) => r.Pallet).join());
check('…with the report, the count and the difference on each line', by('P-3')['Report quantity'] === 40 && by('P-3')['Counted quantity'] === 36 && by('P-3')['Adjustment'] === -4 && by('P-1')['Adjustment'] === 0 && by('P-1').Result === 'Matches'
  && by('P-9')['Report quantity'] === '' && by('P-9')['Counted quantity'] === 12 && by('P-4')['Counted quantity'] === '' && by('P-4').Result === 'Not found', JSON.stringify([by('P-3'), by('P-9'), by('P-4')].map((r) => [r.Pallet, r['Report quantity'], r['Counted quantity'], r.Adjustment, r.Result])));
check('…and a How to use sheet', sheet.sheets[1].name === 'How to use');
let r = await fetch(`${BASE}/api/admin/sessions/${S}/export/erp-aisle?aisle=F09`, { headers: A });
check('An aisle with nothing in it says so', r.status === 404);

/* the sheet back, as a CSV: three lines marked, one blank */
const back = 'Aisle,Bin,Pallet,Uploaded to ERP\nF01,F01A001,P-1,yes\nF01,F01A002,P-2,x\nF01,F01A003,P-3,10/20\nF01,F01A004,P-9,\n';
r = await fetch(`${BASE}/api/admin/sessions/${S}/erp-entries/upload?aisle=F01`, { method: 'POST', headers: csv, body: back });
let out = await j(r);
check('Uploading it back marks the filled-in lines, a match included, and leaves the blank one', r.status === 200 && out.marked === 3 && out.skipped === 1, JSON.stringify(out));
a = (await get(`/api/admin/sessions/${S}/erp-entries/aisles`)).aisles;
check('…the aisle shows 3 of 5 uploaded', a.find((x) => x.aisle === 'F01').uploaded === 3 && a.find((x) => x.aisle === 'F01').state === 'some');
const sheet2 = await get(`/api/admin/sessions/${S}/export/erp-aisle?aisle=F01`);
const p3 = sheet2.sheets[0].rows.find((x) => x.Pallet === 'P-3');
check('…and the next download says who uploaded each line, and when', p3['Uploaded to ERP'] === 'yes' && !!p3['Uploaded by'] && !!p3['Uploaded at'] && sheet2.sheets[0].rows.find((x) => x.Pallet === 'P-9')['Uploaded to ERP'] === '');
const log = await get(`/api/admin/audit?limit=20`);
check('The log says it came from the aisle sheet', (Array.isArray(log) ? log : []).some((x) => /from the aisle F01 sheet/.test(x.action)));

/* counted again after it went in: flagged */
const task = (await get(`/api/admin/sessions/${S}/recounts`)).find((t) => t.bin === 'F01A003');
await post(`/api/sessions/${S}/recounts/${task.id}/take`, { team: '2' }, G);
await send([line('P-3', 38, 'F01A003', '2', { pass: 2, recountId: task.id })]);
await post(`/api/sessions/${S}/recounts/${task.id}/done`, { team: '2' }, G);
a = (await get(`/api/admin/sessions/${S}/erp-entries/aisles`)).aisles;
const sheet3 = await get(`/api/admin/sessions/${S}/export/erp-aisle?aisle=F01`);
const p3b = sheet3.sheets[0].rows.find((x) => x.Pallet === 'P-3');
check('A line second-counted after it was uploaded is flagged changed, with the old number', a.find((x) => x.aisle === 'F01').changed === 1 && p3b['Changed since uploaded'] === 'was 36' && p3b['Counted quantity'] === 38 && p3b.Count === '2nd', JSON.stringify(p3b));
r = await fetch(`${BASE}/api/admin/sessions/${S}/erp-entries/upload?aisle=F01`, { method: 'POST', headers: csv, body: 'Pallet,Uploaded to ERP\nP-3,yes\n' });
out = await j(r);
check('A plain yes on a changed line keeps its first mark, so an old sheet cannot hide the change', out.already === 1 && (await get(`/api/admin/sessions/${S}/erp-entries/aisles`)).aisles.find((x) => x.aisle === 'F01').changed === 1, JSON.stringify(out));
r = await fetch(`${BASE}/api/admin/sessions/${S}/erp-entries/upload?aisle=F01`, { method: 'POST', headers: csv, body: 'Pallet,Uploaded to ERP\nP-3,again\n' });
out = await j(r);
const p3c = (await get(`/api/admin/sessions/${S}/export/erp-aisle?aisle=F01`)).sheets[0].rows.find((x) => x.Pallet === 'P-3');
check('"again" marks it at today\'s numbers: no longer changed', out.remarked === 1 && p3c['Uploaded to ERP'] === 'yes' && p3c['Changed since uploaded'] === '' && (await get(`/api/admin/sessions/${S}/erp-entries/aisles`)).aisles.find((x) => x.aisle === 'F01').changed === 0, JSON.stringify([out, p3c['Changed since uploaded']]));
r = await fetch(`${BASE}/api/admin/sessions/${S}/erp-entries/upload`, { method: 'POST', headers: csv, body: 'Pallet,Quantity\nP-1,40\n' });
check('A file without the column is turned away, saying which column', r.status === 400 && /Uploaded to ERP/.test((await j(r)).error));
r = await fetch(`${BASE}/api/admin/sessions/${S}/erp-entries/upload`, { method: 'POST', headers: csv, body: 'Pallet,Uploaded to ERP\nP-2,no\n' });
check('"no" takes a mark off', (await j(r)).unmarked === 1);

/* inventory control can do all of it */
await post('/api/admin/users', { username: 'INV-ERP', name: 'Inv Ctrl', password: 'erp-aisles-pass-1', mustChange: false, profile: 'inventory' });
const IH = { ...hdr, authorization: 'Bearer ' + (await j(await post('/api/admin/login', { username: 'INV-ERP', password: 'erp-aisles-pass-1' }, hdr))).token };
check('Inventory control may list the aisles and download a sheet', (await fetch(`${BASE}/api/admin/sessions/${S}/erp-entries/aisles`, { headers: IH })).status === 200 && (await fetch(`${BASE}/api/admin/sessions/${S}/export/erp-aisle?aisle=F02`, { headers: IH })).status === 200);

/* ------------------------------------------------------------------ the page: download, fill in, upload */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#adjust`);
await signIn(page, { user: 'INV-ERP', password: 'erp-aisles-pass-1' });
await pickSession(page, S);
await page.waitForSelector('#erpAislesTable tr[data-aisle="F02"]');
check('Adjustments → ERP upload, an aisle at a time: a row an aisle', (await page.locator('#erpAislesTable tbody tr[data-aisle]').count()) === 2 && /2 of 5|1 of 5/.test(clean(await page.textContent('#erpAislesTable tr[data-aisle="F01"]'))), clean(await page.textContent('#erpAislesTable tr[data-aisle="F01"]')));
check('…saying what is still being counted', /not counted|open/.test(clean(await page.textContent('#erpAislesTable tr[data-aisle="F02"]'))), clean(await page.textContent('#erpAislesTable tr[data-aisle="F02"]')));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#erpAislesTable button[data-erp-aisle="F02"]')]);
check('⬇ Excel downloads the aisle\'s workbook', /aisle-F02-for-ERP/.test(dl.suggestedFilename()), dl.suggestedFilename());
const wb = XLSX.read(readFileSync(await dl.path()), { type: 'buffer' });
const heads = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0] || [];
check('…its first sheet is the aisle, with the column to fill in', wb.SheetNames[0] === 'Aisle F02' && heads.includes('Uploaded to ERP'), `${wb.SheetNames.join('|')} / ${heads.join(',')}`);
/* fill it in as inventory control would, in Excel: every line yes */
const ws = wb.Sheets['Aisle F02'];
const data = XLSX.utils.sheet_to_json(ws, { defval: '' }).map((x) => ({ ...x, 'Uploaded to ERP': 'yes' }));
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(data), 'Aisle F02');
XLSX.utils.book_append_sheet(wb2, wb.Sheets['How to use'], 'How to use');
const file = join(mkdtempSync(join(tmpdir(), 'erpaisle-')), 'F02-filled.xlsx');
writeFileSync(file, XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }));
await page.setInputFiles('#fErpAisleFile', file);
await page.waitForFunction(() => /marked as uploaded/.test(document.getElementById('erpAislesMsg').textContent), null, { timeout: 8000 }).catch(() => {});
check('Uploading the filled-in workbook marks every line in it', /2 lines marked as uploaded to the ERP/.test(clean(await page.textContent('#erpAislesMsg'))), clean(await page.textContent('#erpAislesMsg')));
await page.waitForTimeout(500);
check('…and the aisle reads all in the ERP', /all in the ERP/.test(clean(await page.textContent('#erpAislesTable tr[data-aisle="F02"]'))));
await page.check('#fErpAislesTodo');
await page.waitForTimeout(400);
check('Only aisles not fully uploaded hides it', (await page.locator('#erpAislesTable tr[data-aisle="F02"]').count()) === 0 && (await page.locator('#erpAislesTable tr[data-aisle="F01"]').count()) === 1, await page.$$eval('#erpAislesTable tbody tr', (t) => t.map((x) => x.textContent).join(' / ')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
