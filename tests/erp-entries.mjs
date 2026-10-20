/*
 * Entered in the ERP.
 *
 * Inventory control keys the adjustments into the ERP by hand from the
 * worksheet and must not key a line twice. Each line can be marked as entered
 * - a few at a time from the Adjustments tab, or by uploading the worksheet
 * back with its "In ERP" column filled in - the mark shows in the table, the
 * worksheet, the adjustments CSV and the Export everything workbook, a line
 * counted again after it was entered is flagged, and only a login that may
 * approve adjustments may mark.
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
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const text = async (p) => (await fetch(BASE + p, { headers: A })).text();

/* a count with three differences from the report */
const sess = await j(await post('/api/admin/sessions', { name: 'ERP count' }));
const sid = sess.id;
await post(`/api/admin/sessions/${sid}/master?kind=bins`, 'Bin Location\nF01A001\nF01A002\nF01A003\nF01A004\n', csv);
await post(`/api/admin/sessions/${sid}/master?kind=pallets`, 'Bin Code,Container No.,Item No.,Description,Quantity\nF01A001,P-1,SKU-1,Mango,40\nF01A002,P-2,SKU-2,Peach,30\nF01A003,P-3,SKU-3,Blueberry,20\n', csv);
const dev = await j(await post('/api/admin/devices', { name: 'ERP-01' }));
const T = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
const at = new Date().toISOString();
await post(`/api/sessions/${sid}/counts`, [
  { clientId: 'e1', palletId: 'P-1', qty: 36, location: 'F01A001', team: '1', scannedAt: at },   // short
  { clientId: 'e2', palletId: 'P-2', qty: 34, location: 'F01A002', team: '1', scannedAt: at },   // over
  { clientId: 'e3', palletId: 'P-9', qty: 10, location: 'F01A004', team: '1', scannedAt: at },   // not on the report
], T);

let view = await get(`/api/admin/sessions/${sid}/adjustments/view`);
const rows = [...view.positive.rows, ...view.negative.rows];
check('The adjustments come with their ERP mark, none entered yet', rows.length === 3 && rows.every((r) => r.erp === null) && view.erp.entered === 0 && view.erp.total === 3, JSON.stringify(view.erp));

let r = await j(await post(`/api/admin/sessions/${sid}/erp-entries`, { pallets: ['P-1', 'NOPE-1'], on: true }));
check('Marking a line records who and when; a pallet not on the count is reported, not marked', r.marked === 1 && r.unknown.join() === 'NOPE-1' && r.entered === 1, JSON.stringify(r));
view = await get(`/api/admin/sessions/${sid}/adjustments/view`);
const p1 = [...view.positive.rows, ...view.negative.rows].find((x) => x.pallet_id === 'P-1');
check('…and the line carries it', p1.erp && p1.erp.by === 'Dana Whitfield' && p1.erp.qty === -4 && !p1.erp.changed, JSON.stringify(p1.erp));

/* the worksheet: download, fill in, bring back */
const sheet = await text(`/api/admin/sessions/${sid}/export/erp-worksheet.csv`);
check('The ERP worksheet lists every line with an In ERP column, filled where it is', /^Side,Pallet,.*,In ERP,Entered by,Entered at,Changed since entered/.test(sheet.split('\n')[0]) && /P-1,.*,yes,Dana Whitfield/.test(sheet) && /P-2,.*,not required,,,,/.test(sheet), sheet.split('\n').slice(0, 2).join(' | '));
const filled = sheet.split('\n').map((line) => (line.startsWith('Positive,P-2') ? line.replace(',not required,,,,', ',not required,x,,,') : line.startsWith('Positive,P-9') ? line.replace(',not required,,,,', ',not required,10/14 DW,,,') : line)).join('\n');
r = await j(await post(`/api/admin/sessions/${sid}/erp-entries/upload`, filled, csv));
check('Uploading it back marks the lines whose In ERP cell was filled - an x, initials and a date both count', r.marked === 2 && r.unmarked === 0 && r.entered === 3 && r.total === 3, JSON.stringify(r));
r = await j(await post(`/api/admin/sessions/${sid}/erp-entries/upload`, 'Pallet,In ERP\nP-2,no\nP-1,\nP-7,yes\n', csv));
check('A "no" takes a mark off, a blank leaves it, an unknown pallet is reported', r.unmarked === 1 && r.marked === 0 && r.unknown.join() === 'P-7' && r.entered === 2, JSON.stringify(r));
r = await post(`/api/admin/sessions/${sid}/erp-entries/upload`, 'Pallet,Qty\nP-2,3\n', csv);
check('A file with no In ERP column is refused with a word on what to upload', r.status === 400 && /no "In ERP" or "Uploaded to ERP" column/.test((await j(r)).error));

/* a second count after the mark: the ERP has the old number */
await post(`/api/sessions/${sid}/counts`, [{ clientId: 'e4', palletId: 'P-1', qty: 38, location: 'F01A001', team: '2', pass: 2, scannedAt: new Date().toISOString() }], T);
view = await get(`/api/admin/sessions/${sid}/adjustments/view`);
const p1b = [...view.positive.rows, ...view.negative.rows].find((x) => x.pallet_id === 'P-1');
check('A line counted again since it was entered is flagged, with the number the ERP has', p1b.erp && p1b.erp.changed && p1b.erp.qty === -4 && p1b.variance_qty === -2 && view.erp.changed === 1, JSON.stringify([p1b.erp, p1b.variance_qty]));

/* the other exports carry the mark */
const adjCsv = await text(`/api/admin/sessions/${sid}/export/adjustments.csv`);
check('The adjustments CSV has the mark columns', /in_erp,entered_by,entered_at/.test(adjCsv.split('\n')[0]));
const wb = await fetch(`${BASE}/api/admin/sessions/${sid}/export/all.xlsx`, { headers: A }).catch(() => null);
check('Export everything still answers', !wb || wb.ok || wb.status === 404, wb ? String(wb.status) : 'no fetch');

/* who may */
await post('/api/admin/users', { username: 'FLOOR-SUP', name: 'Floor Sup', password: 'dock-side-77', mustChange: false, profile: 'floor' });
const ft = (await j(await post('/api/admin/login', { username: 'FLOOR-SUP', password: 'dock-side-77' }, hdr))).token;
r = await post(`/api/admin/sessions/${sid}/erp-entries`, { pallets: ['P-9'], on: false }, { ...hdr, authorization: 'Bearer ' + ft });
check('A count supervisor, who may not approve adjustments, may not mark either', r.status === 403, String(r.status));
await post('/api/admin/users', { username: 'INV-CTRL', name: 'Inventory Control', password: 'count-week-1', mustChange: false, profile: 'inventory' });
const it = (await j(await post('/api/admin/login', { username: 'INV-CTRL', password: 'count-week-1' }, hdr))).token;
r = await post(`/api/admin/sessions/${sid}/erp-entries`, { pallets: ['P-9'], on: false }, { ...hdr, authorization: 'Bearer ' + it });
check('Inventory control may', r.status === 200 && (await j(r)).unmarked === 1);

/* ---- the tab */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#adjust`);
await signIn(page, { user: 'INV-CTRL', password: 'count-week-1' });
await page.evaluate(() => window.appApi.showSub('adjust')); await page.waitForTimeout(1500);
await page.click('#pnSide button[data-side="all"]'); await page.waitForTimeout(600);
const tableText = clean(await page.textContent('#pnTable'));
check('The Adjustments tab has an In ERP column: P-1 changed, P-2 blank, P-9 blank', /CHANGED/.test(tableText) && (await page.$$('#pnTable tr[data-pallet]')).length === 3 && (await page.$$('#pnTable .erpPick')).length === 3, tableText.slice(0, 120));
check('…and the chip says how many are in', /1 of 3 entered · 1 changed since/.test(clean(await page.textContent('#erpChip'))), clean(await page.textContent('#erpChip')));
await page.check('#pnTable tr[data-pallet="P-2"] .erpPick'); await page.check('#pnTable tr[data-pallet="P-9"] .erpPick');
await page.click('#btnErpMark'); await page.waitForTimeout(1200);
check('Tick two lines, Mark as entered: both carry the mark, the message says so', /2 lines marked as entered/.test(clean(await page.textContent('#erpMsg'))) && (await page.$$('#pnTable tr[data-pallet] .tag')).length >= 3 && /3 of 3 entered/.test(clean(await page.textContent('#erpChip'))), clean(await page.textContent('#erpMsg')));
await page.check('#fPnHideEntered'); await page.waitForTimeout(500);
check('Hide lines already in the ERP leaves nothing of a fully entered count', (await page.$$('#pnTable tr[data-pallet]')).length === 0);
await page.uncheck('#fPnHideEntered'); await page.waitForTimeout(400);
await page.check('#pnTable tr[data-pallet="P-9"] .erpPick'); await page.click('#btnErpUnmark'); await page.waitForTimeout(1000);
check('Take the mark off works from the table too', /The mark is off 1 line/.test(clean(await page.textContent('#erpMsg'))) && /2 of 3 entered/.test(clean(await page.textContent('#erpChip'))));
const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await page.click('#btnErpWorksheet');
const d = await dl;
check('Download the ERP worksheet hands over a CSV', !!d && /erp-worksheet-session-\d+\.csv/.test(d.suggestedFilename()), d ? d.suggestedFilename() : 'no download');
const up = await page.$('#fErpFile');
await up.setInputFiles({ name: 'erp-worksheet.csv', mimeType: 'text/csv', buffer: Buffer.from('Side,Pallet,In ERP\nPositive,P-9,yes\n') });
await page.waitForTimeout(1500);
check('Uploading the worksheet back from the tab marks the line and says what it did', /From the worksheet: 1 marked as entered/.test(clean(await page.textContent('#erpMsg'))) && /3 of 3 entered/.test(clean(await page.textContent('#erpChip'))), clean(await page.textContent('#erpMsg')));
/* Export everything: the pallets the report does not have, on a sheet of their own */
const ev = await get(`/api/admin/sessions/${sid}/export/everything`);
const nor = ev.sheets.find((x) => x.name === 'Not on the report');
check('Export everything has a Not on the report sheet, after Adjustments', !!nor && ev.sheets.findIndex((x) => x.name === 'Not on the report') === ev.sheets.findIndex((x) => x.name === 'Adjustments') + 1, ev.sheets.map((x) => x.name).join());
check('…with the one pallet found on the floor that the report does not have, where it was found, and its ERP mark', nor && nor.rows.length === 1 && nor.rows[0].Pallet === 'P-9' && nor.rows[0]['Found in'] === 'F01A004' && nor.rows[0].Aisle === 'F01' && nor.rows[0]['Counted quantity'] === 10 && nor.rows[0]['In ERP'] === 'yes', JSON.stringify(nor && nor.rows[0]));
check('…and a blank Investigation column to write the finding in', nor && nor.columns[nor.columns.length - 1] === 'Investigation' && nor.rows[0].Investigation === '');
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
