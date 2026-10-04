/*
 * The Testing Suite's other jobs.
 *
 * A scanner is not only used for the wall-to-wall count: there is the cycle
 * count a person does alone off a list, the front pallets to put back in the
 * empty bin behind them, and the Not in Location list it watches for as it
 * goes. Each can be practised on the same two aisles, set up only when asked
 * for, only for a login that may do that job for real - and none of it leaks:
 * the planted lost pallets never reach the real Not in Location page or a
 * floor gun, and a new run clears the lot.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) })).json()).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const get = async (p, h = A) => (await fetch(BASE + p, { headers: h })).json();
const post = async (p, body = {}, h = A) => (await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();

/* ---------------- the API: set up, scoped, cleared ---------------- */
const made = await post('/api/admin/practice');
check('A practice count offers the three other jobs, none set up yet', made.modes && made.modes.available && ['cycle', 'moves', 'missing'].every((k) => made.modes[k].allowed && !made.modes[k].on));
const bad = await post('/api/admin/practice/mode', { mode: 'juggling' });
check('A job that does not exist is refused', /not a practice mode/.test(bad.error || ''), bad.error);

const cyc = await post('/api/admin/practice/mode', { mode: 'cycle' });
check('Asking for a cycle count makes one beside the run, with a list of five bins', cyc.modes.cycle.on && cyc.modes.cycle.bins.length === 5 && cyc.modes.cycle.session && cyc.modes.cycle.session.name === 'Practice cycle count',
  JSON.stringify(cyc.modes.cycle.bins.map((b) => b.bin)));
check('…a plain bin, two pallets, an empty bin, a short pallet, a gone one', cyc.modes.cycle.bins.map((b) => b.bin).join(',') === 'F01A001,F01A002,F01A003,F01A004,F01B006');
check('…and the run is still the run: same practice count, history untouched', cyc.session.id === made.session.id && cyc.history.length === 0);
check('…with a thing to try for it', cyc.checklist.some((c) => c.key === 'cycle' && !c.done));
const cyc2 = await post('/api/admin/practice/mode', { mode: 'cycle' });
check('Asking again changes nothing', cyc2.modes.cycle.session.id === cyc.modes.cycle.session.id);

const mv = await post('/api/admin/practice/mode', { mode: 'moves' });
check('Asking for pallet moves plants three on the run', mv.modes.moves.on && mv.modes.moves.list.length === 3 && mv.modes.moves.list.every((x) => x.status === 'open'));
check('…one of them into a bin that is not actually empty, to be skipped', mv.modes.moves.list.some((x) => x.to === 'F01A005' && x.occupied.includes('F12314-111')));
check('…with two things to try: move one, skip one', ['move', 'moveSkip'].every((k) => mv.checklist.some((c) => c.key === k && !c.done)));

const ms = await post('/api/admin/practice/mode', { mode: 'missing' });
check('Asking for Not in Location plants three lost pallets', ms.modes.missing.on && ms.modes.missing.rows.length === 3 && ms.modes.missing.rows.every((r) => r.status === 'missing'));
check('…two on the shelves and one nowhere', ms.modes.missing.rows.filter((r) => r.where).length === 2 && ms.modes.missing.rows.some((r) => !r.where));
check('The real Not in Location page never sees them', (await get('/api/admin/missing')).summary.total === 0);
const floorDev = await post('/api/admin/devices', { name: 'FLOOR-07' });
const F = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${floorDev.uid}`, {}, hdr)).token };
check('…nor does a gun on the floor', (await get('/api/missing', F)).pallets.length === 0);
const T = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${made.device.uid}`, {}, hdr)).token };
check('The practice gun does, and nothing else', (await get('/api/missing', T)).pallets.map((p) => p[0]).join(',') === 'F12317-111,F23419-111,F18888-888');
const guns = await get('/api/sessions?practice=1', T);
check('The practice gun is offered the cycle count and the pallets to move, as a floor gun would be',
  guns.some((s) => s.mode === 'cycle') && guns.some((s) => s.id === made.session.id && s.movesOpen === 3), JSON.stringify(guns.map((s) => [s.name, s.mode, s.movesOpen])));

/* only a login that may do the job for real may practise it */
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'IVY-CHEN', name: 'Ivy Chen', password: 'cold-room-11', mustChange: false, profile: 'inventory' }) });
const ivyTok = (await post('/api/admin/login', { username: 'IVY-CHEN', password: 'cold-room-11' }, hdr)).token;
const I = { ...hdr, authorization: 'Bearer ' + ivyTok };
const ivy = await post('/api/admin/practice', {}, I);
check('Inventory control may not do cycle counts or moves for real, so is not offered them to practise', !ivy.modes.cycle.allowed && !ivy.modes.moves.allowed, JSON.stringify(ivy.modes));
const ivyTry = await fetch(`${BASE}/api/admin/practice/mode`, { method: 'POST', headers: I, body: JSON.stringify({ mode: 'cycle' }) });
check('…and the server refuses the set-up outright', ivyTry.status === 403);

/* ---------------- the page and the gun ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto(BASE + '/testing');
await page.fill('#fUser', 'DANA-WHITFIELD');
await page.fill('#fPassword', 'changeme');
await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active');
await page.waitForSelector('#shelves table.shelf');
await page.click('#btnTips').catch(() => {});       // the tips are checked on their own below
await wait(300);
if (/Hide tips/.test(await page.textContent('#btnTips'))) await page.click('#btnTips');

const modeBtn = (k) => page.locator(`#modeList button[data-mode="${k}"]`);
check('"What to practise" lists the full count and the three other jobs', (await page.$$('#modeList button')).length === 4 && await modeBtn('cycle').isVisible());
check('…marking the ones already set up', await modeBtn('cycle').evaluate((b) => b.classList.contains('set')) && await modeBtn('moves').evaluate((b) => b.classList.contains('set')));
check('…on the full count to begin with, so the sheet reads as before', await modeBtn('full').evaluate((b) => b.classList.contains('now')) && await page.isHidden('#modePane'));

const gunFrame = async () => {
  for (let i = 0; i < 80; i++) {
    const f = page.frames().find((x) => /practice=1/.test(x.url()));
    if (f) { try { if (await f.evaluate(() => typeof window.wedge === 'function' && !!document.querySelector('.screen.active'))) return f; } catch { /* navigating */ } }
    await wait(150);
  }
  throw new Error('the gun never came up');
};
let gun = await gunFrame();
const screenOf = () => gun.evaluate(() => document.querySelector('.screen.active')?.id).catch(() => '');
const waitScreen = async (id, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) { if ((await screenOf()) === id) return true; await wait(100); }
  return false;
};
const paneChip = (code) => page.locator('#modePane .scan', { hasText: new RegExp(`^${code}$`) }).first();
const click = async (loc) => { await loc.click(); await wait(350); };
const done = async () => (await page.$$eval('.check.done', (cs) => cs.map((c) => c.dataset.key)));
const waitCheck = async (key, ms = 9000) => {
  for (let t = 0; t < ms; t += 250) { if ((await done()).includes(key)) return true; await wait(250); }
  return false;
};
const skipComments = async () => {
  for (let t = 0; t < 3000; t += 100) {
    if (await gun.isVisible('#btnSkip')) { await gun.click('#btnSkip'); await wait(300); return; }
    await wait(100);
  }
};
const atPrompt = async (re, ms = 6000) => {
  for (let t = 0; t < ms; t += 100) {
    if ((await screenOf()) === 'scrScan' && re.test(await gun.textContent('#prompt').catch(() => ''))) return true;
    await wait(100);
  }
  return false;
};
const tip = async () => clean(await page.textContent('#coachText').catch(() => ''));
const waitTip = async (re, ms = 6000) => {
  for (let t = 0; t < ms; t += 200) { if (await page.isVisible('#coach') && re.test(await tip())) return true; await wait(200); }
  return false;
};

/* ---- the cycle count ---- */
await page.click('#btnTips');          // tips on, to see them follow the job
await modeBtn('cycle').click();
await wait(600);
check('Picking Cycle count opens its pane: the clock-in number and today\'s list', await page.isVisible('#modePane') && (await page.$$('#modePane tr[data-cycle-bin]')).length >= 5 && await paneChip('T1001').isVisible());
check('…and the gun on its sign-on screen is restarted so it sees the cycle count', await waitScreen('scrSignon', 10000));
gun = await gunFrame();
for (let t = 0; t < 8000 && !(await gun.isVisible('#btnModeCycle')); t += 200) await wait(200);
check('The gun now offers Cycle count and Move pallets, as it would on the floor', await gun.isVisible('#btnModeCycle') && await gun.isVisible('#btnModeMove'));
check('A tip says to tap Cycle count on the gun', await waitTip(/tap Cycle count/i), await tip());
await gun.click('#btnModeCycle');
await wait(500);
check('…then to click the clock-in number, no team on a cycle count', await waitTip(/T1001/), await tip());
await click(paneChip('T1001'));
check('…then to sign on', await waitTip(/Sign on/), await tip());
await gun.click('#btnStart');
check('The person signs on alone, to their list', await waitScreen('scrAssign'));
check('…and the gun calls it a cycle count with five bins', /Cycle count/.test(clean(await gun.textContent('#scrAssign'))) && clean(await gun.textContent('#recountCount')) === '5', clean(await gun.textContent('#recountCard')));
check('…the tip says to start the list', await waitTip(/Start counting the list/), await tip());
await gun.click('#btnRecounts');
check('The gun takes the first bin on the list', await atPrompt(/PALLET/i) && /CYCLE COUNT · bin F01A001/.test(clean(await gun.textContent('#recountBanner'))), clean(await gun.textContent('#recountBanner')));
check('…and the tip points at its pallet in the pane', await waitTip(/F01A001.*F12311-111/), await tip());
await click(paneChip('F12311-111'));
await click(page.locator('#modePane tr[data-pallet="F12311-111"] .scan.qty'));
check('…then at the bin', await waitTip(/click F01A001/i), await tip());
await click(paneChip('F01A001'));
await skipComments();
check('…then says to tap Bin done', await waitTip(/Bin done/), await tip());
await gun.click('#btnRecountDone');
await wait(600);
check('Bin done ticks "count a bin off a cycle-count list"', await waitCheck('cycle'));
const paneRow = clean(await page.locator('#modePane tr[data-cycle-bin="F01A001"]').first().textContent());
check('…and the pane shows the bin done', /✓ counted/.test(paneRow) && /bin done/.test(paneRow), paneRow);
check('The cycle count\'s lines are on the cycle count, not on the run', (await get('/api/admin/practice')).totals.lines === 0);
check('The gun moved on to the next bin on the list', /bin F01A002/.test(clean(await gun.textContent('#recountBanner'))), clean(await gun.textContent('#recountBanner')));
check('The dashboard lists the practice cycle count for its owner, flagged practice', (await get('/api/admin/sessions')).some((s) => s.name === 'Practice cycle count' && s.practice === 1 && s.mode === 'cycle'));

/* ---- moving pallets ---- */
await gun.click('#btnToAssign');
await waitScreen('scrAssign');
await gun.click('#btnSignoff');
await waitScreen('scrSignon');
await modeBtn('moves').click();
await wait(600);
check('Picking Move pallets opens its pane with the three moves', (await page.$$('#modePane tr[data-move]')).length === 3 && /not empty: F12314-111/.test(clean(await page.textContent('#modePane'))));
gun = await gunFrame();
for (let t = 0; t < 8000 && !(await gun.isVisible('#btnModeMove')); t += 200) await wait(200);
check('The tip says to tap Front2Back on the gun', await waitTip(/tap Front2Back/i), await tip());
await gun.click('#btnModeMove');
await wait(400);
check('Front2Back asks for a badge alone, and the tip says so', await gun.isHidden('#teamBlock') && await waitTip(/just a clock-in number/i), await tip());
await click(page.locator('#crewVals .scan').first());
await gun.click('#btnStart');
check('The badge signs on to Front2Back', await waitScreen('scrMove'));
check('…and the tip says to pick an aisle', await waitTip(/Pick an aisle/i), await tip());
await gun.click('#moveAisles button:has-text("F01")');
await wait(500);
check('The gun shows the desk for the first pallet in F01, and the tip says to move it and tap Moved', clean(await gun.textContent('#mvPallet')) === 'F12311-111' && await waitTip(/Moved — next/), await tip());
await gun.click('#btnMoveDone');
check('Moved — next ticks it off', await waitCheck('move'));
const moved = clean(await page.locator('#modePane tr[data-move]').first().textContent());
check('…the pane shows it moved', /✓ moved to F01A003/.test(moved), moved);
const shelfNote = clean(await page.locator('#shelves tr[data-pallet="F12311-111"]').textContent());
check('…and the full count\'s sheet says the pallet is in F01A003 now', /moved it to F01A003/.test(shelfNote), shelfNote);
check('The next move in F01 is the one into a bin that is not empty: the tip says so', await waitTip(/F12319-111/) && await waitTip(/not empty/), await tip());
check('It is the last in the aisle, so › is off; the office skips it from its own desk', await gun.$eval('#btnMoveNext', (b) => b.disabled));
await post(`/api/admin/sessions/${made.session.id}/moves/${(await get(`/api/admin/sessions/${made.session.id}/moves`)).moves.find((x) => x.pallet_id === 'F12319-111').id}/skip`, { reason: 'Bin behind is not empty' });
check('Skipping it from the office, with the reason, ticks the skip', await waitCheck('moveSkip'));
const mvList = await get(`/api/admin/sessions/${made.session.id}/moves`);
check('…and the office\'s move list has one moved and one skipped, with the reason', mvList.summary.done === 1 && mvList.summary.skipped === 1 && mvList.moves.some((m) => m.status === 'skipped' && /not empty/.test(m.reason)), JSON.stringify(mvList.summary));

/* ---- Not in Location ---- */
await gun.click('#btnMoveSignoff');
await waitScreen('scrSignon');
await modeBtn('missing').click();
await wait(600);
check('Picking Not in Location opens its pane: three lost pallets, two of them on a shelf', (await page.$$('#modePane tr[data-lost]')).length === 3 && (await page.$$('#modePane tr[data-lost][data-where=""]')).length === 1);
gun = await gunFrame();
await gun.click('#btnModeFull');
await gun.fill('#fTeam', '99');
await click(page.locator('#crewVals .scan').first());
await gun.click('#btnStart');
await waitScreen('scrAssign');
await gun.click('#btnCount');
await atPrompt(/PALLET/i);
check('On the full count the tip points at the first lost pallet that is on a shelf, and says where', await waitTip(/F12317-111.*Not in Location.*F01B003/), await tip());
await click(page.locator('#shelves .scan[data-code="F12317-111"]'));
await wait(700);
check('The gun calls it out: found', /Not in Location list — found/.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')));
check('…and the tip follows that pallet, not the top of the sheet', /quantity/.test(await tip()) && await page.locator('#shelves tr[data-pallet="F12317-111"] .scan.qty').evaluate((b) => b.classList.contains('spot')), await tip());
await click(page.locator('#shelves tr[data-pallet="F12317-111"] .scan.qty'));
await click(page.locator('#shelves .scan', { hasText: /^F01B003$/ }).first());
await skipComments();
check('Counting it ticks "find a pallet from the Not in Location list"', await waitCheck('found'));
const lostRow = clean(await page.locator('#modePane tr[data-lost="F12317-111"]').textContent());
check('…and the pane shows where it turned up', /✓ found in F01B003/.test(lostRow), lostRow);
check('The real Not in Location page still has nothing', (await get('/api/admin/missing')).summary.total === 0);

/* ---- a new run clears the lot ---- */
await page.click('#btnReset');
await wait(1500);
const fresh = await get('/api/admin/practice');
check('Start over clears the cycle count, the moves and the lost list', !fresh.modes.cycle.on && !fresh.modes.moves.on && !fresh.modes.missing.on && fresh.checklist.length === 12, fresh.checklist.map((c) => c.key).join(','));
check('…back on the full count', await modeBtn('full').evaluate((b) => b.classList.contains('now')) && await page.isHidden('#modePane'));
check('…and the history holds the run, not its companions', fresh.history.length === 1);
check('No script errors on the page', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} practice-mode checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
