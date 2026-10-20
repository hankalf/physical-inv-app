/*
 * Third counts, and the second and third counts side by side with the first.
 *
 * A second count that agrees with the first confirms the difference; one that
 * agrees with the report says the first count was wrong. One that agrees with
 * neither settles nothing - with the count's Third count option on, that bin
 * is counted a third time, by a team that did neither, and the third count
 * stands. A supervisor can ask for one by hand. The export lays every bin
 * counted again out on one row a pallet: report, 1st, 2nd, 3rd, final.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

const BINS = Array.from({ length: 6 }, (_, i) => `F01A${String(i + 1).padStart(3, '0')}`);
const s = await j(await post('/api/admin/sessions', { name: 'Third count week' }));
const S = s.id;
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + [...BINS, 'F02A001'].map((b) => `${b},Freezer,${b.slice(0, 3)}`).join('\n') + '\n', csv);
await post(`/api/admin/sessions/${S}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\n' + BINS.map((b, i) => `P-${i + 1},S${i},Mango,40,${b}`).join('\n') + '\nP-9,S9,Peas,30,F02A001\n', csv);
const d = await j(await post('/api/admin/devices', { name: 'THIRD-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${d.uid}`, {}, hdr))).token };
let n = 0;
const line = (pallet, qty, bin, team, extra = {}) => ({ clientId: `t${++n}`, palletId: pallet, qty, location: bin, team, deviceId: 'THIRD-01', scannedAt: new Date().toISOString(), ...extra });
const send = async (rows) => j(await post(`/api/sessions/${S}/counts`, rows, G));
const tasks = async () => get(`/api/admin/sessions/${S}/recounts`);
const taskFor = async (bin, round = 2) => (await tasks()).find((t) => t.bin === bin && Number(t.round) === round);
const gunTasks = async (team) => (await get(`/api/sessions/${S}/recounts?team=${team}`, G)).tasks;

/* first counts by team 1: three bins off the report */
await send([line('P-1', 35, 'F01A001', '1'), line('P-2', 31, 'F01A002', '1'), line('P-3', 33, 'F01A003', '1'), line('P-4', 40, 'F01A004', '1')]);
check('First counts that disagree with the report raise second counts, round 2', !!(await taskFor('F01A001')) && !!(await taskFor('F01A002')) && !!(await taskFor('F01A003')) && !(await taskFor('F01A004')));
check('…a second count is never offered to the team that did the first', !(await gunTasks('1')).length && (await gunTasks('2')).length === 3);

/* the option is off: a second count that settles nothing stays as it is */
const t1 = await taskFor('F01A001');
await post(`/api/sessions/${S}/recounts/${t1.id}/take`, { team: '2' }, G);
await send([line('P-1', 37, 'F01A001', '2', { pass: 2, recountId: t1.id })]);
await post(`/api/sessions/${S}/recounts/${t1.id}/done`, { team: '2' }, G);
check('Third count off: a second count that agrees with neither raises nothing', !(await taskFor('F01A001', 3)));

/* turn it on */
let r = await post(`/api/admin/sessions/${S}/settings`, { thirdCount: true });
check('The count takes the Third count option', r.status === 200 && (await j(r)).third_count === 1);

/* F01A002: second count agrees with the first -> the difference is real, no third */
const t2 = await taskFor('F01A002');
await post(`/api/sessions/${S}/recounts/${t2.id}/take`, { team: '2' }, G);
await send([line('P-2', 31, 'F01A002', '2', { pass: 2, recountId: t2.id })]);
r = await j(await post(`/api/sessions/${S}/recounts/${t2.id}/done`, { team: '2' }, G));
check('A second count that agrees with the first raises no third count', !r.third && !(await taskFor('F01A002', 3)));

/* F01A003: the gun says done before its lines arrive (no signal), then they come in disagreeing with both */
const t3 = await taskFor('F01A003');
await post(`/api/sessions/${S}/recounts/${t3.id}/take`, { team: '2' }, G);
r = await j(await post(`/api/sessions/${S}/recounts/${t3.id}/done`, { team: '2' }, G));
check('Bin done before its lines are in: nothing is judged yet', !r.third && !(await taskFor('F01A003', 3)));
const late = await send([line('P-3', 36, 'F01A003', '2', { pass: 2, recountId: t3.id })]);
const third = await taskFor('F01A003', 3);
check('…when they arrive agreeing with neither the first count (33) nor the report (40), a third count is raised', !!third && late.thirdCounts && late.thirdCounts.created === 1, JSON.stringify(late.thirdCounts));
check('…round 3, remembering both teams, with the numbers for the supervisor', third && third.first_team === '1' && third.second_team === '2' && /first P-3 ×33; second P-3 ×36; report P-3 ×40/.test(third.detail), JSON.stringify(third));
check('…offered to neither team 1 nor team 2, but to team 3, as a third count', !(await gunTasks('1')).some((t) => t.bin === 'F01A003') && !(await gunTasks('2')).some((t) => t.bin === 'F01A003')
  && (await gunTasks('3')).some((t) => t.bin === 'F01A003' && t.round === 3 && /^Third count — /.test(t.reason)));
r = await post(`/api/sessions/${S}/recounts/${third.id}/take`, { team: '2' }, G);
check('…and team 2 cannot take it', r.status === 409 && /third team/.test((await j(r)).error));
await post(`/api/sessions/${S}/recounts/${third.id}/take`, { team: '3' }, G);
// an older gun that only knows "second count": the task makes it a third count all the same
await send([line('P-3', 34, 'F01A003', '3', { pass: 2, recountId: third.id })]);
await post(`/api/sessions/${S}/recounts/${third.id}/done`, { team: '3' }, G);
const csvText = await (await fetch(`${BASE}/api/admin/sessions/${S}/export/counts.csv`, { headers: A })).text();
const [head, ...body] = csvText.trim().split(/\r?\n/);
const cols = head.split(',');
const rows = body.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]))).map((c) => ({ ...c, pass: Number(c.pass), qty: Number(c.qty) }));
check('Lines counted for a third-count task are filed as the third count', rows.some((c) => c.location_code === 'F01A003' && c.pass === 3 && c.qty === 34), JSON.stringify(rows.filter((c) => c.location_code === 'F01A003').map((c) => [c.pass, c.qty])));
const report = await get(`/api/admin/sessions/${S}/pallets`);
const plist = Array.isArray(report) ? report : (report.rows || report.pallets || []);
const p3 = plist.find((x) => x.pallet_id === 'P-3');
check('The third count stands: the pallet report shows 34, with the first (33) and second (36) beside it', p3 && Number(p3.counted_qty) === 34 && Number(p3.first_count_qty) === 33 && Number(p3.second_count_qty) === 36 && p3.count_round === 3, JSON.stringify(p3 && [p3.counted_qty, p3.first_count_qty, p3.second_count_qty, p3.count_round]));
check('…and the second count is not raised again for it', !(await tasks()).some((t) => t.bin === 'F01A003' && t.status !== 'done'));

/* by hand: F01A001's second count (done before the option) gets a third */
r = await post(`/api/admin/sessions/${S}/recounts/${t1.id}/third`, {});
let out = await j(r);
check('A supervisor raises a third count by hand on a finished second count', r.status === 200 && out.created && /neither/.test(out.why), JSON.stringify(out));
r = await post(`/api/admin/sessions/${S}/recounts/${t1.id}/third`, {});
check('…once: a second ask finds it open', (await j(r)).created === false);
const t1b = await taskFor('F01A002');
r = await post(`/api/admin/sessions/${S}/recounts/${(await taskFor('F01A003', 3)).id}/third`, {});
check('…not on a third count itself', r.status === 409);
const open2 = await taskFor('F01A002');
check('(the agreeing one is done)', open2.status === 'done' && t1b.id === open2.id);

/* the export, side by side */
const sbs = await get(`/api/admin/sessions/${S}/export/recounts-side-by-side`);
const row = (bin) => sbs.sheets[1].rows.find((x) => x.Bin === bin);
check('Export 2nd & 3rd counts: one row per pallet for every bin counted again', sbs.sheets.map((x) => x.name).join('|') === 'Summary|Side by side' && sbs.sheets[1].rows.length === 3, JSON.stringify(sbs.sheets[1].rows.map((x) => x.Bin)));
const a3 = row('F01A003');
check('…report, 1st, 2nd and 3rd counts, each with its team, and the final', a3['Report quantity'] === 40 && a3['1st count'] === 33 && a3['1st count team'] === '1' && a3['2nd count'] === 36 && a3['2nd count team'] === '2'
  && a3['3rd count'] === 34 && a3['3rd count team'] === '3' && a3['Final count'] === 34 && a3['Final count is the'] === '3rd count' && a3['Final vs report'] === -6 && a3['Which number stands'] === 'The third count stands', JSON.stringify(a3));
const a2 = row('F01A002');
check('…a second count that agreed with the first says so, and the 2nd count is final', a2['Final count'] === 31 && a2['Final count is the'] === '2nd count' && a2['3rd count'] === '' && /agrees with the first/.test(a2['Which number stands']));
const a1 = row('F01A001');
check('…one waiting on its third count says so', /Waiting for the third count/.test(a1['Which number stands']) && a1.State === 'Open', JSON.stringify(a1));
const sum = Object.fromEntries(sbs.sheets[0].rows.map((x) => [x.What, x.Value]));
check('…with a summary of how each was settled', sum['Bins counted again'] === 3 && sum['…of them given a third count'] === 2 && sum['Settled by a third count'] === 1, JSON.stringify(sum));
const one = await get(`/api/admin/sessions/${S}/export/recounts-side-by-side?aisle=F02`);
check('…and one aisle on its own', one.sheets[1].rows.length === 0 && /-F02-/.test(one.filename));
const ev = await get(`/api/admin/sessions/${S}/export/everything`);
check('Export everything carries it too, and marks third-count lines', ev.sheets.some((x) => x.name === 'Counts side by side' && x.rows.length === 3) && ev.sheets.find((x) => x.name === 'Count lines').rows.some((x) => x['Third count'] === 'Yes'));

/* ------------------------------------------------------------------ the pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#start`);
await signIn(page);
await pickSession(page, S);
await page.waitForTimeout(800);
check('Settings → Count session has the Third count option, ticked for this count', await page.isChecked('#fThirdCount'));
await page.goto(`${BASE}/admin#second`);
await page.waitForSelector('#scrMain.active');
await page.addStyleTag({ content: '[data-sub] { display: block !important; }' });
await pickSession(page, S);
await page.waitForSelector(`#recountTable tr[data-recount="${third.id}"]`);
check('Second counts: a third count is marked as one, with both earlier teams', /3rd count/.test(clean(await page.textContent(`#recountTable tr[data-recount="${third.id}"]`))) && /2nd 2/.test(clean(await page.textContent(`#recountTable tr[data-recount="${third.id}"]`))));
check('…a 3rd count column', (await page.$$eval('#recountTable thead th', (t) => t.map((x) => x.textContent))).includes('3rd count'));
check('…and a 3rd count button only on finished second counts that have none', (await page.locator(`#recountTable button[data-third="${t2.id}"]`).count()) === 1 && (await page.locator(`#recountTable button[data-third="${t1.id}"]`).count()) === 0);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportSideBySide')]);
const sandbox = { window: {}, self: {}, console };
vm.runInNewContext(readFileSync(new URL('../public/vendor/xlsx.full.min.js', import.meta.url), 'utf8'), sandbox);
const XLSX = sandbox.XLSX || sandbox.window.XLSX || sandbox.self.XLSX;
const wb = XLSX.read(readFileSync(await dl.path()), { type: 'buffer' });
check('Export 2nd & 3rd counts with the 1st downloads the workbook', /second-and-third-counts/.test(dl.suggestedFilename()) && wb.SheetNames.join('|') === 'Summary|Side by side' && XLSX.utils.sheet_to_json(wb.Sheets['Side by side']).length === 3, dl.suggestedFilename());
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
