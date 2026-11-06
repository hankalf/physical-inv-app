/*
 * Assigning one side of an aisle. Racking has two faces - the odd positions
 * and the even - and two teams can split an aisle, one each side, without
 * holding each other up. The gun walks its side only and says so; a bin on
 * the other side is "Not your side". Next up offers the side still open on
 * an aisle whose other side is spoken for. The plan file carries a Face
 * column.
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

/* F01 and F02 share racking; F03 stands alone. Six positions a level, levels A and B. */
const S = (await pj('/api/admin/sessions', { name: 'Split aisles' })).id;
const dev = await pj('/api/admin/devices', { name: 'FACE-01' });
const D = { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const status = async (team) => j(await fetch(`${BASE}/api/sessions/${S}/team-status?team=${team}`, { headers: D }));
let bins = 'Bin Location,Zone,Aisle\n';
for (const a of ['F01', 'F02', 'F03', 'F04']) for (const l of ['A', 'B']) for (let i = 1; i <= 6; i++) bins += `${a}${l}${String(i).padStart(3, '0')},Freezer,${a}\n`;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await pj(`/api/admin/sessions/${S}/aisles/auto-block`, { size: 2 });
await pj(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false });
await pj('/api/admin/people/teams', { name: '8', shift: '1' });

/* ---------------- two teams, one aisle, a side each ---------------- */
let r = await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01', levels: 'A-B', face: 'Front', force: true });
check('Team 1 gets the Front side of F01: queued as such, and it starts', r.added.join() === 'F01 (AB, Front)' && r.activated.some((a) => a.team === '1'), JSON.stringify(r));
r = await pj(`/api/admin/sessions/${S}/assignments`, { team: '2', aisles: 'F01', levels: 'A-B', face: 'back', force: true });
check('Team 2 gets the Back side of the same aisle: not held by team 1, it starts too', r.added.join() === 'F01 (AB, Back)' && r.activated.some((a) => a.team === '2'), JSON.stringify(r));
let rows = await get(`/api/admin/sessions/${S}/assignments`);
check('Both are active on F01, each with its side', rows.filter((x) => x.aisle === 'F01' && x.status === 'active').length === 2 && rows.find((x) => x.team === '1').face === 'odd' && rows.find((x) => x.team === '2').face === 'even', JSON.stringify(rows.map((x) => [x.team, x.status, x.face])));
let t1 = await status('1');
let t2 = await status('2');
check('Team 1\'s gun walks the odd positions only: 001, 003, 005 on A then B', t1.bins.join() === 'F01A001,F01A003,F01A005,F01B001,F01B003,F01B005' && t1.active.face === 'odd' && t1.active.faceLabel === 'Front' && t1.progress.bins === 6, t1.bins.join());
check('Team 2\'s gun walks the even ones', t2.bins.join() === 'F01A002,F01A004,F01A006,F01B002,F01B004,F01B006' && t2.active.faceLabel === 'Back', t2.bins.join());
/* a third team wanting the whole aisle waits - and so does one wanting a side somebody has */
r = await pj(`/api/admin/sessions/${S}/assignments`, { team: '3', aisles: 'F02', levels: 'A-B', force: true });
let t3 = await status('3');
check('Team 3 on F02, both sides: held - F02 shares racking with F01, where teams 1 and 2 are', !t3.active && t3.waitingOn && t3.waitingOn.blockedByTeam, JSON.stringify(t3.waitingOn));
r = await pj(`/api/admin/sessions/${S}/assignments`, { team: '4', aisles: 'F01', levels: 'A-B', face: 'Front', force: true });
const t4 = await status('4');
check('Team 4 wanting the Front of F01 as well waits on team 1', !t4.active && t4.waitingOn && t4.waitingOn.blockedByTeam === '1' && t4.waitingOn.faceLabel === 'Front', JSON.stringify(t4.waitingOn));
check('The same side twice on one team is refused as a duplicate; the other side is not', (await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01', levels: 'A-B', face: 'Front', force: true })).skipped.length === 1
  && (await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01', levels: 'A-B', face: 'Back', force: true })).added.length === 1);
check('A side that is not one is refused, naming the two', (await post(`/api/admin/sessions/${S}/assignments`, { team: '5', aisles: 'F03', levels: 'A-B', face: 'left' })).status === 400 && /Front, Back or both/.test((await (await post(`/api/admin/sessions/${S}/assignments`, { team: '5', aisles: 'F03', levels: 'A-B', face: 'left' })).json()).error));

/* ---------------- next up knows a half-planned aisle ---------------- */
await pj(`/api/admin/sessions/${S}/assignments`, { team: '5', aisles: 'F03', levels: 'A-B', face: 'Front', force: true });
let d = await get(`/api/admin/sessions/${S}/plan/next`);
const f3 = d.suggestions.find((x) => x.aisle === 'F03');
check('Next up: F03 has its Front side taken, so it is offered as the Back side only, not held by team 5, and says who has the other', f3 && f3.face === 'even' && !f3.held && f3.faceLabel === 'Back' && /Back side only: team 5 has the other/.test(f3.why) && !d.suggestions.some((x) => x.aisle === 'F01'), JSON.stringify(d.suggestions.map((x) => [x.aisle, x.face, x.why])));
check('…and the names of the two sides come with it', d.faces && d.faces.odd === 'Front' && d.faces.even === 'Back');

/* ---------------- the plan file ---------------- */
const f = await fetch(`${BASE}/api/admin/sessions/${S}/export/plan.csv`, { headers: A });
const lines = (await f.text()).replace(/^﻿/, '').split(/\r?\n/);
check('The plan export has a Face column, filled where a side was given', lines[0] === 'Team,Aisle,Levels,Face,Start,Status' && lines.some((l) => /^1,F01,A-B,Front,/.test(l)) && lines.some((l) => /^3,F02,A-B,,/.test(l)), lines.slice(0, 4).join(' | '));
const up = await j(await fetch(`${BASE}/api/admin/sessions/${S}/plan`, { method: 'POST', headers: csv, body: 'Team,Aisle,Levels,Face\n6,F02,A-B,Back\n7,F03,A-B,sideways\n' }));
rows = await get(`/api/admin/sessions/${S}/assignments`);
check('A plan upload takes the Face column, and skips a row whose side is not one', up.planned === 1 && up.skipped === 1 && up.skippedBadFace === 1 && rows.some((x) => x.team === '6' && x.aisle === 'F02' && x.face === 'even'), JSON.stringify(up));

/* ---------------- the gun ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (dd) => dd.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', '1');
await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 90000 }); await gun.waitForTimeout(500);
const card = clean(await gun.textContent('#scrAssign'));
check('Gun: the aisle card says the side, and lists only its bins', /Front side only/.test(card) && /F01A001/.test(card) && !/F01A002/.test(card), card.slice(0, 160));
await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(600);
check('…the Count button names it', /Front side/.test(clean(await gun.textContent('#btnCount'))) || /Next bin\s*F01A001/.test(clean(await gun.textContent('#nextBin'))), clean(await gun.textContent('#nextBin')).slice(0, 80));
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(500); };
await gun.click('#btnEmpty'); await gun.waitForTimeout(300);   // nothing on the report here: empty bin, then the bin itself
await scan('F01A002');
check('Scan a bin on the Back side: the gun stops - Not your side - and says team 2 has it', await gun.isVisible('#ovTitle') && /Not your side/.test(clean(await gun.textContent('#ovTitle'))) && /Back side/.test(clean(await gun.textContent('#scrOverride, #ovWhy, body'))), clean(await gun.textContent('#ovTitle')));
check('No page errors', !errors.length, errors.join(' | '));

/* ---------------- the dashboard ---------------- */
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#nuList .nu-row', { timeout: 10000 }); await page.waitForTimeout(400);
await page.fill('#qaScan', '8'); await page.press('#qaScan', 'Enter'); await page.waitForTimeout(900);
check('Next up for team 8: F03 is offered as its Back side, the button saying so', (await page.locator('#nuList button[data-queue="F03"][data-face="even"]').count()) === 1 && /Queue Back/.test(clean(await page.textContent('#nuList button[data-queue="F03"]'))), clean(await page.textContent('#nuList .nu-row[data-aisle="F03"]')));
await page.click('#nuFace button[data-face="odd"]'); await page.waitForTimeout(300);
check('Pick Front beside Next up: the other aisles\' buttons queue the Front side; F03 still its open Back', /Queue( anyway)? Front/.test(clean(await page.textContent('#nuList button[data-queue="F04"]'))) && /Queue Back/.test(clean(await page.textContent('#nuList button[data-queue="F03"]'))), (await page.$$eval('#nuList button[data-queue]', (b) => b.map((x) => `${x.dataset.queue}:${x.textContent}`))).join(' | '));
await page.click('#nuList button[data-queue="F03"]'); await page.waitForTimeout(900);
rows = await get(`/api/admin/sessions/${S}/assignments`);
check('Queue it: team 8 has the Back side of F03, and the message says so', rows.some((x) => x.team === '8' && x.aisle === 'F03' && x.face === 'even') && /F03 \(ABCDEF, Back\)/.test(clean(await page.textContent('#nuMsg'))), clean(await page.textContent('#nuMsg')));
await page.click('#btnPlanMore'); await page.waitForTimeout(400);
check('The planning board chips say the side', /Front side/.test(clean(await page.textContent('#teamList'))) && /Back side/.test(clean(await page.textContent('#teamList'))));
check('…and the typed row has a Side box', await page.isVisible('#fAssignFace'));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
