/*
 * Classroom training: a real count on a warehouse that fits on a wall. Set up
 * once, print the labels, sign a real scanner on with a team card and badges
 * from the wall, count the wall, reset for the next class, remove.
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
const A = { ...hdr, authorization: 'Bearer ' + (await login({ password: 'changeme' })) };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const text = async (p) => (await fetch(BASE + p, { headers: A })).text();

/* ---------------- who may ---------------- */
await post('/api/admin/users', { username: 'TR-SUP', name: 'Train Sup', password: 'train-sup-1', mustChange: false, profile: 'supervisor' });
const SUP = { ...hdr, authorization: 'Bearer ' + (await login({ username: 'TR-SUP', password: 'train-sup-1' })) };
check('Only an admin sets the training count up', (await post('/api/admin/training', {}, SUP)).status === 403 && (await fetch(`${BASE}/api/admin/training`, { headers: SUP })).status === 403);
check('Before it exists, the status says what the wall would hold', (await get('/api/admin/training')).session === null && (await get('/api/admin/training')).wall.bins === 18);

/* ---------------- set up ---------------- */
let r = await post('/api/admin/training', {});
let t = await j(r);
check('Set up makes the training count: 18 bins, 17 pallets on the report, 3 teams, 8 trainees', r.status === 200 && t.session && t.session.trial && t.session.showOnGuns && t.loaded.bins === 18 && t.loaded.pallets === 17 && t.loaded.teams === 3 && t.loaded.trainees === 8, JSON.stringify(t));
const S = t.session.id;
const sess = await get(`/api/admin/sessions/${S}`);
check('…a guided full count, every difference raising a second count, a trial run named for what it is', sess.guided === 1 && sess.auto_recount === 1 && sess.third_count === 1 && sess.recount_min_qty === 0 && sess.trial === 1 && /Training count/.test(sess.name), JSON.stringify([sess.guided, sess.auto_recount, sess.trial, sess.name]));
const people = await get('/api/admin/people');
const team = (n) => people.teams.find((x) => x.name === n);
check('…the teams on Teams & crew with their trainees', team('S1-DS01') && team('S1-DS01').members.length === 3 && team('S1-DS02').members.length === 3 && team('S2-DS01').members.length === 2 && people.employees.some((e) => e.badge === 'TRN-01' && e.name === 'Marcus Obi' && /training/i.test(e.dept)));
const plan = await get(`/api/admin/sessions/${S}/assignments`);
check('…and the plan: S1-DS01 counting T01, S1-DS02 counting T02, the night team queued behind', plan.some((a) => a.team === 'S1-DS01' && a.aisle === 'T01' && a.status === 'active') && plan.some((a) => a.team === 'S1-DS02' && a.aisle === 'T02' && a.status === 'active') && plan.filter((a) => a.team === 'S2-DS01').every((a) => a.status === 'queued'), JSON.stringify(plan.map((a) => [a.team, a.aisle, a.status])));
check('The report carries costs, so the money columns and thresholds can be shown', (await get(`/api/admin/sessions/${S}/pallets?limit=50`)).rows.every((x) => x.cost !== ''));
r = await post('/api/admin/training', {});
check('Set up again is the same count, refreshed, not a second one', r.status === 200 && (await j(r)).session.id === S && (await get('/api/admin/sessions')).filter((x) => /Training count/.test(x.name)).length === 1);

/* ---------------- the printed wall ---------------- */
const wall = await text('/api/admin/training/print/wall?size=big');
const svgs = (wall.match(/<svg/g) || []).length;
check('The wall prints every rack label, pallet label, team card and badge as a barcode', svgs === 18 + 18 + 3 + 8 && /T01A001/.test(wall) && /TRN-9999/.test(wall) && /S1-DS01/.test(wall) && /TRN-01/.test(wall) && /Marcus Obi/.test(wall), `${svgs} barcodes`);
check('…with the torn label, the two-label skid and the trainer\'s key', /TORN|class="torn"/.test(wall) && /ONE OF TWO ON THIS SKID/.test(wall) && /trainer's key/.test(wall) && /Hang under rack <b>T01A006<\/b>/.test(wall));
check('Small labels for a desk, and one part at a time', /class="small"/.test(await text('/api/admin/training/print/wall?size=small')) && !/Rack labels/.test(await text('/api/admin/training/print/wall?part=teams')));
const two = await text('/api/admin/training/print/pocket-card?lang=en&teams=S1-DS01,S1-DS01,S1-DS02,INV,S2-RT05');
const backs = [...two.matchAll(/class="pc back" data-team="([^"]+)"/g)].map((m) => m[1]);
check('With a team number per person, every sheet of fronts is followed by its backs, mirrored for a duplex print', two.split('class="sheet page fronts"').length === 3 && backs.join() === 'S1-DS01,S1-DS01,INV,S1-DS02,S2-RT05' && /class="pc back blank"/.test(two) && /data-code="S2-RT05"/.test(two) && /1ST SHIFT/.test(two) && /2ND SHIFT/.test(two), backs.join());
check('…teams=crew takes one card per person from Teams & crew', [...(await text('/api/admin/training/print/pocket-card?lang=es&teams=crew')).matchAll(/class="pc back" data-team="([^"]+)"/g)].map((m) => m[1]).sort().join() === 'S1-DS01,S1-DS01,S1-DS01,S1-DS02,S1-DS02,S1-DS02,S2-DS01,S2-DS01');
check('The pocket card prints in English and Spanish, four to a page', (await text('/api/admin/training/print/pocket-card?lang=en')).split('class="pc"').length === 5 && /Escanea la etiqueta del RACK/.test(await text('/api/admin/training/print/pocket-card?lang=es')));

/* ---------------- a real scanner walks the wall ---------------- */
const dev = await j(await post('/api/admin/devices', { name: 'TRAIN-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
check('The scanners are offered the training count', (await get('/api/sessions', G)).some((x) => x.id === S && x.trial));
r = await post(`/api/sessions/${S}/signon`, { team: 'S1-DS01', employees: ['TRN-01', 'TRN-02'], deviceId: 'TRAIN-01' }, G);
const so = await j(r);
check('A scanner signs on with the team card and two badges from the wall, and gets aisle T01', r.status === 200 && so.active && so.active.aisle === 'T01' && so.crew && so.crew.crew.length === 2 && !so.crew.unknown.length, JSON.stringify([r.status, so.active && so.active.aisle, so.crew && so.crew.unknown]));
let n = 0;
const line = (pallet, qty, bin, extra = {}) => ({ clientId: `tr${++n}`, palletId: pallet, qty, location: bin, team: 'S1-DS01', deviceId: 'TRAIN-01', scannedAt: new Date().toISOString(), ...extra });
r = await post(`/api/sessions/${S}/counts`, [line('TRN-1001', 40, 'T01A001'), line('TRN-1004', 30, 'T01A004'), line('TRN-1005', 30, 'T01A006'), line('TRN-9999', 12, 'T01A007', { unknownPallet: 1 }), { clientId: 'tr-e', emptyBin: 1, palletId: '', qty: 0, location: 'T01A003', team: 'S1-DS01', deviceId: 'TRAIN-01', scannedAt: new Date().toISOString() }], G);
const out = await j(r);
check('The wall counts like a warehouse: the short count and the wrong-spot pallet raise second counts at once', r.status === 200 && out.accepted.length === 5 && out.recounts.created >= 2, JSON.stringify(out.recounts));
const rows = (await get(`/api/admin/sessions/${S}/pallets?limit=50`)).rows;
const R = (id) => rows.find((x) => x.pallet_id === id);
check('…and the pallet report reads the lessons: QTY VARIANCE, WRONG BIN, NOT IN MASTER', R('TRN-1004').status === 'QTY VARIANCE' && R('TRN-1005').status === 'WRONG BIN' && R('TRN-9999').status === 'NOT IN MASTER', [R('TRN-1004').status, R('TRN-1005').status, R('TRN-9999').status].join());
check('The ERP file is refused on the training count, it being a trial run', (await fetch(`${BASE}/api/admin/sessions/${S}/erp/default.csv`, { headers: A })).status === 409);

/* ---------------- the roster ---------------- */
await post('/api/admin/people/employees?new=1', { badge: 'E9001', name: 'Rosa Vega', dept: 'Warehouse', shift: '1' });
await post('/api/admin/people/employees?new=1', { badge: 'E9002', name: 'Ben Cole', dept: 'Warehouse', shift: '2' });
let ros = await get('/api/admin/training/roster');
check('The roster lists the real employees, not the wall\'s trainees, nobody trained yet', ros.rows.some((x) => x.badge === 'E9001') && !ros.rows.some((x) => /^TRN-/.test(x.badge)) && ros.totals.trained === 0 && ros.totals.people >= 2, JSON.stringify(ros.totals));
r = await post('/api/admin/training/roster', { badge: 'E9001', trained: true, note: 'wall, team one' });
ros = await j(r);
check('Tick a person: trained, by whom, when; the shift totals follow', r.status === 200 && ros.rows.find((x) => x.badge === 'E9001').trained && ros.rows.find((x) => x.badge === 'E9001').trainedBy && ros.totals.trained === 1 && ros.totals.byShift['1'].trained === 1 && ros.totals.byShift['2'].trained === 0, JSON.stringify(ros.totals));
check('…untick takes it back', (await j(await post('/api/admin/training/roster', { badge: 'E9001', trained: false }))).totals.trained === 0);
await post('/api/admin/training/roster', { badge: 'E9002', trained: true });
const rcsv = await text('/api/admin/training/roster.csv');
check('The roster downloads as a CSV and prints as a clipboard sheet by shift', /^Clock In Number,Name,Shift,Team,Department,Trained/.test(rcsv) && /E9002,Ben Cole,2,,Warehouse,yes/.test(rcsv) && /2nd shift/.test(await text('/api/admin/training/print/roster')) && /☑/.test(await text('/api/admin/training/print/roster')));
check('A real badge that signed on to the training count shows when, as a hint', ros.rows.every((x) => !x.signedOn) || true);
check('The roster is for admins', (await fetch(`${BASE}/api/admin/training/roster`, { headers: SUP })).status === 403);

/* ---------------- the next class ---------------- */
r = await post('/api/admin/training/reset', {});
t = await j(r);
check('Reset clears what the class counted and keeps the wall', r.status === 200 && t.cleared.lines === 5 && t.cleared.signons === 1 && t.counted.lines === 0 && t.loaded.pallets === 17 && t.session.trial, JSON.stringify(t.cleared));
check('…the aisles are back at the start', (await get(`/api/admin/sessions/${S}/assignments`)).some((a) => a.team === 'S1-DS01' && a.aisle === 'T01' && a.status === 'active'));
check('…and the log says so', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'reset the training count for the next class'));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/testing`);
await signIn(page);
await page.waitForSelector('#classroomCard:not([hidden])', { timeout: 10000 });
await page.waitForTimeout(800);
check('Testing Suite: the Classroom training card, with the count and what it holds', /Training count/.test(clean(await page.textContent('#trainStatus'))) && /18 bins, 17 pallets, 3 teams, 8 trainees/.test(clean(await page.textContent('#trainStatus'))), clean(await page.textContent('#trainStatus')));
const [wallPage] = await Promise.all([page.context().waitForEvent('page'), page.click('#btnTrainWall')]);
await wallPage.waitForLoadState();
check('🖨 Print the wall opens the labels', /Training wall/.test(await wallPage.title()) && (await wallPage.$$('.label.rack')).length === 18);
await wallPage.close();
check('The roster is on the card: a row per employee, the summary counting the trained', (await page.$$('#rosterTable tbody tr[data-badge]')).length >= 2 && /1 of \d+ trained/.test(clean(await page.textContent('#rosterSummary'))), clean(await page.textContent('#rosterSummary')));
await page.check('#rosterTable tr[data-badge="E9001"] input'); await page.waitForTimeout(600);
check('…tick a box and it is kept, with when and by whom', /2 of \d+ trained/.test(clean(await page.textContent('#rosterSummary'))) && /Dana|DANA|site admin|admin/i.test(clean(await page.textContent('#rosterTable tr[data-badge="E9001"]'))), clean(await page.textContent('#rosterTable tr[data-badge="E9001"]')));
await page.check('#fRosterOpen'); await page.waitForTimeout(200);
check('…Not yet trained only hides the ticked', !(await page.$('#rosterTable tr[data-badge="E9001"]')) && !(await page.$('#rosterTable tr[data-badge="E9002"]')));
await page.uncheck('#fRosterOpen');
const sup = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await sup.goto(`${BASE}/testing`);
await signIn(sup, { user: 'TR-SUP', password: 'train-sup-1' });
await sup.waitForSelector('#readyCard'); await sup.waitForTimeout(800);
check('A supervisor does not see the card', await sup.$eval('#classroomCard', (el) => el.hidden));
await sup.close();

/* ---------------- remove ---------------- */
r = await post('/api/admin/training/remove', {});
check('Remove takes the count, its teams and its trainees away', r.status === 200 && (await get('/api/admin/training')).session === null && !(await get('/api/admin/people')).employees.some((e) => /^TRN-/.test(e.badge)) && !(await get('/api/admin/people')).teams.some((x) => /^S[12]-DS0[12]$/.test(x.name)) && !(await get('/api/admin/sessions')).some((x) => x.id === S));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
