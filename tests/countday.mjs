/*
 * The count-day checklist: everything a count day needs in the order it
 * happens, each line with how to do it and a button to the place. The lines
 * the app can see for itself tick themselves from the database and the log;
 * the rest a supervisor ticks, and the tick says who and when. Kept per count.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));
const list = async (S) => j(await fetch(`${BASE}/api/admin/sessions/${S}/countday`, { headers: A }));
const find = (c, key) => c.phases.flatMap((p) => p.items).find((x) => x.key === key);

/* a fresh count: most lines open */
const S = (await post('/api/admin/sessions', { name: 'Count day' })).id;
let c = await list(S);
check('A fresh count: five phases in the order of the day, nothing much done', c.phases.map((p) => p.title).join(' | ') === 'The week before | The day before | Count morning | During the count | Closing out' && c.done < 6 && c.total > 25, `${c.done}/${c.total}`);
check('…every line says how, in steps, and most point at a guide section and a place in the app', c.phases.flatMap((p) => p.items).every((x) => x.how.length >= 2) && c.phases.flatMap((p) => p.items).filter((x) => x.guide && x.goto).length > 20);
check('…the lines the app decides are marked so, and say what is missing', find(c, 'bins').auto && !find(c, 'bins').done && /nothing uploaded/.test(find(c, 'bins').detail) && find(c, 'count').done);
check('…what is needed before anyone can scan is listed', c.required.includes('Upload the bin list') && c.required.includes('Queue the aisles onto the teams'));

/* the app ticks what it can see */
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nK01A001,Dry,K01\nK01A002,Dry,K01\nK02A001,Dry,K02\n' });
await post('/api/admin/people/teams', { name: 'S1-DS01', shift: '1' });
await post('/api/admin/people/employees', { badge: 'CD1', name: 'Cam Day', shift: '1', equipment: ['DOCK TRUCK'] });
await post('/api/admin/people/assign', { badge: 'CD1', teamId: (await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).teams.find((t) => t.name === 'S1-DS01').id });
await post(`/api/admin/sessions/${S}/assignments`, { team: 'S1-DS01', aisles: 'K01', levels: 'A', force: true });
await fetch(`${BASE}/api/admin/sessions/${S}/print/aisle-sheet?t=${encodeURIComponent(tok)}`);
await post('/api/admin/backups', {}).catch(() => {});
c = await list(S);
check('Upload the bin list, load a team, queue the plan, print the aisle sheet: the app ticks each', find(c, 'bins').done && find(c, 'crew').done && find(c, 'plan').done && find(c, 'aisleSheet').done, [find(c, 'bins').done, find(c, 'crew').done, find(c, 'plan').done, find(c, 'aisleSheet').done].join());
check('…and the details say what it saw', /3 bins/.test(find(c, 'bins').detail) && /1 aisle assignment/.test(find(c, 'plan').detail) && /printed/.test(find(c, 'aisleSheet').detail), find(c, 'plan').detail);
check('…a level no team reaches shows on its line', find(c, 'levels').done === true || /No team can reach/.test(find(c, 'levels').detail), find(c, 'levels').detail);

/* a supervisor ticks what the app cannot see */
let r = await fetch(`${BASE}/api/admin/sessions/${S}/countday/tick`, { method: 'POST', headers: A, body: JSON.stringify({ key: 'charge', on: true }) });
c = await j(r);
check('Tick "every scanner on charge": done, by whom, when', r.status === 200 && find(c, 'charge').done && find(c, 'charge').by === 'Dana Whitfield' && find(c, 'charge').at, JSON.stringify(find(c, 'charge')));
r = await fetch(`${BASE}/api/admin/sessions/${S}/countday/tick`, { method: 'POST', headers: A, body: JSON.stringify({ key: 'bins', on: true }) });
c = await j(r);
check('…a line the app decides takes no tick: the bin list stays as the database says', find(c, 'bins').auto && find(c, 'bins').done);
c = await j(await fetch(`${BASE}/api/admin/sessions/${S}/countday/tick`, { method: 'POST', headers: A, body: JSON.stringify({ key: 'charge', on: false }) }));
check('…untick takes it back', !find(c, 'charge').done);
await fetch(`${BASE}/api/admin/sessions/${S}/countday/tick`, { method: 'POST', headers: A, body: JSON.stringify({ key: 'brief', on: true }) });
const S2 = (await post('/api/admin/sessions', { name: 'Another count' })).id;
check('Ticks are kept per count: a new count starts clean', !find(await list(S2), 'brief').done && find(await list(S), 'brief').done);

/* on paper */
const html = await (await fetch(`${BASE}/api/admin/sessions/${S}/print/countday?t=${encodeURIComponent(tok)}`)).text();
check('The checklist prints: the phases, a box per line, the how under each, who ticked it', /Count-day checklist — Count day/.test(html) && (html.match(/<h2>/g) || []).length === 5 && /☑/.test(html) && /☐/.test(html) && /Dana Whitfield/.test(html) && /<ol><li>/.test(html));

/* the page */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#start`);
await signIn(page);
await pickSession(page, S);
await page.waitForSelector('#countdayList .cd-item', { timeout: 10000 });
check('Count setup opens on the checklist, with the progress', /of \d+ done/.test(clean(await page.textContent('#countdayState'))) && (await page.$$('#countdayList .cd-phase')).length === 5, clean(await page.textContent('#countdayState')));
check('…a line the app ticked shows ✓ and app, and cannot be unticked', (await page.$eval('#countdayList .cd-item[data-key="bins"]', (el) => el.classList.contains('done') && el.querySelector('.cd-box').disabled && /app/.test(el.textContent))));
await page.click('#countdayList .cd-item[data-key="wifi"] button:has-text("How?")');
check('…How? opens the steps under the line', await page.$eval('#countdayList .cd-item[data-key="wifi"]', (el) => el.classList.contains('open') && el.querySelectorAll('.cd-how li').length >= 2));
check('…with a link to the guide section', (await page.$eval('#countdayList .cd-item[data-key="plan"] .cd-how a', (a) => a.getAttribute('href'))) === '/guide?open=admin%2Ffirst-full-count&at=15--give-the-teams-their-aisles');
await page.click('#countdayList .cd-item[data-key="wifi"] .cd-box'); await page.waitForTimeout(600);
check('…tick a line on the page: done, with who and when', await page.$eval('#countdayList .cd-item[data-key="wifi"]', (el) => el.classList.contains('done') && /ticked by Dana Whitfield/.test(el.textContent)));
await page.click('#countdayList .cd-item[data-key="offered"] button:has-text("Scanners")'); await page.waitForTimeout(700);
check('…a line\'s button goes to the place: Scanners → This count on the scanners', await page.$eval('[data-sub="gun"]', (el) => el.classList.contains('active')) && await page.$eval('#countGunCard', (el) => el.classList.contains('flash')));
await page.goto(`${BASE}/guide?open=admin%2Ffirst-full-count&at=15--give-the-teams-their-aisles`); await page.waitForTimeout(1500);
check('A guide link opens the guide at its section', /give the teams their aisles/i.test(clean(await page.textContent('#readerBody')).slice(0, 4000)) && await page.evaluate(() => document.getElementById('15--give-the-teams-their-aisles').classList.contains('lit')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
