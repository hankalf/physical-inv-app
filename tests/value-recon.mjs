/*
 * Reconciliation by value: the differences in money, by aisle, by system or
 * by item, the biggest first, with how far the second counts have got.
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

/* two aisles, two systems, priced: V01 is JustFood, V02 is Harvest; one pallet unpriced */
const S = (await pj('/api/admin/sessions', { name: 'By value' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + ['V01A001', 'V01A002', 'V01A003', 'V02A001', 'V02A002'].map((b) => `${b},Dry,${b.slice(0, 3)}`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: `Bin Code,Container No.,Item No.,Description,Quantity,System,Cost
V01A001,FR1,MANGO,Mango 32oz,100,JustFood,2
V01A002,FR2,BERRY,Blackberries,100,JustFood,1
V01A003,FR3,MANGO,Mango 32oz,100,JustFood,2
V02A001,HV1,PEACH,Peaches,100,Harvest,5
V02A002,HV2,PLUM,Plums,100,Harvest,
` });
await pj(`/api/admin/sessions/${S}/settings`, { guided: false, askComments: false, autoRecount: true });
const dev = await pj('/api/admin/devices', { name: 'VAL-01' });
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
/* FR1 +10 ($20), FR2 -30 (-$30), FR3 matches, HV1 -20 (-$100), HV2 -5 (unpriced) */
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  ['FR1', 110, 'V01A001'], ['FR2', 70, 'V01A002'], ['FR3', 100, 'V01A003'], ['HV1', 80, 'V02A001'], ['HV2', 95, 'V02A002'],
].map(([p, q, b], i) => ({ clientId: `v${i}`, palletId: p, qty: q, location: b, team: '1', employees: ['E1'], deviceId: 'VAL-01' }))) });

let d = await get(`/api/admin/sessions/${S}/value`);
const row = (k) => d.rows.find((r) => r.group === k);
check('By aisle: V02 first (the biggest difference), then V01; totals net, over and under',
  d.priced && d.by === 'aisle' && d.rows.map((r) => r.group).join() === 'V02,V01' && d.totals.net === -110 && d.totals.over === 20 && d.totals.under === -130 && d.totals.pallets === 4 && d.totals.unpriced === 1,
  JSON.stringify({ rows: d.rows.map((r) => [r.group, r.net]), totals: d.totals }));
check('…V01: two pallets differ, +$20 and -$30, net -$10, the report worth $500 there, matches included', row('V01').pallets === 2 && row('V01').over === 20 && row('V01').under === -30 && row('V01').net === -10 && row('V01').expected === 500, JSON.stringify(row('V01')));
check('…V02: the unpriced pallet is counted but not priced', row('V02').pallets === 2 && row('V02').unpriced === 1 && row('V02').net === -100, JSON.stringify(row('V02')));
check('…and every difference has a second count open, so none is second-counted yet', d.totals.recountsOpen === 4 && d.totals.secondCounted === 0 && row('V01').recounts_open === 2, JSON.stringify(d.totals));
d = await get(`/api/admin/sessions/${S}/value?by=system`);
check('By system: Harvest first, JustFood second', d.rows.map((r) => `${r.group}:${r.net}`).join() === 'HARVEST:-100,JUSTFOOD:-10', d.rows.map((r) => `${r.group}:${r.net}`).join());
d = await get(`/api/admin/sessions/${S}/value?by=sku`);
check('By item: PEACH first, the label carries the description', d.rows[0].group === 'PEACH' && /PEACH — Peaches/.test(d.rows[0].label) && d.rows.length === 4, d.rows.map((r) => r.label).join(' | '));
const text = await (await fetch(`${BASE}/api/admin/sessions/${S}/export/value.csv?by=aisle`, { headers: A })).text();
const lines = text.trim().split(/\r?\n/);
check('The CSV has the columns, a row an aisle and a TOTAL row', lines[0] === 'group,label,pallets,over,under,net,abs,expected,unpriced,first_only,second_counted,recounts_open' && lines.length === 4 && /^TOTAL,,4,20,-130,-110,,1000,1,0,0,4$/.test(lines[3]), lines.join(' | '));

/* a report with no costs says so */
const S2 = (await pj('/api/admin/sessions', { name: 'No costs' })).id;
await fetch(`${BASE}/api/admin/sessions/${S2}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nV01A001,Dry,V01\n' });
await fetch(`${BASE}/api/admin/sessions/${S2}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\nP1,S,Item,10,V01A001\n' });
check('A report with no costs is not priced', (await get(`/api/admin/sessions/${S2}/value`)).priced === false);

/* ---------------- the card ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#reports`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#valueTable tbody tr[data-value]', { timeout: 10000 }); await page.waitForTimeout(300);
check('Reports → Reconciliation by value: an aisle a row, V02 first, the net under the heading',
  (await page.locator('#valueTable tbody tr[data-value]').count()) === 2 && (await page.locator('#valueTable tbody tr[data-value]').first().getAttribute('data-value')) === 'V02' && /-\$110\.00 net over 4 pallets that differ · 1 of them unpriced/.test(clean(await page.textContent('#valueSub'))),
  clean(await page.textContent('#valueSub')));
check('…the five figures above it', (await page.locator('#valueStats .stat').count()) === 5 && /\+\$20\.00/.test(clean(await page.textContent('#valueStats'))), clean(await page.textContent('#valueStats')));
await page.click('#valueBy button[data-by="sku"]'); await page.waitForTimeout(400);
check('…By item: four rows, PEACH first, with the second counts open', (await page.locator('#valueTable tbody tr[data-value]').count()) === 4 && /PEACH — Peaches/.test(clean(await page.textContent('#valueTable tbody tr[data-value]'))) && /1 open/.test(clean(await page.textContent('#valueTable tbody'))), clean(await page.textContent('#valueTable tbody')).slice(0, 160));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportValue')]);
check('…and the CSV downloads for the view shown', dl.suggestedFilename() === `value-by-sku-session-${S}.csv`, dl.suggestedFilename());
await pickSession(page, S2); await page.waitForTimeout(600);
check('A count with no costs says so on the card', /carries no costs/.test(clean(await page.textContent('#valueSub'))), clean(await page.textContent('#valueSub')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
