/*
 * Pallets to move back: a front pallet with an empty bin behind it.
 *
 * The office builds the list from the report (or uploads one); the gun offers
 * "Move pallets" at sign-on and walks it aisle by aisle - scan the pallet, put
 * it back, scan the bin it went into. Skips carry a reason. Done moves move
 * the pallet on the report, and queue through a dead spot like anything else.
 */
import { chromium } from 'playwright-core';
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

const sess = await post('/api/admin/sessions', { name: 'Moves test' });
let bins = 'Bin Location,Zone,Aisle,Description\n';
for (const a of ['F01', 'F02']) for (let n = 1; n <= 6; n++) bins += `${a}A${String(n).padStart(3, '0')},Freezer,${a},"Rack, Level: A, Position # ${String(n).padStart(3, '0')} -  ${n % 2 ? 'Front' : 'Back'}"\n`;
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nM-1,S,Chicken,40,F01A001\nM-2,S,Peas,30,F01A003\nM-3,S,Corn,20,F01A005\nM-4,S,Cod,20,F01A006\nM-5,S,Fries,24,F02A003\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { guided: false, askComments: false });

/* ---------------- building the list ---------------- */
const built = await post(`/api/admin/sessions/${sess.id}/moves/build`, {});
check('The move list is read off the report: front pallets with an empty bin behind', built.added === 3, `${built.added} added`);
let list = await get(`/api/admin/sessions/${sess.id}/moves`);
const by = Object.fromEntries(list.moves.map((m) => [m.pallet_id, m]));
check('…each from its front bin to the bin behind', by['M-1'].from_bin === 'F01A001' && by['M-1'].to_bin === 'F01A002' && by['M-2'].to_bin === 'F01A004' && by['M-5'].to_bin === 'F02A004');
check('…and a front pallet with something behind it is left alone', !by['M-3'] && !by['M-4']);
const again = await post(`/api/admin/sessions/${sess.id}/moves/build`, {});
check('Building again does not double the list', again.added === 0 && again.found === 3);
const up = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\nM-3,F01A005,F02A006\n' })).json();
check('A list can be uploaded too', up.added === 1);
const bad = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\nM-9,F01A005,Z99Z999\n' })).json();
check('…and a bin not on the count is refused, naming the row', /row 2: Z99Z999 is not on this count/.test(bad.error || ''), bad.error);
list = await get(`/api/admin/sessions/${sess.id}/moves`);
check('The summary counts what is waiting, by aisle', list.summary.open === 4 && list.summary.aisles === 2, JSON.stringify(list.summary));
const dev = await post('/api/admin/devices', { name: 'MOVE-01' });
const D = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${(await post('/api/admin/devices', { name: 'MOVE-02' })).uid}`, {}, hdr)).token };
const forGun = await get(`/api/sessions/${sess.id}/moves`, D);
check('The gun gets them by aisle, in walking order', forGun.aisles.map((a) => `${a.aisle}:${a.open}`).join(',') === 'F01:3,F02:1' && forGun.aisles[0].moves[0].pallet === 'M-1', JSON.stringify(forGun.aisles.map((a) => `${a.aisle}:${a.open}`)));
const sessions = await get('/api/sessions', D);
check('The session list tells the gun how many moves are waiting', sessions.find((s) => s.id === sess.id).movesOpen === 4);

/* ---------------- the gun ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await ctx.newPage();
const errors = [];
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept().catch(() => {}));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
check('Sign-on offers "Move pallets" while any are waiting', await gun.isVisible('#btnModeMove'));
await gun.click('#btnModeMove');
await gun.waitForTimeout(300);
check('…listing the counts that have moves', (await gun.$$eval('#fSession option', (os) => os.map((o) => o.textContent))).some((t) => /Moves test/.test(t)));
await gun.fill('#fTeam', '4'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E4'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrMove.active', { timeout: 8000 });
const aisleBtns = await gun.$$eval('#moveAisles button', (bs) => bs.map((b) => b.textContent));
check('The gun shows the aisles with moves waiting', aisleBtns.length === 2 && /F01.*3 to move/.test(aisleBtns[0]), aisleBtns.join(' | '));
await gun.click('#moveAisles button >> nth=0');
await gun.waitForTimeout(300);
const scan = async (v) => { await gun.fill('#fMoveScan', v); await gun.press('#fMoveScan', 'Enter'); await gun.waitForTimeout(400); };
check('Picking an aisle shows the first pallet: which one, from where, to where', clean(await gun.textContent('#mvPallet')) === 'M-1' && /from F01A001 → to F01A002/.test(await gun.textContent('#mvWhere')) && /Scan the PALLET/.test(await gun.textContent('#mvPrompt')));
await scan('M-2');
check('The wrong pallet is refused', /That is M-2 — this move is pallet M-1/.test(await gun.textContent('#moveMsg')), clean(await gun.textContent('#moveMsg')));
await scan('M-1');
check('The right pallet moves on to the bin', /Scan the BIN it went into/.test(await gun.textContent('#mvPrompt')) && /Move it to F01A002/.test(await gun.textContent('#moveMsg')));
await scan('F01A001');
check('The front bin it came from is refused', /front bin it came from/.test(await gun.textContent('#moveMsg')));
await scan('F01A003');
check('…and so is any other bin', /That is F01A003, not F01A002/.test(await gun.textContent('#moveMsg')));
await scan('F01A002');
check('The bin behind finishes the move and brings up the next pallet', /Moved M-1 to F01A002/.test(await gun.textContent('#moveMsg')) && clean(await gun.textContent('#mvPallet')) === 'M-2' && /2 to move/.test(await gun.textContent('#mvLeft')), clean(await gun.textContent('#moveMsg')));
await wait(1500);
list = await get(`/api/admin/sessions/${sess.id}/moves`);
check('The move lands on the server as done, by team and scanner', list.moves.find((m) => m.pallet_id === 'M-1').status === 'done' && list.moves.find((m) => m.pallet_id === 'M-1').team === '4' && list.moves.find((m) => m.pallet_id === 'M-1').device_id === 'MOVE-01');
const rep = (await get(`/api/admin/sessions/${sess.id}/pallets?limit=50`)).rows.find((r) => r.pallet_id === 'M-1');
check('…and the report now expects the pallet in the bin behind', rep.expected_location === 'F01A002', rep.expected_location);

/* skipping, with a reason */
await gun.click('#btnMoveSkip');
await gun.waitForTimeout(200);
check('"Cannot move it" offers reasons', (await gun.$$eval('#moveSkipReasons button', (bs) => bs.length)) === 4);
await gun.click('#moveSkipReasons button:has-text("Bin behind is not empty")');
await gun.waitForTimeout(1500);
list = await get(`/api/admin/sessions/${sess.id}/moves`);
check('A skipped move keeps its reason for the office', list.moves.find((m) => m.pallet_id === 'M-2').status === 'skipped' && /not empty/.test(list.moves.find((m) => m.pallet_id === 'M-2').reason));
check('…and the gun moves on to the next pallet', clean(await gun.textContent('#mvPallet')) === 'M-3');

/* a dead spot in the freezer */
await ctx.setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await scan('M-3'); await scan('F02A006');
check('A move finished with no signal is kept on the gun', /Moved M-3/.test(await gun.textContent('#moveAisleMsg') + await gun.textContent('#moveMsg')) && (await get(`/api/admin/sessions/${sess.id}/moves`)).moves.find((m) => m.pallet_id === 'M-3').status === 'open');
check('…and the aisle is done, back at the aisle list', await gun.isHidden('#moveTask') && (await gun.$$eval('#moveAisles button', (bs) => bs.length)) === 1);
await ctx.setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
let landed = false;
for (let t = 0; t < 25000 && !landed; t += 1000) { await wait(1000); landed = (await get(`/api/admin/sessions/${sess.id}/moves`)).moves.find((m) => m.pallet_id === 'M-3').status === 'done'; }
check('…and sends it the moment there is signal', landed);

/* SOS from here, and back */
await gun.click('#btnMoveSos');
await gun.waitForTimeout(300);
check('SOS works from the move screen', await gun.isVisible('#scrSos'));
await gun.click('#btnSosBack');
await gun.waitForTimeout(300);
check('…and comes back to it', await gun.isVisible('#scrMove'));

/* ---------------- the Front bins page ---------------- */
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => errors.push('front: ' + e.message));
await page.goto(BASE + '/front');
await signIn(page);
await page.waitForTimeout(1200);
check('Front bins is its own page in the sidebar, with no count to pick', clean(await page.textContent('#navTabs a.tab.current')).includes('Front bins') && (await page.$('#sessionPick')) === null);
check('…working from the site\'s current bin list, and saying which', /bin list: 12 bins/.test(clean(await page.textContent('#frontRef'))), clean(await page.textContent('#frontRef')));
const viaSite = await get('/api/admin/front/moves');
check('The moves are reachable with no count in the address', viaSite.summary.open === 1 && viaSite.summary.done === 2);
check('…with the moves summary', clean(await page.textContent('#mvOpen')) === '1' && clean(await page.textContent('#mvDone')) === '2' && clean(await page.textContent('#mvSkipped')) === '1',
  `${await page.textContent('#mvOpen')} / ${await page.textContent('#mvDone')} / ${await page.textContent('#mvSkipped')}`);
const rows = await page.$$eval('#mvTable tbody tr', (trs) => trs.map((tr) => tr.textContent));
check('…and every move with its state and reason', rows.length === 4 && rows.some((r) => /M-2.*skipped.*not empty/.test(r)) && rows.some((r) => /M-1.*moved/.test(r)), rows.join(' | ').slice(0, 200));
check('The front-placed bins list moved here too', await page.$('#frontCard') !== null && (await page.$$('#navTabs .sub[data-page="/front"]')).length === 2);
const subs = await page.$$eval('#navTabs .navgroup.here .sub', (ss) => ss.map((s) => s.textContent));
check('The sidebar opens the page\'s sections out under it', subs.join(',') === 'Pallets to move back,Front-placed bins', subs.join(','));
check('…and lists the other pages\' sections folded', (await page.$$('#navTabs .sub[data-page="/admin"]')).length === 6 && await page.$eval('#navTabs .sub[data-page="/admin"]', (s) => s.closest('.subs').hidden));
await page.click('#navTabs .sub[data-page="/front"][data-nav-sub="bins"]');
await page.waitForTimeout(300);
check('Clicking a section in the sidebar switches to it', await page.$eval('[data-sub="bins"]', (p) => p.classList.contains('active')) && await page.$eval('#navTabs .sub[data-nav-sub="bins"]', (s) => s.classList.contains('current')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} move checks passed`);
process.exit(failed ? 1 : 0);
