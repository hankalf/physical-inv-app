/*
 * Crew metrics: how each team and each person worked the count - time,
 * quiet spells and off-task (breaks taken out), pace, rhythm, and the habits
 * a count sees. Per team and per person, on the Reports tab, as CSV, as an
 * Excel workbook, and in Export everything.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession, expandSubTabs } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const post = async (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const pj = async (p, b = {}) => j(await post(p, b));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const MIN = 60000;
const TZ = 'America/New_York';
const localHM = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`; };

await post('/api/admin/idle-config', { minutes: 10, teams: false });
const S = (await pj('/api/admin/sessions', { name: 'Crew metrics' })).id;
let bins = 'Bin Location,Zone,Aisle\n';
for (let i = 1; i <= 20; i++) bins += `F01A${String(i).padStart(3, '0')},Freezer,F01\n`;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await pj(`/api/admin/sessions/${S}/settings`, { autoRecount: false, askComments: false, guided: false });
await pj('/api/admin/people/employees', { badge: 'CM1', name: 'Ada Lane', shift: '1', dept: 'Freezer' });
await pj('/api/admin/people/employees', { badge: 'CM2', name: 'Bo Reyes', shift: '1' });
await pj('/api/admin/people/employees', { badge: 'CM3', name: 'Cy Park', shift: '1' });
const dev = async (n) => { const d = await pj('/api/admin/devices', { name: n }); return { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${d.uid}`, { method: 'POST' }))).token }; };
const D1 = await dev('CREW-01'), D2 = await dev('CREW-02');
await fetch(`${BASE}/api/sessions/${S}/signon`, { method: 'POST', headers: D1, body: JSON.stringify({ team: '1', employees: ['CM1', 'CM2'], deviceId: 'CREW-01' }) });
await fetch(`${BASE}/api/sessions/${S}/signon`, { method: 'POST', headers: D2, body: JSON.stringify({ team: '2', employees: ['CM3'], deviceId: 'CREW-02' }) });
const now = Date.now();
const ago = (m) => new Date(now - m * MIN).toISOString();
/* team 1: six lines over ten minutes an hour ago, a 38-minute gap with a 15-minute break inside it, then two more */
const t1 = [60, 58, 56, 54, 52, 50, 12, 8];
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D1, body: JSON.stringify(t1.map((m, i) => ({ clientId: `c1-${i}`, palletId: `P1-${i}`, qty: 10, location: `F01A${String(i + 1).padStart(3, '0')}`, team: '1', employees: ['CM1', 'CM2'], deviceId: 'CREW-01', scannedAt: ago(m) }))) });
const hours = { on: true, breaks: [{ from: localHM(now - 40 * MIN), to: localHM(now - 25 * MIN), label: 'Break' }] };
await pj(`/api/admin/sessions/${S}/clock-schedule`, hours);
/* team 2: steady every two minutes, one override, one line voided */
const t2 = [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4];
await fetch(`${BASE}/api/sessions/${S}/counts`, { method: 'POST', headers: D2, body: JSON.stringify(t2.map((m, i) => ({ clientId: `c2-${i}`, palletId: `P2-${i}`, qty: 5, location: `F01A${String(i + 9).padStart(3, '0')}`, team: '2', employees: ['CM3'], deviceId: 'CREW-02', scannedAt: ago(m), ...(i === 3 ? { unknownPallet: 1, overrideReason: 'Hand-written ID' } : {}) }))) });
await fetch(`${BASE}/api/sessions/${S}/void`, { method: 'POST', headers: D2, body: JSON.stringify({ clientId: 'c2-13' }) });

/* ---------------- the numbers ---------------- */
let d = await get(`/api/admin/sessions/${S}/crew-metrics`);
const T1 = d.teams.find((t) => t.team === '1'), T2 = d.teams.find((t) => t.team === '2');
check('Two teams, three people', d.teams.length === 2 && d.people.length === 3 && d.totals.teams === 2 && d.totals.people === 3, JSON.stringify(d.totals));
check('Team 1: 8 lines, 8 bins, both people named, on the clock for about an hour', T1.lines === 8 && T1.bins === 8 && T1.people.map((p) => p.name).sort().join() === 'Ada Lane,Bo Reyes' && near(T1.elapsedMs / MIN, 60, 2), `${T1.lines} lines, ${Math.round(T1.elapsedMs / MIN)} min`);
check('…one quiet spell of 38 minutes, 15 of it the scheduled break, so 23 minutes off-task', T1.spells === 1 && near(T1.downtimeMs / MIN, 38, 1) && near(T1.scheduledOffMs / MIN, 15, 1) && near(T1.offTaskMs / MIN, 23, 1) && near(T1.longestSpellMs / MIN, 23, 1), `${Math.round(T1.downtimeMs / MIN)} down, ${Math.round(T1.scheduledOffMs / MIN)} break, ${Math.round(T1.offTaskMs / MIN)} off-task`);
check('…off-task as a share of the time not in breaks, and the rhythm: about two minutes between scans', near(T1.offTaskPct, 51, 4) && near(T1.secondsBetweenScans, 120, 10), `${T1.offTaskPct}% · ${T1.secondsBetweenScans}s`);
check('…pace over the counting time, and clean habits', T1.binsPerHour > 15 && T1.habits === 'clean' && T1.overrides === 0, `${T1.binsPerHour} bins/h · ${T1.habits}`);
check('Team 2: 13 lines (the voided one not counted), no quiet spell, one override and one void in its habits', T2.lines === 13 && T2.voided === 1 && T2.spells === 0 && T2.offTaskMs === 0 && T2.overrides === 1 && T2.unknownPallets === 1 && /1 override · 1 pallet off the list · 1 voided/.test(T2.habits), `${T2.lines} lines · ${T2.habits}`);
const ada = d.people.find((p) => p.badge === 'CM1'), cy = d.people.find((p) => p.badge === 'CM3');
check('A person is credited with every line of the gun they were on: Ada and Bo both have team 1\'s 8 lines', ada.lines === 8 && ada.name === 'Ada Lane' && ada.dept === 'Freezer' && ada.teams.join() === '1' && d.people.find((p) => p.badge === 'CM2').lines === 8, JSON.stringify([ada.lines, ada.teams]));
check('…Cy has team 2\'s 13 lines, the override and the void against them, one sign-on, on now', cy.lines === 13 && cy.overrides === 1 && cy.voided === 1 && cy.signons === 1 && cy.onNow && /1 override/.test(cy.habits), cy.habits);
check('Totals: 23 minutes off-task over the count, 1 override, 1 void, one clean team of two', near(d.totals.offTaskMs / MIN, 23, 1) && d.totals.overrides === 1 && d.totals.voided === 1 && d.totals.cleanTeams === 1, JSON.stringify(d.totals));
check('With no hours set, nothing is taken out as a break', (await (async () => { await pj(`/api/admin/sessions/${S}/clock-schedule`, { on: false }); const x = await get(`/api/admin/sessions/${S}/crew-metrics`); await pj(`/api/admin/sessions/${S}/clock-schedule`, hours); return near(x.teams.find((t) => t.team === '1').offTaskMs / MIN, 38, 1) && x.teams.find((t) => t.team === '1').scheduledOffMs === 0; })()));

/* ---------------- the files ---------------- */
const f1 = await fetch(`${BASE}/api/admin/sessions/${S}/export/crew-teams.csv`, { headers: A });
const l1 = (await f1.text()).replace(/^﻿/, '').split(/\r?\n/);
check('Teams CSV: the columns, one row a team, times in words', f1.status === 200 && l1[0].startsWith('Team,Shift,People,State,Started,Last activity,Time on count,Counting time,Quiet spells,Off-task,Off-task %,Longest spell,In breaks,Lines') && l1.length >= 3 && /23 min/.test(l1[1]) && /Ada Lane \(CM1\)/.test(l1[1]), l1[1].slice(0, 160));
const f2 = await fetch(`${BASE}/api/admin/sessions/${S}/export/crew-people.csv`, { headers: A });
const l2 = (await f2.text()).replace(/^﻿/, '').split(/\r?\n/);
check('People CSV: one row a person, with their teams and habits', l2[0].startsWith('Clock-in number,Name,Department,Shift,Teams,Sign-ons') && l2.some((l) => /^CM3,Cy Park,/.test(l) && /1 override/.test(l)), l2.find((l) => /^CM3/.test(l)));
const xr = await fetch(`${BASE}/api/admin/sessions/${S}/export/crew-metrics.xlsx`, { headers: A });
const xbuf = Buffer.from(await xr.arrayBuffer());
const names = [...xbuf.toString('latin1').matchAll(/xl\/worksheets\/sheet\d\.xml/g)].length;
check('The workbook downloads: an .xlsx with a Teams and a People sheet', xr.status === 200 && /crew-metrics-Crew-metrics\.xlsx/.test(xr.headers.get('content-disposition')) && xbuf.readUInt32LE(0) === 0x04034b50 && names >= 2, xr.headers.get('content-disposition'));
const ev = await get(`/api/admin/sessions/${S}/export/everything`);
const sn = ev.sheets.map((x) => x.name);
check('Export everything has Crew - teams and Crew - people, after Teams', sn.indexOf('Crew - teams') === sn.indexOf('Teams') + 1 && sn.indexOf('Crew - people') === sn.indexOf('Teams') + 2 && ev.sheets.find((x) => x.name === 'Crew - people').rows.length === 3, sn.join(' | '));
check('The log records the exports', (await get('/api/admin/audit?limit=20')).some((r) => /exported the crew metrics/.test(r.action)));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/admin#reports`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#crewTable tbody tr[data-crew-team]', { timeout: 10000 }); await page.waitForTimeout(300);
check('Reports → Crew metrics: a row a team, the off-task shaded as high, the habits', (await page.locator('#crewTable tbody tr[data-crew-team]').count()) === 2 && /23 min · 5\d(\.\d)?%/.test(clean(await page.textContent('#crewTable tr[data-crew-team="1"]'))) && /high/.test(clean(await page.textContent('#crewTable tr[data-crew-team="1"]'))) && /1 override/.test(clean(await page.textContent('#crewTable tr[data-crew-team="2"]'))), clean(await page.textContent('#crewTable tr[data-crew-team="1"]')).slice(0, 200));
check('…the numbers up top: off-task over the count, breaks, overrides, voids, clean teams', /23 min/.test(clean(await page.textContent('#crewStats'))) && /1 of 2/.test(clean(await page.textContent('#crewStats'))), clean(await page.textContent('#crewStats')));
await page.click('#crewWho button[data-who="people"]'); await page.waitForTimeout(300);
check('People: a row a person, with their name, number and teams', (await page.locator('#crewTable tbody tr[data-crew-badge]').count()) === 3 && /Ada Lane/.test(clean(await page.textContent('#crewTable tr[data-crew-badge="CM1"]'))) && /on now/.test(clean(await page.textContent('#crewTable tr[data-crew-badge="CM3"]'))), clean(await page.textContent('#crewTable tr[data-crew-badge="CM1"]')).slice(0, 160));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportCrewXlsx')]);
check('The Excel button downloads the workbook', /crew-metrics/.test(dl.suggestedFilename()), dl.suggestedFilename());
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
