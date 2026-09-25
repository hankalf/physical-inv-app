/*
 * One box that finds anything.
 *
 * A supervisor's question is rarely "open the pallet report". It is "where is
 * pallet F02-118", "who counted F01A005", "which team has F04", "where do I
 * upload the bin list". Knowing which of four pages and twenty cards answers
 * that is fine after a month and hopeless on day one.
 *
 * Two things are checked here: that the answer comes back with enough on it to
 * BE the answer - a pallet's expected and counted quantity, the team that
 * counted a bin - rather than only a link to a page that might have it; and that
 * the app's own screens are findable by what a person would call them, not by
 * the name a developer gave the tab.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'search test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF02A001,Freezer,F02\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: ['Pallet ID,SKU,Description,Qty,Location,Lot,ABC',
    'SR-1001,SKU-7788,Chicken breast 40lb,100,F01A001,LOT-4471,A',
    'SR-1002,SKU-9900,Ground beef 10lb,50,F01A002,LOT-5512,B'].join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
await fetch(`${BASE}/api/admin/people/employees`, { method: 'POST', headers: A, body: JSON.stringify({ badge: 'E4242', name: 'Marisol Quintana', dept: 'Freezer', equipment: ['SCISSOR LIFT'] }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'SEARCH-07', notes: 'freezer cradle by the dock' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
await fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ deviceId: 'SEARCH-07', team: '3', employees: ['E4242'] }) });
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 'sr1', palletId: 'SR-1001', qty: 88, location: 'F01A001', lot: 'LOT-4471', team: '3', employees: ['E4242'], deviceId: 'SEARCH-07' },
  { clientId: 'sr2', palletId: 'STRAY-99', qty: 12, location: 'F02A001', team: '3', employees: ['E4242'], deviceId: 'SEARCH-07', unknownPallet: 1 },
]) });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { method: 'POST', headers: A, body: JSON.stringify({ team: '3', body: 'Bring the pallet jack back to the dock' }) });

const find = async (q) => j(await fetch(`${BASE}/api/admin/search?q=${encodeURIComponent(q)}&session=${sess.id}`, { headers: A }));
const group = (r, kind) => (r.groups || []).find((g) => g.kind === kind);
const titles = (r, kind) => ((group(r, kind) || {}).rows || []).map((x) => x.title).join(' | ');

/* ---------------- a pallet, answered on the spot ---------------- */
const pal = await find('SR-1001');
check('A pallet is found by its ID', /SR-1001/.test(titles(pal, 'Pallets')), titles(pal, 'Pallets'));
const palRow = group(pal, 'Pallets').rows[0];
check('...with what the report expected and what was counted, so the answer is right there',
  /report: 100/.test(palRow.detail) && /counted: 88/.test(palRow.detail), palRow.detail);
check('...and who counted it', /team 3/.test(palRow.detail), palRow.detail);
check('...and it knows where that lives in the app', palRow.goto.page === '/admin' && palRow.goto.sub === 'reports', JSON.stringify(palRow.goto));

check('A pallet is found by its item number too', /SR-1001/.test(titles(await find('SKU-7788'), 'Pallets')));
check('...and by a word from its description', /SR-1002/.test(titles(await find('ground beef'), 'Pallets')));

/* A pallet counted that was never on the report is the one supervisors hunt
   for, and a search of the report alone would miss it. */
const stray = await find('STRAY-99');
check('A pallet counted but not on the report is found, and said to be exactly that',
  /STRAY-99/.test(titles(stray, 'Counted, not on the report')), JSON.stringify((stray.groups || []).map((g) => g.kind)));

/* ---------------- bins, lots, aisles ---------------- */
const bin = await find('F01A001');
check('A bin is found by its code', /F01A001/.test(titles(bin, 'Bins')), titles(bin, 'Bins'));
check('...saying whether anybody has counted it, and who',
  /1 line\(s\) counted by team 3/.test(group(bin, 'Bins').rows[0].detail), group(bin, 'Bins').rows[0].detail);
const lot = await find('LOT-4471');
check('A lot code is found', /LOT-4471/.test(titles(lot, 'Lots')), titles(lot, 'Lots'));
check('...and choosing it runs the lot search rather than just opening the tab',
  group(lot, 'Lots').rows[0].goto.focus === 'fLotSearch' && group(lot, 'Lots').rows[0].goto.press === 'btnFindLot',
  JSON.stringify(group(lot, 'Lots').rows[0].goto));
const aisle = await find('F02');
check('An aisle is found, with its racking block and whether anybody is in it',
  /F02/.test(titles(aisle, 'Aisles')), titles(aisle, 'Aisles'));

/* ---------------- the things that outlive a count ---------------- */
check('Somebody on the crew is found by name', /Marisol/.test(titles(await find('marisol'), 'Crew')));
check('...or by their clock-in number', /Marisol/.test(titles(await find('E4242'), 'Crew')));
const scanner = await find('SEARCH-07');
check('A scanner is found by name', /SEARCH-07/.test(titles(scanner, 'Scanners')), titles(scanner, 'Scanners'));
check('...and by what somebody wrote in its notes', /SEARCH-07/.test(titles(await find('dock'), 'Scanners')));
check('A count is found by its name', /search test/.test(titles(await find('search test'), 'Counts')));
check('A message sent to the floor is found by what it said',
  /pallet jack/.test(titles(await find('pallet jack'), 'Messages to the floor')));
check('The log is searchable — who did what', ((await find('uploaded')).groups || []).some((g) => g.kind === 'In the log'));

/* ---------------- the edges ---------------- */
check('One letter is not a search — it would match the warehouse', (await find('F')).tooShort === true);
check('A term nobody has is answered honestly, not with everything',
  (await find('zzzzzzz')).hits === 0, String((await find('zzzzzzz')).hits));
check('A wildcard is a character, not a pattern — "%" finds nothing rather than everything',
  (await find('%%')).hits === 0, String((await find('%%')).hits));
check('Searching needs a supervisor sign-in', (await fetch(`${BASE}/api/admin/search?q=SR-1001`)).status === 401);

/* ================= in the page ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(800);

check('The box is in the sidebar, on every page', await page.$('#navSearch') !== null);
const search = async (q) => {
  await page.fill('#navSearch', q);
  await page.waitForFunction(() => !document.getElementById('navResults').hidden, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  return clean(await page.textContent('#navResults'));
};

const palletPanel = await search('SR-1001');
check('Typing a pallet ID shows it, with the numbers', /SR-1001/.test(palletPanel) && /counted: 88/.test(palletPanel), palletPanel.slice(0, 160));

/* The app's own screens, by the name a person would use rather than the tab's */
const where = await search('upload bin list');
check('"upload bin list" finds the place that does it', /Upload the bin list/.test(where), where.slice(0, 140));
check('...and says which page and tab it is on', /settings/.test(where), where.slice(0, 140));
const kb = await search('keyboard');
check('"keyboard" finds the scanner screen settings', /Scanner screen/.test(kb), kb.slice(0, 140));
const appr = await search('approve');
check('"approve" finds the adjustments tab', /Adjustments/.test(appr), appr.slice(0, 140));

/* Going there: a hit on this page switches tab; the card it landed on says so. */
await search('find a lot');
await page.click('#navResults .hit');
await page.waitForTimeout(1200);
check('Choosing a place goes there', await page.$eval('[data-sub="reports"]', (el) => el.classList.contains('active')));

await search('LOT-4471');
const lotHit = await page.$('#navResults .hit');
await lotHit.click();
await page.waitForTimeout(1600);
check('Choosing a lot fills the lot box and runs it, rather than leaving somebody to retype it',
  (await page.inputValue('#fLotSearch')) === 'LOT-4471' && /LOT-4471/.test(clean(await page.textContent('#lotTable'))),
  clean(await page.textContent('#lotMsg')).slice(0, 90));

/* From another page: the search sends you across and lands on the right tab. */
await page.goto(BASE + '/settings');
await page.waitForSelector('#scrMain.active');
await page.waitForTimeout(700);
await page.fill('#navSearch', 'racking blocks');
await page.waitForTimeout(700);
await page.click('#navResults .hit');
await page.waitForTimeout(700);
check('A hit on another page takes you to that page, on the right tab',
  /\/settings/.test(page.url()) && await page.$eval('[data-sub="lists"]', (el) => el.classList.contains('active')), page.url());

/* Keyboard: "/" from anywhere, Escape to put it away. */
await page.goto(BASE + '/admin');
await page.waitForSelector('#scrMain.active');
await page.waitForTimeout(700);
await page.keyboard.press('/');
check('"/" puts the cursor in the search box from anywhere on the page',
  await page.evaluate(() => document.activeElement?.id === 'navSearch'));
await page.keyboard.type('SR-100');
await page.waitForTimeout(900);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape puts it away', await page.$eval('#navResults', (el) => el.hidden));

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} search checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
