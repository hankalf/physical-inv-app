/*
 * The Team plan's buttons on an aisle: release sends an active aisle to the
 * back of the team's queue, so the next one starts - it used to go to the
 * front, where auto-start handed it straight back; and ✕ takes an aisle off
 * the plan whatever its state, the aisle's counts staying.
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
const del = (p) => fetch(BASE + p, { method: 'DELETE', headers: A });

const S = (await j(await post('/api/admin/sessions', { name: 'Plan release' }))).id;
const bins = ['P01', 'P02', 'P03'].flatMap((a) => ['A001', 'A002'].map((b) => `${a}${b}`));
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Dry,${b.slice(0, 3)}`).join('\n') + '\n', csv);
const plan = async (team) => (await get(`/api/admin/sessions/${S}/assignments`)).filter((x) => x.team === team).sort((a, b) => a.position - b.position);
const byAisle = async (team, aisle) => (await plan(team)).find((x) => x.aisle === aisle);

/* team 4 queues three aisles: the first starts by itself */
await post(`/api/admin/sessions/${S}/assignments`, { team: '4', aisles: 'P01, P02, P03', levels: 'A-F' });
check('Three aisles queued: the first is active, the rest wait', (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() === 'P01:active,P02:queued,P03:queued', (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join());

/* release: P01 goes to the back, P02 starts */
let r = await post(`/api/admin/sessions/${S}/assignments/${(await byAisle('4', 'P01')).id}`, { status: 'queued' });
let out = await j(r);
check('Release P01: it goes to the back of the queue and P02 starts', r.status === 200 && (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() === 'P02:active,P03:queued,P01:queued' && out.activated.some((x) => x.aisle === 'P02'), (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join());
check('…and the log says it was released', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'released an aisle' && /team 4: P01/.test(x.detail)));

/* ✕ on the active one: P03 starts in its place */
r = await del(`/api/admin/sessions/${S}/assignments/${(await byAisle('4', 'P02')).id}`);
out = await j(r);
check('✕ on the active P02: off the plan, and P03 starts in its place', r.status === 200 && out.removed.aisle === 'P02' && out.removed.status === 'active' && (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() === 'P03:active,P01:queued', JSON.stringify(out));
check('…the log says which aisle came off, and that it was being counted', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'took an aisle off the plan' && /team 4: P02 \(ABCDEF\), was active/.test(x.detail)));

/* release with nothing else queued: it starts again, and the answer says so */
r = await del(`/api/admin/sessions/${S}/assignments/${(await byAisle('4', 'P01')).id}`);
r = await post(`/api/admin/sessions/${S}/assignments/${(await byAisle('4', 'P03')).id}`, { status: 'queued' });
out = await j(r);
check('Release the only aisle: it starts again, and the answer says ✕ is the way off', out.assignment.status === 'active' && /nothing else queued/.test(out.note) && /✕/.test(out.note), out.note);
check('A ✕ on an aisle that is not there is a 404', (await del(`/api/admin/sessions/${S}/assignments/999999`)).status === 404);

/* done, then ✕: off the plan, the counts stay */
await post(`/api/admin/sessions/${S}/assignments`, { team: '5', aisles: 'P02', levels: 'A-C' });
const dev = await j(await post('/api/admin/devices', { name: 'PLAN-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
await post(`/api/sessions/${S}/counts`, [{ clientId: 'pr1', palletId: 'PR-1', qty: 5, location: 'P02A001', team: '5', deviceId: 'PLAN-01', scannedAt: new Date().toISOString() }], G);
await post(`/api/admin/sessions/${S}/assignments/${(await byAisle('5', 'P02')).id}`, { status: 'done' });
r = await del(`/api/admin/sessions/${S}/assignments/${(await byAisle('5', 'P02')).id}`);
check('✕ on a finished aisle: off the plan, and its count line stays', r.status === 200 && !(await byAisle('5', 'P02')) && (await get(`/api/admin/sessions/${S}/progress`)).bins_counted === 1);

/* ------------------------------------------------------------------ the board */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
const errors = [];
const asked = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
await post(`/api/admin/sessions/${S}/assignments`, { team: '4', aisles: 'P01', levels: 'A-F' });   // team 4 now: P03 active, P01 queued
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await pickSession(page, S);
await page.waitForSelector('.seq .a.active', { timeout: 8000 });
const row = (aisle) => page.locator('.seq .a', { hasText: aisle }).first();
check('The board: the active aisle has done, release and ✕; the queued one start and ✕', clean(await row('P03').locator('button').allTextContents().then((t) => t.join(' '))) === 'done release ✕' && clean(await row('P01').locator('button').allTextContents().then((t) => t.join(' '))) === 'start ✕',
  clean(await row('P03').locator('button').allTextContents().then((t) => t.join(' '))));
await row('P03').locator('button', { hasText: 'release' }).click();
await page.waitForTimeout(900);
check('Release on the board: P01 starts, P03 waits behind it, and the card says so', /P03 released to the back of team 4/.test(clean(await page.textContent('#assignMsg'))) && /P01 started/.test(clean(await page.textContent('#assignMsg')))
  && (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() === 'P01:active,P03:queued', clean(await page.textContent('#assignMsg')));
await row('P01').locator('button', { hasText: '✕' }).click();
await page.waitForTimeout(900);
check('✕ on the active aisle asks first, then takes it off and the next starts', asked.length === 1 && /Take P01 off team 4/.test(asked[0]) && /P01 is off team 4/.test(clean(await page.textContent('#assignMsg'))) && /P03 started/.test(clean(await page.textContent('#assignMsg')))
  && (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() === 'P03:active', clean(await page.textContent('#assignMsg')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
