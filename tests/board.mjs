/* The office board and the scanner setup cards: two pages nobody signs in to. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* ---------------- a count worth watching ---------------- */
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'board session' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '1', aisles: 'F01', levels: 'A-C', force: true }) });

const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'BOARD-01', notes: 'freezer' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
await fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ team: '1', employees: ['E1001', 'E1002'], deviceId: 'BOARD-01' }) });
const pallets = readFileSync(`${S}fixtures/pallets.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const mine = pallets.filter((c) => /^F01/.test(c[5] || '')).slice(0, 12);
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify(
  mine.map((c, i) => ({ clientId: 'b' + i, palletId: c[0], qty: i === 0 ? 1 : Number(c[4]), location: c[5], team: '1', employees: ['E1001', 'E1002'], deviceId: 'BOARD-01' }))) });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/recounts/generate`, { method: 'POST', headers: A, body: '{}' });

/* ---------------- the payload is progress and nothing else ---------------- */
const res = await fetch(`${BASE}/api/board`);
check('The board needs no sign-in at all', res.ok, String(res.status));
const d = await j(res);
check('It picks the open full count on its own', d.session && d.session.name === 'board session', d.session && d.session.name);
check('It carries the headline numbers', d.pct > 0 && d.bins.total === 13673 && d.pallets.found === 12,
  `${d.pct}% · ${d.bins.counted}/${d.bins.total} bins · ${d.pallets.found}/${d.pallets.total} pallets`);
check('It carries one row per team, with the aisle they are in', d.teams.length === 1 && d.teams[0].team === '1' && d.teams[0].aisle === 'F01' && d.teams[0].crew === 2,
  JSON.stringify(d.teams[0]));
check('It counts the second counts that are open', d.recounts.open > 0, JSON.stringify(d.recounts));
check('It carries every aisle with its progress', d.aisles.length === 28 && d.aisles.some((a) => a.aisle === 'F01' && a.counted > 0),
  `${d.aisles.length} aisles`);

const flat = JSON.stringify(d);
check('It leaks no pallet IDs', !/PLT\d/.test(flat), (flat.match(/PLT\w+/) || [])[0] || 'none');
check('It leaks no clock in numbers', !/E100\d/.test(flat), (flat.match(/E100\d/) || [])[0] || 'none');
check('It offers no way to change anything', (await fetch(`${BASE}/api/board`, { method: 'POST' })).status >= 400);
const closed = await fetch(`${BASE}/api/board?session=999999`);
check('An unknown session id does not blow it up', closed.ok && (await j(closed)).session === null, String(closed.status));

/* ---------------- on a screen ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(BASE + '/board');
await page.waitForTimeout(2200);
check('Board: /board serves it with no sign-in screen', (await page.$('#fPassword')) === null && (await page.$('#bPct')) !== null);
check('Board: the headline percentage is on screen', Number(await page.textContent('#bPct')) > 0, await page.textContent('#bPct'));
check('Board: the team row shows who is where', /F01/.test(await page.textContent('#bTeams')) && /just now|min ago/.test(await page.textContent('#bTeams')),
  clean(await page.textContent('#bTeams')).slice(0, 110));
check('Board: every aisle gets a tile, and the one being counted is marked',
  (await page.$$('.ai')).length === 28 && (await page.$$('.ai.active')).length === 1, `${(await page.$$('.ai')).length} tiles`);
check('Board: it fits the screen without scrolling',
  await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight) === 0);
check('Board: the tab title carries the number, for a browser on a wall',
  /^\d/.test(await page.title()), await page.title());
await page.screenshot({ path: `${S}screenshots/board.png` });

// it must survive the server going away rather than blanking the wall
const before = await page.textContent('#bPct');
await page.route('**/api/board*', (r) => r.abort());
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(1200);
check('Board: when it cannot reach the server it keeps the last numbers and says so',
  (await page.textContent('#bPct')) === before, `still ${await page.textContent('#bPct')}%`);
await page.unroute('**/api/board*');
await page.close();

/* ---------------- the printed setup cards ---------------- */
for (const n of ['BOARD-02', 'BOARD-03']) await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: n }) });
check('The cards need a token like any other print page', (await fetch(`${BASE}/api/admin/print/scanner-cards`)).status === 401);
const cards = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
cards.on('pageerror', (e) => errors.push('cards: ' + e.message));
await cards.goto(`${BASE}/api/admin/print/scanner-cards?t=${tok}`);
await cards.waitForTimeout(1600);
check('Cards: one per scanner, each with its own QR drawn', (await cards.$$('.card')).length === 3 && (await cards.$$('.qr img, .qr canvas')).length >= 3,
  `${(await cards.$$('.card')).length} cards`);
check('Cards: each carries its own enrolment link, and they differ',
  new Set(await cards.$$eval('.url', (u) => u.map((x) => x.textContent))).size === 3);
check('Cards: the link on the card is the one that actually enrols that scanner',
  (await cards.$$eval('.url', (u) => u.map((x) => x.textContent))).some((t) => t.includes(dev.uid)), dev.uid);
check('Cards: they say what to do with them', /Add to Home screen/.test(await cards.textContent('body')));
await cards.screenshot({ path: `${S}screenshots/scanner-cards.png`, fullPage: true });
await cards.close();
const log = await j(await fetch(`${BASE}/api/admin/audit?limit=40`, { headers: A }));
check('Printing the cards is recorded in the log', log.some((r) => r.action === 'printed scanner setup cards'), '');

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} board checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
