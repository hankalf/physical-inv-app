/*
 * Approve and key in one pass: every approved adjustment carries its ERP
 * tick on the same row, Mark shown as keyed does a screenful, and the
 * approved lines still to key download one system at a time.
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
const pj = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));
const text = async (p) => (await fetch(BASE + p, { headers: A })).text();

/* three pallets differ, two systems; approvals on, no threshold */
const S = (await pj('/api/admin/sessions', { name: 'Approve and key' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location,System\nPA1,S1,Item 1,100,F01A001,JustFood\nPA2,S2,Item 2,100,F01A002,JustFood\nPA3,S3,Item 3,100,F01A003,Harvest\n' });
await pj(`/api/admin/sessions/${S}/settings`, { guided: false, askComments: false, autoRecount: false, requireApproval: true });
const dev = await pj('/api/admin/devices', { name: 'KEY-01' });
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D, body: JSON.stringify([['PA1', 90, 'F01A001'], ['PA2', 80, 'F01A002'], ['PA3', 70, 'F01A003']]
  .map(([p, q, b], i) => ({ clientId: `k${i}`, palletId: p, qty: q, location: b, team: '1', employees: ['E1'], deviceId: 'KEY-01' }))) });

let d = await get(`/api/admin/sessions/${S}/adjustments`);
check('Three waiting, none approved, so nothing to key', d.summary.pending === 3 && d.keyed.approved === 0 && d.keyed.keyed === 0 && d.adjustments.every((r) => !r.erp_uploaded), JSON.stringify(d.keyed));
await pj(`/api/admin/sessions/${S}/adjustments/decide`, { palletIds: ['PA1', 'PA3'], decision: 'approve', reason: 'Miscount' });
d = await get(`/api/admin/sessions/${S}/adjustments`);
check('Two approved: both still to key', d.keyed.approved === 2 && d.keyed.keyed === 0);
let lines = (await text(`/api/admin/sessions/${S}/export/approved-not-keyed.csv`)).trim().split(/\r?\n/);
check('The approved-not-keyed CSV lists the two, with the system, reason and who signed', lines.length === 3 && lines[0] === 'pallet_id,source,sku,location,kind,expected_qty,counted_qty,variance_qty,status,reason,decided_by,decided_at' && lines.some((l) => /^PA3,HARVEST,S3,F01A003,.*,-30,approved,Miscount,/.test(l)), lines.join(' | '));
lines = (await text(`/api/admin/sessions/${S}/export/approved-not-keyed.csv?source=HARVEST`)).trim().split(/\r?\n/);
check('…one system at a time', lines.length === 2 && /^PA3,/.test(lines[1]), lines.join(' | '));
const close = await get(`/api/admin/sessions/${S}/closeout`);
check('The close-out checklist counts the two to key', close.items.find((i) => i.key === 'erp').n === 2);

/* ---------------- the table ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#adjust`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#adjustTable tbody tr', { timeout: 10000 }); await page.waitForTimeout(300);
check('Adjustments: the waiting line has no Keyed tick; the tile says two are approved and not keyed',
  (await page.locator('#adjustTable input[data-keyed]').count()) === 0 && /2\s*Approved, not yet keyed/.test(clean(await page.textContent('#adjustStats'))), clean(await page.textContent('#adjustStats')));
await page.uncheck('#fAdjPendingOnly'); await page.waitForTimeout(500);
check('…untick "Only the ones still waiting": the two approved lines carry a Keyed tick, unticked', (await page.locator('#adjustTable input[data-keyed]').count()) === 2 && !(await page.isChecked('#adjustTable input[data-keyed="PA1"]')));
await page.check('#adjustTable input[data-keyed="PA1"]'); await page.waitForTimeout(700);
d = await get(`/api/admin/sessions/${S}/adjustments`);
check('Tick one: it is marked as keyed, with who', d.keyed.keyed === 1 && d.adjustments.find((r) => r.pallet_id === 'PA1').erp_by === 'Dana Whitfield' && await page.isChecked('#adjustTable input[data-keyed="PA1"]'), JSON.stringify(d.adjustments.find((r) => r.pallet_id === 'PA1').erp_by));
check('…and the tile moves', /1\s*Approved, not yet keyed · 1 keyed/.test(clean(await page.textContent('#adjustStats'))), clean(await page.textContent('#adjustStats')));
await page.uncheck('#adjustTable input[data-keyed="PA1"]'); await page.waitForTimeout(700);
check('Untick it: the mark comes off', (await get(`/api/admin/sessions/${S}/adjustments`)).keyed.keyed === 0);
await page.selectOption('#fAdjSource', 'HARVEST'); await page.waitForTimeout(500);
await page.click('#btnAdjKeyShown'); await page.waitForTimeout(700);
d = await get(`/api/admin/sessions/${S}/adjustments`);
check('Mark shown as keyed, one system picked: only that system\'s approved line is marked', d.keyed.keyed === 1 && d.adjustments.find((r) => r.pallet_id === 'PA3').erp_uploaded === 'yes' && !d.adjustments.find((r) => r.pallet_id === 'PA1').erp_uploaded && /1 line marked as keyed/.test(clean(await page.textContent('#adjustMsg'))), clean(await page.textContent('#adjustMsg')));
await page.selectOption('#fAdjSource', ''); await page.waitForTimeout(400);
await page.check('#fAdjHideKeyed'); await page.waitForTimeout(500);
check('Hide lines keyed: PA3 is gone from the table', !/PA3/.test(clean(await page.textContent('#adjustTable'))) && /PA1/.test(clean(await page.textContent('#adjustTable'))));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportNotKeyed')]);
check('…and the approved-not-keyed CSV downloads', /approved-not-keyed-session/.test(dl.suggestedFilename()), dl.suggestedFilename());
check('The worksheet and the table agree', (await text(`/api/admin/sessions/${S}/export/erp-worksheet.csv`)).split(/\r?\n/).some((l) => /^.*PA3,.*,yes/.test(l) || /PA3.*Dana Whitfield/.test(l)));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
