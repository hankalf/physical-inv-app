/*
 * Which jobs the scanners offer.
 *
 * The sign-on screen offers the jobs that exist - a full count, a cycle count,
 * moving pallets. An admin can switch any of them off for every scanner at
 * once (during a wall-to-wall: the full count alone), the practice gun in the
 * Testing Suite always sees all three, and at least one job has to stay on.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const login = async (body) => (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) })).json()).token;
const tok = await login({ username: 'DANA-WHITFIELD', password: 'changeme' });
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const j = (r) => r.json();
const post = (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });

/* a full count, a cycle programme with a batch, and a move list: every job exists */
const full = await j(await post('/api/admin/sessions', { name: 'Jobs full' }));
const cyc = await j(await post('/api/admin/sessions', { name: 'Jobs cycle', mode: 'cycle' }));
const bins = 'Bin Location\nF01A001\nF01A002\nF01A003\nF02A001\nF02A002\n';
for (const s of [full, cyc]) await fetch(`${BASE}/api/admin/sessions/${s.id}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await fetch(`${BASE}/api/admin/sessions/${cyc.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Bin Code,Container No.,Item No.,Description,Quantity,System\nF01A001,J-1,SKU-1,Mango,40,ERP\nF02A001,J-2,SKU-2,Berries,30,ERP\n' });
await post(`/api/admin/sessions/${cyc.id}/cycle/batches`, { size: 2, pick: 'oldest' });
await fetch(`${BASE}/api/admin/sessions/${full.id}/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\nJ-9,F01A001,F01A002\n' });
await post('/api/admin/missing', { pallet: 'J-LOST', description: 'Lost mango', last: 'F02A002' });
const dev = await j(await post('/api/admin/devices', { name: 'JOBS-01' }));

let jobs = await j(await fetch(`${BASE}/api/admin/scanner-jobs`, { headers: A }));
check('Out of the box every job is on', jobs.jobs.full && jobs.jobs.cycle && jobs.jobs.move && jobs.jobs.missing && jobs.all.length === 4, JSON.stringify(jobs));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await ctx.newPage();
gun.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
const offers = async () => ({ full: await gun.isVisible('#btnModeFull'), cycle: await gun.isVisible('#btnModeCycle'), move: await gun.isVisible('#btnModeMove'), find: await gun.isVisible('#btnModeFind'), block: await gun.isVisible('#modeBlock') });
let o = await offers();
check('The gun offers all four jobs when all four exist', o.full && o.cycle && o.move && o.find && o.block, JSON.stringify(o));

/* the admin keeps the full count alone */
let r = await post('/api/admin/scanner-jobs', { cycle: false, move: false, missing: false });
check('An admin switches the cycle count, moves and finds off', r.status === 200 && JSON.stringify((await j(r)).jobs) === '{"full":true,"cycle":false,"move":false,"missing":false}');
await gun.reload(); await gun.waitForTimeout(1500);
o = await offers();
check('The gun now offers the full count alone, with no job picker at all', !o.block && !o.cycle && !o.move && !o.find && /Count session/.test(await gun.textContent('#sessionLabel')), JSON.stringify(o) + ' ' + await gun.textContent('#sessionLabel'));
check('…and lists the full count only', (await gun.$$eval('#fSession option', (os) => os.map((x) => x.textContent))).join('|').includes('Jobs full') && !(await gun.$$eval('#fSession option', (os) => os.map((x) => x.textContent))).join('|').includes('Jobs cycle'));

/* a gun that had picked the cycle count last time is moved off it */
await post('/api/admin/scanner-jobs', { cycle: true, move: true, missing: true });
await gun.reload(); await gun.waitForTimeout(1200);
await gun.click('#btnModeCycle'); await gun.waitForTimeout(200);
await post('/api/admin/scanner-jobs', { cycle: false });
await gun.reload(); await gun.waitForTimeout(1500);
check('A gun that last chose the cycle count falls back to a job that is on', await gun.$eval('#btnModeFull', (b) => b.classList.contains('selected')) && !(await gun.isVisible('#btnModeCycle')));

/* the practice gun is not affected */
const prac = await j(await post('/api/admin/practice'));
const pgun = await browser.newPage({ viewport: { width: 360, height: 640 } });
await pgun.goto(`${BASE}/?d=${prac.device.uid}&practice=1`); await pgun.waitForTimeout(1500);
const ptok = (await j(await post(`/api/devices/${prac.device.uid}`, {}, hdr))).token;
const pj = await j(await fetch(`${BASE}/api/scanner-jobs?practice=1`, { headers: { authorization: 'Device ' + ptok } }));
const dtok = (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token;
const dj = await j(await fetch(`${BASE}/api/scanner-jobs`, { headers: { authorization: 'Device ' + dtok } }));
check('The practice gun in the Testing Suite still gets every job, while a floor gun gets the ticked ones', pj.jobs.cycle === true && pj.jobs.move === true && dj.jobs.cycle === false, JSON.stringify([pj, dj]));

/* the rules */
r = await post('/api/admin/scanner-jobs', { full: false, cycle: false, move: false, missing: false });
check('Every job off is refused', r.status === 400 && /at least one job/.test((await j(r)).error));
await post('/api/admin/users', { username: 'JOBS-SUP', name: 'Jobs Sup', password: 'dock-side-77', mustChange: false, profile: 'floor' });
const supTok = await login({ username: 'JOBS-SUP', password: 'dock-side-77' });
r = await post('/api/admin/scanner-jobs', { move: false }, { ...hdr, authorization: 'Bearer ' + supTok });
check('A count supervisor cannot change it; it is a Settings matter', r.status === 403, String(r.status));

/* the card */
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto(`${BASE}/settings#gun`);
await page.fill('#fUser', 'DANA-WHITFIELD'); await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active', { state: 'attached' }); await page.waitForTimeout(1500);
check('Settings → Scanner screen shows the card with the current ticks', await page.$eval('#fJobFull', (b) => b.checked) && !(await page.$eval('#fJobCycle', (b) => b.checked)) && await page.$eval('#fJobMove', (b) => b.checked) && await page.$eval('#fJobMissing', (b) => b.checked) && /only:/.test(await page.textContent('#jobsChip')));
await page.check('#fJobCycle'); await page.click('#btnJobsSave'); await page.waitForTimeout(500);
check('Ticking a job back on saves it, and the chip says every job', /every job/.test(await page.textContent('#jobsMsg')) && /every job/.test(await page.textContent('#jobsChip')) && (await j(await fetch(`${BASE}/api/admin/scanner-jobs`, { headers: A }))).jobs.cycle === true);

await post('/api/admin/scanner-jobs', { full: true, cycle: true, move: true, missing: true });
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
