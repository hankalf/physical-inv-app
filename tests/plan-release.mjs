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
/* ------------------------------------------------------------------ the drag
   Team 4 is counting P03 and has nothing queued; two more aisles, a second
   team, and the board's drag does the rest. */
await post(`/api/admin/sessions/${S}/assignments`, { team: '4', aisles: 'P01, P02', levels: 'A-F' });
await post('/api/admin/people/teams', { name: '6', shift: '1' });
await page.reload(); await page.waitForSelector('.seq .a.active', { timeout: 8000 }); await page.waitForTimeout(600);
const card = (aisle) => page.locator('.seq .a', { hasText: aisle }).first();
const col = (team) => page.locator(`#teamList .team[data-team="${team}"]`);
check('The board: the queued cards are draggable, the one being counted is not', await card('P01').getAttribute('draggable') === 'true' && (await card('P03').getAttribute('draggable')) !== 'true');
check('…and each says what it is: Counting now with its bins, Next, Queued', /Counting now/.test(await card('P03').textContent()) && /\/ 2 bins have a count/.test(clean(await card('P03').textContent())) && /Next/.test(await card('P01').textContent()) && /Queued/.test(await card('P02').textContent()), clean(await card('P03').textContent()));
check('Team 6, with nothing queued, has a drop zone and the Queue aisles button', (await col('6').locator('.drop').count()) === 1 && (await col('6').locator('button[data-queue-for="6"]').count()) === 1);
await card('P02').dragTo(card('P01'));
await page.waitForTimeout(1000);
check('Dragging P02 onto P01 puts it in front: the queue is P02, P01', (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() === 'P03:active,P02:queued,P01:queued' && /reordered/.test(clean(await page.textContent('#assignMsg'))), (await plan('4')).map((x) => `${x.aisle}:${x.status}`).join() + ' · ' + clean(await page.textContent('#assignMsg')));
check('…and the log says so', (await get('/api/admin/audit?limit=10')).some((x) => x.action === "reordered a team's aisles" && /team 4: P02/.test(x.detail)));
await card('P01').dragTo(col('6').locator('.drop'));
await page.waitForTimeout(1000);
check('Dragging P01 onto team 6 moves it there, and it starts, team 6 having nothing else', (await plan('6')).map((x) => `${x.aisle}:${x.status}`).join() === 'P01:active' && (await plan('4')).map((x) => x.aisle).join() === 'P03,P02' && /P01 moved from team 4 to team 6/.test(clean(await page.textContent('#assignMsg'))), clean(await page.textContent('#assignMsg')));
check('…with its levels kept, and the log naming both teams', (await byAisle('6', 'P01')).levels === 'ABCDEF' && (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'moved an aisle to another team' && /P01: team 4 → team 6/.test(x.detail)));
await card('P02').dragTo(page.locator('#aislePool'));
await page.waitForTimeout(1000);
check('Dragging P02 back onto the list takes it off the plan, and the list offers it again', (await plan('4')).map((x) => x.aisle).join() === 'P03' && (await page.locator('.pool-aisle[data-aisle="P02"]').count()) === 1 && /P02 is off team 4/.test(clean(await page.textContent('#assignMsg'))), clean(await page.textContent('#assignMsg')));
await page.locator('.pool-aisle[data-aisle="P02"]').dragTo(col('4').locator('.drop'));
await page.waitForTimeout(1000);
check('Dragging an aisle from the list onto team 4 queues it last, every level for a team not on Teams & crew', (await plan('4')).map((x) => `${x.aisle}:${x.status}:${x.levels}`).join() === 'P03:active:ABCDEF,P02:queued:ABCDEF' && /P02 queued for team 4/.test(clean(await page.textContent('#assignMsg'))), (await plan('4')).map((x) => `${x.aisle}:${x.status}:${x.levels}`).join());
check('The list shows the aisles no team has, with their bins', (await page.locator('.pool-aisle').count()) === 0 && /every aisle is planned/.test(clean(await page.textContent('#poolCount'))), clean(await page.textContent('#poolCount')));
check('The title line sums the board up', /2 teams · 2 counting · 1 queued/.test(clean(await page.textContent('#planSummary'))), clean(await page.textContent('#planSummary')));
/* the route itself: only queued aisles move */
r = await post(`/api/admin/sessions/${S}/assignments/order`, { team: '4', ids: [(await byAisle('4', 'P03')).id] });
check('The order route refuses the aisle being counted', r.status === 409 && /only an aisle still queued/.test((await j(r)).error || ''));
check('…and an aisle that is not on the count', (await post(`/api/admin/sessions/${S}/assignments/order`, { team: '4', ids: [999999] })).status === 404);
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
