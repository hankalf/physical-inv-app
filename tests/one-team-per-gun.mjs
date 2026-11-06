/*
 * One team per scanner. A gun still signed on as one team is not taken over
 * by a second sign-on: the second team is refused and told who has it. The
 * first team taps Sign off, or a supervisor signs the scanner off from the
 * dashboard. The same team signing on again is a crew change, not a double.
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
const post = async (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const pj = async (p, b = {}) => j(await post(p, b));

const S = (await pj('/api/admin/sessions', { name: 'One team per gun' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\n' });
await pj(`/api/admin/sessions/${S}/settings`, { guided: false, askComments: false });
const dev = await pj('/api/admin/devices', { name: 'ONE-01' });
const G = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const signon = (team, emp = ['E1']) => post(`/api/sessions/${S}/signon`, { deviceId: 'ONE-01', team, employees: emp }, G);

/* ---------------- the rule ---------------- */
check('Team 3 signs on to the scanner', (await signon('3')).status === 200);
let r = await signon('5');
let body = await j(r);
check('Team 5 trying the same scanner is refused, told team 3 has it and what to do', r.status === 409 && body.code === 'signedOn' && /signed on as team 3 \(since \d/.test(body.error) && /Sign off first, or a supervisor/.test(body.error), body.error);
let open = (await get(`/api/admin/sessions/${S}/clocks`)).signons;
check('The dashboard sees one scanner signed on, as team 3', open.length === 1 && open[0].deviceId === 'ONE-01' && open[0].team === '3' && open[0].employees.join() === 'E1', JSON.stringify(open));
check('Team 3 signing on again (a crew change) is fine, and still one sign-on open', (await signon('3', ['E1', 'E2'])).status === 200 && (await get(`/api/admin/sessions/${S}/clocks`)).signons.length === 1);
check('The refusal is in the log', (await get('/api/admin/audit?limit=20')).some((x) => /refused a sign-on: the scanner is signed on as another team/.test(x.action) && /team 5 tried; team 3 has it/.test(x.detail)));
/* team 3 taps Sign off: the gun is free */
await post(`/api/sessions/${S}/signoff`, { deviceId: 'ONE-01', team: '3' }, G);
check('After team 3 signs off, team 5 signs on', (await signon('5')).status === 200 && (await get(`/api/admin/sessions/${S}/clocks`)).signons[0].team === '5');
/* a supervisor signs the scanner off from the dashboard */
const off = await pj(`/api/admin/sessions/${S}/signoff`, { deviceId: 'ONE-01' });
check('A supervisor signs the scanner off: team 5 is off it, and it is logged', off.ended === 1 && off.teams.join() === '5' && (await get(`/api/admin/sessions/${S}/clocks`)).signons.length === 0 && (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'signed a scanner off'), JSON.stringify(off));
check('…and team 7 can sign on now', (await signon('7')).status === 200);
check('A sign-off needs a scanner name', (await post(`/api/admin/sessions/${S}/signoff`, {})).status === 400);
/* the function: a floor supervisor with Alerts may; a login without it may not */
await pj('/api/admin/users', { username: 'ONE-VIEW', name: 'Only Views', password: 'look-only-11', mustChange: false, access: ['dashboard'] });
const viewer = await j(await post('/api/admin/login', { username: 'ONE-VIEW', password: 'look-only-11' }, hdr));
check('A login without the Alerts function cannot sign a scanner off', (await post(`/api/admin/sessions/${S}/signoff`, { deviceId: 'ONE-01' }, { ...hdr, authorization: 'Bearer ' + viewer.token })).status === 403);

/* ---------------- on the gun ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (dd) => dd.accept());
const dev2 = await pj('/api/admin/devices', { name: 'ONE-02' });
const G2 = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev2.uid}`, { method: 'POST' }))).token };
await post(`/api/sessions/${S}/signon`, { deviceId: 'ONE-02', team: '4', employees: ['E4'] }, G2);   // team 4 has ONE-02 and walked off with it signed on
await gun.goto(`${BASE}/?d=${dev2.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', '6');
await gun.fill('#fEmployee', 'E6'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(1500);
check('Gun: team 6 picks up a scanner signed on as team 4 - it stays on the sign-on screen and says so', await gun.isVisible('#scrSignon.active') && /Scanner already signed on/.test(clean(await gun.textContent('#signonMsg'))) && /team 4/.test(clean(await gun.textContent('#signonMsg'))), clean(await gun.textContent('#signonMsg')));

/* ---------------- the dashboard ---------------- */
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/admin`);
await signIn(page);
await pickSession(page, S);
await page.waitForSelector('#teamTable tr[data-team="4"] button[data-signoff="ONE-02"]', { timeout: 10000 });
check('Dashboard: team 4\'s row shows its scanner with a Sign off button', await page.isVisible('#teamTable tr[data-team="4"] button[data-signoff="ONE-02"]'));
await page.click('#teamTable tr[data-team="4"] button[data-signoff="ONE-02"]'); await page.waitForTimeout(1200);
check('…Sign off frees the scanner', !(await get(`/api/admin/sessions/${S}/clocks`)).signons.some((x) => x.deviceId === 'ONE-02') && !(await page.$('#teamTable button[data-signoff="ONE-02"]')));
await gun.click('#btnStart'); await gun.waitForTimeout(2500);
check('Gun: team 6 tries again and is signed on', !(await gun.isVisible('#scrSignon.active')) && (await get(`/api/admin/sessions/${S}/clocks`)).signons.some((x) => x.deviceId === 'ONE-02' && x.team === '6'), JSON.stringify((await get(`/api/admin/sessions/${S}/clocks`)).signons));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
