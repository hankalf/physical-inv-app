/*
 * The walk order of an aisle: a level at a time (the default), a bay at a
 * time, or a snake. Set on the Settings aisle table; the gun follows the
 * server's order as given, from the far end when the plan says so.
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
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const pj = async (p, b = {}) => j(await post(p, b));

/* F01: two bays (001-004, 005-008) on levels A and B; a pallet in every bin */
const S = (await pj('/api/admin/sessions', { name: 'Walk order' })).id;
let bins = 'Bin Location,Zone,Aisle\n', pal = 'Pallet ID,SKU,Description,Qty,Location\n';
for (const a of ['F01', 'F02']) for (const l of ['A', 'B']) for (let i = 1; i <= 8; i++) { const c = `${a}${l}00${i}`; bins += `${c},Freezer,${a}\n`; pal += `P-${a}${l}${i},SKU,Item,10,${c}\n`; }
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: pal });
await pj(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false, autoRecount: false });
await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01', levels: 'AB', force: true });
const dev = await pj('/api/admin/devices', { name: 'WALK-01' });
const D = { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const status = async () => j(await fetch(`${BASE}/api/sessions/${S}/team-status?team=1`, { headers: D }));
const L = (l, from, to, step = 1) => { const out = []; for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(`F01${l}00${i}`); return out; };

let st = await status();
check('Default: a level at a time, A001 … A008 then B001 … B008', st.bins.join() === [...L('A', 1, 8), ...L('B', 1, 8)].join() && st.active.walk === 'level', st.bins.join());
check('The aisle table says so', (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').walk === 'level');

let r = await post(`/api/admin/sessions/${S}/aisles/walk`, { aisle: 'F01', walk: 'bay' });
check('Set to a bay at a time: the table takes it', r.status === 200 && (await j(r)).find((a) => a.aisle === 'F01').walk === 'bay');
st = await status();
check('…the gun walks every level of the first bay, then the second: A001-A004, B001-B004, A005-A008, B005-B008',
  st.bins.join() === [...L('A', 1, 4), ...L('B', 1, 4), ...L('A', 5, 8), ...L('B', 5, 8)].join() && st.active.walk === 'bay', st.bins.join());

await post(`/api/admin/sessions/${S}/aisles/walk`, { aisle: 'F01', walk: 'snake' });
st = await status();
check('Snake: A up, then B back the way they came', st.bins.join() === [...L('A', 1, 8), ...L('B', 8, 1, -1)].join(), st.bins.join());
check('A walk the system does not know is refused', (await post(`/api/admin/sessions/${S}/aisles/walk`, { aisle: 'F01', walk: 'zigzag' })).status === 400);
check('It is in the log', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'set the walk order' && /F01: snake/.test(x.detail)));

/* from the far end: whichever order, reversed - team 2 on F02, a snake walked from the far end */
await pj(`/api/admin/sessions/${S}/assignments`, { team: '2', aisles: 'F02', levels: 'AB', force: true, direction: 'down' });
await post(`/api/admin/sessions/${S}/aisles/walk`, { aisle: 'F02', walk: 'snake' });
const st2 = await j(await fetch(`${BASE}/api/sessions/${S}/team-status?team=2`, { headers: D }));
check('From the far end: the snake reversed, B001 first then A008 back to A001', st2.active.direction === 'down' && st2.bins.join() === [...L('B', 1, 8).map((c) => c.replace('F01', 'F02')), ...L('A', 8, 1, -1).map((c) => c.replace('F01', 'F02'))].join(), st2.bins.join());

/* ---------------- the gun follows the order as given ---------------- */
await post(`/api/admin/sessions/${S}/aisles/walk`, { aisle: 'F01', walk: 'bay' });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
gun.on('pageerror', (e) => errors.push(e.message));
gun.on('dialog', (dd) => dd.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', '1'); await gun.fill('#fEmployee', 'E1'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 90000 });
await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(600);
const banner = async () => clean(await gun.textContent('#nextBin'));
check('Gun: the guide starts at the first bin of the order', /F01A001/.test(await banner()), await banner());
{
  const scan = async (code) => { await gun.fill('#fScan', code); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(350); };
  for (const [b, p] of [['F01A001', 'P-F01A1'], ['F01A002', 'P-F01A2'], ['F01A003', 'P-F01A3'], ['F01A004', 'P-F01A4']]) { await scan(b); await scan(p); await scan('10'); await gun.waitForTimeout(300); }
  await gun.waitForTimeout(800);
  check('…after the four A positions of the bay, the guide goes up to B001, not along to A005', /F01B001/.test(await banner()), await banner());
}

/* ---------------- the Settings aisle table ---------------- */
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#bins`);
await signIn(page);
await page.waitForSelector('#aisleTable', { timeout: 10000 });
await pickSession(page, S);
await page.waitForSelector('#aisleTable select[data-walk="F01"]', { timeout: 10000 });
check('Settings → aisle table: a Walk select on the aisle, reading the order set', (await page.inputValue('#aisleTable select[data-walk="F01"]')) === 'bay');
await page.selectOption('#aisleTable select[data-walk="F01"]', 'level'); await page.waitForTimeout(700);
check('…changed from the table, the aisle takes it', (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').walk === 'level');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
