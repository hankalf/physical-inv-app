/*
 * Dashboard → Reports → Pallet report: the columns inventory control reads, in
 * their order - Pallet ID, System, SKU, Description, Expected, 1st count, 2nd
 * count, Counted, Expected bin, Found in (when different), Lot, Expiry, Team,
 * Comments, Status, ERP upload (by whom and when) - on one screen, no scrolling
 * across at a desk's width.
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
const csv = { authorization: A.authorization, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const S = (await j(await post('/api/admin/sessions', { name: 'Pallet report count' }))).id;
const BINS = ['R01A001', 'R01A002', 'R01A003', 'R01A004', 'R01A005'];
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + BINS.map((b) => `${b},Freezer,R01`).join('\n') + '\n', csv);
await post(`/api/admin/sessions/${S}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location,Lot Code,Best Before\n'
  + 'PR-1,SKU-101,Chicken breast IQF boneless skinless 4x10lb case — export grade,40,R01A001,LOT-11,2027-03-01\n'
  + 'PR-2,SKU-102,Peas petite 12x2lb,30,R01A002,,\n'
  + 'PR-3,SKU-103,Sweetcorn 20lb,20,R01A003,,\n'
  + 'PR-4,SKU-104,Salmon fillet 10lb,15,R01A004,,\n', csv);
const dev = await j(await post('/api/admin/devices', { name: 'PR-GUN' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
let n = 0;
const line = (pallet, qty, bin, extra = {}) => ({ clientId: `pr${++n}`, palletId: pallet, qty, location: bin, team: '4', deviceId: 'PR-GUN', scannedAt: new Date().toISOString(), ...extra });
await post(`/api/sessions/${S}/counts`, [
  line('PR-1', 36, 'R01A001', { lot: 'LOT-11', expiry: '2027-03-01', comments: 'two cases crushed at the back of the pallet, label partly torn off' }),
  line('PR-2', 30, 'R01A002'),                 // a match
  line('PR-3', 20, 'R01A005', { comments: 'found behind the ladder in the next bay over, label faded but readable' }),   // found in another bin
], G);
// PR-1 goes back for a second count, which finds 38
const rc = (await get(`/api/admin/sessions/${S}/recounts`)).find((t) => t.bin === 'R01A001') || (await j(await post(`/api/admin/sessions/${S}/recounts`, { bin: 'R01A001' })));
await post(`/api/sessions/${S}/recounts/${rc.id}/take`, { team: '5' }, G);
await post(`/api/sessions/${S}/counts`, [line('PR-1', 38, 'R01A001', { team: '5', pass: 2, recountId: rc.id, lot: 'LOT-11' })], G);
await post(`/api/sessions/${S}/recounts/${rc.id}/done`, { team: '5' }, G);
// PR-1 is keyed into the ERP; PR-3 is not yet
let r = await post(`/api/admin/sessions/${S}/erp-entries`, { pallets: ['PR-1'], on: true });
check('A line is marked as uploaded to the ERP', r.status === 200, String(r.status));

/* ---------------- the data ---------------- */
let rows = (await get(`/api/admin/sessions/${S}/pallets?limit=100`)).rows;
const R = (id) => rows.find((x) => x.pallet_id === id);
check('A second-counted pallet carries its 1st and 2nd counts beside the count that stands', R('PR-1').first_count_qty === 36 && R('PR-1').second_pass_qty === 38 && Number(R('PR-1').counted_qty) === 38, JSON.stringify([R('PR-1').first_count_qty, R('PR-1').second_pass_qty, R('PR-1').counted_qty]));
check('…an uploaded line says by whom and when', R('PR-1').erp_uploaded === 'yes' && /DANA/i.test(R('PR-1').erp_by) && !!R('PR-1').erp_at && !R('PR-1').erp_changed, JSON.stringify([R('PR-1').erp_by, R('PR-1').erp_at]));
check('…a line not uploaded has no mark', !R('PR-3').erp_uploaded);
const out = await (await fetch(`${BASE}/api/admin/sessions/${S}/export/pallets.csv`, { headers: A })).text();
const head = out.split(/\r?\n/)[0];
check('The pallet report CSV has the 2nd count and the ERP columns too', /second_pass_qty/.test(head) && /erp_uploaded,erp_by,erp_at,erp_changed/.test(head) && out.split(/\r?\n/).some((l) => /^PR-1,/.test(l) && /,yes,/.test(l)), head.slice(0, 140));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const open = async (width, height) => {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/admin#reports`);
  await signIn(page);
  await pickSession(page, S);
  await page.evaluate(() => window.appApi.showSub('reports'));
  await page.uncheck('#fOnlyExceptions').catch(() => {});
  await page.waitForSelector('#palletTable tr[data-pallet="PR-1"]', { timeout: 8000 });
  await page.waitForTimeout(500);
  return page;
};
const page = await open(1440, 900);
const heads = await page.$$eval('#palletTable thead th', (ths) => ths.map((t) => t.textContent.trim()));
check('The columns, in the order asked for, short enough never to wrap', heads.join('|') === 'Pallet ID|System|SKU|Description|Exp.|1st|2nd|Counted|Exp. bin|Found in|Lot|Expiry|Team|Comments|Status|ERP', heads.join('|'));
check('…an abbreviated heading says its full name on hover, and no heading wraps', (await page.$eval('#palletTable thead th:nth-child(5)', (th) => th.title)) === 'Expected: what the report says is on the pallet' && await page.$$eval('#palletTable thead th', (ths) => ths.every((th) => getComputedStyle(th).whiteSpace === 'nowrap' && th.getBoundingClientRect().height < 2.2 * parseFloat(getComputedStyle(th).fontSize) * 1.2 + 10)));
const cellsOf = async (id) => page.$$eval(`#palletTable tr[data-pallet="${id}"] td`, (tds) => tds.map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
const c1 = await cellsOf('PR-1');
check('PR-1: expected 40, 1st count 36, 2nd count 38, counted 38', c1[4] === '40' && c1[5] === '36' && c1[6] === '38' && c1[7] === '38', c1.slice(4, 8).join(' / '));
check('…found in is blank where it is the expected bin', c1[8] === 'R01A001' && c1[9] === '', `${c1[8]} | ${c1[9]}`);
check('…lot and expiry shown, and the team', /LOT-11/.test(c1[10]) && /2027-03-01/.test(c1[11]) && /4|5/.test(c1[12]));
check('…ERP upload: uploaded, by whom and when', /✓ uploaded/.test(c1[15]) && /DANA/i.test(c1[15]), c1[15]);
check('…and the Recount button sits under the status, not in a column of its own', (await page.$$('#palletTable thead th')).length === 16 && /Recount|recount pending|QTY VARIANCE|Quantity/i.test(c1[14]), c1[14]);
const c3 = await cellsOf('PR-3');
check('PR-3, found in another bin: Found in shows it', c3[8] === 'R01A003' && c3[9] === 'R01A005', `${c3[8]} | ${c3[9]}`);
check('…and ERP upload says not yet', /not yet/.test(c3[15]), c3[15]);
const c2 = await cellsOf('PR-2');
check('PR-2, a match: nothing to upload', c2[15] === '—', c2[15]);
const twoLines = (sel, text) => page.$eval(sel, (td, t) => { const d = td.querySelector('.clamp'); const h = d.getBoundingClientRect().height; const lh = parseFloat(getComputedStyle(d).lineHeight); return td.title.includes(t) && h > 0 && h <= lh * 2 + 1; }, text);
check('A long description is clamped to two lines, all of it on hover', await twoLines('#palletTable tr[data-pallet="PR-1"] td:nth-child(4)', 'export grade'));
check('…and so is a long comment', await twoLines('#palletTable tr[data-pallet="PR-3"] td:nth-child(14)', 'label faded but readable'));
const fits = (pg) => pg.$eval('#palletTable', (t) => { const box = t.closest('.scroll'); return { table: Math.round(t.scrollWidth), box: Math.round(box.clientWidth) }; });
let f = await fits(page);
check('At 1440 wide, the whole report fits: no scrolling across', f.table <= f.box, JSON.stringify(f));
await page.screenshot({ path: new URL('./screenshots/pallet-report-1440.png', import.meta.url).pathname, fullPage: false }).catch(() => {});
const small = await open(1366, 768);
f = await fits(small);
check('…and at 1366, a common laptop', f.table <= f.box, JSON.stringify(f));

/* a line that moves after it went in is flagged, so it is keyed again: PR-4 is keyed as missing, then found */
await post(`/api/sessions/${S}/aisles/R01/done`, { team: '4' }, G).catch(() => {});
await post(`/api/admin/sessions/${S}/erp-entries`, { pallets: ['PR-4'], on: true });
await post(`/api/sessions/${S}/counts`, [line('PR-4', 15, 'R01A004')], G);
await wait(300);
rows = (await get(`/api/admin/sessions/${S}/pallets?limit=100`)).rows;
check('A line that moves after it went in says changed since, so it is keyed again', R('PR-4').erp_uploaded === 'yes' && R('PR-4').erp_changed === 1 && Number(R('PR-4').counted_qty) === 15, JSON.stringify([R('PR-4').counted_qty, R('PR-4').erp_uploaded, R('PR-4').erp_changed]));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
