/*
 * Ready for count day.
 *
 * The check at the top of Settings → Count setup: the site's settings against
 * what a count day needs. It starts with plenty wrong, each thing is put right
 * the way an admin would, and it ends ready - and each line it shows takes
 * the admin to the card that fixes it.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = async (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ready = async (q = '') => j(await fetch(`${BASE}/api/admin/readiness${q}`, { headers: A }));
const has = (r, level, re) => r.checks.some((c) => c.level === level && re.test(c.title));

let r = await ready();
check('With no count at all it is not ready, and says why first', r.state === 'not-ready' && r.checks[0].level === 'fail' && has(r, 'fail', /No open full count/), r.checks.map((c) => c.title).slice(0, 3).join(' | '));
check('…and points at the card that fixes it', r.checks.find((c) => /No open full count/.test(c.title)).fix.card === 'sessionCard');
check('A site admin still on "changeme" is a fail', has(r, 'fail', /changeme/));

const sess = await j(await post('/api/admin/sessions', { name: 'October wall-to-wall' }));
r = await ready();
check('A count with no bin list fails; no report is a warning', has(r, 'fail', /No bin list/) && has(r, 'warn', /No inventory report/));
check('…and one the scanners do not land on is a warning', has(r, 'warn', /do not land on/));
await post(`/api/admin/sessions/${sess.id}/master?kind=bins`, readFileSync(`${S}fixtures/front-royal-bins.csv`, 'utf8'), csv);
await post(`/api/admin/sessions/${sess.id}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\nP-1,S1,Mango,40,F01A001\n', csv);
await post('/api/admin/default-session', { sessionId: sess.id });
r = await ready();
check('Once loaded and made the default, those turn green', has(r, 'ok', /bins on the count/) && has(r, 'ok', /pallets on the report/) && has(r, 'ok', /Scanners land on/), r.checks.filter((c) => c.level !== 'ok').map((c) => c.title).join(' | '));

check('Every job ticked on the scanners is a warning on count day', has(r, 'warn', /also offer Cycle count, Front2Back, Not in Location/));
await post('/api/admin/scanner-jobs', { full: true, cycle: false, move: false, missing: false });
r = await ready();
check('…the full count alone is right', has(r, 'ok', /full count alone/));
await post('/api/admin/scanner-jobs', { full: false, cycle: true });
r = await ready();
check('…and no full count on the scanners is a fail', has(r, 'fail', /do not offer the full count/));
await post('/api/admin/scanner-jobs', { full: true, cycle: false, move: false, missing: false });

check('No scanners registered is a fail', has(r, 'fail', /No scanners registered/));
const dev = await j(await post('/api/admin/devices', { name: 'GUN-01' }));
r = await ready();
check('…registered but never opened is still a fail', has(r, 'fail', /No scanner has opened its link/));
await post(`/api/devices/${dev.uid}`, {}, hdr);
r = await ready();
check('…opened on the device, it is ready', has(r, 'ok', /All 1 scanners are signed in/));

check('No crew list is a warning', has(r, 'warn', /No crew list/) && r.checks.find((c) => /No crew list/.test(c.title)).fix.page === '/teams');
await post('/api/admin/people/employees', { badge: 'E1', name: 'Rosa Delgado' });
r = await ready();
check('…a crew list clears it', has(r, 'ok', /1 people on the crew list/));

await post('/api/admin/idle-config', { minutes: 0 });
r = await ready();
check('The stopped-scanning alert switched off is a warning', has(r, 'warn', /stopped-scanning alert is off/));
await post('/api/admin/idle-config', { minutes: 10 });

check('Backups only on this server are a warning, pointing at OneDrive', has(r, 'warn', /only on this server/) && r.checks.find((c) => /only on this server/.test(c.title)).fix.card === 'onedriveCard');

// the site admin changes the password
await post('/api/admin/me/password', { current: 'changeme', next: 'cold-store-2026' });
const tok2 = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'cold-store-2026' }) }))).token;
A.authorization = 'Bearer ' + tok2;
r = await ready();
check('A changed password clears the fail', !has(r, 'fail', /changeme/) && r.fails === 0, r.checks.filter((c) => c.level === 'fail').map((c) => c.title).join(' | '));
check('…leaving it "nearly": warnings only', r.state === 'nearly', r.state);

const sup = await j(await post('/api/admin/users', { username: 'SUP-R', name: 'Sup R', password: 'dock-side-77', mustChange: false, profile: 'supervisor' }));
const supTok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'SUP-R', password: 'dock-side-77' }) }))).token;
check('Only an admin sees the check', (await fetch(`${BASE}/api/admin/readiness`, { headers: { authorization: 'Bearer ' + supTok } })).status === 403 && !!sup.username);

/* ------------------------------------------------------------ the card */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings`);
await page.fill('#fUser', 'DANA-WHITFIELD'); await page.fill('#fPassword', 'cold-store-2026'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1500);
check('Count setup opens on the count-day check', await page.isVisible('#readyCard') && /nearly ready/.test(await page.textContent('#readyState')));
const rows = await page.$$eval('#readyList .check', (li) => li.map((x) => x.className.replace('check ', '')));
check('…worst first, every line marked', rows.length > 6 && rows.indexOf('ok') > rows.lastIndexOf('warn'), rows.join(','));
await page.click('#readyList .check.warn:has-text("only on this server") button');
await page.waitForTimeout(900);
check('A line\'s button opens the section and the card that fixes it', await page.$eval('[data-sub="backups"]', (el) => el.classList.contains('active')) && await page.$eval('#onedriveCard', (el) => el.classList.contains('flash')));
await page.evaluate(() => window.appApi.showSub('start'));
await page.waitForTimeout(400);
await page.click('#readyList .check.warn:has-text("No inventory") button').catch(() => {});
await post('/api/admin/idle-config', { minutes: 0 }, { ...hdr, authorization: 'Bearer ' + tok2 });
await page.click('#btnReadyRecheck');
await page.waitForTimeout(800);
check('Check again picks up a change made since', /stopped-scanning alert is off/.test(await page.textContent('#readyList')));
check('No page errors', errors.length === 0, errors.join(' | '));
await browser.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
