/*
 * An aisle handed back a level at a time. A team finishes level A, then B,
 * then C: each is marked done on the planning board, comes off the gun's
 * walk, and its pallets nobody saw become second counts. The last level
 * finishes the aisle the usual way; a level can be opened again meanwhile.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession, expandSubTabs, openPlanMore } from './helpers.mjs';

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
const post = async (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const pj = async (p, b = {}) => j(await post(p, b));

/* F01 with levels A, B, C, three bins each, a pallet in every bin; F02 queued behind it */
const S = (await pj('/api/admin/sessions', { name: 'Level by level' })).id;
let bins = 'Bin Location,Zone,Aisle\n', pal = 'Pallet ID,SKU,Description,Qty,Location\n';
for (const a of ['F01', 'F02']) for (const l of ['A', 'B', 'C']) for (let i = 1; i <= 3; i++) { bins += `${a}${l}00${i},Freezer,${a}\n`; pal += `P-${a}${l}${i},SKU-${l}${i},Item ${l}${i},10,${a}${l}00${i}\n`; }
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: pal });
await pj(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false, autoRecount: true });
await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01, F02', levels: 'A-C', force: true });
const dev = await pj('/api/admin/devices', { name: 'LVL-01' });
const D = { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const status = async () => j(await fetch(`${BASE}/api/sessions/${S}/team-status?team=1`, { headers: D }));
const asg = async () => (await get(`/api/admin/sessions/${S}/assignments`)).find((x) => x.aisle === 'F01');
/* level A counted, less one pallet */
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: { ...hdr, ...D }, body: JSON.stringify([1, 2].map((i) => ({ clientId: `a${i}`, palletId: `P-F01A${i}`, qty: 10, location: `F01A00${i}`, team: '1', employees: ['E1'], deviceId: 'LVL-01' }))) });

check('To begin with the gun walks all nine bins of F01', (await status()).bins.length === 9 && (await asg()).levels_done === '');
let r = await pj(`/api/admin/sessions/${S}/assignments/${(await asg()).id}`, { levelDone: 'A' });
check('Level A marked done: the aisle stays active with A handed back and B, C to count', !r.finished && r.levelsDone === 'A' && r.levelsLeft === 'BC' && r.assignment.status === 'active', JSON.stringify(r));
let st = await status();
check('…the gun walks B and C only now, and says so', st.bins.length === 6 && !st.bins.some((b) => /^F01A/.test(b)) && st.active.levelsDone === 'A' && st.active.levelsLeft === 'BC', st.bins.join());
let recs = await get(`/api/admin/sessions/${S}/recounts`);
check('…and the pallet nobody saw on level A is a second count already; nothing from B or C', recs.length === 1 && recs[0].bin === 'F01A003' && recs[0].reason === 'MISSING', JSON.stringify(recs.map((x) => [x.bin, x.reason])));
check('The aisle overview says A is done', /1 \(ABC\) · A done/.test((await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').active_detail), (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').active_detail);
check('The log says so', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'marked a level done' && /F01 level A \(B, C still to count\)/.test(x.detail)));
/* open it again, then on with B */
r = await pj(`/api/admin/sessions/${S}/assignments/${(await asg()).id}`, { levelOpen: 'A' });
check('Level A opened again: back on the walk', r.levelsDone === '' && (await status()).bins.length === 9);
await pj(`/api/admin/sessions/${S}/assignments/${(await asg()).id}`, { levelDone: 'A' });
r = await pj(`/api/admin/sessions/${S}/assignments/${(await asg()).id}`, { levelDone: 'B' });
check('A and B done: C left', r.levelsDone === 'AB' && r.levelsLeft === 'C' && !r.finished && (await status()).bins.join() === 'F01C001,F01C002,F01C003', JSON.stringify(r));
check('A level the aisle does not have is refused, naming the ones it has', (await post(`/api/admin/sessions/${S}/assignments/${(await asg()).id}`, { levelDone: 'D' })).status === 400);
r = await pj(`/api/admin/sessions/${S}/assignments/${(await asg()).id}`, { levelDone: 'C' });
const after = await asg();
check('The last level finishes the aisle: done, F02 started, the aisle filed, the log says every level is in', r.finished && after.status === 'done' && r.activated.some((x) => x.aisle === 'F02') && (await get('/api/admin/audit?limit=10')).some((x) => /marked an aisle done, level by level/.test(x.action)) && (await get(`/api/admin/sessions/${S}/archives`)).archives.some((f) => /F01/.test(JSON.stringify(f))), JSON.stringify({ finished: r.finished, status: after.status, activated: r.activated }));
check('…and every pallet nobody saw in F01 is a second count now', (await get(`/api/admin/sessions/${S}/recounts`)).filter((x) => x.reason === 'MISSING').length === 7);
check('A level on a finished aisle is refused', (await post(`/api/admin/sessions/${S}/assignments/${after.id}`, { levelDone: 'A' })).status === 409);

/* ---------------- the planning board ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await openPlanMore(page);
const f02 = (await get(`/api/admin/sessions/${S}/assignments`)).find((x) => x.aisle === 'F02');
await page.waitForSelector(`#teamList .a[data-id="${f02.id}"] button[data-level-done="A"]`, { timeout: 10000 });
check('The board: the aisle being counted carries a chip a level - A, B, C - none ticked', (await page.locator(`#teamList .a[data-id="${f02.id}"] button[data-level-done]`).count()) === 3 && !(await page.$(`#teamList .a[data-id="${f02.id}"] button[data-level-done].selected`)));
await page.click(`#teamList .a[data-id="${f02.id}"] button[data-level-done="A"]`); await page.waitForTimeout(1200);
check('Click A: it is ticked, the message says what is left, and the gun walks B and C', (await page.$eval(`#teamList .a[data-id="${f02.id}"] button[data-level-done="A"]`, (b) => b.classList.contains('selected'))) && /Level A of F02 is done/.test(clean(await page.textContent('#assignMsg'))) && (await status()).bins.length === 6, clean(await page.textContent('#assignMsg')));
check('…the chip row reads on the card', /Done by level:\s*A ✓\s*B\s*C/.test(clean(await page.textContent(`#teamList .a[data-id="${f02.id}"]`))), clean(await page.textContent(`#teamList .a[data-id="${f02.id}"]`)).slice(0, 160));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
