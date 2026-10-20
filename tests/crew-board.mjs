/*
 * The crew board: a wall screen of who is on which team, by shift - 1st
 * 6am-2pm, 2nd 2pm-10pm until an admin sets other hours - with the shift on
 * now marked by the site's clock. No sign-in, no controls, and no clock-in
 * numbers on it.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
/* minutes of the day → "6:30am", as the board writes a shift's hours */
const twelve = (mins) => { const m = ((mins % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`; };

/* two teams on days, one on nights, one whose shift comes from its people, and two people on no team */
const add = (badge, name, dept, shift, equipment = []) => post('/api/admin/people/employees?new=1', { badge, name, dept, shift, equipment });
await add('CB1', 'Ana Day', 'Freezer', '1', ['SCISSOR LIFT']);
await add('CB2', 'Ben Day', 'Freezer', '1');
await add('CB3', 'Cy Night', 'Dry Dock', '2', ['HIGH REACH']);
await add('CB4', 'Di Night', 'Dry Dock', '2');
await add('CB5', 'Ed Loose', 'Shipping', '1');
await add('CB6', 'Flo Unset', 'Shipping', '');
const team = async (name, shift) => j(await post('/api/admin/people/teams', { name, shift }));
const t1 = await team('11', '1'); const t2 = await team('12', '2'); const t3 = await team('13', ''); const t4 = await team('14', '');
await post('/api/admin/people/assign', { badge: 'CB1', teamId: t1.id });
await post('/api/admin/people/assign', { badge: 'CB2', teamId: t1.id });
await post('/api/admin/people/assign', { badge: 'CB3', teamId: t2.id });
await post('/api/admin/people/assign', { badge: 'CB4', teamId: t3.id });     // team 13 has no shift set: Di is 2nd shift, so it reads as 2nd

/* a count: team 11 on aisle C01 and scanning, team 12 on C02 and quiet past the limit, team 13 queued and not signed on */
const csv = { authorization: A.authorization, 'content-type': 'text/csv' };
const S = (await j(await post('/api/admin/sessions', { name: 'Crew board count' }))).id;
const bins = ['C01A001', 'C01A002', 'C02A001', 'C02A002', 'C03A001'];
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Dry,${b.slice(0, 3)}`).join('\n') + '\n' });
await post(`/api/admin/sessions/${S}/assignments`, { team: '11', aisles: 'C01', levels: 'A-C', force: true });
await post(`/api/admin/sessions/${S}/assignments`, { team: '12', aisles: 'C02', levels: 'A-F', force: true });
await post(`/api/admin/sessions/${S}/assignments`, { team: '13', aisles: 'C03', levels: 'A-F', force: true });
await post(`/api/admin/sessions/${S}/assignments`, { team: '11', aisles: 'C03', levels: 'D-F', force: true });
/* a gun each: one gun signing on twice would sign the first team off */
const gun = async (name) => { const d = await j(await post('/api/admin/devices', { name })); return { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${d.uid}`, {}))).token }; };
const G11 = await gun('CREW-11'); const G12 = await gun('CREW-12');
const line = (id, pallet, bin, team, deviceId) => [{ clientId: id, palletId: pallet, qty: 4, location: bin, team, deviceId, scannedAt: new Date().toISOString() }];
await post('/api/admin/idle-config', { minutes: 1, teams: true });
await post(`/api/sessions/${S}/signon`, { team: '12', employees: ['CB3'], deviceId: 'CREW-12' }, G12);
await post(`/api/sessions/${S}/counts`, line('cb2', 'CBP-2', 'C02A001', '12', 'CREW-12'), G12);
/* a real minute: team 12 goes quiet past the one-minute limit, team 11 signs on and scans after it */
await new Promise((r) => setTimeout(r, 62000));
await post(`/api/sessions/${S}/signon`, { team: '11', employees: ['CB1', 'CB2'], deviceId: 'CREW-11' }, G11);
await post(`/api/sessions/${S}/counts`, line('cb1', 'CBP-1', 'C01A001', '11', 'CREW-11'), G11);

/* ---------------- the payload ---------------- */
const res = await fetch(`${BASE}/api/board/crew?session=${S}`);
check('The crew board needs no sign-in', res.ok, String(res.status));
const d = await j(res);
const by = (k) => d.shifts.find((s) => s.key === k);
check('Two shifts, with their hours, and a Shift not set group', d.shifts.map((s) => `${s.key}:${s.label}:${s.hours}`).join('|') === '1:1st shift:6am – 2pm|2:2nd shift:2pm – 10pm|:Shift not set:', d.shifts.map((s) => s.label).join('|'));
check('1st shift: team 11 with Ana and Ben, by name', by('1').teams.some((t) => t.name === '11' && t.members.map((m) => m.name).join() === 'Ana Day,Ben Day'), JSON.stringify(by('1').teams.map((t) => t.name)));
check('2nd shift: team 12, and team 13 whose shift comes from its people', by('2').teams.map((t) => `${t.name}${t.shiftInferred ? '*' : ''}`).join() === '12,13*', JSON.stringify(by('2').teams.map((t) => [t.name, t.shiftInferred])));
check('A team with nobody on it and no shift waits under Shift not set', by('').teams.some((t) => t.name === '14' && !t.members.length));
check('People on no team are not on the board at all', !d.shifts.some((s) => 'unassigned' in s) && !/Ed Loose|Flo Unset/.test(JSON.stringify(d)) && d.people === 4, String(d.people));
check('Each person is a name and nothing else: no department, no equipment, no clock-in number', Object.keys(by('1').teams.find((t) => t.name === '11').members[0]).join() === 'name' && !/CB[1-6]|Freezer|Dry Dock|Scissor|High reach/i.test(JSON.stringify(d.shifts)));
const T = (name) => d.shifts.flatMap((s) => s.teams).find((t) => t.name === name);
check('Team 11: on aisle C01, levels A–C, scanning, last scan just now in C01A001, C03 next', T('11').now.aisle === 'C01' && T('11').now.levels === 'ABC' && T('11').now.state === 'scanning' && !T('11').now.stopped && T('11').now.lastBin === 'C01A001' && T('11').now.next.aisle === 'C03', JSON.stringify(T('11').now));
check('Team 12: on C02, quiet past the one-minute limit — stopped scanning', T('12').now.aisle === 'C02' && T('12').now.state === 'stopped scanning' && T('12').now.stopped && T('12').now.quietMinutes >= 1, JSON.stringify(T('12').now));
check('Team 13: an aisle queued but nobody signed on', T('13').now.state === 'not signed on' && !T('13').now.stopped, JSON.stringify(T('13').now));
check('The board says which count it is reading, and the stopped-scanning limit', d.session.id === S && d.quietLimit === 1);
const hour = d.now.hour;
const want = hour >= 6 && hour < 14 ? '1' : hour >= 14 && hour < 22 ? '2' : '';
check('…and the clock it was judged by comes with it, as a wall clock says it', /^\d{1,2}:\d{2} (AM|PM)$/.test(d.now.time) && Number(d.now.time.split(':')[0]) === (hour % 12 || 12), d.now.time);
check('The shift on now follows the site\'s clock', d.now.shift === want && d.shifts.filter((s) => s.on).map((s) => s.key).join() === want && (want ? /until/.test(d.now.until + 'until') : /Between shifts/.test(d.now.label)), `${hour}h → ${JSON.stringify(d.now)}`);

/* ---------------- the page ---------------- */
const wantShown = want || '1';            // between shifts the board shows the next one coming in
const cfg = await j(await fetch(`${BASE}/api/admin/crew-board`, { headers: A }));
check('The crew board’s options start as: the shift on now, everything shown, scrolling by itself at normal speed, shifts 6–14 and 14–22', cfg.shift === 'auto' && Object.values(cfg.show).every(Boolean) && cfg.scroll.on && cfg.scroll.speed === 'normal' && cfg.scroll.pause === 6 && cfg.pxPerSecond === 36 && cfg.isDefault && cfg.shifts['1'].from === '06:00' && cfg.shifts['1'].to === '14:00' && cfg.shifts['2'].from === '14:00' && cfg.shifts['2'].to === '22:00' && cfg.shiftHours.map((s) => s.hours).join('|') === '6am – 2pm|2pm – 10pm', JSON.stringify(cfg));
check('…and the screen is told them with the teams', d.config && d.config.shift === 'auto' && d.config.scroll.on && !('isDefault' in d.config), JSON.stringify(d.config));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/crew?session=${S}`);
await page.waitForSelector('.shift .team');
check('/crew serves it with no sign-in screen', (await page.$('#fPassword')) === null && (await page.$$('.shift')).length === 1);
check('One shift at a time: the one on now by the site’s clock (or the next one coming in)', (await page.getAttribute('.shift', 'data-shift')) === wantShown, `${hour}h → ${await page.getAttribute('.shift', 'data-shift')}`);
check('A team with no shift set is listed with it, marked', /Team 14/.test(await page.textContent('.shift')) && /shift not set/.test(await page.textContent('.team[data-team="14"]')) && await page.$eval('.team[data-team="14"]', (e) => e.classList.contains('unset')));
await page.goto(`${BASE}/crew?shift=1&session=${S}`);
await page.waitForSelector('.shift[data-shift="1"] .team');
check('?shift=1 pins a screen to the 1st shift, with its hours', (await page.$$('.shift')).length === 1 && /1st shift.*6am – 2pm/.test(clean(await page.textContent('.shift[data-shift="1"] .sh'))));
check('Team 11 lists Ana and Ben, names only', /Ana Day/.test(await page.textContent('.team[data-team="11"]')) && /Ben Day/.test(await page.textContent('.team[data-team="11"]')) && !/Freezer|Scissor/i.test(await page.textContent('.team[data-team="11"]')), clean(await page.textContent('.team[data-team="11"]')));
check('…where it is: Aisle C01 · levels A–C, last scan just now, next C03', /Aisle C01 · levels A–C/.test(clean(await page.textContent('.team[data-team="11"] .where'))) && /last scan just now · C01A001/.test(clean(await page.textContent('.team[data-team="11"] .where'))) && /next C03/.test(await page.textContent('.team[data-team="11"] .where')), clean(await page.textContent('.team[data-team="11"] .where')));
check('…the aisle and its levels are one piece, so they never part across a line', await page.$eval('.team[data-team="11"] .where .pos', (e) => getComputedStyle(e).whiteSpace === 'nowrap' && /Aisle C01 · levels A–C/.test(e.textContent)));
check('…and that it is scanning, in green', /Scanning/i.test(await page.textContent('.team[data-team="11"] .st')) && await page.$eval('.team[data-team="11"]', (e) => e.classList.contains('live')));
check('The header names the count', /Crew board count/.test(await page.textContent('#bSession')));
check('The shift on now is marked, and only when it is', (await page.$$('.shift.on')).length === (want === '1' ? 1 : 0) && (want !== '1' || /On now/.test(await page.textContent('.shift.on .sh'))));
check('The header clock shows the site’s time, not the browser’s', clean(await page.textContent('#bClock')) === d.now.time || /^\d{1,2}:\d{2} (AM|PM)$/.test(clean(await page.textContent('#bClock'))), clean(await page.textContent('#bClock')));
check('The shift header counts its teams and their people, the unset team included', clean(await page.textContent('.shift[data-shift="1"] .count')) === '2 teams · 2 people', clean(await page.textContent('.shift[data-shift="1"] .count')));
check('Nobody off a team is on the screen', !/Ed Loose|Flo Unset|Not on a team/.test(await page.textContent('body')));
check('No clock-in numbers anywhere on the screen', !/CB[1-6]\b/.test(await page.textContent('body')));
check('It fits a 1080p screen without scrolling', await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2), String(await page.evaluate(() => document.documentElement.scrollHeight)));
await page.goto(`${BASE}/crew?shift=2&session=${S}`);
await page.waitForSelector('.shift[data-shift="2"] .team');
check('?shift=2 pins it to the 2nd shift alone', (await page.$$('.shift')).length === 1 && (await page.getAttribute('.shift', 'data-shift')) === '2');
check('Team 12 is marked red: Stopped scanning, with how long', /Stopped scanning · \d+ min/i.test(clean(await page.textContent('.team[data-team="12"] .st'))) && await page.$eval('.team[data-team="12"]', (e) => e.classList.contains('stopped')), clean(await page.textContent('.team[data-team="12"] .st')));
check('Team 13 says Not signed on', /Not signed on/i.test(await page.textContent('.team[data-team="13"] .st')));
check('Team 13 says its shift comes from its people', /shift from its people/.test(await page.textContent('.team[data-team="13"]')));

/* ---------------- the admin's options ---------------- */
let r = await post('/api/admin/crew-board', { shift: '2', show: { notes: false, lastScan: false }, scroll: { on: true, speed: 240, pause: 1 } });
const c2 = await j(r);
check('An admin fixes the screen to the 2nd shift, takes the notes and last scans off, and sets the scroll fast with a short pause', r.status === 200 && c2.shift === '2' && !c2.show.notes && !c2.show.lastScan && c2.show.members && c2.scroll.speed === 240 && c2.pxPerSecond === 240 && c2.scroll.pause === 1, JSON.stringify(c2));
r = await post('/api/admin/crew-board', { shift: '3' });
check('A shift that is not auto, 1 or 2 is refused', r.status === 400);
r = await post('/api/admin/crew-board', { scroll: { speed: 'warp' } });
check('…and so is a speed that is not slow, normal, fast or a number', r.status === 400);
await page.goto(`${BASE}/crew?session=${S}`);
await page.waitForSelector('.shift[data-shift="2"] .team');
check('The screen now shows the 2nd shift whatever the clock says', (await page.$$('.shift')).length === 1 && (await page.getAttribute('.shift', 'data-shift')) === '2');
check('…without last scans or next aisles', !/last scan|next C/.test(await page.textContent('.shift')) && /Stopped scanning/i.test(await page.textContent('.team[data-team="12"]')));
/* a short screen: the list is longer than it, so it scrolls by itself */
const tv = await browser.newPage({ viewport: { width: 420, height: 380 } });
tv.on('pageerror', (e) => errors.push(e.message));
await tv.goto(`${BASE}/crew?session=${S}`);
await tv.waitForSelector('.shift[data-shift="2"] .team');
const overflow = await tv.$eval('.shift .teams', (g) => g.scrollHeight - g.clientHeight);
/* how far it got over three seconds: a short list is down and back up again quickly, so one glance could miss it */
const farthest = () => tv.evaluate(() => new Promise((r) => { let m = 0; const g = document.querySelector('.shift .teams'); const t = setInterval(() => { m = Math.max(m, g.scrollTop); }, 40); setTimeout(() => { clearInterval(t); r(m); }, 3000); }));
const moved = await farthest();
check('On a screen the list does not fit, it scrolls down by itself after the pause', overflow > 20 && moved > 10, `overflow ${overflow}px, scrolled ${moved}px within 3 s`);
check('…with no scrollbar showing', await tv.$eval('.shift .teams', (g) => getComputedStyle(g).scrollbarWidth === 'none'));
await tv.goto(`${BASE}/crew?session=${S}&scroll=0`);
await tv.waitForSelector('.shift[data-shift="2"] .team');
check('?scroll=0 on the address keeps that one screen still', (await farthest()) === 0);
await post('/api/admin/crew-board', { scroll: { on: false } });
await tv.goto(`${BASE}/crew?session=${S}`);
await tv.waitForSelector('.shift[data-shift="2"] .team');
check('Scrolling switched off by the admin: the list stays put', (await farthest()) === 0);
/* ---------------- the shift times ----------------
   An admin moves the hours and the board judges "on now" by them. The clock is
   whatever it is when the test runs, so the times are set around it. */
const hhmm = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
const m0 = d.now.minutes;
check('The board says the minute of the day it judged by', Number.isInteger(m0) && m0 >= 0 && m0 < 1440 && Math.floor(m0 / 60) === d.now.hour, String(m0));
r = await post('/api/admin/crew-board', { shifts: { 1: { from: hhmm(m0 + 60), to: hhmm(m0 - 60) }, 2: { from: hhmm(m0 - 60), to: hhmm(m0 + 60) } } });
const c3 = await j(r);
check('The shift times are set on the clock, and one of them may run past midnight', r.status === 200 && c3.shifts['2'].from === hhmm(m0 - 60) && c3.shifts['2'].to === hhmm(m0 + 60) && c3.shifts['1'].from === hhmm(m0 + 60), JSON.stringify(c3.shifts));
let d2 = await j(await fetch(`${BASE}/api/board/crew?session=${S}`));
check('…and the board corrects itself: it is now the 2nd shift, until the hour set, whatever the clock says', d2.now.shift === '2' && d2.now.next === '2' && d2.shifts.find((s) => s.key === '2').on && /2nd shift/.test(d2.now.label), JSON.stringify(d2.now));
check('…with the hours written as a clock says them', d2.shifts.find((s) => s.key === '2').hours === `${twelve(m0 - 60)} – ${twelve(m0 + 60)}` && c3.shiftHours.find((s) => s.key === '2').hours === d2.shifts.find((s) => s.key === '2').hours, d2.shifts.find((s) => s.key === '2').hours);
await page.goto(`${BASE}/crew?session=${S}`);
await page.waitForSelector('.shift[data-shift="2"] .team');
check('The screen follows: the 2nd shift, marked On now, with the new hours in its header', (await page.getAttribute('.shift', 'data-shift')) === '2' && /On now/.test(await page.textContent('.shift .sh')) && clean(await page.textContent('.shift .hours')) === d2.shifts.find((s) => s.key === '2').hours, clean(await page.textContent('.shift .sh')));
r = await post('/api/admin/crew-board', { shifts: { 1: { from: hhmm(m0 + 10), to: hhmm(m0 + 20) }, 2: { from: hhmm(m0 + 30), to: hhmm(m0 + 40) } } });
d2 = await j(await fetch(`${BASE}/api/board/crew?session=${S}`));
check('Between shifts by the new times, the board names the one coming in next and when it starts', r.status === 200 && d2.now.shift === '' && d2.now.next === '1' && d2.now.label === `Between shifts · 1st shift starts ${twelve(m0 + 10)}`, JSON.stringify(d2.now));
check('A time that is not on the clock is refused', (await post('/api/admin/crew-board', { shifts: { 1: { from: '25:00' } } })).status === 400 && (await post('/api/admin/crew-board', { shifts: { 2: { to: '6am' } } })).status === 400);
check('…and so is a shift that starts and ends at the same time', (await post('/api/admin/crew-board', { shifts: { 1: { from: '14:00', to: '14:00' } } })).status === 400);
r = await post('/api/admin/crew-board', { shifts: { 1: { from: '06:00', to: '15:00' }, 2: { from: '14:00', to: '22:00' } } });
check('…and shifts that overlap, naming both', r.status === 400 && /overlap.*6am – 3pm.*2pm – 10pm/.test((await j(r)).error || ''), JSON.stringify(await j(r).catch(() => null)));
check('A refused save changes nothing', JSON.stringify((await j(await fetch(`${BASE}/api/admin/crew-board`, { headers: A }))).shifts) === JSON.stringify({ 1: { from: hhmm(m0 + 10), to: hhmm(m0 + 20) }, 2: { from: hhmm(m0 + 30), to: hhmm(m0 + 40) } }));
/* the settings page shows and saves them */
const adm = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
adm.on('pageerror', (e) => errors.push(e.message));
await adm.goto(`${BASE}/settings#advanced`);
await adm.fill('#fPassword', 'changeme'); await adm.click('#btnLogin'); await adm.waitForSelector('#crewBoardCard:not([hidden])');
await adm.waitForFunction(() => document.getElementById('fCbS1From').value !== '');
check('Settings → Site & systems → Crew board shows the four times', await adm.$eval('#fCbS1From', (e) => e.value) === hhmm(m0 + 10) && await adm.$eval('#fCbS2To', (e) => e.value) === hhmm(m0 + 40) && /1st shift .* · 2nd shift/.test(clean(await adm.textContent('#cbShiftHours'))), clean(await adm.textContent('#cbShiftHours')));
await adm.fill('#fCbS1From', '06:00'); await adm.fill('#fCbS1To', '14:00'); await adm.fill('#fCbS2From', '14:00'); await adm.fill('#fCbS2To', '22:00');
await adm.click('#btnCrewBoardSave'); await adm.waitForTimeout(600);
check('Save puts them back to 6–14 and 14–22, and says so', /Saved/.test(await adm.textContent('#crewBoardMsg')) && /1st shift 6am – 2pm, 2nd shift 2pm – 10pm/.test(clean(await adm.textContent('#crewBoardMsg'))) && JSON.stringify((await j(await fetch(`${BASE}/api/admin/crew-board`, { headers: A }))).shifts) === JSON.stringify({ 1: { from: '06:00', to: '14:00' }, 2: { from: '14:00', to: '22:00' } }), clean(await adm.textContent('#crewBoardMsg')));
await adm.close();

await post('/api/admin/users', { username: 'CREW-SUP', name: 'Crew Sup', password: 'crew-board-1', mustChange: false, profile: 'supervisor' });
const SUP = { ...hdr, authorization: 'Bearer ' + (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'CREW-SUP', password: 'crew-board-1' }) }))).token };
check('Only an admin changes what the wall screen shows', (await post('/api/admin/crew-board', { shift: 'auto' }, SUP)).status === 403 && (await fetch(`${BASE}/api/admin/crew-board`, { headers: SUP })).status === 403);
check('The change is in the log', (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((x) => x.action === 'changed the crew board'));
await post('/api/admin/crew-board', { shift: 'auto', show: { notes: true, lastScan: true }, scroll: { on: true, speed: 'normal', pause: 6 } });
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
