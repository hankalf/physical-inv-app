/*
 * Team clocks, stopped-scanning alerts, and 1st / 2nd shift.
 *
 * The server knows when each team signed on, when it last scanned, and whether
 * it still has an aisle. So the dashboard shows every team's time on the count,
 * and a team that should be counting but has gone quiet gets an amber bar - and,
 * if the site wants, a card in the Teams channel. Signing off stops the clock.
 *
 * The alert is minute-based, so this suite waits a real minute for it.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
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

/* a Teams channel to post into */
const posted = [];
const channel = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { try { posted.push(JSON.parse(b)); } catch { posted.push(b); } res.end('1'); });
});
await new Promise((r) => channel.listen(0, '127.0.0.1', r));
await post('/api/admin/teams-webhook', { url: `http://127.0.0.1:${channel.address().port}/hook`, on: true });

/* ---------------- shifts on Teams & crew ---------------- */
const t7 = await post('/api/admin/people/teams', { name: '7', shift: '1' });
const t8 = await post('/api/admin/people/teams', { name: '8' });
check('A team can be made with its shift', t7.shift === '1');
const t8b = await post(`/api/admin/people/teams/${t8.id}/shift`, { shift: '2' });
check('…and an existing team moved to 2nd shift', t8b.shift === '2');
const t9 = await post('/api/admin/people/teams', { name: '9', shift: '1st' });
const t10 = await post('/api/admin/people/teams', { name: '10', shift: 'Night' });
check('A shift written in words is understood: "1st" is 1, "Night" is 2', t9.shift === '1' && t10.shift === '2', `${t9.shift} ${t10.shift}`);
for (const t of [t9, t10]) await fetch(`${BASE}/api/admin/people/teams/${t.id}`, { method: 'DELETE', headers: A });   // the shift view below counts teams
const bad = await post(`/api/admin/people/teams/${t8.id}/shift`, { shift: '9' });
check('A shift that is not 1st or 2nd is cleared, not stored', bad.shift === '');
await post(`/api/admin/people/teams/${t8.id}/shift`, { shift: '2' });

/* ---------------- a count, two teams on it ---------------- */
const sess = await post('/api/admin/sessions', { name: 'Clock test' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF02A001,Freezer,F02\nF02A002,Freezer,F02\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nCK-1,S,Chicken,40,F01A001\nCK-2,S,Peas,30,F02A001\nCK-3,S,Corn,20,F02A002\n' });
await post(`/api/admin/sessions/${sess.id}/assignments`, { team: '7', aisles: ['F01'], levels: 'A-F', force: true });
await post(`/api/admin/sessions/${sess.id}/assignments`, { team: '8', aisles: ['F02'], levels: 'A-F', force: true });
const dev = async (name) => {
  const d = await post('/api/admin/devices', { name });
  return { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${d.uid}`, {}, hdr)).token };
};
const G7 = await dev('CLK-07');
const G8 = await dev('CLK-08');
await post(`/api/sessions/${sess.id}/signon`, { deviceId: 'CLK-07', team: '7', employees: ['E1'] }, G7);
await post(`/api/sessions/${sess.id}/signon`, { deviceId: 'CLK-08', team: '8', employees: ['E2'] }, G8);
await post('/api/admin/idle-config', { minutes: 1, teams: true });

let c = await get(`/api/admin/sessions/${sess.id}/clocks`);
const clock = (t) => c.clocks.find((x) => x.team === t);
check('Each team signed on has a clock', clock('7') && clock('8') && clock('7').started && clock('8').started);
check('…counting, with its shift from Teams & crew', clock('7').working && clock('7').shift === '1' && clock('8').shift === '2');
check('Nobody has gone quiet yet', c.open.length === 0);
check('The limit is the site\'s setting', c.config.minutes === 1 && c.config.teams === true);

const line = (id, pallet, bin, team, dev) => [{ clientId: id, palletId: pallet, qty: 10, location: bin, team, employees: ['E'], deviceId: dev, scannedAt: new Date().toISOString() }];
await post(`/api/sessions/${sess.id}/counts`, line('ck-a', 'CK-2', 'F02A001', '8', 'CLK-08'), G8);

/* ---------------- a real minute later ---------------- */
await wait(40000);
await post(`/api/sessions/${sess.id}/counts`, line('ck-b', 'CK-3', 'F02A002', '8', 'CLK-08'), G8);   // team 8 keeps going
await wait(26000);
c = await get(`/api/admin/sessions/${sess.id}/clocks`);
check('A team that has not scanned for the limit gets an alert', c.open.some((a) => a.team === '7'), c.open.map((a) => a.team).join(','));
check('…and one that is still scanning does not', !c.open.some((a) => a.team === '8'));
check('Its quiet time is on the clock', clock('7').quietMinutes >= 1, `${clock('7').quietMinutes} min`);
await wait(800);
const card = posted.find((p) => JSON.stringify(p).includes('Team 7 has stopped scanning'));
check('The Teams channel gets a card saying so', !!card);
check('…with the shift and the count on it', card && JSON.stringify(card).includes('1st shift') && JSON.stringify(card).includes('Clock test'));
c = await get(`/api/admin/sessions/${sess.id}/clocks`);
check('Asking again does not raise a second alert for the same quiet spell', c.open.filter((a) => a.team === '7').length === 1
  && posted.filter((p) => JSON.stringify(p).includes('Team 7 has stopped')).length === 1);

/* ---------------- the dashboard ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForSelector('#idleAlert:not([hidden])', { timeout: 8000 }).catch(() => {});
const bar = clean(await page.textContent('#idleAlert'));
check('The dashboard shows an amber bar above every tab', /Team 7 has stopped scanning/.test(bar), bar.slice(0, 120));
check('…saying the shift and the last thing it did', /1st shift/.test(bar), bar.slice(0, 160));
const rows = await page.$$eval('#teamTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
const heads = await page.$$eval('#teamTable thead th', (ths) => ths.map((t) => t.textContent));
check('The team table has a start time, a running clock and the shift', ['Shift', 'Started', 'Time on count', 'Last scan'].every((h) => heads.includes(h)), heads.join('|'));
const r7 = rows.find((r) => r[0] === '7');
check('…team 7 reads 1st shift, with a clock in minutes', r7 && r7[1] === '1st' && /min/.test(r7[heads.indexOf('Time on count')]), r7 && r7.join(' | '));
check('…and its last scan is amber, past the limit', await page.$eval('#teamTable tr[data-team="7"] td.quiet', (td) => td.classList.contains('late')));
await page.click('#shiftFilter button[data-shift="2"]');
await wait(300);
const only2 = await page.$$eval('#teamTable tbody tr', (trs) => trs.map((tr) => tr.children[0].textContent.trim()));
check('The shift filter shows only 2nd-shift teams', only2.length === 1 && only2[0] === '8', only2.join(','));
await page.click('#shiftFilter button[data-shift=""]');
await wait(300);

await page.click('#idleAlert button:text("On break")');
await wait(1200);
check('"On break" quiets it', await page.isHidden('#idleAlert'));
c = await get(`/api/admin/sessions/${sess.id}/clocks`);
check('…recorded as a break, and by whom', c.recent[0].why === 'on break' && !!c.recent[0].cleared_by, `${c.recent[0].why} / ${c.recent[0].cleared_by}`);
check('A signed-on team shows its aisle before its first scan', r7 && /F01/.test(r7[heads.indexOf('Active aisle')]), r7 && r7[heads.indexOf('Active aisle')]);
check('…and no new alert while the break lasts', c.open.length === 0);

/* ---------------- signing off ---------------- */
await post(`/api/sessions/${sess.id}/signoff`, { deviceId: 'CLK-07', team: '7' }, G7);
c = await get(`/api/admin/sessions/${sess.id}/clocks`);
check('Signing off on the gun stops the team\'s clock', !clock('7').working && clock('7').state === 'signed off' && !!clock('7').endedAt, clock('7').state);
check('…and team 8 is still counting', clock('8').working);

/* finishing the last aisle stops the clock too */
const asg = await get(`/api/admin/sessions/${sess.id}/assignments`);
const a8 = asg.find((a) => a.team === '8' && a.status === 'active');
await post(`/api/admin/sessions/${sess.id}/assignments/${a8.id}`, { status: 'done' });
c = await get(`/api/admin/sessions/${sess.id}/clocks`);
check('A team with no aisle left is finished, and its clock stops', clock('8').state === 'finished' && !clock('8').working);

/* a scanner re-used by another crew ends the first crew */
await post(`/api/sessions/${sess.id}/signon`, { deviceId: 'CLK-08', team: '9', employees: ['E3'] }, G8);
c = await get(`/api/admin/sessions/${sess.id}/clocks`);
check('When another crew signs on to a scanner, the crew before it has signed off', clock('9') && ['finished', 'signed off'].includes(clock('8').state));

/* ---------------- the setting ---------------- */
const off = await post('/api/admin/idle-config', { minutes: 0 });
check('0 turns the alert off', off.minutes === 0);

/* ---------------- Teams & crew page ---------------- */
const tp = await browser.newPage({ viewport: { width: 1440, height: 950 } });
tp.on('pageerror', (e) => errors.push(e.message));
await tp.goto(BASE + '/teams');
await tp.waitForSelector('#scrMain.active', { timeout: 8000 }).catch(async () => { await signIn(tp); });
await tp.waitForTimeout(800);
const sels = await tp.$$eval('#teams .bucket select', (ss) => ss.map((s) => s.value));
check('Each team card on Teams & crew has its shift', sels.includes('1') && sels.includes('2'), sels.join(','));
await tp.click('#shiftView button[data-shift="1"]');
await tp.waitForTimeout(300);
const names = await tp.$$eval('#teams .bucket .name', (ns) => ns.map((n) => n.textContent));
check('…and the page can show one shift at a time', names.length === 1 && names[0] === 'Team 7', names.join(','));

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
channel.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} clock and shift checks passed`);
process.exit(failed ? 1 : 0);
