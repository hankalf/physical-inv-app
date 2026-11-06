/*
 * The close-out checklist on the Progress tab: what stands between now and
 * done, one line an item, each with its number, where it stands, and a button
 * to the tab that clears it. The first three hold the final report.
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
const item = (d, k) => d.items.find((i) => i.key === k);

/* F01 and F02 with three bins each, a pallet in every bin; approvals on */
const S = (await pj('/api/admin/sessions', { name: 'Close-out' })).id;
let bins = 'Bin Location,Zone,Aisle\n', pal = 'Pallet ID,SKU,Description,Qty,Location\n';
for (const a of ['F01', 'F02']) for (let i = 1; i <= 3; i++) { bins += `${a}A00${i},Freezer,${a}\n`; pal += `P-${a}${i},SKU-${i},Item ${i},10,${a}A00${i}\n`; }
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: pal });
await pj(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false, autoRecount: true, requireApproval: true });

let d = await get(`/api/admin/sessions/${S}/closeout`);
check('Nothing counted yet: every bin is without a count, by aisle, and that holds the final report',
  item(d, 'bins').n === 6 && /by aisle: F01 3 · F02 3/.test(item(d, 'bins').detail) && !d.ready && d.blocking === 1 && d.open === 1, JSON.stringify([item(d, 'bins'), d.blocking, d.open]));
check('…the eight items are there, each with a tab', d.items.length === 8 && d.items.every((i) => i.tab && i.label), d.items.map((i) => i.key).join());
check('…and approvals on: the approve line says all decided', /all decided/.test(item(d, 'approve').detail));

/* team 1 on F01, counts two bins (one a miscount), skips the third */
await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01', levels: 'A', force: true });
const dev = await pj('/api/admin/devices', { name: 'CLOSE-01' });
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
await fetch(`${BASE}/api/sessions/${S}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ deviceId: 'CLOSE-01', team: '1', employees: ['E1'] }) });
await fetch(`${BASE}/api/sessions/${S}/team-status?team=1`, { headers: D });
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 'c1', palletId: 'P-F011', qty: 10, location: 'F01A001', team: '1', employees: ['E1'], deviceId: 'CLOSE-01' },
  { clientId: 'c2', palletId: 'P-F012', qty: 7, location: 'F01A002', team: '1', employees: ['E1'], deviceId: 'CLOSE-01' }]) });
await fetch(`${BASE}/api/sessions/${S}/issues`, { method: 'POST', headers: D, body: JSON.stringify({ clientId: 'sk1', kind: 'blocked', target: 'bin', confirm: 'none', reason: 'Skipped on the gun: Cannot reach it', bin: 'F01A003', aisle: 'F01', team: '1', deviceId: 'CLOSE-01' }) });
await fetch(`${BASE}/api/sessions/${S}/issues`, { method: 'POST', headers: D, body: JSON.stringify({ clientId: 'dm1', kind: 'damage', target: 'pallet', confirm: 'none', reason: 'Crushed cases', bin: 'F01A001', palletId: 'P-F011', aisle: 'F01', team: '1', deviceId: 'CLOSE-01' }) });

d = await get(`/api/admin/sessions/${S}/closeout`);
check('Two bins counted: four without a count, F02 first with the most', item(d, 'bins').n === 4 && /F02 3 · F01 1/.test(item(d, 'bins').detail), item(d, 'bins').detail);
check('The miscount is a second count open with no team yet', item(d, 'second').n === 1 && /no team yet 1/.test(item(d, 'second').detail) && item(d, 'second').blocks, JSON.stringify(item(d, 'second')));
check('Team 1 still holds F01', item(d, 'aisles').n === 1 && /F01 team 1 \(A\)/.test(item(d, 'aisles').detail) && !item(d, 'aisles').blocks, item(d, 'aisles').detail);
check('The skipped bin is listed with its reason', item(d, 'skipped').n === 1 && /F01A003 \(Cannot reach it\)/.test(item(d, 'skipped').detail), item(d, 'skipped').detail);
check('The fix list counts the damage and the skip', item(d, 'fixlist').n === 2 && /1 damage · 1 blocked/.test(item(d, 'fixlist').detail), item(d, 'fixlist').detail);
check('The miscount is an adjustment to approve', item(d, 'approve').n === 1 && /1 line waiting/.test(item(d, 'approve').detail), item(d, 'approve').detail);
check('…and nothing is keyed into the ERP yet, because nothing is approved', item(d, 'erp').n === 0 && /no adjustment lines/.test(item(d, 'erp').detail), item(d, 'erp').detail);
check('Two things hold the final report', d.blocking === 2 && !d.ready && d.open === 6, JSON.stringify([d.blocking, d.open]));

/* the skipped bin counted after all: off the list; the second count given to team 2 */
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 'c3', palletId: 'P-F013', qty: 10, location: 'F01A003', team: '1', employees: ['E1'], deviceId: 'CLOSE-01' }]) });
const rec = (await get(`/api/admin/sessions/${S}/recounts`))[0];
await pj(`/api/admin/sessions/${S}/recounts/${rec.id}`, { team: '2' });
await pj(`/api/admin/sessions/${S}/adjustments/decide`, { palletIds: ['P-F012'], decision: 'approve', reason: 'Miscount' });
d = await get(`/api/admin/sessions/${S}/closeout`);
check('Counted after all, the skipped bin is off the list', item(d, 'skipped').n === 0);
check('The second count now says team 2', /team 2 1/.test(item(d, 'second').detail), item(d, 'second').detail);
check('Approved, the line is one to key into the ERP', item(d, 'approve').n === 0 && item(d, 'erp').n === 1 && /1 of 1 approved lines still to key/.test(item(d, 'erp').detail), item(d, 'erp').detail);

/* ---------------- the card on the Progress tab ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#progress`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#closeoutList li[data-closeout]', { timeout: 10000 }); await page.waitForTimeout(300);
check('Progress → Close-out: eight lines, the blockers red, the tidy-up amber, the clear ones green',
  (await page.locator('#closeoutList li[data-closeout]').count()) === 8
  && (await page.locator('#closeoutList li.fail').count()) === 2 && (await page.locator('#closeoutList li.warn').count()) === 3 && (await page.locator('#closeoutList li.ok').count()) === 3,
  `${await page.locator('#closeoutList li.fail').count()} fail · ${await page.locator('#closeoutList li.warn').count()} warn · ${await page.locator('#closeoutList li.ok').count()} ok`);
check('…the line under the heading says what holds the final report', /2 things hold the final report · 5 open in all/.test(clean(await page.textContent('#closeoutSub'))), clean(await page.textContent('#closeoutSub')));
check('…the bins line reads by aisle', /3 · bins without a count.*by aisle: F02 3/.test(clean(await page.textContent('#closeoutList li[data-closeout="bins"]'))), clean(await page.textContent('#closeoutList li[data-closeout="bins"]')));
await page.click('#closeoutList li[data-closeout="second"] button[data-go]'); await page.waitForTimeout(400);
check('…and its button opens the tab that clears it', await page.isVisible('#recountTable, #recTeams'), 'second counts tab');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
