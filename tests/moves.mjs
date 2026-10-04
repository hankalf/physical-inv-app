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
await post('/api/admin/pallet-system', { url: `${BASE}/board` });     // the system the gun's move desk frames
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
check('Sign-on offers "Front2Back" while any moves are waiting', await gun.isVisible('#btnModeMove') && clean(await gun.textContent('#btnModeMove')) === 'Front2Back');
await gun.click('#btnModeMove');
await gun.waitForTimeout(300);
check('…and asks for a badge alone: no team, no count to pick', await gun.isHidden('#teamBlock') && await gun.isHidden('#fSession') && /Your clock-in number/.test(await gun.textContent('#employeeLabel')));
await gun.fill('#fEmployee', 'E4'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrMove.active', { timeout: 8000 });
const aisleBtns = await gun.$$eval('#moveAisles button', (bs) => bs.map((b) => b.textContent));
check('The gun asks which aisle to work, with how many are waiting in each', aisleBtns.length === 2 && /F01.*3$/.test(aisleBtns[0]) && /F02.*1$/.test(aisleBtns[1]), aisleBtns.join(' | '));
await gun.click('#moveAisles button >> nth=0');
await gun.waitForTimeout(300);
check('Picking an aisle opens the desk: the pallet, the bin it is in and the bin it goes to', clean(await gun.textContent('#mvPallet')) === 'M-1' && clean(await gun.textContent('#mvFrom')) === 'F01A001' && clean(await gun.textContent('#mvTo')) === 'F01A002' && /1 of 3 to move/.test(await gun.textContent('#mvLeft')), clean(await gun.textContent('#mvLeft')));
check('…with the pallet system framed under it, from the address the office set, and a link to open it', await gun.isVisible('#moveSys') && (await gun.getAttribute('#moveFrame', 'src')) === `${BASE}/board` && (await gun.getAttribute('#moveOpen', 'href')) === `${BASE}/board` && /Pallet system:/.test(await gun.textContent('#mvUrlNote')));
check('…and no scan box and no skip: the scanning happens in that screen', (await gun.$('#fMoveScan')) === null && (await gun.$('#btnMoveSkip')) === null);
await gun.click('#btnMoveNext'); await gun.waitForTimeout(200);
check('› steps to the next pallet in the aisle, ‹ back', clean(await gun.textContent('#mvPallet')) === 'M-2' && /2 of 3/.test(await gun.textContent('#mvLeft')));
await gun.click('#btnMovePrev'); await gun.waitForTimeout(200);
check('', clean(await gun.textContent('#mvPallet')) === 'M-1');
await gun.click('#btnMoveDone'); await gun.waitForTimeout(1500);
check('"Moved — next" ticks it off and brings up the next pallet', /Moved M-1 to F01A002/.test(await gun.textContent('#moveMsg')) && clean(await gun.textContent('#mvPallet')) === 'M-2' && /1 of 2 to move/.test(await gun.textContent('#mvLeft')), clean(await gun.textContent('#moveMsg')));
list = await get(`/api/admin/sessions/${sess.id}/moves`);
check('The move lands on the server as done into the bin behind, by badge and scanner', list.moves.find((m) => m.pallet_id === 'M-1').status === 'done' && list.moves.find((m) => m.pallet_id === 'M-1').actual_bin === 'F01A002' && list.moves.find((m) => m.pallet_id === 'M-1').team === 'E4' && list.moves.find((m) => m.pallet_id === 'M-1').device_id === 'MOVE-01');
const rep = (await get(`/api/admin/sessions/${sess.id}/pallets?limit=50`)).rows.find((r) => r.pallet_id === 'M-1');
check('…and the report now expects the pallet in the bin behind', rep.expected_location === 'F01A002', rep.expected_location);
await gun.click('#btnMoveAisles'); await gun.waitForTimeout(200);
check('Aisles goes back to the aisle list, with the counts moved on', (await gun.$$eval('#moveAisles button', (bs) => bs.map((b) => b.textContent)))[0].endsWith('· 2'));
await gun.click('#moveAisles button >> nth=0'); await gun.waitForTimeout(200);
await gun.click('#btnMoveDone'); await gun.waitForTimeout(600);
await gun.click('#btnMoveDone'); await gun.waitForTimeout(1500);
check('Finishing an aisle says so and returns to the aisle list', await gun.isHidden('#moveTask') && /Aisle F01 done|F01.*done/i.test(await gun.textContent('#moveAisleMsg')) && (await gun.$$eval('#moveAisles button', (bs) => bs.length)) === 1, clean(await gun.textContent('#moveAisleMsg')));

/* a dead spot in the freezer */
await ctx.setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await gun.click('#moveAisles button >> nth=0'); await gun.waitForTimeout(200);
await gun.click('#btnMoveDone'); await gun.waitForTimeout(600);
check('A move ticked off with no signal is kept on the gun', /Moved M-5/.test(await gun.textContent('#moveAisleMsg') + await gun.textContent('#moveMsg')) && (await get(`/api/admin/sessions/${sess.id}/moves`)).moves.find((m) => m.pallet_id === 'M-5').status === 'open');
check('…and the desk says there is nothing left', await gun.isHidden('#moveTask') && /Nothing left to move/.test(await gun.textContent('#moveBanner')));
await ctx.setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
let landed = false;
for (let t = 0; t < 25000 && !landed; t += 1000) { await wait(1000); landed = (await get(`/api/admin/sessions/${sess.id}/moves`)).moves.find((m) => m.pallet_id === 'M-5').status === 'done'; }
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
check('The moves are reachable with no count in the address', viaSite.summary.open === 0 && viaSite.summary.done === 4);
check('…with the moves summary', clean(await page.textContent('#mvOpen')) === '0' && clean(await page.textContent('#mvDone')) === '4' && clean(await page.textContent('#mvSkipped')) === '0',
  `${await page.textContent('#mvOpen')} / ${await page.textContent('#mvDone')} / ${await page.textContent('#mvSkipped')}`);
const rows = await page.$$eval('#mvTable tbody tr', (trs) => trs.map((tr) => tr.textContent));
check('…and every move with its state', rows.length === 4 && rows.every((r) => /moved/.test(r)) && rows.some((r) => /M-1.*moved/.test(r)), rows.join(' | ').slice(0, 200));
check('The front-placed bins list moved here too', await page.$('#frontCard') !== null && (await page.$$('#navTabs .sub[data-page="/front"]')).length === 3);
const subs = await page.$$eval('#navTabs .navgroup.here .sub', (ss) => ss.map((s) => s.textContent));
check('The sidebar opens the page\'s sections out under it', subs.join(',') === 'Pallets to move back,Move desk,Front-placed bins', subs.join(','));
check('…and lists the other pages\' sections folded', (await page.$$('#navTabs .sub[data-page="/admin"]')).length === 7 && await page.$eval('#navTabs .sub[data-page="/admin"]', (s) => s.closest('.subs').hidden));
await page.click('#navTabs .sub[data-page="/front"][data-nav-sub="bins"]');
await page.waitForTimeout(300);
check('Clicking a section in the sidebar switches to it', await page.$eval('[data-sub="bins"]', (p) => p.classList.contains('active')) && await page.$eval('#navTabs .sub[data-nav-sub="bins"]', (s) => s.classList.contains('current')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} move checks passed`);
process.exit(failed ? 1 : 0);
