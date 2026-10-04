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
check('The report is wrong on purpose: F01-004 says 36, the shelf holds 32', shelf('F01-004').report.qty === 36 && shelf('F01-004').qty === 32);
check('…F01-005 is on the report in F01A006, and sitting in F01A005', shelf('F01-005').report.bin === 'F01A006' && bin('F01A005').shelf[0].id === 'F01-005');
check('…F01-099 is on the shelf and not on the report', shelf('F01-099').report === null);
check('…and F01-013 is on the report and not on the shelf', bin('F01B006').missing.some((m) => m.id === 'F01-013' && !m.foundIn));

const otherTok = await login('Marcus Obi');
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
await page.fill('#fUser', 'Dana Whitfield');
await page.fill('#fPassword', 'changeme');
await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active');
await page.waitForSelector('#shelves table.shelf');

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

await page.click('#teamVals .scan');
await wait(300);
await page.click('#crewVals .scan >> nth=0');
await wait(300);
check('Clicking the team on the sheet scans it into the team box', (await gun.inputValue('#fTeam')) === '99');
check('Clicking a clock-in number adds it to the crew', clean(await gun.textContent('#employeeChips')).includes('T1001'));
await gun.click('#btnStart');
check('The team signs on to its aisle', await waitScreen('scrAssign'), await gunText());
check('…and the sheet ticks off signing on', await waitCheck('signon'));
await gun.click('#btnCount');
await atPalletStep();

await count('F01-001', 'F01A001');
check('A pallet, quantity and bin clicked on the sheet become a counted line', await waitCheck('first'));
const f1 = clean(await rowOf('F01-001').locator('.state').textContent());
check('…and the sheet shows it counted, right', f1 === '✓ 40', f1);

await atPalletStep();
await count('F01-002', 'F01A002');
await atPalletStep();
await count('F01-003', 'F01A002');
check('Two pallets in one bin', await waitCheck('two'));

await atPalletStep();
await gun.click('#btnEmpty');
await wait(250);
await click(binChip('F01A003'));
await skipComments();
check('An empty bin, recorded with the gun\'s own button', await waitCheck('empty'));

await atPalletStep();
await count('F01-004', 'F01A004');
check('A pallet short of the report', await waitCheck('short'));
const f4 = clean(await rowOf('F01-004').locator('.rep').first().textContent());
check('…the sheet said what the report claims', /report says 36/.test(f4), f4);

/* The report has F01-005 one bay along: the gun says so and asks. */
await atPalletStep();
await click(chipFor('F01-005'));
await click(qtyChip('F01-005'));
await click(binChip('F01A005'));
if ((await screenOf()) === 'scrOverride') {
  await gun.selectOption('#fReason', { index: 1 });
  await gun.click('#btnOverrideAccept');
  await wait(300);
}
await skipComments();
check('A pallet found in the wrong bin', await waitCheck('moved'));

/* F01-099 is not on the report at all: the gun wants a reason. */
await atPalletStep();
await click(chipFor('F01-099'));
check('A pallet that is not on the report stops the gun and asks: count it anyway?', (await screenOf()) === 'scrOverride'
  && await gun.isVisible('#btnOvYes'), await gunText());
await gun.click('#btnOvYes');
await wait(300);
await click(qtyChip('F01-099'));
await click(binChip('F01A006'));
await skipComments();
check('…and with a reason it is counted', await waitCheck('unlisted'));

/* The torn label: the gun's own "will not scan" path, then the ID typed. */
await atPalletStep();
check('The torn label is marked on the sheet', await chipFor('F01-006').evaluate((b) => b.classList.contains('torn')));
await gun.click('#btnNoScan');
await gun.click('#btnNoScanType');
await wait(250);
await count('F01-006', 'F01B001');
check('A pallet whose label will not scan', await waitCheck('label'));

await atPalletStep();
await count('F01-007', 'F01B002');

/* The rack label nobody can read: the gun offers the bin it expects. */
await atPalletStep();
await click(chipFor('F01-008'));
await click(qtyChip('F01-008'));
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

for (const [p, b] of [['F01-009', 'F01B004'], ['F01-010', 'F01B004'], ['F01-011', 'F01B004'], ['F01-012', 'F01B005']]) {
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
const nsMade = await post('/api/admin/practice', {}, N);
check('…and opening the Testing tab gives them a fresh one of their own', nsMade.session && ![pid, fresh.session.id, other.session.id].includes(nsMade.session.id)
  && nsMade.checklist.every((c) => !c.done) && nsMade.device.name === 'TEST-NEWSTARTER', nsMade.device && nsMade.device.name);

/* ---------------- over to the dashboard ---------------- */
await page.click('#btnDashboard');
await page.waitForURL(/\/admin/);
await page.waitForSelector('#scrMain.active');
await wait(1500);
const picked = clean(await page.textContent('#sessionPick .sess-btn'));
check('"Open the dashboard" lands on the practice count', /Practice count/.test(picked), picked);
check('…marked practice in the picker', /practice/i.test(await page.textContent('#sessionPick .sess-btn .tag.practice').catch(() => '')));

check('No script errors on the page', errors.length === 0, errors.join(' | '));
await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} testing-tab checks passed`);
process.exit(failed ? 1 : 0);
