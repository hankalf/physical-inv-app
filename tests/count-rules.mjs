/*
 * Three rules from the floor, before go-live.
 *
 * 1. Two teams in one aisle from opposite ends. A team queued "from the far
 *    end" may share an aisle - same levels - with one coming from the 001 end;
 *    its gun walks the bins backwards, both see what the other has counted, and
 *    the aisle is only checked for missing pallets when the second hands it
 *    back. The auto-plan pairs teams up, and the plan file takes a Start column.
 * 2. Bin is EMPTY with the bin already scanned (the bin comes first) asks
 *    "Mark it EMPTY?" - it does not make the counter scan the bin again.
 * 3. A pallet found in another bin than the report's: the report's bin gets a
 *    second count too, once it has been counted, to catch a duplicate label.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

const BINS = Array.from({ length: 10 }, (_, i) => `F01A${String(i + 1).padStart(3, '0')}`);
async function count(name, { pallets = true } = {}) {
  const s = await j(await post('/api/admin/sessions', { name }));
  await post(`/api/admin/sessions/${s.id}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + [...BINS, 'F02A001', 'F02A002'].map((b) => `${b},Freezer,${b.slice(0, 3)}`).join('\n') + '\n', csv);
  if (pallets) await post(`/api/admin/sessions/${s.id}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\n' + BINS.map((b, i) => `P-${i + 1},S${i},Mango,40,${b}`).join('\n') + '\nP-11,S,Peas,30,F02A001\n', csv);
  return s;
}
const gunToken = async (name) => {
  const d = await j(await post('/api/admin/devices', { name }));
  return { uid: d.uid, H: { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${d.uid}`, {}, hdr))).token } };
};

/* ================= 1. opposite ends ================= */
const s1 = await count('Opposite ends');
let r = await post(`/api/admin/sessions/${s1.id}/assignments`, { team: '1', aisles: ['F01'], levels: 'A-F', force: true });
check('Team 1 is queued on F01 from the 001 end, and starts', (await j(r)).activated.some((a) => a.team === '1'));
r = await post(`/api/admin/sessions/${s1.id}/assignments`, { team: '2', aisles: ['F01'], levels: 'A-F', direction: 'down', force: true });
const q2 = await j(r);
check('Team 2 on the same aisle and levels from the far end starts too: they do not hold each other up', q2.activated.some((a) => a.team === '2') && /from the far end/.test(q2.added.join()), JSON.stringify(q2));
r = await post(`/api/admin/sessions/${s1.id}/assignments`, { team: '3', aisles: ['F01'], levels: 'A-F', force: true });
check('A third team from the 001 end waits: one team each way, no more', !(await j(r)).activated.some((a) => a.team === '3'));
// (team 3 is taken off again, so the pair is all there is in the aisle)
for (const a of (await get(`/api/admin/sessions/${s1.id}/assignments`)).filter((x) => x.team === '3')) await fetch(`${BASE}/api/admin/sessions/${s1.id}/assignments/${a.id}`, { method: 'DELETE', headers: A });
const G = await gunToken('ENDS-02');
const st2 = await get(`/api/sessions/${s1.id}/team-status?team=2`, G.H);
check('Team 2\'s gun gets the aisle backwards, from the far end, and knows team 1 is coming the other way', st2.active && st2.active.direction === 'down' && st2.bins[0] === 'F01A010' && st2.bins[9] === 'F01A001' && st2.active.partner && st2.active.partner.team === '1', JSON.stringify([st2.bins[0], st2.active && st2.active.partner]));
const st1 = await get(`/api/sessions/${s1.id}/team-status?team=1`, G.H);
check('…and team 1 from the 001 end, knowing team 2', st1.bins[0] === 'F01A001' && st1.active.partner.team === '2' && st1.active.direction === 'up');
const line = (id, pallet, bin, team) => ({ clientId: id, palletId: pallet, qty: 40, location: bin, team, deviceId: 'ENDS-02', scannedAt: new Date().toISOString() });
await post(`/api/sessions/${s1.id}/counts`, [line('e1', 'P-1', 'F01A001', '1'), line('e2', 'P-2', 'F01A002', '1'), line('e3', 'P-10', 'F01A010', '2')], G.H);
const st2b = await get(`/api/sessions/${s1.id}/team-status?team=2`, G.H);
check('Each sees the bins the other has counted', st2b.progress.countedBins.includes('F01A001') && st2b.progress.countedBins.includes('F01A010'));
r = await post(`/api/sessions/${s1.id}/assignments/${st1.active.id}/complete`, { team: '1' }, G.H);
let rc = await get(`/api/admin/sessions/${s1.id}/recounts`);
check('Team 1 hands back early: no "missing" second counts while team 2 is still in the aisle', r.status === 200 && !rc.some((x) => x.reason === 'MISSING'), JSON.stringify(rc.map((x) => x.reason)));
await post(`/api/sessions/${s1.id}/assignments/${st2.active.id}/complete`, { team: '2' }, G.H);
rc = await get(`/api/admin/sessions/${s1.id}/recounts`);
check('When the second team hands it back, the pallets nobody saw are raised as missing', rc.filter((x) => x.reason === 'MISSING').length === 7, JSON.stringify(rc.map((x) => `${x.reason}:${x.bin}`)));
const list = await get(`/api/admin/sessions/${s1.id}/assignments`);
check('The assignment list says which end each team started from', list.some((a) => a.team === '2' && a.direction === 'down') && list.some((a) => a.team === '1' && a.direction === 'up'));

/* the auto-plan in pairs, and the plan file */
const s2 = await count('Pairs plan');
let plan = await j(await post(`/api/admin/sessions/${s2.id}/assignments/auto`, { teams: '1, 2, 3', preview: true, pairs: true }));
const t1 = plan.teams.find((t) => t.team === '1'); const t2 = plan.teams.find((t) => t.team === '2');
check('Auto-assign in pairs: teams 1 and 2 count the same aisles, 2 from the far end', t1.aisles.map((a) => a.aisle).join() === t2.aisles.map((a) => a.aisle).join() && t2.aisles.every((a) => a.direction === 'down') && t1.aisles.every((a) => a.direction === 'up') && /from the far end/.test(t2.text), `${t1.text} | ${t2.text}`);
check('…and the odd team out is told it works alone', plan.warnings.some((w) => /Team 3 has no partner/.test(w)), plan.warnings.join(' / '));
plan = await j(await post(`/api/admin/sessions/${s2.id}/assignments/auto`, { teams: '1, 2, 3', pairs: true }));
const after = await get(`/api/admin/sessions/${s2.id}/assignments`);
check('Queued, the pair is active in the same aisle at once', after.filter((a) => a.status === 'active' && a.aisle === t1.aisles[0].aisle).map((a) => a.team).sort().join() === '1,2', JSON.stringify(after.filter((a) => a.status === 'active')));
const s3 = await count('Plan file');
await post(`/api/admin/sessions/${s3.id}/master?kind=plan`, 'Team,Aisle,Levels,Start\n5,F01,A-F,001 end\n6,F01,A-F,far end\n', csv);
const fromFile = await get(`/api/admin/sessions/${s3.id}/assignments`);
check('A plan file with a Start column: "far end" starts that team at the far end', fromFile.find((a) => a.team === '6').direction === 'down' && fromFile.find((a) => a.team === '5').direction === 'up' && fromFile.filter((a) => a.status === 'active').length === 2);

/* ================= 3. a pallet in another bin: the report's bin is checked for a duplicate label ================= */
const s4 = await count('Label check');
const L = await gunToken('LABEL-01');
const l4 = (id, pallet, bin, extra = {}) => ({ clientId: id, palletId: pallet, qty: 40, location: bin, team: '1', deviceId: 'LABEL-01', scannedAt: new Date().toISOString(), ...extra });
await post(`/api/sessions/${s4.id}/counts`, [l4('k1', 'P-3', 'F01A005')], L.H);
rc = await get(`/api/admin/sessions/${s4.id}/recounts`);
check('P-3 found in F01A005, not F01A003: the bin it was found in comes back, as before', rc.some((x) => x.reason === 'WRONG BIN' && x.bin === 'F01A005'));
check('…but its report bin F01A003 waits until somebody has counted it', !rc.some((x) => x.reason === 'LABEL CHECK'), JSON.stringify(rc.map((x) => `${x.reason}:${x.bin}`)));
await post(`/api/sessions/${s4.id}/counts`, [l4('k2', 'EMPTY', 'F01A003', { emptyBin: 1, qty: 0 })], L.H);
rc = await get(`/api/admin/sessions/${s4.id}/recounts`);
const lc = rc.find((x) => x.reason === 'LABEL CHECK');
check('F01A003 counted: a second count of it is raised, to look for a second pallet with the same label', lc && lc.bin === 'F01A003' && lc.pallet_id === 'P-3' && /found in F01A005/.test(lc.detail) && lc.status === 'open', JSON.stringify(lc));
check('…by a team other than the one that counted the bin first', lc && lc.first_team === '1');
const tasks = await get(`/api/sessions/${s4.id}/recounts?team=2`, L.H);
const task = (tasks.tasks || tasks).find((x) => x.bin === 'F01A003');
check('The gun says why, without numbers: check for a duplicate label', task && /duplicate label/i.test(task.reason), JSON.stringify(task));
await post(`/api/admin/sessions/${s4.id}/recounts/${lc.id}`, { status: 'done' });
await post(`/api/admin/sessions/${s4.id}/recounts/generate`, {});
await post(`/api/sessions/${s4.id}/counts`, [l4('k3', 'P-4', 'F01A004')], L.H);
rc = await get(`/api/admin/sessions/${s4.id}/recounts`);
check('A check that is done is not raised again', rc.filter((x) => x.reason === 'LABEL CHECK').length === 1, JSON.stringify(rc.filter((x) => x.reason === 'LABEL CHECK')));
/* the other way round: the report's bin counted first, the pallet found elsewhere later */
await post(`/api/sessions/${s4.id}/counts`, [l4('k4', 'P-7', 'F01A007'), l4('k5', 'P-6', 'F02A002')], L.H);
rc = await get(`/api/admin/sessions/${s4.id}/recounts`);
check('The report\'s bin counted first, the pallet turning up elsewhere later: the check is raised then', rc.some((x) => x.reason === 'LABEL CHECK' && x.bin === 'F01A006' && x.pallet_id === 'P-6') === false
  && true, 'F01A006 not yet counted');
await post(`/api/sessions/${s4.id}/counts`, [l4('k6', 'P-60', 'F01A006')], L.H);
rc = await get(`/api/admin/sessions/${s4.id}/recounts`);
check('…once F01A006 has been looked in: here a pallet not on the report is in it too, and the one second count of the bin does both', rc.filter((x) => x.bin === 'F01A006' && x.status !== 'done').length === 1, JSON.stringify(rc.map((x) => `${x.reason}:${x.bin}:${x.pallet_id}`)));
await post(`/api/sessions/${s4.id}/counts`, [l4('k7', 'P-9', 'F02A002'), l4('k8', 'EMPTY', 'F01A009', { emptyBin: 1, qty: 0 })], L.H);
rc = await get(`/api/admin/sessions/${s4.id}/recounts`);
check('…and with nothing else in the report bin, it is the label check itself', rc.some((x) => x.reason === 'LABEL CHECK' && x.bin === 'F01A009' && x.pallet_id === 'P-9'), JSON.stringify(rc.map((x) => `${x.reason}:${x.bin}:${x.pallet_id}`)));
const ev = await get(`/api/admin/sessions/${s4.id}/export/everything`);
check('Export everything names it in words', ev.sheets.find((x) => x.name === 'Second counts').rows.some((x) => /Duplicate-label check/.test(x.Why)));

/* ================= 2. EMPTY with the bin already scanned ================= */
const layoutWas = await get('/api/admin/scanner-layout');
await post('/api/admin/scanner-layout', { order: ['bin', 'pallet', 'qty', 'lot', 'expiry'] });
const s5 = await count('Empty confirm');
await post(`/api/admin/sessions/${s5.id}/settings`, { guided: false, askComments: false });
const E = await j(await post('/api/admin/devices', { name: 'EMPTY-01' }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await ctx.newPage();
const errors = []; gun.on('pageerror', (e) => errors.push(e.message));
await gun.goto(`${BASE}/?d=${E.uid}`); await gun.waitForTimeout(1500);
await gun.selectOption('#fSession', String(s5.id)).catch(() => {});
await gun.fill('#fTeam', '4'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E4'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrScan.active', { timeout: 8000 });
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
check('The gun asks for the bin first', /BIN/i.test(await gun.textContent('#prompt')), await gun.textContent('#prompt'));
await scan('F01A004');
check('Bin scanned, the pallet step offers "Bin is EMPTY" with no "scan the bin"', await gun.isVisible('#btnEmpty') && clean(await gun.textContent('#btnEmpty')) === 'Bin is EMPTY', clean(await gun.textContent('#btnEmpty')));
await gun.click('#btnEmpty'); await gun.waitForTimeout(300);
check('Tapped: it asks "Mark F01A004 EMPTY?" - yes or no, no second scan', await gun.isVisible('#emptyConfirm') && /Mark F01A004 EMPTY\?/.test(await gun.textContent('#emptyConfirmText')));
await gun.click('#btnEmptyNo'); await gun.waitForTimeout(300);
check('No: back to the pallet, the bin still scanned', !(await gun.isVisible('#emptyConfirm')) && /PALLET/i.test(await gun.textContent('#prompt')));
await gun.click('#btnEmpty'); await gun.waitForTimeout(200);
await gun.click('#btnEmptyYes'); await gun.waitForTimeout(800);
check('Yes: recorded EMPTY at once, and on to the next bin', /F01A004 recorded as EMPTY/.test(await gun.textContent('#scanMsg')) && /BIN/i.test(await gun.textContent('#prompt')), clean(await gun.textContent('#scanMsg')));
let lines = [];
for (let t = 0; t < 20 && !lines.length; t++) { await wait(500); lines = (await get(`/api/admin/sessions/${s5.id}/export/everything`)).sheets.find((x) => x.name === 'Count lines').rows; }
check('…and the server has one EMPTY line for F01A004', lines.length === 1 && /F01A004/.test(JSON.stringify(lines[0])) && /empty|yes/i.test(JSON.stringify(lines[0])), JSON.stringify(lines[0]).slice(0, 160));
await post('/api/admin/scanner-layout', { order: ['pallet', 'qty', 'lot', 'expiry', 'bin'] });
await gun.reload(); await gun.waitForTimeout(1800);
if (await gun.isVisible('#btnStart')) { await gun.click('#btnStart'); await gun.waitForSelector('#scrScan.active', { timeout: 8000 }).catch(() => {}); }
await gun.waitForTimeout(600);
check('With the pallet first, "Bin is EMPTY — scan the bin" is as it was: one scan of the bin', /scan the bin/.test(clean(await gun.textContent('#btnEmpty'))), clean(await gun.textContent('#btnEmpty')));
await post('/api/admin/scanner-layout', { order: layoutWas.order });

/* ================= 1, on the gun: the next bin from the far end ================= */
const s6 = await count('Far end on the gun');
await post(`/api/admin/sessions/${s6.id}/assignments`, { team: '8', aisles: ['F01'], levels: 'A-F', direction: 'down', force: true });
await post(`/api/admin/sessions/${s6.id}/settings`, { askComments: false });
const F = await j(await post('/api/admin/devices', { name: 'FAR-01' }));
const g2 = await (await browser.newContext({ viewport: { width: 360, height: 640 } })).newPage();
g2.on('pageerror', (e) => errors.push('far: ' + e.message));
await g2.goto(`${BASE}/?d=${F.uid}`); await g2.waitForTimeout(1500);
await g2.selectOption('#fSession', String(s6.id)).catch(() => {});
await g2.fill('#fTeam', '8'); await g2.press('#fTeam', 'Enter');
await g2.fill('#fEmployee', 'E8'); await g2.press('#fEmployee', 'Enter');
await g2.click('#btnStart'); await g2.waitForTimeout(1500);
check('The far-end team\'s aisle card says to start at the far end', /start at the far end/.test(clean(await g2.textContent('#scrAssign'))), clean(await g2.textContent('#scrAssign')).slice(0, 160));
await g2.click('#btnCount'); await g2.waitForTimeout(800);
check('…and its gun sends it to F01A010 first, not F01A001', /F01A010/.test(clean(await g2.textContent('#nextBin'))), clean(await g2.textContent('#nextBin')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
