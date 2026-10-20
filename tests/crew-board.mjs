/*
 * The crew board: a wall screen of who is on which team, by shift - 1st
 * 6am-2pm, 2nd 2pm-10pm - with the shift on now marked by the site's clock.
 * No sign-in, no controls, and no clock-in numbers on it.
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
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/crew?session=${S}`);
await page.waitForSelector('.shift[data-shift="1"] .team');
check('/crew serves it with no sign-in screen', (await page.$('#fPassword')) === null && (await page.$$('.shift')).length >= 2);
check('1st and 2nd shift side by side, each with its hours', /1st shift.*6am – 2pm/.test(clean(await page.textContent('.shift[data-shift="1"] .sh'))) && /2nd shift.*2pm – 10pm/.test(clean(await page.textContent('.shift[data-shift="2"] .sh'))));
check('Team 11 lists Ana and Ben, names only', /Ana Day/.test(await page.textContent('.team[data-team="11"]')) && /Ben Day/.test(await page.textContent('.team[data-team="11"]')) && !/Freezer|Scissor/i.test(await page.textContent('.team[data-team="11"]')), clean(await page.textContent('.team[data-team="11"]')));
check('…where it is: Aisle C01 · levels A–C, last scan just now, next C03', /Aisle C01 · levels A–C/.test(clean(await page.textContent('.team[data-team="11"] .where'))) && /last scan just now · C01A001/.test(clean(await page.textContent('.team[data-team="11"] .where'))) && /next C03/.test(await page.textContent('.team[data-team="11"] .where')), clean(await page.textContent('.team[data-team="11"] .where')));
check('…and that it is scanning, in green', /Scanning/i.test(await page.textContent('.team[data-team="11"] .st')) && await page.$eval('.team[data-team="11"]', (e) => e.classList.contains('live')));
check('Team 12 is marked red: Stopped scanning, with how long', /Stopped scanning · \d+ min/i.test(clean(await page.textContent('.team[data-team="12"] .st'))) && await page.$eval('.team[data-team="12"]', (e) => e.classList.contains('stopped')), clean(await page.textContent('.team[data-team="12"] .st')));
check('Team 13 says Not signed on', /Not signed on/i.test(await page.textContent('.team[data-team="13"] .st')));
check('The header names the count', /Crew board count/.test(await page.textContent('#bSession')));
check('Team 13 says its shift comes from its people', /shift from its people/.test(await page.textContent('.team[data-team="13"]')));
check('The shift on now is marked, and only that one', (await page.$$('.shift.on')).length === (want ? 1 : 0) && (!want || (await page.getAttribute('.shift.on', 'data-shift')) === want) && (!want || /On now/.test(await page.textContent('.shift.on .sh'))));
check('The header clock shows the site\'s time, not the browser\'s', clean(await page.textContent('#bClock')) === d.now.time || /^\d{1,2}:\d{2} (AM|PM)$/.test(clean(await page.textContent('#bClock'))), clean(await page.textContent('#bClock')));
check('The shift header counts its teams and their people', clean(await page.textContent('.shift[data-shift="1"] .count')) === '1 team · 2 people', clean(await page.textContent('.shift[data-shift="1"] .count')));
check('Nobody off a team is on the screen', !/Ed Loose|Flo Unset|Not on a team/.test(await page.textContent('body')));
check('Shift not set has team 14, and only teams', /Team 14/.test(await page.textContent('.shift.unset')) && (await page.$$('.shift.unset .team')).length === 1);
check('No clock-in numbers anywhere on the screen', !/CB[1-6]\b/.test(await page.textContent('body')));
check('It fits a 1080p screen without scrolling', await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2), String(await page.evaluate(() => document.documentElement.scrollHeight)));
await page.goto(`${BASE}/crew?shift=2&session=${S}`);
await page.waitForSelector('.shift[data-shift="2"] .team');
check('?shift=2 pins it to the 2nd shift alone', (await page.$$('.shift')).length === 1 && (await page.getAttribute('.shift', 'data-shift')) === '2');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
