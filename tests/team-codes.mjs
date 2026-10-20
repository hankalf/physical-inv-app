/*
 * Team number codes: a printable card a team with its number as a QR, scanned
 * in the gun's Team number box at sign-on. Every team or one shift, from
 * Teams & crew.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const tok = await login({ password: 'changeme' });
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });

for (const [name, shift] of [['51', '1'], ['52', '2'], ['S1-DS09', '1']]) await post('/api/admin/people/teams', { name, shift, notes: name === '52' ? 'dock side' : '' });

const page = async (q = '') => (await fetch(`${BASE}/api/admin/print/team-codes?t=${encodeURIComponent(tok)}${q}`)).text();
let html = await page();
const teamsOn = (h) => [...h.matchAll(/data-team="([^"]+)"/g)].map((m) => m[1]);
const codesOn = (h) => [...h.matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]);
check('A card for every team on Teams & crew', ['51', '52', 'S1-DS09'].every((t) => teamsOn(html).includes(t)), teamsOn(html).join());
check('…each QR holds the team number and nothing else', ['51', '52', 'S1-DS09'].every((t) => codesOn(html).includes(t)) && codesOn(html).every((c) => teamsOn(html).includes(c)), codesOn(html).join());
check('…and the same number as a Code 128 barcode under the QR, the kind the rack labels use, for a scanner with QR switched off', ['51', '52', 'S1-DS09'].every((t) => html.includes(`data-bars="${t}"`)) && (html.match(/<svg /g) || []).length >= 3 && /Code 128/.test(html));
check('…with the number large, the shift, and the team\'s note', /class="name">S1-DS09</.test(html) && /TEAM · 1st shift/.test(html) && /dock side/.test(html));
html = await page('&shift=2');
check('One shift: the 2nd shift\'s teams alone', teamsOn(html).includes('52') && !teamsOn(html).includes('51') && !teamsOn(html).includes('S1-DS09') && /2nd shift/.test(html), teamsOn(html).join());
html = await page('&only=51');
check('One team by name', teamsOn(html).join() === '51', teamsOn(html).join());
check('The log says who printed them', (await j(await fetch(`${BASE}/api/admin/audit?limit=10`, { headers: A }))).some((x) => x.action === 'printed team number codes'));

/* a login without Downloads may not print them */
await post('/api/admin/users', { username: 'NO-PRINT', name: 'No Print', password: 'cannot-print-1', mustChange: false, profile: 'custom', access: ['teams'] });
const np = await login({ username: 'NO-PRINT', password: 'cannot-print-1' });
check('A login without Downloads is refused', (await fetch(`${BASE}/api/admin/print/team-codes?t=${encodeURIComponent(np)}`)).status === 403);

/* ------------------------------------------------------------------ the page and the gun */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const errors = [];
const office = await ctx.newPage();
office.on('pageerror', (e) => errors.push(e.message));
await office.goto(`${BASE}/teams#crew`);
await signIn(office);
await office.waitForSelector('#btnTeamCodes');
await office.selectOption('#fTeamCodesShift', '1');
const [sheet] = await Promise.all([ctx.waitForEvent('page'), office.click('#btnTeamCodes')]);
sheet.on('pageerror', (e) => errors.push('sheet: ' + e.message));
await sheet.waitForLoadState();
await sheet.waitForFunction(() => [...document.querySelectorAll('.qr')].every((b) => [...b.querySelectorAll('canvas, img')].some((c) => c.getBoundingClientRect().width > 0)), null, { timeout: 8000 }).catch(() => {});
const drawn = await sheet.$$eval('.qr', (bs) => bs.map((b) => { const w = Math.max(0, ...[...b.querySelectorAll('canvas, img')].map((c) => c.getBoundingClientRect().width)); return { code: b.dataset.code, w: Math.round(w) }; }));
check('Print team QR codes on Teams & crew opens the page for that shift, every QR drawn', drawn.length >= 2 && drawn.every((d) => d.w >= 140) && drawn.some((d) => d.code === 'S1-DS09') && !drawn.some((d) => d.code === '52'), JSON.stringify(drawn));

/* the gun: what the QR holds, scanned into Team number, is taken as the team */
const dev = await j(await post('/api/admin/devices', { name: 'TEAMQR-01' }));
const gun = await ctx.newPage();
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active', { timeout: 8000 });
await gun.waitForTimeout(800);
await gun.focus('#fTeam');
await gun.keyboard.type('S1-DS09'); await gun.keyboard.press('Enter');     // a scanner types what it reads, then Enter
await gun.waitForTimeout(300);
check('On the gun, the code scanned into Team number is the team, and sign-on moves on to the clock-in numbers', (await gun.inputValue('#fTeam')) === 'S1-DS09' && await gun.evaluate(() => document.activeElement && document.activeElement.id === 'fEmployee'), await gun.inputValue('#fTeam'));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
