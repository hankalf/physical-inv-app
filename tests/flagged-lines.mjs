/*
 * The flagged lines listed, each with why: the lines a counter accepted past
 * a warning, and the ones whose label would not scan, with a chip a reason.
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

const S = (await pj('/api/admin/sessions', { name: 'Flagged' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\nP1,SKU-1,Item,10,F01A001\n' });
await pj(`/api/admin/sessions/${S}/settings`, { guided: false, askComments: false, autoRecount: false });
const dev = await pj('/api/admin/devices', { name: 'FLAG-01' });
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 'f1', palletId: 'P1', qty: 10, location: 'F01A001', team: '1', employees: ['E1'], deviceId: 'FLAG-01' },
  { clientId: 'f2', palletId: 'NEW-9', qty: 4, location: 'F01A002', team: '1', employees: ['E1'], deviceId: 'FLAG-01', unknownPallet: 1, overrideReason: 'Not on the list - counted anyway' },
  { clientId: 'f3', palletId: 'P7', qty: 2, location: 'F09Z001', team: '1', employees: ['E1'], deviceId: 'FLAG-01', unknownLocation: 1, unknownPallet: 1, overrideReason: 'Other' },
  { clientId: 'f4', palletId: 'P1', qty: 10, location: 'F01A002', team: '2', employees: ['E2'], deviceId: 'FLAG-01', duplicatePallet: 1, overrideReason: 'Moved' }]) });

const d = await get(`/api/admin/sessions/${S}/flagged`);
check('Three of the four lines are flagged, each saying why', d.total === 3 && d.rows.every((r) => r.why.length) && d.rows.find((r) => r.pallet_id === 'P7').why.join() === 'unknown_pallet,unknown_location,override', JSON.stringify(d.rows.map((r) => [r.pallet_id, r.why])));
check('…in words, with the override reason', /Pallet not on the report · Bin not on the list · Override: Other/.test(d.rows.find((r) => r.pallet_id === 'P7').whyWords), d.rows.find((r) => r.pallet_id === 'P7').whyWords);
check('…and a tally by reason', d.byWhy.unknown_pallet === 2 && d.byWhy.duplicate_pallet === 1 && d.byWhy.override === 3, JSON.stringify(d.byWhy));
check('The clean line is not among them', !d.rows.some((r) => r.pallet_id === 'P1' && r.team === '1'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#reports`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#flaggedTable tbody tr[data-flagged]', { timeout: 10000 }); await page.waitForTimeout(300);
check('Reports → Flagged lines: the three, with why, and a chip a reason', (await page.locator('#flaggedTable tbody tr[data-flagged]').count()) === 3 && /3 lines/.test(clean(await page.textContent('#flaggedSub'))) && /Counted twice \(1\)/.test(clean(await page.textContent('#flaggedWhy'))) && /Override: Moved/.test(clean(await page.textContent('#flaggedTable'))), clean(await page.textContent('#flaggedWhy')));
await page.click('#flaggedWhy button[data-why="duplicate_pallet"]'); await page.waitForTimeout(250);
check('…a chip narrows it to that reason', (await page.locator('#flaggedTable tbody tr[data-flagged]').count()) === 1 && /Counted twice/.test(clean(await page.textContent('#flaggedTable tbody'))));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportFlagged')]);
check('…and the CSV downloads', /flagged-lines/.test(dl.suggestedFilename()), dl.suggestedFilename());
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
