/*
 * A pallet with more than one label, the two cases the floor suites do not
 * walk: a site that scans the bin first - the button comes after the bin and
 * the bin is not asked for again - and a second count, where every label on
 * the pallet is counted again in the bin the task is for.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: A.authorization, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* M01A001 holds one pallet carrying two loads, each with its own label */
const S = (await j(await post('/api/admin/sessions', { name: 'Multi-label count' }))).id;
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\nM01A001,Dry,M01\nM01A002,Dry,M01\n', csv);
await post(`/api/admin/sessions/${S}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\nML-1,S1,Beans,10,M01A001\nML-2,S2,Rice,12,M01A001\nML-3,S3,Oats,9,M01A002\n', csv);
await post(`/api/admin/sessions/${S}/assignments`, { team: '7', aisles: 'M01', levels: 'A-F', force: true });   // a guided count: team 7 is on M01
const layoutWas = await get('/api/admin/scanner-layout');
await post('/api/admin/scanner-layout', { order: ['bin', 'pallet', 'qty'] });
const dev = await j(await post('/api/admin/devices', { name: 'MULTI-LBL' }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const gun = await (await browser.newContext({ viewport: { width: 360, height: 640 } })).newPage();
const errors = [];
gun.on('pageerror', (e) => errors.push(e.message));
gun.on('dialog', (d) => d.accept().catch(() => {}));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
await gun.selectOption('#fSession', String(S)).catch(() => {});
await gun.fill('#fTeam', '7'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E7001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrScan.active, #scrAssign.active', { timeout: 8000 });
if (await gun.$('#scrAssign.active')) { await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); }
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
const skip = async () => { if (await gun.isVisible('#btnSkip')) { await gun.click('#btnSkip'); await gun.waitForTimeout(400); } };
const T = (sel) => gun.textContent(sel).then(clean);

/* ---------------- bin first ---------------- */
check('Bin first: the line starts with the bin, and the button is there before it', /Scan BIN LOCATION/.test(await T('#prompt')) && await gun.isVisible('#btnMultiLabel'), await T('#prompt'));
await scan('M01A001');
check('…and still there once the bin is in, before the first pallet', /Scan PALLET ID/.test(await T('#prompt')) && await gun.isVisible('#btnMultiLabel'));
await gun.click('#btnMultiLabel'); await gun.waitForTimeout(300);
check('Tapped with the bin already in: no second bin scan, straight to label 1', /Scan LABEL 1 on this pallet/.test(await T('#prompt')) && /M01A001/.test(await T('#ctx')), await T('#prompt'));
await scan('ML-1'); await scan('10'); await skip();
check('Label 1 in; label 2 asked for in the same bin', /Scan LABEL 2 on this pallet/.test(await T('#prompt')) && /M01A001/.test(await T('#ctx')), await T('#prompt'));
await scan('ML-2'); await scan('12'); await skip();
await gun.click('#btnMultiDone'); await gun.waitForTimeout(400);
check('Done: back to the bin-first order, a new line starting at the bin', /Pallet with 2 labels counted in M01A001/.test(await T('#scanMsg')) && /Scan BIN LOCATION/.test(await T('#prompt')), await T('#scanMsg'));

let rows = [];
for (let i = 0; i < 20 && !(rows.some((r) => r.pallet_id === 'ML-2' && Number(r.counted_qty) === 12)); i++) { await wait(500); rows = (await get(`/api/admin/sessions/${S}/pallets?limit=50`)).rows; }
const r1 = rows.find((r) => r.pallet_id === 'ML-1'); const r2 = rows.find((r) => r.pallet_id === 'ML-2');
check('Both labels counted with their own quantity in M01A001, both matching', r1 && r2 && Number(r1.counted_qty) === 10 && Number(r2.counted_qty) === 12 && r1.status === 'MATCH' && r2.status === 'MATCH',
  JSON.stringify([r1 && [r1.counted_qty, r1.status], r2 && [r2.counted_qty, r2.status]]));

/* Back from label 1, before anything is in, cancels and starts the line again */
await gun.click('#btnMultiLabel'); await gun.waitForTimeout(300);
check('From the very start (no bin yet), it asks for the bin', /Scan the BIN this pallet is in/.test(await T('#prompt')));
await gun.click('#btnBack'); await gun.waitForTimeout(300);
check('Back before anything is in cancels it, nothing recorded', /Scan BIN LOCATION/.test(await T('#prompt')) && await gun.isHidden('#btnMultiDone'));
/* a second label seen late, on a bin-first site: the button is where the line starts - at the bin */
check('Bin first: "Another label on the pallet just counted" is offered at the start of the next line, before the bin', await gun.isVisible('#btnSameLabel') && /ML-2/.test(await T('#btnSameLabel')), await T('#btnSameLabel'));
await gun.click('#btnSameLabel'); await gun.waitForTimeout(300);
check('…it keeps that pallet\'s bin and asks for the next label', /Scan LABEL 2 on this pallet/.test(await T('#prompt')) && /M01A001/.test(await T('#ctx')), await T('#prompt') + ' ' + await T('#ctx'));
await gun.click('#btnBack'); await gun.waitForTimeout(400);
check('…and Back leaves it as it was, a new line starting at the bin', /Scan BIN LOCATION/.test(await T('#prompt')) && await gun.isHidden('#btnMultiDone'), await T('#prompt'));

/* ---------------- a second count ---------------- */
await post('/api/admin/scanner-layout', { order: layoutWas.order || ['pallet', 'qty', 'bin'] });
const task = await j(await post(`/api/admin/sessions/${S}/recounts`, { bin: 'M01A001', team: '7' }));
await gun.click('#btnToAssign'); await gun.waitForSelector('#scrAssign.active');
await gun.click('#btnAssignRefresh'); await gun.waitForTimeout(900);
await gun.click('#btnRecounts'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(500);
check('Second count: the gun is on bin M01A001', /SECOND COUNT · bin M01A001/.test(await T('#recountBanner')), await T('#recountBanner'));
check('…and the button is offered there too', await gun.isVisible('#btnMultiLabel'));
await gun.click('#btnMultiLabel'); await gun.waitForTimeout(300);
await scan('M01A002');
check('…a different bin is refused, as on any second count', /This second count is for bin M01A001/.test(await T('#scanMsg')), await T('#scanMsg'));
await scan('M01A001');
await scan('ML-1'); await scan('11'); await skip();
await scan('ML-2'); await scan('12'); await skip();
await gun.click('#btnMultiDone'); await gun.waitForTimeout(400);
check('…both labels go in, then Done', /Pallet with 2 labels counted in M01A001/.test(await T('#scanMsg')), await T('#scanMsg'));
// both labels the report has there are counted: the second count finishes by itself (Bin done only if it did not)
if (await gun.isVisible('#btnRecountDone')) await gun.click('#btnRecountDone');
await gun.waitForTimeout(1500);
// the second count stands over the first: ML-1 now reads 11, ML-2 12, both from pass 2
let after = [];
for (let i = 0; i < 20 && !after.some((r) => r.pallet_id === 'ML-1' && Number(r.counted_qty) === 11); i++) { await wait(500); after = (await get(`/api/admin/sessions/${S}/pallets?limit=50`)).rows; }
const a1 = after.find((r) => r.pallet_id === 'ML-1'); const a2 = after.find((r) => r.pallet_id === 'ML-2');
const t = (await get(`/api/admin/sessions/${S}/recounts`)).find((x) => x.id === (task.id || (task.task && task.task.id)));
check('The second count has both labels with their own quantities, standing over the first, and the task is done',
  a1 && Number(a1.counted_qty) === 11 && a2 && Number(a2.counted_qty) === 12 && t && t.status === 'done', JSON.stringify({ ml1: a1 && a1.counted_qty, ml2: a2 && a2.counted_qty, status: t && t.status }));
/* ---------------- the bin first, whatever the settings refresh says ----------------
   Pallet first on this site. "This pallet has more than one label" at the start of a line puts the
   bin first; the gun's settings refresh, which runs between lines, used to put the site's order
   back and drop the counter onto label 1 with no bin - the next scan was refused as a bin. */
await post('/api/admin/scanner-layout', { order: ['pallet', 'qty', 'bin'] });
const dev2 = await j(await post('/api/admin/devices', { name: 'MULTI-LBL-2' }));
const g2 = await (await browser.newContext({ viewport: { width: 360, height: 640 } })).newPage();
g2.on('pageerror', (e) => errors.push('g2: ' + e.message));
await g2.goto(`${BASE}/?d=${dev2.uid}`);
await g2.waitForTimeout(1500);
await g2.selectOption('#fSession', String(S)).catch(() => {});
await g2.fill('#fTeam', '7'); await g2.press('#fTeam', 'Enter');
await g2.fill('#fEmployee', 'E7002'); await g2.press('#fEmployee', 'Enter');
await g2.click('#btnStart');
await g2.waitForSelector('#scrScan.active, #scrAssign.active', { timeout: 8000 });
if (await g2.$('#scrAssign.active')) { await g2.click('#btnCount'); await g2.waitForSelector('#scrScan.active'); }
await g2.waitForTimeout(600);
check('Pallet first: the line starts at the pallet', /Scan PALLET ID/.test(clean(await g2.textContent('#prompt'))));
await g2.click('#btnMultiLabel'); await g2.waitForTimeout(400);
check('…more than one label: the bin comes first', /Scan the BIN this pallet is in/.test(clean(await g2.textContent('#prompt'))), clean(await g2.textContent('#prompt')));
await g2.waitForTimeout(16000);                                   // past the settings refresh's own gap
await g2.evaluate(() => window.dispatchEvent(new Event('online')));   // which the next sync runs
await g2.waitForTimeout(1500);
check('…and the settings refresh between lines leaves the bin first, not label 1 with no bin', /Scan the BIN this pallet is in/.test(clean(await g2.textContent('#prompt'))), clean(await g2.textContent('#prompt')));
await g2.fill('#fScan', 'M01A002'); await g2.press('#fScan', 'Enter'); await g2.waitForTimeout(500);
check('…the bin scans, and label 1 is asked for', /Scan LABEL 1 on this pallet/.test(clean(await g2.textContent('#prompt'))), clean(await g2.textContent('#prompt')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
