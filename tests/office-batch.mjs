/*
 * The office side of this round:
 *
 *   - front-placed bins for cycle counts: a list, a download, a batch;
 *   - one export with everything in it, readable;
 *   - adjustments as positive and negative;
 *   - a trial run: counted for real, cleared for real, and forgotten by the guns.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) })).json()).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p, h = A) => (await fetch(BASE + p, { headers: h })).json();
const post = async (p, body = {}, h = A) => (await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();
const postRaw = (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });

/* ================= front-placed bins ================= */
const cyc = await post('/api/admin/sessions', { name: 'Cycle programme', mode: 'cycle' });
const binRows = [];
for (const a of ['F01', 'F02']) for (const lvl of ['A', 'B']) for (let n = 1; n <= 6; n++) {
  const pos = String(n).padStart(3, '0');
  binRows.push(`${a}${lvl}${pos},Freezer,${a},"Frozen Rack, Level: ${lvl}, Position # ${pos} -  ${n % 2 ? 'Front' : 'Back'}"`);
}
await fetch(`${BASE}/api/admin/sessions/${cyc.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle,Description\n' + binRows.join('\n') + '\n' });
const front = await get(`/api/admin/sessions/${cyc.id}/cycle/bins?face=front`);
check('The front-placed bins are the ones the bin list says face front', front.count === 12 && front.bins.every((b) => b.face === 'front' && Number(b.code.slice(-3)) % 2 === 1),
  `${front.count}: ${front.bins.slice(0, 4).map((b) => b.code).join(',')}`);
const f01a = await get(`/api/admin/sessions/${cyc.id}/cycle/bins?face=front&aisle=F01&levels=A`);
check('…narrowed by aisle and level', f01a.count === 3 && f01a.bins.map((b) => b.code).join(',') === 'F01A001,F01A003,F01A005', f01a.bins.map((b) => b.code).join(','));
const back = await get(`/api/admin/sessions/${cyc.id}/cycle/bins?face=back`);
check('Back bins are the rest', back.count === 12 && back.bins.every((b) => b.face === 'back'));
const csvText = await (await fetch(`${BASE}/api/admin/sessions/${cyc.id}/cycle/bins?face=front&format=csv`, { headers: A })).text();
check('The list downloads as a CSV with plain headings', /^\uFEFF?Bin,Zone,Aisle,Level,Face,Last counted,Cycle task open/.test(csvText) && csvText.includes('F01A001,FREEZER,F01,A,Front,never,No'),
  csvText.split('\n').slice(0, 2).join(' | '));
const prev = await post(`/api/admin/sessions/${cyc.id}/cycle/preview`, { target: 100, face: 'front' });
check('A cycle batch can be limited to front bins', prev.available === 12 && prev.picked.every((b) => Number(b.code.slice(-3)) % 2 === 1));
const made = await post(`/api/admin/sessions/${cyc.id}/cycle/batches`, { target: 100, face: 'front', aisle: 'F02' });
check('…and generated from them', made.created === 6, `${made.created}`);
const afterBatch = await get(`/api/admin/sessions/${cyc.id}/cycle/bins?face=front&aisle=F02`);
check('The list then shows those bins have a cycle task open', afterBatch.bins.every((b) => b.open_task));

/* the drawing decides when the description does not say */
const plain = await post('/api/admin/sessions', { name: 'Plain list', mode: 'cycle' });
await post(`/api/admin/sessions/${plain.id}/settings`, { layout: 'front-royal' });
await fetch(`${BASE}/api/admin/sessions/${plain.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF05A001,Freezer,F05\nF05A002,Freezer,F05\nF05A003,Freezer,F05\n' });
const byDrawing = await get(`/api/admin/sessions/${plain.id}/cycle/bins?face=front`);
check('Where the list does not say, the site drawing does (odd positions front)', byDrawing.bins.map((b) => b.code).join(',') === 'F05A001,F05A003', byDrawing.bins.map((b) => b.code).join(','));

/* ================= which counts the scanners see ================= */
{
  const hid = await post('/api/admin/sessions', { name: 'Still being set up' });
  const d = await post('/api/admin/devices', { name: 'SHOW-01' });
  const G = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${d.uid}`, {}, hdr)).token };
  check('A new count is shown on the scanners to start with', (await get('/api/sessions', G)).some((s) => s.id === hid.id));
  await post(`/api/admin/sessions/${hid.id}/settings`, { showOnGuns: false });
  check('Unticking "Show on the scanners" takes it off their list', !(await get('/api/sessions', G)).some((s) => s.id === hid.id));
  check('…while the dashboards still have it, marked', (await get('/api/admin/sessions')).find((s) => s.id === hid.id).show_on_guns === 0);
  await post(`/api/admin/sessions/${hid.id}/settings`, { showOnGuns: true });
  check('…and ticking it puts it back', (await get('/api/sessions', G)).some((s) => s.id === hid.id));
}

/* ================= a full count, run as a trial ================= */
const sess = await post('/api/admin/sessions', { name: 'Q4 wall-to-wall' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle,Description,Last Phys. Invt. Date\nF01A001,Freezer,F01,,2026-01-15\nF01A002,Freezer,F01,,2026-01-15\nF01A003,Freezer,F01,,2026-01-15\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nQ-1,SKU-1,Chicken,40,F01A001\nQ-2,SKU-2,Peas,30,F01A002\nQ-3,SKU-3,Corn,20,F01A003\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { askComments: false, askLot: false, askExpiry: false });
await post(`/api/admin/sessions/${sess.id}/assignments`, { team: '5', aisles: ['F01'], levels: 'A-F', force: true });
const trialOn = await post(`/api/admin/sessions/${sess.id}/trial`, { on: true });
check('A count can be made a trial run', trialOn.session.trial === 1);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const dev = await post('/api/admin/devices', { name: 'TRIAL-01' });
const gctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await gctx.newPage();
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept().catch(() => {}));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
await gun.selectOption('#fSession', String(sess.id)).catch(() => {});
await gun.fill('#fTeam', '5'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E5'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrAssign.active', { timeout: 8000 });
check('The gun says TRIAL RUN', await gun.isVisible('#chipTrial'));
await gun.click('#btnCount');
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
await scan('Q-1'); await scan('38'); await scan('F01A001');
await scan('Q-2'); await scan('30'); await scan('F01A002');
await wait(2500);
let prog = await get(`/api/admin/sessions/${sess.id}/progress`);
check('A trial counts like the real thing', prog.lines === 2, `${prog.lines} lines`);
const erp = await postRaw(`/api/admin/sessions/${sess.id}/erp/pallet-lines.csv`, {}).catch(() => null);
const erpGet = await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/pallet-lines.csv`, { headers: A });
check('…but nothing can be sent to the ERP during a trial', erpGet.status === 409 && /trial run/.test((await erpGet.json()).error), String(erpGet.status));
const binsDuring = (await get(`/api/admin/sessions/${sess.id}/export/everything`)).sheets.find((s) => s.name === 'Bins').rows;
check('…and a trial leaves the cycle-count clock where the ERP put it', binsDuring.find((b) => b.Bin === 'F01A001')['Last counted'] === '2026-01-15',
  binsDuring.find((b) => b.Bin === 'F01A001')['Last counted']);
const board = await get(`/api/board?session=${sess.id}`);
check('The office board says it is a trial', board.session.trial === true);

/* a line the gun scans now but cannot send until after the clear */
await gctx.setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await scan('Q-3'); await scan('20'); await scan('F01A003');
const queued = await gun.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('invcount'); r.onsuccess = () => { const t = r.result.transaction('lines').objectStore('lines').getAll(); t.onsuccess = () => res(t.result.filter((l) => !l.synced).length); };
}));
check('(a trial line is left waiting on a gun with no signal)', queued === 1, `${queued}`);

/* ---- the dashboard ---- */
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('CLEAR') : d.accept()).catch(() => {}));
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
check('The dashboard shows TRIAL RUN above every tab', await page.isVisible('#trialBanner'));
{
  const sp = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await sp.goto(BASE + '/settings#start'); await signIn(sp);
  await sp.selectOption('#fSessionPick', String(sess.id)); await sp.waitForTimeout(800);
  check('…and Settings → Count setup offers to end it', await sp.isVisible('#btnTrialEnd') && await sp.isHidden('#btnTrialOn'));
  await sp.close();
}

/* positive and negative, while we are here: Q-1 is 2 short */
await page.waitForTimeout(800);
check('Adjustments show positive and negative side by side', clean(await page.textContent('#pnMinusUnits')) === '-2' && clean(await page.textContent('#pnPlusUnits')) === '0',
  `${await page.textContent('#pnPlusUnits')} / ${await page.textContent('#pnMinusUnits')}`);
await page.click('#pnTiles button[data-side="negative"]');
await page.waitForTimeout(300);
const negRows = await page.$$eval('#pnTable tbody tr', (trs) => trs.map((tr) => tr.textContent));
check('…and a click on Negative lists what comes off', negRows.length === 1 && /Q-1/.test(negRows[0]) && /Less than the report/.test(negRows[0]), negRows.join(' | '));

/* export everything */
const ev = await get(`/api/admin/sessions/${sess.id}/export/everything`);
const names = ev.sheets.map((s) => s.name);
check('Export everything has a sheet for every table', ['Summary', 'Count lines', 'Pallets', 'Adjustments', 'Bins', 'Bins not counted', 'Teams', 'Sign-ons', 'SOS', 'Stopped scanning', 'Second counts', 'Log'].every((n) => names.includes(n)), names.join(', '));
const lines = ev.sheets.find((s) => s.name === 'Count lines');
check('…with headings in plain words', ['Scanned', 'Team', 'Bin', 'Pallet', 'Quantity', 'Empty bin', 'Pallet not on report'].every((h) => lines.columns.includes(h)));
const l1 = lines.rows.find((r) => r.Pallet === 'Q-1');
check('…Yes and No rather than 1 and 0', l1 && l1['Empty bin'] === 'No' && l1['Voided'] === 'No');
check('…times on the warehouse clock, as a date and a time', l1 && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(l1.Scanned), l1 && l1.Scanned);
check('…the item filled in from the report, though the gun counted blind', l1 && l1.Item === 'SKU-1');
const summary = Object.fromEntries(ev.sheets.find((s) => s.name === 'Summary').rows.map((r) => [r.What, r.Value]));
check('The summary reads like a report', summary['Count'] === 'Q4 wall-to-wall' && summary['Trial run'] === 'Yes' && summary['Bins counted'] === 2, JSON.stringify(summary).slice(0, 160));
await page.evaluate(() => window.appApi.showSub('reports'));
await page.waitForTimeout(500);
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#btnExportAll')]);
const file = await download.path();
const bytes = readFileSync(file);
check('The button downloads an Excel workbook', /\.xlsx$/.test(download.suggestedFilename()) && bytes.slice(0, 2).toString() === 'PK', download.suggestedFilename());

/* ---- ending the trial: under Settings → Count setup ---- */
const sp2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
sp2.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('CLEAR') : d.accept()).catch(() => {}));
await sp2.goto(BASE + '/settings#start'); await signIn(sp2);
await sp2.selectOption('#fSessionPick', String(sess.id)); await sp2.waitForTimeout(800);
await sp2.click('#btnTrialEnd');
await sp2.waitForTimeout(1500);
check('Ending the trial asks for CLEAR, then clears it', /Trial run cleared: 2 lines/.test(clean(await sp2.textContent('#trialMsg'))), clean(await sp2.textContent('#trialMsg')));
await sp2.close();
await page.reload(); await page.waitForSelector('#scrMain.active'); await pickSession(page, sess.id); await page.waitForTimeout(1200);
prog = await get(`/api/admin/sessions/${sess.id}/progress`);
check('Every line is gone', prog.lines === 0);
const asg = await get(`/api/admin/sessions/${sess.id}/assignments`);
check('The bin list, the report and the team plan stay — the aisle back at the start', prog.bins_total === 3 && prog.pallets_total === 3 && asg.length === 1 && asg[0].status === 'active');
check('The count is no longer a trial', !(await get('/api/admin/sessions')).find((s) => s.id === sess.id).trial);
check('The banner goes', await page.isHidden('#trialBanner'));
check('ERP export works again', (await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/pallet-lines.csv`, { headers: A })).status === 200);

/* ---- the gun forgets ---- */
await gctx.setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
let told = false;
for (let t = 0; t < 30000 && !told; t += 1000) {
  await wait(1000);
  told = /trial run was cleared/.test(await gun.textContent('#scanMsg'));
}
check('The gun is told the trial was cleared', told, clean(await gun.textContent('#scanMsg')));
check('…and drops the TRIAL RUN chip', await gun.isHidden('#chipTrial'));
const left = await gun.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('invcount'); r.onsuccess = () => { const t = r.result.transaction('lines').objectStore('lines').getAll(); t.onsuccess = () => res(t.result.length); };
}));
check('…and forgets every trial line, sent or not', left === 0, `${left} left`);
prog = await get(`/api/admin/sessions/${sess.id}/progress`);
check('The line it scanned during the trial and sent late was dropped by the server', prog.lines === 0, `${prog.lines}`);
await scan('Q-1');
check('A pallet counted in the trial is not "already counted" on the real count', /QUANTITY/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await scan('40'); await scan('F01A001');
await wait(2500);
prog = await get(`/api/admin/sessions/${sess.id}/progress`);
check('The real count starts counting', prog.lines === 1);

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} office checks passed`);
process.exit(failed ? 1 : 0);
