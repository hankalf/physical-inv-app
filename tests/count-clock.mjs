/*
 * The clock on the count.
 *
 * From the first sign-on: how long the count has run, how much of that was
 * downtime (nobody scanning for longer than the stopped-scanning limit), how
 * long it was actually counting, the pace over the counting time and over the
 * last half hour, and when it will be done at that pace. The same per team.
 * It is on the dashboard, on the office board, and in Export everything; a
 * closed count ends at the last thing anybody did, not at the click that
 * closed it.
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
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const mins = (ms) => Math.round(ms / 60000);

/* a count that started three hours ago, with two long quiet spells in it */
await post('/api/admin/idle-config', { minutes: 10, teams: false });
const sess = await j(await post('/api/admin/sessions', { name: 'Clocked count' }));
const sid = sess.id;
await post(`/api/admin/sessions/${sid}/master?kind=bins`, 'Bin Location\n' + Array.from({ length: 10 }, (_, i) => `F01A00${i + 1}`).join('\n') + '\n', csv);
await post(`/api/admin/sessions/${sid}/master?kind=pallets`, 'Bin Code,Container No.,Item No.,Description,Quantity\n' + Array.from({ length: 10 }, (_, i) => `F01A00${i + 1},P-${i + 1},SKU-${i + 1},Mango,40`).join('\n') + '\n', csv);
const dev = await j(await post('/api/admin/devices', { name: 'CLOCK-01' }));
const T = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();
/* lines at -180, -178, -176 | lunch | -120, -118 | a long stop | -10, -8, -6 */
const AT = [180, 178, 176, 120, 118, 10, 8, 6];
await post(`/api/sessions/${sid}/counts`, AT.map((m, i) => ({ clientId: `ck${i}`, palletId: `P-${i + 1}`, qty: 40, location: `F01A00${i + 1}`, team: '1', deviceId: 'CLOCK-01', scannedAt: ago(m) })), T);

let c = (await get(`/api/admin/sessions/${sid}/clocks`)).count;
check('The clocks answer carries the clock on the whole count', !!c && c.running === true && c.gapMinutes === 10, JSON.stringify(c && { running: c.running, gap: c.gapMinutes }));
check('It starts at the first line, three hours ago, not when the count was made', near(mins(now - Date.parse(c.started)), 180), c.started);
check('Time on the clock is three hours', near(mins(c.elapsedMs), 180), String(mins(c.elapsedMs)));
check('Two quiet spells longer than the limit: 56 min and 108 min, both over', c.spells.length === 2 && c.spells.every((s) => !s.open) && near(c.spells[0].minutes, 56) && near(c.spells[1].minutes, 108), JSON.stringify(c.spells));
check('Downtime is the two spells together; counting time is the rest', near(mins(c.downtimeMs), 164) && near(mins(c.countingMs), 16), `${mins(c.downtimeMs)} / ${mins(c.countingMs)}`);
check('Six quiet minutes now is not downtime yet, under a ten-minute limit', c.quietMinutes === null && c.downtimeClosedMs === c.downtimeMs);
check('The pace is over the counting time, not the wall clock: 8 lines in 16 min is about 30 an hour', c.lines === 8 && c.bins === 8 && c.linesPerHour >= 26 && c.linesPerHour <= 34, `${c.linesPerHour}/h`);
check('The last half hour: three lines, three bins, six an hour', c.recent && c.recent.lines === 3 && c.recent.bins === 3 && c.recent.binsPerHour === 6, JSON.stringify(c.recent));
check('Two bins left at six an hour: done in about twenty minutes, on the recent pace', c.binsLeft === 2 && c.finishBasis === 'recent' && near(mins(Date.parse(c.finishAt) - now), 20), `${c.finishAt} (${c.finishBasis})`);

/* a shorter limit: the quiet now counts, and keeps growing */
await post('/api/admin/idle-config', { minutes: 5, teams: false });
c = (await get(`/api/admin/sessions/${sid}/clocks`)).count;
check('With a five-minute limit the six quiet minutes now are downtime, as an open spell', c.quietMinutes === 6 && c.spells.length === 3 && c.spells[2].open && c.spells[2].to === null, JSON.stringify(c.spells[2]));
check('…added to the downtime, and the closed spells are told apart so the screen can tick the open one', near(mins(c.downtimeMs), 170) && near(mins(c.downtimeClosedMs), 164), `${mins(c.downtimeMs)} / ${mins(c.downtimeClosedMs)}`);
await post('/api/admin/idle-config', { minutes: 10, teams: false });

/* the team signs on (a gun does that before its first scan; here it is the test's clock that is wrong) */
await post(`/api/sessions/${sid}/signon`, { deviceId: 'CLOCK-01', team: '1', employees: ['E1'] }, T);
c = (await get(`/api/admin/sessions/${sid}/clocks`)).count;
const t1 = c.teams.find((t) => t.team === '1');
check('Team 1 is reckoned the same way: its downtime, counting time and pace', t1 && t1.working && near(mins(t1.downtimeMs), 164) && t1.spells === 2 && t1.lines === 8 && near(t1.linesPerHour, c.linesPerHour, 4), JSON.stringify(t1));
check('Signing on is activity: the count is no longer quiet, and the clock still reads three hours', c.quietMinutes === null && near(mins(c.elapsedMs), 180) && near(mins(c.downtimeMs), 164), `${mins(c.elapsedMs)} / ${mins(c.downtimeMs)}`);

/* a second team signing on is activity too */
const dev2 = await j(await post('/api/admin/devices', { name: 'CLOCK-02' }));
const T2 = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev2.uid}`, {}, hdr))).token };
await post(`/api/sessions/${sid}/signon`, { deviceId: 'CLOCK-02', team: '2', employees: ['E2'] }, T2);
c = (await get(`/api/admin/sessions/${sid}/clocks`)).count;
const t2 = c.teams.find((t) => t.team === '2');
check('A team that has just signed on has a clock with no pace yet', t2 && t2.working && t2.lines === 0 && t2.linesPerHour === null && mins(t2.elapsedMs) === 0, JSON.stringify(t2));
check('…and the whole count\'s last activity is that sign-on', mins(now - Date.parse(c.lastActivity)) === 0 && c.quietMinutes === null);

/* the board carries it, without names */
let b = await get(`/api/board?session=${sid}`, {});
check('The office board carries the clock', b.clock && near(mins(b.clock.elapsedMs), 180) && near(mins(b.clock.downtimeMs), 164) && b.clock.finishAt, JSON.stringify(b.clock && [mins(b.clock.elapsedMs), mins(b.clock.downtimeMs)]));
check('…with a row per team and no clock-in numbers', b.clock.teams.length === 2 && !/E1|E2/.test(JSON.stringify(b.clock)));

/* Export everything says how long it took */
const ev = await get(`/api/admin/sessions/${sid}/export/everything`);
const sum = Object.fromEntries(ev.sheets.find((s) => s.name === 'Summary').rows.map((r) => [r.What, r.Value]));
check('The Summary sheet has the clock: started, time on the clock, downtime, counting time, pace', /3 h 0[01] min/.test(sum['Time on the clock']) && /2 h 4[345] min/.test(sum['Downtime (quiet spells over 10 min)']) && /\d+ bins an hour/.test(sum['Pace']), JSON.stringify([sum['Time on the clock'], sum['Downtime (quiet spells over 10 min)'], sum['Pace']]));
const dt = ev.sheets.find((s) => s.name === 'Downtime');
check('…and a Downtime sheet lists the quiet spells', dt && dt.rows.length === 2 && dt.rows.every((r) => r.Minutes > 10 && r.From && r.To), JSON.stringify(dt && dt.rows));

/* ---- on the dashboard */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin`);
await signIn(page);
await pickSession(page, sid);
await page.waitForSelector('#countClock:not([hidden])', { timeout: 8000 }).catch(() => {});
const strip = clean(await page.textContent('#countClock'));
check('The dashboard shows the clock strip: time on the clock, downtime, counting, pace, done about', /3 h 0[01] min/.test(strip) && /2 h 4[345] min/.test(strip) && /Downtime/i.test(strip) && /Counting/i.test(strip) && /an hour|\/ h/i.test(strip) && /Done about/i.test(strip), strip.slice(0, 220));
check('…and says when it started and lists the quiet spells', /Started/.test(strip) && /56 min/.test(strip) && /1 h 48 min/.test(strip), strip.slice(0, 300));
const heads = await page.$$eval('#teamTable thead th', (ths) => ths.map((t) => t.textContent));
const rows = await page.$$eval('#teamTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
const r1 = rows.find((r) => r[0] === '1');
check('The team table has Downtime and Lines / h columns', heads.includes('Downtime') && heads.includes('Lines / h'), heads.join('|'));
check('…team 1 shows its downtime and pace', r1 && /2 h 4[345] min/.test(r1[heads.indexOf('Downtime')]) && /^\d+$/.test(r1[heads.indexOf('Lines / h')]), r1 && r1.join(' | '));

/* ---- on the office board */
const board = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
board.on('pageerror', (e) => errors.push('board: ' + e.message));
await board.goto(`${BASE}/board?session=${sid}`); await board.waitForTimeout(2200);
const bs = clean(await board.textContent('#bClockRow'));
check('The board shows the same clock, big: on the clock, downtime, counting, pace, done about', /3 h 0[01] min/.test(bs) && /2 h 4[345] min/.test(bs) && /Done about/i.test(bs), bs.slice(0, 200));
check('Board: it still fits the screen without scrolling', await board.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight) === 0);
await board.close();

/* ---- closing the count stops the clock at the last thing anybody did */
await post(`/api/admin/sessions/${sid}/status`, { status: 'closed' });
c = (await get(`/api/admin/sessions/${sid}/clocks`)).count;
check('Closed: the clock stops at the last activity, not at the click that closed it', c.running === false && c.ended === c.lastActivity && near(mins(c.elapsedMs), 180) && c.finishAt === null && c.recent === null, JSON.stringify([c.ended, c.lastActivity, mins(c.elapsedMs)]));
await page.reload(); await signIn(page).catch(() => {}); await pickSession(page, sid).catch(() => {});
await page.waitForSelector('#countClock:not([hidden])', { timeout: 8000 }).catch(() => {});
check('…and the dashboard says it took that long', /Took/i.test(clean(await page.textContent('#countClock'))), clean(await page.textContent('#countClock')).slice(0, 160));

/* a count nobody has started */
const empty = await j(await post('/api/admin/sessions', { name: 'Not started' }));
c = (await get(`/api/admin/sessions/${empty.id}/clocks`)).count;
check('A count nobody has signed on to has no clock running', c.started === null && c.elapsedMs === 0 && c.spells.length === 0 && c.finishAt === null);
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
