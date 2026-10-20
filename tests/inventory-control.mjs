/*
 * Inventory Control: a tab under Counting with the dashboard's own second
 * counts, adjustments and reports, and an overview of where the count stands
 * for the people who turn it into stock. A login given Inventory Control - or
 * the dashboard's matching tabs - may use it; cycle counts stay out of it while
 * they are switched off for the site.
 */
import { chromium } from 'playwright-core';
import { pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + await login({ password: 'changeme' }) };
const csv = { authorization: A.authorization, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const status = async (p, h) => (await fetch(BASE + p, { headers: h })).status;

/* a count with differences: two second counts, one more and one less than the report */
const BINS = ['K01A001', 'K01A002', 'K01A003', 'K01A004'];
const S = (await j(await post('/api/admin/sessions', { name: 'IC overview count' }))).id;
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + BINS.map((b) => `${b},Cooler,K01`).join('\n') + '\n', csv);
await post(`/api/admin/sessions/${S}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\n' + BINS.map((b, i) => `IC-${i + 1},S${i},Kiwi,40,${b}`).join('\n') + '\n', csv);
const dev = await j(await post('/api/admin/devices', { name: 'IC-GUN-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
let n = 0;
const line = (pallet, qty, bin) => ({ clientId: `ic${++n}`, palletId: pallet, qty, location: bin, team: '1', deviceId: 'IC-GUN-01', scannedAt: new Date().toISOString() });
await post(`/api/sessions/${S}/counts`, [line('IC-1', 40, 'K01A001'), line('IC-2', 50, 'K01A002'), line('IC-3', 30, 'K01A003')], G);
const C = (await j(await post('/api/admin/sessions', { name: 'IC cycle count', mode: 'cycle' }))).id;

let o = await get(`/api/admin/sessions/${S}/inventory-control`);
check('The overview: counted, of how many bins', o.session.binsCounted === 3 && o.session.bins === 4 && o.session.mode === 'full', JSON.stringify(o.session));
check('…the second counts still open', o.recounts.stillOpen === 2 && o.recounts.done === 0, JSON.stringify(o.recounts));
check('…what the count adds and takes off, and the net', o.adjustments.positive.units === 10 && o.adjustments.negative.units < 0 && o.adjustments.positive.pallets === 1, JSON.stringify(o.adjustments));
check('…how much of it is in the ERP, line by line and aisle by aisle', o.erp.lines >= 2 && o.erp.entered === 0 && o.erp.aisles === 1, JSON.stringify(o.erp));
check('…and the final report waits for the second counts', !o.final.ready && o.final.blockedBy === 2);
check('With cycle counts on, the open cycle counts are listed', Array.isArray(o.cycles) && o.cycles.some((c) => c.id === C));
check('…and with Not in Location on, its pallets', o.missing && typeof o.missing.missing === 'number');

/* who may use it */
await post('/api/admin/users', { username: 'IC-ONLY', name: 'Ivy Control', password: 'stock-turns-1', mustChange: false, profile: 'custom', access: ['inventory', 'export'] }, A);
await post('/api/admin/users', { username: 'IC-SECOND', name: 'Sam Second', password: 'stock-turns-2', mustChange: false, profile: 'custom', access: ['dashboard.second'] }, A);
await post('/api/admin/users', { username: 'IC-JOBS', name: 'Jo Jobs', password: 'stock-turns-3', mustChange: false, profile: 'jobs' }, A);
const ICO = { ...hdr, authorization: 'Bearer ' + await login({ username: 'IC-ONLY', password: 'stock-turns-1' }) };
const ICS = { ...hdr, authorization: 'Bearer ' + await login({ username: 'IC-SECOND', password: 'stock-turns-2' }) };
const JOB = { ...hdr, authorization: 'Bearer ' + await login({ username: 'IC-JOBS', password: 'stock-turns-3' }) };
const me = await get('/api/admin/me', ICO);
check('Inventory Control is a page a login can be given, with its tabs', me.accessKeys.some(([k]) => k === 'inventory') && me.tabs.inventory.map(([k]) => k).join() === 'overview,second,adjust,reports');
check('Given Inventory Control alone: its overview, second counts, adjustments and reports', await status(`/api/admin/sessions/${S}/inventory-control`, ICO) === 200
  && await status(`/api/admin/sessions/${S}/recounts`, ICO) === 200 && await status(`/api/admin/sessions/${S}/adjustments/view`, ICO) === 200 && await status(`/api/admin/sessions/${S}/pallets`, ICO) === 200);
check('…but not the rest of the dashboard', await status(`/api/admin/sessions/${S}/progress`, ICO) === 403 && await status(`/api/admin/sessions/${S}/assignments`, ICO) === 403);
check('Given the dashboard\'s Second counts alone: Inventory Control\'s overview and second counts, not its adjustments', await status(`/api/admin/sessions/${S}/inventory-control`, ICS) === 200
  && await status(`/api/admin/sessions/${S}/recounts`, ICS) === 200 && await status(`/api/admin/sessions/${S}/adjustments/view`, ICS) === 403);
check('A login for the warehouse jobs has none of it', await status(`/api/admin/sessions/${S}/inventory-control`, JOB) === 403);

/* ------------------------------------------------------------------ the page */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/inventory`);
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active');
await pickSession(page, S);
await page.waitForSelector('#icStats .stat', { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(600);
const nav = await page.$$eval('#navTabs a.tab', (as) => as.map((a) => a.textContent.trim()));
check('The sidebar: Inventory Control under Counting, after Full Counts', nav.findIndex((t) => /Inventory Control/.test(t)) === nav.findIndex((t) => /Full Counts/.test(t)) + 1, nav.join(' | '));
check('…its page says so', /Inventory Control/.test(await page.textContent('h1')) && /Inventory Control/.test(await page.title()));
const subs = await page.$$eval('#subTabs button', (bs) => bs.map((b) => b.dataset.goto));
check('…with four tabs: Overview, Second counts, Adjustments, Reports', subs.join() === 'overview,second,adjust,reports', subs.join());
const stats = clean(await page.textContent('#icStats'));
check('Overview: counted, second counts open, positive and negative, the ERP', /75%/.test(stats) && /2\s*second counts still open/.test(stats) && /\+10/.test(stats) && /lines in the ERP/.test(stats), stats);
check('…the final report waits, and says why', /2 second counts are still open/.test(await page.textContent('#icFinal')));
check('…the open cycle counts', await page.isVisible('#icCycleCard') && (await page.locator(`#icCycles tr[data-cycle="${C}"]`).count()) === 1);
await page.click('#icStats button[data-ic-stat="second"]');
await page.waitForTimeout(800);
check('A figure opens its tab: the dashboard\'s own Second counts card, with its rows', await page.isVisible('#btnRecAdd') && /K01A00[23]/.test(await page.textContent('#scrMain [data-sub="second"].active')));
await page.click('#subTabs button[data-goto="adjust"]');
await page.waitForTimeout(900);
check('Adjustments: positive and negative, the ERP by aisle', await page.isVisible('#btnErpWorksheet') && /K01/.test(clean(await page.textContent('#scrMain [data-sub="adjust"].active'))));
await page.click('#subTabs button[data-goto="reports"]');
await page.waitForTimeout(900);
check('Reports: the pallet report and the exports', await page.isVisible('#btnExportPallets') && await page.isVisible('#btnFinalReport'));
await page.click('#subTabs button[data-goto="overview"]');
await page.locator(`#icCycles tr[data-cycle="${C}"] button`).click();
await page.waitForTimeout(1000);
check('Show it here: the cycle count, on the same tabs', /IC cycle count/.test(await page.textContent('#icSub')) && /CYCLE/.test(await page.textContent('#icKind')));

/* the dashboard is as it was */
await page.goto(`${BASE}/admin`);
await page.waitForSelector('#scrMain.active');
await page.waitForTimeout(800);
const dsubs = await page.$$eval('#subTabs button', (bs) => bs.map((b) => b.dataset.goto));
check('The dashboard keeps its tabs and has no Overview', !dsubs.includes('overview') && dsubs.includes('progress') && dsubs.includes('second') && dsubs.includes('reports') && /Dashboard/.test(await page.textContent('h1')), dsubs.join());

/* cycle counts switched off: none of them here */
await post('/api/admin/features', { cycle: false });
await page.goto(`${BASE}/inventory`);
await page.waitForSelector('#scrMain.active');
await pickSession(page, S);
await page.waitForTimeout(1200);
const listed = await page.$$eval('#sessionPick .sess-row', (rs) => rs.map((r) => r.textContent));
check('Cycle counts off: Inventory Control lists no cycle count, and no cycle card', !listed.some((t) => /IC cycle count/.test(t)) && listed.some((t) => /IC overview count/.test(t)) && await page.isHidden('#icCycleCard'), listed.length + ' rows');
check('…and the server leaves them out too', (await get(`/api/admin/sessions/${S}/inventory-control`)).cycles === null);
await post('/api/admin/features', { cycle: true });

/* a login with Inventory Control alone */
const ip = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
ip.on('pageerror', (e) => errors.push('ic-only: ' + e.message));
await ip.goto(`${BASE}/inventory`);
await ip.fill('#fUser', 'IC-ONLY'); await ip.fill('#fPassword', 'stock-turns-1'); await ip.click('#btnLogin');
await ip.waitForSelector('#scrMain.active');
await pickSession(ip, S);
await ip.waitForSelector('#icStats .stat', { timeout: 8000 }).catch(() => {});
const ipNav = await ip.$$eval('#navTabs a.tab', (as) => as.map((a) => a.textContent.trim()));
check('Inventory Control alone: the sidebar has it and not the Dashboard', ipNav.some((t) => /Inventory Control/.test(t)) && !ipNav.some((t) => /^.?Dashboard/.test(t)), ipNav.join(' | '));
check('…and its overview fills in', /second counts still open/.test(clean(await ip.textContent('#icStats'))));
check('…with the cycle counts too, here alone: the dashboard\'s list has none for this login', await ip.isVisible('#icCycleCard')
  && !(await get('/api/admin/sessions', ICO)).some((s) => s.id === C) && (await get('/api/admin/sessions?inventory=1', ICO)).some((s) => s.id === C));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
