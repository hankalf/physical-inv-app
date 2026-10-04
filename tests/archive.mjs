/*
 * Filed as the count goes.
 *
 * Every aisle a team hands back is written to disk at once as CSV files - its
 * count lines, its pallets, its bins - and the final report, every sheet of
 * Export everything, is offered only when every bin has a count and no second
 * count is open.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = (p) => fetch(BASE + p, { headers: A }).then(j);
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });

const sess = await j(await post('/api/admin/sessions', { name: 'Archive test' }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\nF02A001\nF02A002\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Bin Code,Container No.,Item No.,Description,Quantity,System\nF01A001,A-1,SKU-1,Mango,40,ERP\nF01A002,A-2,SKU-2,Berries,30,ERP\nF02A001,B-1,SKU-3,Cherries,20,ERP\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { autoRecount: true, recountMinQty: 1, recountMinPct: 1, recountCap: 50 });
const a1 = await j(await post(`/api/admin/sessions/${sess.id}/assignments`, { team: '1', aisles: ['F01', 'F02'], levels: 'A-F' }));
check('Two aisles queued on team 1', !a1.error && a1.added && a1.added.length === 2, JSON.stringify(a1).slice(0, 300));
const dev = await j(await post('/api/admin/devices', { name: 'ARCH-01' }));
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const gpost = (p, b) => fetch(BASE + p, { method: 'POST', headers: D, body: JSON.stringify(b) }).then(j);
const signon = await gpost(`/api/sessions/${sess.id}/signon`, { deviceId: 'ARCH-01', team: '1', employees: ['E1'] });
const line = (palletId, qty, location, n) => ({ clientId: `c${n}`, palletId, qty, location, team: '1', employees: ['E1'], deviceId: 'ARCH-01', aisle: location.slice(0, 3), scannedAt: new Date().toISOString(), sentAt: new Date().toISOString() });
await gpost(`/api/sessions/${sess.id}/counts`, [line('A-1', 40, 'F01A001', 1), line('A-2', 25, 'F01A002', 2)]);   // A-2 short: a second count

/* ---------------- an aisle handed back is filed ---------------- */
const asg = (await get(`/api/admin/sessions/${sess.id}/assignments`));
const f01 = (asg.assignments || asg).find((a) => a.aisle === 'F01');
await gpost(`/api/sessions/${sess.id}/assignments/${f01.id}/complete`, { team: '1' });
let arch = await get(`/api/admin/sessions/${sess.id}/archives`);
check('Handing an aisle back files it at once', arch.archives.length === 1 && arch.archives[0].kind === 'aisle' && arch.archives[0].aisle === 'F01', JSON.stringify(arch.archives.map((a) => a.name)));
const files = arch.archives[0].files.map((f) => f.name);
check('…as CSV files: count lines, pallets, bins, second counts, a README', ['count-lines.csv', 'pallets.csv', 'bins.csv', 'second-counts.csv', 'README.txt'].every((f) => files.includes(f)), files.join(' | '));
const dl = await fetch(`${BASE}/api/admin/sessions/${sess.id}/archives/file?folder=${arch.archives[0].name}&file=count-lines.csv`, { headers: A });
const body = await dl.text();
check('…the count lines file has the aisle\'s two lines and nothing else', dl.status === 200 && /A-1/.test(body) && /A-2/.test(body) && body.trim().split('\n').length === 3, `${body.trim().split('\n').length} rows: ${body.slice(0, 300)}`);
const pal = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/archives/file?folder=${arch.archives[0].name}&file=pallets.csv`, { headers: A })).text();
check('…and the pallets file has the aisle\'s pallets, not F02\'s', /A-1/.test(pal) && /A-2/.test(pal) && !/B-1/.test(pal));
const bad = await fetch(`${BASE}/api/admin/sessions/${sess.id}/archives/file?folder=..&file=..%2Finventory.db`, { headers: A });
check('A path that tries to leave the folder is refused', bad.status === 404);
check('The hand-back is in the log', (await get('/api/admin/audit?limit=20')).some((r) => r.action === 'aisle filed' && /F01/.test(r.detail)));

/* ---------------- the final report waits for a whole count ---------------- */
check('The final report is not offered yet: bins to count and a second count open', !arch.readiness.ready && /2 bins still to count/.test(arch.readiness.reasons.join(',')) && /second count/.test(arch.readiness.reasons.join(',')), arch.readiness.reasons.join(' | '));
let r = await post(`/api/admin/sessions/${sess.id}/archives/final`);
check('…and asking for it anyway is refused, saying why', r.status === 409 && /still to count/.test((await j(r)).error), String(r.status));
await gpost(`/api/sessions/${sess.id}/counts`, [line('B-1', 20, 'F02A001', 3), { ...line('', 0, 'F02A002', 4), emptyBin: 1, palletId: '' }]);
arch = await get(`/api/admin/sessions/${sess.id}/archives`);
check('Every bin counted, the second count is what is left', arch.readiness.binsLeft === 0 && arch.readiness.recountsOpen === 1 && !arch.readiness.ready, JSON.stringify(arch.readiness));
const rec = await get(`/api/admin/sessions/${sess.id}/recounts`);
const task = (Array.isArray(rec) ? rec : rec.tasks || rec.recounts || []).find((t) => t.status !== 'done');
check('…the short pallet raised that second count', !!task && task.bin === 'F01A002', JSON.stringify(task || rec).slice(0, 200));
await gpost(`/api/sessions/${sess.id}/recounts/${task.id}/take`, { team: '1' }).catch(() => {});
await gpost(`/api/sessions/${sess.id}/counts`, [{ ...line('A-2', 25, 'F01A002', 5), recountId: task.id, pass: 2 }]);
await gpost(`/api/sessions/${sess.id}/recounts/${task.id}/done`, { team: '1' });
arch = await get(`/api/admin/sessions/${sess.id}/archives`);
check('With the second count done the count is whole', arch.readiness.ready === true, JSON.stringify(arch.readiness));
r = await post(`/api/admin/sessions/${sess.id}/archives/final`);
const fin = await j(r);
check('The final report files every sheet', r.status === 200 && fin.sheets >= 12 && fin.archives.some((a) => a.kind === 'final'), JSON.stringify([r.status, fin.sheets]));
const finalFiles = fin.archives.find((a) => a.kind === 'final').files.map((f) => f.name);
check('…summary, count lines, pallets, adjustments, log among them', ['summary.csv', 'count-lines.csv', 'pallets.csv', 'adjustments.csv', 'log.csv', 'README.txt'].every((f) => finalFiles.includes(f)), finalFiles.join(' | '));

/* ---------------- the card on the dashboard ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
await page.goto(`${BASE}/admin`);
await signIn(page, { user: 'DANA-WHITFIELD' });
await page.waitForTimeout(1500);
const rows = await page.$$eval('#archiveTable tbody tr', (trs) => trs.map((t) => t.textContent));
check('Dashboard → Reports lists what was filed, final report first', rows.length === 2 && /Final report/.test(rows[0]) && /Aisle F01/.test(rows[1]), rows.map((x) => x.slice(0, 60)).join(' | '));
check('…with the final report button on, since the count is whole', !(await page.$eval('#btnFinalReport', (b) => b.disabled)) && /count is whole/.test(await page.textContent('#finalWhy')), clean(await page.textContent('#finalWhy')));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
