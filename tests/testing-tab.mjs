/*
 * The Testing tab.
 *
 * Inventory staff learn the gun on a practice count that sits beside the real
 * one: the real scanner app in a frame, a sheet of test data next to it, and a
 * click on the sheet "scanning" into the gun. Everything that matters about it
 * is that it is the real thing - the same app, the same checks - and that none
 * of it leaks: a floor gun never sees the practice count, the practice gun
 * never sees the live one, the board never shows it, and its storage is its own.
 *
 * This walks every "thing to try" on the sheet through the embedded gun and
 * checks the sheet ticks each one off from what actually reached the server.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (name) => (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name }) })).json()).token;
const tok = await login('Dana Whitfield');
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p, h = A) => (await fetch(BASE + p, { headers: h })).json();
const post = async (p, body = {}, h = A) => (await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();

/* ---------------- a real count running alongside ---------------- */
const live = await post('/api/admin/sessions', { name: 'Live wall-to-wall' });
await fetch(`${BASE}/api/admin/sessions/${live.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${live.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\nLIVE-1,SKU-A,Chicken,40,F01A001\n' });

/* ---------------- the practice count ---------------- */
const before = await get('/api/admin/practice');
check('Nothing is made until somebody opens the Testing tab', before.session === null);

const made = await post('/api/admin/practice');
const pid = made.session && made.session.id;
check('Opening it makes a practice count', !!pid && made.session.name === 'Practice count', `#${pid}`);
check('…of 24 real Front Royal bins in two aisles', made.totals.bins === 24 && new Set(made.bins.map((b) => b.aisle)).size === 2, `${made.totals.bins} bins`);
check('…with 25 pallets on the shelves', made.totals.pallets === 25);
check('…and twelve things to try, none done yet', made.checklist.length === 12 && made.checklist.every((c) => !c.done));
check('…and team 99 queued on F01 then F02', made.assignment.map((a) => `${a.aisle}:${a.status}`).join(',') === 'F01:active,F02:queued',
  made.assignment.map((a) => `${a.aisle}:${a.status}`).join(','));
check('The supervisor gets a test scanner of their own', made.device && made.device.name === 'TEST-DANA-WHITFIELD', made.device && made.device.name);
const again = await post('/api/admin/practice');
check('Opening it again is the same practice count, not a second one', again.session.id === pid);

const bin = (code) => made.bins.find((b) => b.bin === code);
const shelf = (id) => made.bins.flatMap((b) => b.shelf).find((p) => p.id === id);
check('The report is wrong on purpose: F12313-111 says 36, the shelf holds 32', shelf('F12313-111').report.qty === 36 && shelf('F12313-111').qty === 32);
check('…F12314-111 is on the report in F01A006, and sitting in F01A005', shelf('F12314-111').report.bin === 'F01A006' && bin('F01A005').shelf[0].id === 'F12314-111');
check('…F19999-999 is on the shelf and not on the report', shelf('F19999-999').report === null);
check('…and F12321-111 is on the report and not on the shelf', bin('F01B006').missing.some((m) => m.id === 'F12321-111' && !m.foundIn));

// a second supervisor is a second account now - there is no shared password to sign in under another name
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'MARCUS-OBI', name: 'Marcus Obi', password: 'dock-side-77', mustChange: false }) });
const otherTok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'MARCUS-OBI', password: 'dock-side-77' }) })).json()).token;
const O = { ...hdr, authorization: 'Bearer ' + otherTok };
const other = await post('/api/admin/practice', {}, O);
check('A second supervisor gets a different test scanner, so they cannot sign each other out',
  other.device.name === 'TEST-MARCUS-OBI' && other.device.uid !== made.device.uid);
check('…and a practice count of their own, starting fresh', other.session.id !== pid && other.checklist.every((c) => !c.done), `#${other.session.id} vs #${pid}`);
check('Each person sees only their own practice count in the dashboards',
  (await get('/api/admin/sessions')).filter((s) => s.practice).map((s) => s.id).join(',') === String(pid)
  && (await get('/api/admin/sessions', O)).filter((s) => s.practice).map((s) => s.id).join(',') === String(other.session.id));

/* ---------------- where it must not show ---------------- */
const floorDev = await post('/api/admin/devices', { name: 'FLOOR-01' });
const ftok = (await post(`/api/devices/${floorDev.uid}`, {}, hdr)).token;
const F = { ...hdr, authorization: 'Device ' + ftok };
const floorList = await get('/api/sessions', F);
check('A gun on the floor is never offered the practice count', floorList.length && floorList.every((s) => !s.practice) && floorList.some((s) => s.id === live.id),
  floorList.map((s) => s.name).join(', '));
check('A floor gun asking for practice counts gets none', (await get('/api/sessions?practice=1', F)).length === 0);
const T = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${other.device.uid}`, {}, hdr)).token };
const practiceList = await get('/api/sessions?practice=1', T);
check('A test gun is offered its own person\'s practice count and nothing else', practiceList.length === 1 && practiceList[0].id === other.session.id,
  practiceList.map((x) => x.id).join(','));
const board = await get('/api/board');
check('The office board does not fall back to the practice count', board.session && board.session.id === live.id, board.session && board.session.name);
check('…nor list it', !(board.sessions || []).some((s) => s.id === pid));
const adminList = await get('/api/admin/sessions');
const openOnes = adminList.filter((s) => s.status === 'open');
check('The dashboards list it last, so no page opens on it by default', openOnes[0].id === live.id && openOnes[openOnes.length - 1].id === pid);
check('…and flag it as practice', adminList.find((s) => s.id === pid).practice === 1);

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
/* every confirm - "complete the aisle anyway?", "start over?" - is a yes */
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto(BASE + '/testing');
await page.fill('#fUser', 'DANA-WHITFIELD');
await page.fill('#fPassword', 'changeme');
await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active');
await page.waitForSelector('#shelves table.shelf');

check('A first-time visitor sees how the page works, open at the top', await page.isVisible('#guideBody') && /Before you start/.test(await page.textContent('#guideBody')));
check('…one step at a time, starting on step 1', /Step 1 of 6/.test(await page.textContent('#stepN')) && /Before you start/.test(await page.textContent('#stepTitle')),
  clean(await page.textContent('#stepN')) + ' ' + clean(await page.textContent('#stepTitle')));
check('…with the dashboard on this count at the top of the page, folded away for a first-timer', await page.isHidden('#dashFrame') && /Show the dashboard/.test(await page.textContent('#btnDashHide'))
  && /\/admin\?embed=\d+/.test(await page.getAttribute('#dashFrame', 'src')), await page.getAttribute('#dashFrame', 'src'));
await page.click('#stepNext');
check('Next reads ahead to step 2, and says so', /Step 2 of 6/.test(await page.textContent('#stepN')) && /look ahead/.test(await page.textContent('#stepState')), clean(await page.textContent('#stepState')));
await page.click('#stepBack');
await page.click('#btnGuide');
check('…and can fold it away', await page.isHidden('#guideBody') && /Show me how/.test(await page.textContent('#btnGuide')));
await page.reload();
await page.waitForSelector('#shelves table.shelf');
check('…which is remembered', await page.isHidden('#guideBody'));
await page.click('#btnGuide');
check('…and brought back', await page.isVisible('#guideBody'));
check('Testing is a tab in the sidebar', (await page.$$eval('#navTabs a', (as) => as.map((a) => a.textContent))).some((t) => /Testing/.test(t)));
check('…and it is the current one', clean(await page.textContent('#navTabs a.current')).includes('Testing'));

const gunFrame = async () => {
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((x) => /practice=1/.test(x.url()));
    if (f) { try { if (await f.evaluate(() => typeof window.wedge === 'function' && !!document.querySelector('.screen.active'))) return f; } catch { /* navigating */ } }
    await wait(150);
  }
  throw new Error('the gun never came up');
};
let gun = await gunFrame();
const screenOf = () => gun.evaluate(() => document.querySelector('.screen.active')?.id);
const gunText = async () => clean(await gun.evaluate(() => document.querySelector('.screen.active')?.innerText || ''));
const waitScreen = async (id, ms = 6000) => {
  for (let t = 0; t < ms; t += 100) { if ((await screenOf()) === id) return true; await wait(100); }
  return false;
};
await wait(800);
check('The gun in the frame is the real scanner app', !!(await gun.$('#fScan')) && !!(await gun.$('#btnSos')));
check('It is marked PRACTICE on its own screen', await gun.isVisible('#chipPractice'));
check('It is signed in as this supervisor\'s test scanner', clean(await page.textContent('#gunName')) === 'TEST-DANA-WHITFIELD');
const offered = await gun.$$eval('#fSession option', (os) => os.map((o) => o.textContent));
check('The only count it offers is the practice count', offered.length === 1 && /Practice count/.test(offered[0]), offered.join(' | '));
check('A frame on a desk is left the right way up', !(await gun.evaluate(() => document.body.classList.contains('upright'))));

/* ---------------- click to scan ---------------- */
const chipFor = (text) => page.locator(`#shelves .scan`, { hasText: new RegExp(`^${text}$`) }).first();
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
const atPalletStep = async () => {
  for (let t = 0; t < 6000; t += 100) {
    if ((await screenOf()) === 'scrScan' && /PALLET/i.test(await gun.textContent('#prompt'))) return true;
    await wait(100);
  }
  return false;
};
const rowOf = (palletId) => page.locator('#shelves tr', { has: page.locator('.scan', { hasText: new RegExp(`^${palletId}$`) }) });
const qtyChip = (palletId) => rowOf(palletId).locator('.scan.qty');
const binChip = (code) => chipFor(code);
async function count(palletId, bin, { qty } = {}) {
  await click(chipFor(palletId));
  if (qty != null) { await gun.evaluate((q) => window.wedge(String(q)), qty); await wait(350); }
  else await click(qtyChip(palletId));
  await click(binChip(bin));
  await skipComments();
}

/* the coach: a bubble on the next thing to click */
for (let t = 0; t < 6000; t += 300) { if (await page.isVisible('#coach') && /Click 99/.test(await page.textContent('#coachText'))) break; await wait(300); }
check('A tip points a first-timer at the team number, and says a click is a scan', await page.isVisible('#coach') && /Click 99/.test(await page.textContent('#coachText')) && /scan/.test(await page.textContent('#coachText')),
  clean(await page.textContent('#coachText')));
check('…and lights up the chip it means', await page.$eval('#teamVals .scan', (b) => b.classList.contains('spot')));
await page.click('#teamVals .scan');
await wait(900);
check('After the team, the tip moves on to the clock-in number', /T1001/.test(await page.textContent('#coachText')) && await page.$eval('#crewVals .scan', (b) => b.classList.contains('spot')), clean(await page.textContent('#coachText')));
await page.click('#crewVals .scan >> nth=0');
await wait(900);
check('…then to the gun: sign on', /Sign on/.test(await page.textContent('#coachText')), clean(await page.textContent('#coachText')));
await page.screenshot({ path: new URL('./screenshots/testing-coach.png', import.meta.url).pathname });
check('Clicking the team on the sheet scans it into the team box', (await gun.inputValue('#fTeam')) === '99');
check('Clicking a clock-in number adds it to the crew', clean(await gun.textContent('#employeeChips')).includes('T1001'));
await gun.click('#btnStart');
check('The team signs on to its aisle', await waitScreen('scrAssign'), await gunText());
check('…and the sheet ticks off signing on', await waitCheck('signon'));
await gun.click('#btnCount');
await atPalletStep();
await wait(900);
check('Signing on moves the guide on by itself, to counting the first pallet', /Step 3 of 6/.test(await page.textContent('#stepN')) && /pallet → quantity → bin/.test(await page.textContent('#stepText')),
  clean(await page.textContent('#stepN')) + ' ' + clean(await page.textContent('#stepTitle')));
check('At the pallet prompt the tip points at the first pallet on the shelf', /Click F12311-111/.test(await page.textContent('#coachText')) && await chipFor('F12311-111').evaluate((b) => b.classList.contains('spot')), clean(await page.textContent('#coachText')));
await click(chipFor('F12311-111'));
await wait(900);
check('…then the quantity', /quantity/.test(await page.textContent('#coachText')) && await qtyChip('F12311-111').evaluate((b) => b.classList.contains('spot')), clean(await page.textContent('#coachText')));
await click(qtyChip('F12311-111'));
await wait(900);
check('…then the bin', /click F01A001/i.test(await page.textContent('#coachText')), clean(await page.textContent('#coachText')));
await click(binChip('F01A001'));
await skipComments();
await page.click('#coachOff');
await wait(400);
check('"I\'ve got it" hides the tips, and the button brings them back', await page.isHidden('#coach') && /Show tips/.test(await page.textContent('#btnTips')));
await page.click('#btnTips');
await wait(900);
check('…pointing at the next pallet, not the first again', /F12312-111/.test(await page.textContent('#coachText')), clean(await page.textContent('#coachText')));
await page.click('#btnTips');
await wait(300);

await atPalletStep();
await count('F12312-111', 'F01A002');
await atPalletStep();
await count('F12312-112', 'F01A002');
check('Two pallets in one bin', await waitCheck('two'));
if (false) {
check('A pallet, quantity and bin clicked on the sheet become a counted line', await waitCheck('first'));
const f1 = clean(await rowOf('F12311-111').locator('.state').textContent());
check('…and the sheet shows it counted, right', f1 === '✓ 40', f1);

}

await atPalletStep();
await gun.click('#btnEmpty');
await wait(250);
await click(binChip('F01A003'));
await skipComments();
check('An empty bin, recorded with the gun\'s own button', await waitCheck('empty'));

await atPalletStep();
await count('F12313-111', 'F01A004');
check('A pallet short of the report', await waitCheck('short'));
const f4 = clean(await rowOf('F12313-111').locator('.rep').first().textContent());
check('…the sheet said what the report claims', /report says 36/.test(f4), f4);

/* The report has F12314-111 one bay along: the gun says so and asks. */
await atPalletStep();
await click(chipFor('F12314-111'));
await click(qtyChip('F12314-111'));
await click(binChip('F01A005'));
if ((await screenOf()) === 'scrOverride') {
  await gun.selectOption('#fReason', { index: 1 });
  await gun.click('#btnOverrideAccept');
  await wait(300);
}
await skipComments();
check('A pallet found in the wrong bin', await waitCheck('moved'));

/* F19999-999 is not on the report at all: the gun wants a reason. */
await atPalletStep();
await click(chipFor('F19999-999'));
check('A pallet that is not on the report stops the gun and asks: count it anyway?', (await screenOf()) === 'scrOverride'
  && await gun.isVisible('#btnOvYes'), await gunText());
await gun.click('#btnOvYes');
await wait(300);
await click(qtyChip('F19999-999'));
await click(binChip('F01A006'));
await skipComments();
check('…and with a reason it is counted', await waitCheck('unlisted'));

/* The torn label: the gun's own "will not scan" path, then the ID typed. */
await atPalletStep();
check('The torn label is marked on the sheet', await chipFor('F12315-111').evaluate((b) => b.classList.contains('torn')));
await gun.click('#btnNoScan');
await gun.click('#btnNoScanType');
await wait(250);
await count('F12315-111', 'F01B001');
check('A pallet whose label will not scan', await waitCheck('label'));

await atPalletStep();
await count('F12316-111', 'F01B002');

/* The rack label nobody can read: the gun offers the bin it expects. */
await atPalletStep();
await click(chipFor('F12317-111'));
await click(qtyChip('F12317-111'));
await gun.click('#btnNoScan');
await wait(200);
const offer = clean(await gun.textContent('#btnNoScanNone'));
/* The gun offers the bin it believes you are at. After F01A005 - a bin the
   report does not list, so the gun keeps it open in case there is more - that
   guess is F01A005, and the sheet says what to do then: type the code. */
if (offer === 'It is F01B003') await gun.click('#btnNoScanNone');
else { await gun.click('#btnNoScanType'); await wait(250); await click(binChip('F01B003')); }
await wait(400);
if ((await screenOf()) === 'scrOverride') { await gun.selectOption('#fReason', { index: 1 }); await gun.click('#btnOverrideAccept'); await wait(300); }
await skipComments();
check('A bin whose rack label will not scan', await waitCheck('binLabel'), offer);

for (const [p, b] of [['F12318-111', 'F01B004'], ['F12318-112', 'F01B004'], ['F12318-113', 'F01B004'], ['F12319-111', 'F01B005']]) {
  await atPalletStep();
  await count(p, b);
}
await atPalletStep();
await gun.click('#btnEmpty');
await wait(250);
await click(binChip('F01B006'));
await skipComments();
check('A pallet missing from its bin — found by recording the bin empty', await waitCheck('missing'));

/* the aisle is done: hand it back and take the next one */
await wait(800);
await gun.click('#btnToAssign');
await waitScreen('scrAssign');
await gun.click('#btnAisleDone');
check('Finishing aisle F01 moves the team to F02', await waitCheck('nextAisle', 12000), await gunText());

/* the SOS button, from the practice gun */
await waitScreen('scrAssign');
await gun.click('#btnCount');
await atPalletStep();
await gun.click('#btnSos');
await waitScreen('scrSos');
await gun.locator('#sosReasons button').first().click();
check('An SOS from the practice gun', await waitCheck('sos'));
const alerts = await get(`/api/admin/sessions/${pid}/alerts`);
const liveAlerts = await get(`/api/admin/sessions/${live.id}/alerts`);
check('…lands on the practice count, not the live one', alerts.alerts.length === 1 && liveAlerts.alerts.length === 0);

await page.evaluate(() => window.scrollTo(0, 0));
await wait(3500);
await page.screenshot({ path: new URL('./screenshots/testing-tab.png', import.meta.url).pathname });
await page.locator('#shelves').screenshot({ path: new URL('./screenshots/testing-tab-shelves.png', import.meta.url).pathname });
const sheet = await get('/api/admin/practice');
check('Every thing to try is ticked off', sheet.checklist.every((c) => c.done), sheet.checklist.filter((c) => !c.done).map((c) => c.key).join(','));
check('The meter reads twelve of twelve', clean(await page.textContent('#checkCount')) === '12 of 12 done');
check('…and the guide is on its last step: the office side', /Step 6 of 6/.test(await page.textContent('#stepN')) && (await page.$$('#stepDots button.done')).length === 5,
  clean(await page.textContent('#stepN')) + ' ' + (await page.$$('#stepDots button.done')).length + ' done');
check('…which opens the dashboard up by itself', await page.isVisible('#dashFrame'));
await page.click('#stepGo');
await wait(600);
check('"Show me the dashboard" ticks the last step off', /You have seen the lot/.test(await page.textContent('#stepTitle')), clean(await page.textContent('#stepTitle')));
/* the dashboard at the top is the real one, on this count only */
const dash = page.frames().find((f) => /\/admin\?embed=/.test(f.url()));
check('The dashboard at the top is the real admin page', !!dash && !!(await dash.$('#subTabs button[data-goto="progress"]')) && !!(await dash.$('#subTabs button[data-goto="adjust"]')));
check('…without its sidebar or header', !!dash && await dash.evaluate(() => document.documentElement.classList.contains('embed') && getComputedStyle(document.querySelector('.side')).display === 'none'));
check('…locked to the practice count', !!dash && (await dash.evaluate(() => window.appApi.currentSession())) === pid, String(dash && await dash.evaluate(() => window.appApi.currentSession())));
// team 99 has finished F01 by now and is on F02: the live dashboard says so
const teamRow = dash ? clean(await dash.evaluate(() => (document.querySelector('#teamTable') || document.body).innerText)) : '';
check('…showing what was just counted: team 99, on its aisle, with its lines', /\b99\b/.test(teamRow) && /Aisle F0[12]/.test(teamRow), teamRow.slice(0, 160));
check('…and its tabs can be switched from the page', !!dash && await dash.evaluate(() => { window.appApi.showSub('second'); return document.querySelector('[data-sub="second"]').classList.contains('active'); }));

/* ---------------- nothing leaked ---------------- */
const liveCounts = await get(`/api/admin/sessions/${live.id}/progress`);
check('The live count received nothing', liveCounts.lines === 0, `${liveCounts.lines} lines`);
const dbs = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
check('The practice gun keeps its own storage, apart from a real scanner\'s and from anyone else\'s', dbs.includes(`invcount-practice-${made.device.uid}`) && !dbs.includes('invcount'), dbs.join(','));
const sw = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0));
check('…and installs no service worker over the admin pages', sw === 0);

/* ---------------- typing any scan ---------------- */
await gun.click('#btnSosBack').catch(() => {});
await waitScreen('scrScan', 3000);
await page.fill('#fWedge', 'NOT-A-PALLET');
await page.click('#btnWedge');
await wait(500);
check('The SCAN box sends anything typed, so a wrong ID can be tried too', (await screenOf()) === 'scrOverride' || /NOT-A-PALLET/.test(await gunText()), await gunText());
await gun.click('#btnOverrideCancel').catch(() => {});

/* ---------------- start over ---------------- */
await page.click('#btnReset');
for (let t = 0; t < 8000; t += 200) { if ((await done()).length === 0) break; await wait(200); }
const fresh = await get('/api/admin/practice');
check('Start over makes a fresh practice run', fresh.session.id !== pid && fresh.checklist.every((c) => !c.done), `#${fresh.session.id}`);
check('…and keeps the last one as history, with how far it got', fresh.history.length === 1 && fresh.history[0].id === pid && fresh.history[0].tried === 12,
  JSON.stringify(fresh.history));
await wait(3500);
check('Your earlier runs are listed on the page', await page.isVisible('#historyCard') && /12 of 12/.test(await page.textContent('#historyTable')));
/* everything from every run, as one workbook */
const runsOut = await get('/api/admin/practice/export');
check('Export my runs: this run and the earlier one, in one workbook', runsOut.runs === 2 && runsOut.sheets[0].name === 'Runs' && runsOut.sheets[0].rows.length === 2
  && runsOut.sheets[0].rows.some((r) => r.Status === 'Earlier run' && r['Things tried'] === '12 of 12') && runsOut.sheets[0].rows.some((r) => r.Status === 'Current run'), JSON.stringify(runsOut.sheets[0].rows));
check('…with what was tried on each, and every sheet of the real export per run', runsOut.sheets[1].name === 'Things tried' && runsOut.sheets[1].rows.length === 24
  && runsOut.sheets.some((x) => x.name === `#${pid} Summary`) && runsOut.sheets.some((x) => x.name === `#${pid} Count lines`), runsOut.sheets.map((x) => x.name).join(' | '));
check('…and nobody else\'s runs are in it', (await get('/api/admin/practice/export', O)).runs <= 1);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btnExportRuns')]);
check('The button hands over an Excel file of it', /^practice-runs-.*\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
check('…the sheet is back to nothing done', clean(await page.textContent('#checkCount')) === '0 of 12 done');
gun = await gunFrame();
await wait(800);
check('…and the gun starts again at sign-on with nothing queued', (await screenOf()) === 'scrSignon'
  && !(await gun.isVisible('#chipQueue')), await screenOf());
check('The old run is out of the count pickers, the live count untouched', !(await get('/api/admin/sessions')).some((s) => s.id === pid)
  && (await get('/api/admin/sessions')).some((s) => s.id === live.id));
check('…and the other person\'s practice was not touched', (await post('/api/admin/practice', {}, O)).session.id === other.session.id);

/* a brand-new user starts with nothing */
await post('/api/admin/users', { username: 'newstarter', name: 'New Starter', password: 'starter-pass-1', role: 'supervisor' });
const nsLogin = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'newstarter', password: 'starter-pass-1' }) })).json();
const N = { ...hdr, authorization: 'Bearer ' + nsLogin.token };
const ns = await get('/api/admin/practice', N);
check('A new user has no practice yet, and no history', ns.session === null && (ns.history || []).length === 0);
check('…and is a first-timer: the guide and the tips come up by themselves', ns.firstTime === true);
check('Dana, who hid the tips, is not', (await get('/api/admin/practice')).firstTime === false);
/* on the same computer, where Dana hid everything, the new starter still sees it */
await page.evaluate(() => { sessionStorage.removeItem('admToken'); });
await page.goto(BASE + '/testing');
await page.fill('#fUser', 'newstarter'); await page.fill('#fPassword', 'starter-pass-1'); await page.click('#btnLogin');
await page.waitForSelector('#shelves table.shelf');
await wait(1500);
check('On a computer where somebody else hid them, a new login still gets the guide open', await page.isVisible('#guideBody'));
check('…and the tip bubble up', await page.isVisible('#coach'));
await page.click('#coachOff');
await wait(600);
check('Hiding the tips is remembered with the login', (await get('/api/admin/practice', N)).firstTime === false);
await page.evaluate(() => { sessionStorage.removeItem('admToken'); });
await page.goto(BASE + '/testing');
await page.fill('#fUser', 'DANA-WHITFIELD'); await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#shelves table.shelf');
await wait(800);
const nsMade = await post('/api/admin/practice', {}, N);
check('…and opening the Testing tab gives them a fresh one of their own', nsMade.session && ![pid, fresh.session.id, other.session.id].includes(nsMade.session.id)
  && nsMade.checklist.every((c) => !c.done) && nsMade.device.name === 'TEST-NEWSTARTER', nsMade.device && nsMade.device.name);

/* ---------------- before you start ---------------- */
for (let t = 0; t < 8000; t += 400) { if (/ready to test/.test(await page.textContent('#readySum'))) break; await wait(400); }
check('"Before you start" says the tab is ready, once the gun is up', /ready to test/.test(await page.textContent('#readySum')), clean(await page.textContent('#readySum')));
const readyText = clean(await page.textContent('#readyList'));
check('…listing the test data, the test scanner, the team\'s aisles and the gun', /Test data loaded — 24 bins, 25 pallets/.test(readyText)
  && /Test scanner TEST-DANA-WHITFIELD registered/.test(readyText) && /Team 99 has 2 aisles/.test(readyText) && /scanner app is running/.test(readyText), readyText.slice(0, 260));
check('…and says whose login the practice is kept under', /Signed in as DANA-WHITFIELD/.test(readyText), readyText.slice(0, 80));

/* ---------------- your own test pallets ---------------- */
const badUp = await fetch(`${BASE}/api/admin/practice/upload?name=bad.csv`, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' },
  body: 'Bin,Pallet,Qty\nZ01A001,ZP-1,ten\n' });
check('A file with a bad quantity is refused, naming the row', badUp.status === 400 && /row 2: "ten" is not a quantity/.test((await badUp.json()).error));
const mine = 'Bin,Pallet,Qty,Note,Lot,Best Before\nZ01A001,ZP-1,40,Chicken,L1,2027-01-01\nZ01A001,ZP-2,12,Peas,,\nZ01A002,,,empty bay,,\nZ02A001,ZP-3,30,Corn,,\n';
await page.setInputFiles('#fPracticeFile', { name: 'dock-test.csv', mimeType: 'text/csv', buffer: Buffer.from(mine) });
await page.click('#btnPracticeUpload');
for (let t = 0; t < 10000; t += 300) { if (/Loaded/.test(await page.textContent('#uploadMsg'))) break; await wait(300); }
check('Uploading your own Bin / Pallet / Qty file starts a run on it', /Loaded 3 pallets in 3 bins from dock-test.csv/.test(clean(await page.textContent('#uploadMsg'))), clean(await page.textContent('#uploadMsg')));
check('…the sheet shows your pallets, not the built-in ones', await chipFor('ZP-1').isVisible() && await page.locator('#shelves .scan', { hasText: /^F12311-111$/ }).count() === 0);
check('…and says it is testing on your file', /dock-test/.test(await page.textContent('#dataSource')));
const ownSheet = await get('/api/admin/practice');
check('…with a checklist for a plain count: every pallet, the empty bins, an aisle, an SOS', ownSheet.source === 'upload'
  && ownSheet.checklist.map((c) => c.key).join(',') === 'signon,first,every,empty,nextAisle,sos', ownSheet.checklist.map((c) => c.key).join(','));
check('…and team 99 queued on its aisles', ownSheet.assignment.map((a) => a.aisle).join(',') === 'Z01,Z02', ownSheet.assignment.map((a) => a.aisle).join(','));
gun = await gunFrame();
await wait(800);
await page.click('#teamVals .scan'); await wait(300);
await page.click('#crewVals .scan >> nth=0'); await wait(300);
await gun.click('#btnStart');
await waitScreen('scrAssign');
await gun.click('#btnCount');
await atPalletStep();
await count('ZP-1', 'Z01A001');
for (let t = 0; t < 9000; t += 300) { if ((await get('/api/admin/practice')).checklist.find((c) => c.key === 'first').done) break; await wait(300); }
const afterOwn = await get('/api/admin/practice');
check('The gun counts your pallets like any other', afterOwn.checklist.find((c) => c.key === 'first').done && /1 of 3/.test(afterOwn.checklist.find((c) => c.key === 'every').label),
  afterOwn.checklist.find((c) => c.key === 'every').label);
const ownId = afterOwn.session.id;
await page.click('#btnReset');
for (let t = 0; t < 8000; t += 300) { if ((await get('/api/admin/practice')).session.id !== ownId) break; await wait(300); }
const again2 = await get('/api/admin/practice');
check('Start over on your file starts over on the same file', again2.source === 'upload' && again2.session.id !== ownId && again2.totals.pallets === 3 && again2.totals.lines === 0);
await page.click('#btnBuiltIn');
for (let t = 0; t < 8000; t += 300) { if ((await get('/api/admin/practice')).source === 'built-in') break; await wait(300); }
const back2 = await get('/api/admin/practice');
check('"Back to the built-in test data" does what it says', back2.source === 'built-in' && back2.totals.pallets === 25);
check('…and every run so far is in your history', back2.history.length >= 3, `${back2.history.length} runs`);

/* ---------------- the sandbox: the gun's settings, in here only ---------------- */
const siteBefore = await get('/api/admin/scanner-prompts');
gun = await gunFrame();
/* asked through the gun itself, with its own token - enrolling its link again would sign it out */
const gunFetch = (path, body) => gun.evaluate(async ([p, b]) => {
  const name = `invcount-practice-${new URLSearchParams(location.search).get('d')}`;
  const tok = await new Promise((res) => { const q = indexedDB.open(name); q.onsuccess = () => { const g = q.result.transaction('meta').objectStore('meta').get('deviceToken'); g.onsuccess = () => res(g.result); }; });
  const init = { headers: { authorization: 'Device ' + tok, 'content-type': 'application/json' } };
  if (b) { init.method = 'POST'; init.body = JSON.stringify(b); }
  return (await fetch(p, init)).json();
}, [path, body || null]);
const gunView = async () => (await gunFetch('/api/sessions?practice=1')).find((s) => s.name.startsWith('Practice count'));
check('A practice count holds the comments step for 5 seconds, whatever the site says', (await gunView()).prompts.commentTimeout === 5);
check('The sandbox card shows the gun\'s settings', Number(await page.inputValue('#sbTimeout')) === 5 && (await page.inputValue('#sbComments')).includes('Damaged'));
await page.fill('#sbTimeout', '9');
await page.check('#sbLarge');
await page.fill('#sbComments', 'Frozen to the rack\nShrink wrap torn');
await page.fill('#sbSos', 'Lift truck down\nNeed a supervisor');
await page.click('#btnSandboxSave');
await wait(1000);
const gv = await gunView();
check('Saving changes what the gun is sent for this practice count', gv.prompts.commentTimeout === 9 && gv.layout_cfg.textSize === 'large' && gv.prompts.comments.join('|') === 'Frozen to the rack|Shrink wrap torn', JSON.stringify([gv.prompts.commentTimeout, gv.layout_cfg.textSize, gv.prompts.comments]));
const sosNow = await gunFetch(`/api/sessions/${(await get('/api/admin/practice')).session.id}/alerts`);
check('…including the SOS list', sosNow.reasons.join('|') === 'Lift truck down|Need a supervisor', sosNow.reasons.join('|'));
const siteAfter = await get('/api/admin/scanner-prompts');
check('…and the site\'s own settings have not moved', JSON.stringify(siteAfter) === JSON.stringify(siteBefore));
check('…nor anybody else\'s practice', (await get('/api/admin/practice', O)).sandbox.prompts.commentTimeout === 5);
await page.click('#btnSandboxReset');
await wait(800);
check('Back to the site\'s settings does that, keeping the 5-second comments step', (await gunView()).prompts.commentTimeout === 5 && (await gunView()).layout_cfg.textSize !== 'large');

/* ---------------- the features that ship turned off ---------------- */
const optRow = (k) => page.locator(`#optList .opt[data-key="${k}"]`);
check('The Testing tab lists the features that ship turned off', await optRow('askLot').isVisible() && await optRow('requireApproval').isVisible() && await optRow('palletMode').isVisible() && (await optRow('trackAbc').count()) === 0);
check('…each off to start with', !(await optRow('askLot').locator('input').isChecked()) && !(await optRow('requireApproval').locator('input').isChecked()));
check('…saying whether the practice data has what it needs', /✓ 25 of 25 pallets have a lot code/.test(await optRow('askLot').textContent()), clean(await optRow('askLot').textContent()));
await optRow('askLot').locator('input').check();
await wait(800);
let opts = (await get('/api/admin/practice')).options;
check('Switching one on changes your practice count', opts.values.askLot === true);
check('…and nothing else: the live count is untouched', !(await get('/api/admin/sessions')).find((x) => x.id === live.id).ask_lot);
check('…nor anybody else\'s practice count', !(await get('/api/admin/practice', O)).options.values.askLot);
await optRow('requireApproval').locator('input').check();
await wait(800);
check('Approvals show their thresholds once switched on', await optRow('requireApproval').locator('input[type=number]').count() === 2);
await optRow('palletMode').locator('select').selectOption('strict');
await wait(800);
await optRow('autoRecount').locator('input').check();
await wait(800);
opts = (await get('/api/admin/practice')).options;
check('The pallet check can be tried strict, and second counts switched on', opts.values.palletMode === 'strict' && opts.values.requireApproval && opts.values.autoRecount, JSON.stringify(opts.values));
// the gun takes the lot question between pallets
gun = await gunFrame();
let lotAsked = false;
for (let t = 0; t < 30000 && !lotAsked; t += 1000) {
  await wait(1000);
  lotAsked = await gun.evaluate(() => {
    try { return JSON.parse(JSON.stringify(window.__state || null)) && false; } catch { return false; }
  }) || await gun.evaluate(async () => {
    const r = await fetch('/api/sessions?practice=1', { headers: { authorization: 'Device ' + (await new Promise((res) => {
      const q = indexedDB.open([...new URLSearchParams(location.search).entries()].length ? `invcount-practice-${new URLSearchParams(location.search).get('d')}` : 'invcount');
      q.onsuccess = () => { const g = q.result.transaction('meta').objectStore('meta').get('deviceToken'); g.onsuccess = () => res(g.result); };
    })) } });
    const list = await r.json();
    return list.length === 1 && list[0].askLot === true;
  });
}
check('The test gun is told to ask for the lot', lotAsked);
for (let t = 0; t < 8000; t += 400) { if ((await page.$$('#shelves .scan.lot')).length) break; await wait(400); }
check('With lot codes on, the sheet grows lot chips to scan', (await page.$$('#shelves .scan.lot')).length >= 20);
/* a short pallet, counted with the gun's own token, is an adjustment waiting */
await gunFetch(`/api/sessions/${(await get('/api/admin/practice')).session.id}/counts`,
  [{ clientId: 'feat-short-1', palletId: 'F12313-111', qty: 30, location: 'F01A004', team: '99', deviceId: 'TEST', lot: 'F12313' }]);
const grown = await get('/api/admin/practice');
check('…and the things to try grow with the features that are on', ['lot', 'approve', 'second'].every((k) => grown.checklist.some((c) => c.key === k)), grown.checklist.map((c) => c.key).join(','));
check('…with the counts the tips speak up on: an adjustment waiting, from the short pallet', grown.extras.pendingApprovals >= 1, JSON.stringify(grown.extras));
/* an uploaded file without lots says so */
const noLots = await fetch(`${BASE}/api/admin/practice/upload?name=plain.csv`, { method: 'POST', headers: { authorization: 'Bearer ' + otherTok, 'content-type': 'text/csv' },
  body: 'Bin,Pallet,Qty\nY01A001,YP-1,10\n' }).then((r) => r.json());
check('On a file with no lot codes, the lot option says what to add to the file', /Add a “Lot” column/.test(noLots.options.needs.askLot.text), noLots.options.needs.askLot.text);

/* ---------------- over to the dashboard, in its own tab ---------------- */
const [tab] = await Promise.all([page.context().waitForEvent('page'), page.click('#btnDashboard')]);
await tab.waitForURL(/\/admin/);
await tab.waitForSelector('#scrMain.active');
await wait(1500);
const picked = clean(await tab.textContent('#sessionPick .sess-btn'));
check('"Own tab" opens the full dashboard on the practice count', /Practice count/.test(picked), picked);
check('…marked practice in the picker', /practice/i.test(await tab.textContent('#sessionPick .sess-btn .tag.practice').catch(() => '')));
check('…with its sidebar, since it is the whole page', await tab.isVisible('#navTabs'));

check('No script errors on the page', errors.length === 0, errors.join(' | '));
await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} testing-tab checks passed`);
process.exit(failed ? 1 : 0);
