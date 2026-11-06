/*
 * The gaps only. An aisle partly counted is finished by sending a team to
 * the bins nobody has counted and nothing else: the gun lists those, listed
 * as the assignment starts, and the bins already counted never show.
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

/* F01: six bins on level A; team 1 counted three of them freely, then left */
const S = (await pj('/api/admin/sessions', { name: 'The gaps' })).id;
let bins = 'Bin Location,Zone,Aisle\n';
for (let i = 1; i <= 6; i++) bins += `F01A00${i},Freezer,F01\n`;
for (let i = 1; i <= 3; i++) bins += `F02A00${i},Freezer,F02\n`;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await pj(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false, autoRecount: false });
await pj('/api/admin/people/teams', { name: '2', shift: '1' });
const dev = await pj('/api/admin/devices', { name: 'GAP-01' });
const D = { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: { ...hdr, ...D }, body: JSON.stringify([1, 3, 5].map((i) => ({ clientId: `g${i}`, palletId: `P${i}`, qty: 10, location: `F01A00${i}`, team: '1', employees: ['E1'], deviceId: 'GAP-01' }))) });

let r = await pj(`/api/admin/sessions/${S}/assignments`, { team: '2', aisles: 'F01', levels: 'A', gaps: true, force: true });
check('Team 2 is sent to the gaps of F01: queued as such, and it starts', /F01 \(A\), only the bins not yet counted/.test(r.added.join()) && r.activated.some((a) => a.team === '2' && a.gaps), JSON.stringify(r));
const status = async (team) => j(await fetch(`${BASE}/api/sessions/${S}/team-status?team=${team}`, { headers: D }));
let st = await status('2');
check('Its gun walks the three bins nobody counted - 002, 004, 006 - and nothing else', st.bins.join() === 'F01A002,F01A004,F01A006' && st.active.gaps && st.progress.bins === 3 && st.progress.counted === 0, JSON.stringify({ bins: st.bins, progress: st.progress }));
/* somebody else counts one of the gaps meanwhile; team 2 counts another */
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: { ...hdr, ...D }, body: JSON.stringify([{ clientId: 'g4', palletId: 'P4', qty: 10, location: 'F01A004', team: '2', employees: ['E2'], deviceId: 'GAP-01' }]) });
st = await status('2');
check('A gap counted stays on the list as counted: 1 of 3, the walk does not shrink under the team', st.bins.length === 3 && st.progress.counted === 1 && st.progress.countedBins.join() === 'F01A004', JSON.stringify(st.progress));
check('The aisle overview says gaps only', /2 \(A\) · gaps only/.test((await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').active_detail), (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').active_detail);
const rows = await get(`/api/admin/sessions/${S}/assignments`);
check('The assignment carries the gap list it started with', rows[0].only_uncounted === 1 && JSON.parse(rows[0].gap_bins).join() === 'F01A002,F01A004,F01A006');

/* ---------------- the dashboard ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (dd) => dd.accept());
await pj(`/api/admin/sessions/${S}/assignments/${rows[0].id}`, { status: 'done' });
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: { ...hdr, ...D }, body: JSON.stringify([{ clientId: 'h1', palletId: 'Q1', qty: 10, location: 'F02A001', team: '1', employees: ['E1'], deviceId: 'GAP-01' }]) });
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#nuList .nu-row', { timeout: 10000 });
await page.fill('#qaScan', '2'); await page.press('#qaScan', 'Enter'); await page.waitForTimeout(900);
check('Next up: F02, one of three bins counted, offers "Queue the 2 uncounted" beside Queue', await page.isVisible('#nuList button[data-queue-gaps="F02"]') && /Queue the 2 uncounted/.test(clean(await page.textContent('#nuList button[data-queue-gaps="F02"]'))), clean(await page.textContent('#nuList .nu-row[data-aisle="F02"]')));
await page.click('#nuList button[data-queue-gaps="F02"]'); await page.waitForTimeout(1000);
const f2 = (await get(`/api/admin/sessions/${S}/assignments`)).find((x) => x.aisle === 'F02');
check('…pressed: team 2 has F02, gaps only, the message says so, and its gun walks 002 and 003', f2 && f2.only_uncounted === 1 && /only the bins not yet counted/.test(clean(await page.textContent('#nuMsg'))) && (await status('2')).bins.join() === 'F02A002,F02A003', clean(await page.textContent('#nuMsg')));
await page.click('#btnPlanMore'); await page.waitForTimeout(400);
check('The planning board marks the card gaps only, and the typed row has a Gaps only tick', /gaps only/.test(clean(await page.textContent('#teamList'))) && await page.isVisible('#fAssignGaps'));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
