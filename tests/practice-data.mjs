/*
 * Practice data: every login's practice, for an admin.
 *
 * The Testing Suite shows each person their own practice. Learn → Practice
 * data lists all of it to an admin - who has practiced, what each tried, how
 * far they got - with an export of one person's lot and a way to take it
 * away. Practice counts are out of every dashboard's picker; only the
 * dashboard inside the Testing Suite still gets its own one.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const tok = await login({ password: 'changeme' });
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}, h = A, method = 'POST') => fetch(BASE + p, { method, headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

/* a real count, and two people practicing */
const live = await j(await post('/api/admin/sessions', { name: 'The real count' }));
await post('/api/admin/users', { username: 'MARCUS-OBI', name: 'Marcus Obi', password: 'dock-side-77', mustChange: false, profile: 'inventory' });
const M = { ...hdr, authorization: 'Bearer ' + (await login({ username: 'MARCUS-OBI', password: 'dock-side-77' })) };
const mine = await j(await post('/api/admin/practice'));
const his = await j(await post('/api/admin/practice', {}, M));
/* Marcus counts a line on his practice gun, then starts over and counts again */
const gunOf = async (dev) => ({ ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token });
let G = await gunOf(his.device);
await post(`/api/sessions/${his.session.id}/signon`, { deviceId: his.device.name, team: '99', employees: ['T1001'] }, G);
await post(`/api/sessions/${his.session.id}/counts`, [{ clientId: 'pd1', palletId: 'F12311-111', qty: 40, location: 'F01A001', team: '99', deviceId: his.device.name, scannedAt: new Date().toISOString() }], G);
const his2 = await j(await post('/api/admin/practice/reset', {}, M));
G = await gunOf(his.device);
await post(`/api/sessions/${his2.session.id}/signon`, { deviceId: his.device.name, team: '99', employees: ['T1001'] }, G);
await post(`/api/sessions/${his2.session.id}/counts`, [
  { clientId: 'pd2', palletId: 'F12311-111', qty: 40, location: 'F01A001', team: '99', deviceId: his.device.name, scannedAt: new Date().toISOString() },
  { clientId: 'pd3', palletId: 'F12312-111', qty: 40, location: 'F01A002', team: '99', deviceId: his.device.name, scannedAt: new Date().toISOString() },
], G);
await post('/api/admin/practice/mode', { mode: 'second' }, M);

/* ---- the listing, to an admin */
let all = await get('/api/admin/practice/all');
check('An admin sees every login\'s practice: two people, three runs', all.people === 2 && all.runs === 3 && all.current === 2, JSON.stringify([all.people, all.runs, all.current]));
const marcus = all.owners.find((o) => o.owner === 'user:marcus-obi');
const dana = all.owners.find((o) => o.owner === 'user:dana-whitfield');
check('…each named, with their login', marcus && marcus.name === 'Marcus Obi' && marcus.username === 'MARCUS-OBI' && dana && dana.name === 'Dana Whitfield', JSON.stringify(all.owners.map((o) => [o.owner, o.name, o.username])));
check('The most recent practice comes first', all.owners[0].owner === 'user:marcus-obi');
check('Marcus has a current run and an earlier one, newest first', marcus.runs.length === 2 && marcus.runs[0].status === 'current' && marcus.runs[0].id === his2.session.id && marcus.runs[1].status === 'earlier' && marcus.runs[1].id === his.session.id, JSON.stringify(marcus.runs.map((r) => [r.id, r.status])));
const cur = marcus.runs[0];
check('…the current run says what was tried, its bins and lines, and the other jobs set up on it', cur.tried >= 2 && cur.of >= 12 && cur.checklist.some((c) => c.key === 'two' && !c.done) && cur.checklist.some((c) => c.key === 'first' && c.done) && cur.lines >= 2 && cur.bins === 2 && cur.jobs.includes('Second counts') && cur.source === 'Built in', JSON.stringify([cur.tried, cur.of, cur.lines, cur.bins, cur.jobs, cur.source]));
check('…and when they last did anything', !!cur.lastActivity && !!marcus.lastActivity, String(marcus.lastActivity));
check('Dana opened the tab and tried nothing yet', dana.runs.length === 1 && dana.runs[0].tried === 0 && dana.runs[0].lines === 0 && dana.lastActivity === null);

/* ---- who may */
const r403 = await fetch(`${BASE}/api/admin/practice/all`, { headers: M });
check('A supervisor may not read it', r403.status === 403, String(r403.status));
check('…nor export anyone\'s', (await fetch(`${BASE}/api/admin/practice/all/export?owner=user:dana-whitfield`, { headers: M })).status === 403);
check('…nor delete anyone\'s', (await post('/api/admin/practice/all?owner=user:dana-whitfield', {}, M, 'DELETE')).status === 403);

/* ---- out of the pickers */
check('The dashboard picker lists no practice count, to an admin either', !(await get('/api/admin/sessions')).some((s) => s.practice) && (await get('/api/admin/sessions')).some((s) => s.id === live.id));
check('…nor to a supervisor', !(await get('/api/admin/sessions', M)).some((s) => s.practice));
check('The dashboard inside the Testing Suite still gets the person\'s own', (await get('/api/admin/sessions?practice=1', M)).filter((s) => s.practice).map((s) => s.id).join() === String(his2.session.id));

/* ---- an admin exports one person's lot */
const ex = await get('/api/admin/practice/all/export?owner=user:marcus-obi');
check('Export gives one workbook of the person\'s runs', ex.runs === 2 && /practice-runs-marcus-obi/.test(ex.filename) && ex.sheets[0].name === 'Runs' && ex.sheets[0].rows.length === 2, JSON.stringify([ex.runs, ex.filename, ex.sheets.length]));
check('A bad owner is refused, not guessed', (await fetch(`${BASE}/api/admin/practice/all/export?owner=marcus`, { headers: A })).status === 400);

/* ---- the page */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/practice`);
await signIn(page);
await page.waitForSelector('#pdTable tbody tr', { timeout: 8000 });
const side = clean(await page.textContent('#navTabs'));
check('Practice data is in the sidebar under Learn, for the admin', /Learn.*Practice data/.test(side), side.slice(side.indexOf('Learn'), side.indexOf('Learn') + 60));
const tiles = clean(await page.textContent('#pdTiles'));
check('The tiles: people, runs, on a run now, lines', /2.*People who have practiced.*3.*Runs.*2.*On a run now.*\d+.*Lines counted/.test(tiles), tiles);
let rows = await page.$$eval('#pdTable tbody tr[data-run]', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
check('A row per run, the person named on their first row, current and earlier told apart', rows.length === 3 && /Marcus Obi/.test(rows[0][0]) && /current/.test(rows[0][1]) && rows[1][0] === '' && /earlier/.test(rows[1][1]) && /Dana Whitfield/.test(rows[2][0]), JSON.stringify(rows.map((r) => r.slice(0, 2))));
await page.click(`#pdTable tr[data-run="${his2.session.id}"] button.linkish`);
await page.waitForSelector('#pdTable tr.more');
const tried = clean(await page.textContent('#pdTable tr.more'));
check('Opening a run lists the things tried, done ones ticked, and the jobs set up on it', /✓ ?Sign on with team 99/.test(tried) && /✓ ?Count a pallet: pallet/.test(tried) && /○ ?Record an empty bin/.test(tried) && /Second counts/.test(tried), tried.slice(0, 160));
await page.selectOption('#fPdWho', 'user:dana-whitfield'); await page.waitForTimeout(300);
rows = await page.$$eval('#pdTable tbody tr[data-run]', (trs) => trs.map((tr) => tr.dataset.owner));
check('Who narrows the list to one person', rows.length === 1 && rows[0] === 'user:dana-whitfield', rows.join());
await page.selectOption('#fPdWho', ''); await page.check('#fPdCurrent'); await page.waitForTimeout(300);
rows = await page.$$eval('#pdTable tbody tr[data-run]', (trs) => trs.map((tr) => tr.dataset.run));
check('Current runs only drops the earlier ones', rows.length === 2 && !rows.includes(String(his.session.id)), rows.join());
await page.uncheck('#fPdCurrent'); await page.waitForTimeout(300);
const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await page.click(`#pdTable tr[data-run="${his2.session.id}"] .acts button:text("Export")`);
const d = await dl;
check('Export from the page hands over the workbook', !!d && /practice-runs-marcus-obi-.*\.xlsx/.test(d.suggestedFilename()), d ? d.suggestedFilename() : 'no download');
page.once('dialog', (dg) => dg.accept());
await page.click(`#pdTable tr[data-run="${his2.session.id}"] .acts button:text("Delete")`);
await page.waitForTimeout(1500);
check('Delete takes the person\'s practice away', /Marcus Obi's practice is gone/.test(clean(await page.textContent('#pdMsg'))) && (await page.$$('#pdTable tbody tr[data-owner="user:marcus-obi"]')).length === 0, clean(await page.textContent('#pdMsg')));
all = await get('/api/admin/practice/all');
check('…every run of theirs, and the log says so', all.people === 1 && !all.owners.some((o) => o.owner === 'user:marcus-obi') && (await get('/api/admin/audit?limit=20')).some((a) => a.action === 'deleted a login\'s practice data' && /marcus-obi: 2 runs/.test(a.detail)));
const fresh = await j(await post('/api/admin/practice', {}, M));
check('…and the Testing Suite starts them fresh', fresh.session && fresh.session.id !== his2.session.id && fresh.checklist.every((c) => !c.done));

/* ---- a supervisor never sees the page */
const sup = await browser.newPage({ viewport: { width: 1440, height: 900 } });
sup.on('pageerror', (e) => errors.push('sup: ' + e.message));
await sup.goto(`${BASE}/practice`);
await signIn(sup, { user: 'MARCUS-OBI', password: 'dock-side-77' });
await sup.waitForTimeout(1500);
const supSide = clean(await sup.textContent('#navTabs'));
check('A supervisor has no Practice data in the sidebar and is sent on from the page', !/Practice data/.test(supSide) && !/\/practice$/.test(sup.url()), sup.url());
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
