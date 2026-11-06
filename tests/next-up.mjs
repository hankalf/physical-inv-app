/*
 * Team plan → Next up. What is left - aisles with bins still to count that
 * no team has - ranked for the team in front of you: the levels it reaches,
 * nearest to where it just was, biggest first, held back while another team
 * is in that racking. One press queues it. The busy parts (auto-assign, the
 * by-hand steps, the file tools, the board) wait behind "More ways to plan".
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
const pj = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));

/* six rack aisles, F01-F06, levels A-C each, paired into blocks; F05 has bins on D too */
const S = (await pj('/api/admin/sessions', { name: 'Next up' })).id;
let bins = 'Bin Location,Zone,Aisle\n';
for (let a = 1; a <= 6; a++) for (const l of ['A', 'B', 'C', ...(a === 5 ? ['D'] : [])]) for (let i = 1; i <= (a === 3 ? 12 : 6); i++) bins += `F0${a}${l}${String(i).padStart(3, '0')},Freezer,F0${a}\n`;
bins += 'REC,Floor,REC\n';
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await pj(`/api/admin/sessions/${S}/aisles/auto-block`, { size: 2 });
await pj('/api/admin/people/teams', { name: '21', shift: '1' });
await pj('/api/admin/people/employees', { badge: 'NU1', name: 'Nia Upton', shift: '1', equipment: ['DOCK TRUCK'] });
await pj('/api/admin/people/assign', { badge: 'NU1', teamId: (await get('/api/admin/people')).teams.find((t) => t.name === '21').id });
await pj('/api/admin/people/teams', { name: '22', shift: '1' });
await pj('/api/admin/people/employees', { badge: 'NU2', name: 'Oren Vale', shift: '1', equipment: ['HIGH REACH', 'SCISSOR LIFT'] });
await pj('/api/admin/people/assign', { badge: 'NU2', teamId: (await get('/api/admin/people')).teams.find((t) => t.name === '22').id });

/* ---------------- the ranking ---------------- */
let d = await get(`/api/admin/sessions/${S}/plan/next`);
check('With no team: every aisle with bins left, biggest first', d.unplanned === 7 && d.suggestions[0].aisle === 'F03' && d.suggestions[0].binsLeft === 36 && d.binsLeft === 133 && !d.team, JSON.stringify(d.suggestions.map((x) => [x.aisle, x.binsLeft])));
d = await get(`/api/admin/sessions/${S}/plan/next?team=21`);
check('For team 21 (a dock truck, A-B): what it reaches, with how many of the bins are on its levels', d.reach === 'AB' && d.suggestions.every((x) => x.levelsReachable === 'AB' || x.floor) && d.suggestions.find((x) => x.aisle === 'F03').binsLeftReachable === 24 && /levels A-B of A-C/.test(d.suggestions.find((x) => x.aisle === 'F03').why), JSON.stringify(d.suggestions.slice(0, 3)));
check('…the floor bin is offered too, with no levels', d.suggestions.some((x) => x.aisle === 'REC' && x.floor && /floor pallets/.test(x.why)));
/* team 21 is counting F01: nearest first, and F02 shares F01's racking */
await pj(`/api/admin/sessions/${S}/assignments`, { team: '21', aisles: 'F01', levels: 'A-B' });
d = await get(`/api/admin/sessions/${S}/plan/next?team=21`);
check('Team 21 in F01: F02 first (same racking), then F03, F04 … - nearest to where it is', d.here === 'F01' && d.suggestions.slice(0, 3).map((x) => x.aisle).join() === 'F02,F03,F04' && /same racking as F01/.test(d.suggestions[0].why) && /next to F01/.test(d.suggestions[1].why), d.suggestions.map((x) => x.aisle).join());
check('…and F01 itself is no longer offered: it is on the plan', !d.suggestions.some((x) => x.aisle === 'F01'));
/* team 22 is in F03's block: F04 is held for anyone else */
await pj(`/api/admin/sessions/${S}/assignments`, { team: '22', aisles: 'F03', levels: 'C' });
d = await get(`/api/admin/sessions/${S}/plan/next?team=21`);
const f4 = d.suggestions.find((x) => x.aisle === 'F04');
check('Team 22 counting F03: F04 (same block) is held for team 21, and goes to the end of the list', f4 && f4.held && /held: team 22 is in that racking/.test(f4.why) && d.suggestions[d.suggestions.length - 1].aisle === 'F04', JSON.stringify(d.suggestions.map((x) => [x.aisle, x.held])));
/* a team that reaches only D is offered only F05 */
d = await get(`/api/admin/sessions/${S}/plan/next?team=22`);
check('Team 22 (high reach and scissor lift: A, C-F): F05 offers it A, C and D, the others A and C; F03 not (on the plan)', d.reach === 'ACDEF' && d.suggestions.some((x) => x.aisle === 'F05' && x.levelsReachable === 'ACD') && d.suggestions.some((x) => x.aisle === 'F04' && x.levelsReachable === 'AC') && !d.suggestions.some((x) => x.aisle === 'F03'), JSON.stringify(d.suggestions.map((x) => [x.aisle, x.levelsReachable])));
d = await get(`/api/admin/sessions/${S}/plan/next?team=21&limit=2`);
check('A limit, and how many more there are', d.suggestions.length === 2 && d.more === 3, `${d.suggestions.length} + ${d.more}`);

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (dd) => dd.accept());
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await expandSubTabs(page);
await pickSession(page, S);
await page.waitForSelector('#nuList .nu-row', { timeout: 10000 }); await page.waitForTimeout(400);
check('Team plan opens on Next up: the scan box, the team chips, and what is left - no team picked', (await page.locator('#nuList .nu-row').count()) >= 5 && /aisles with bins left and nobody on them/.test(clean(await page.textContent('#nuLeft'))) && /pick a team/.test(clean(await page.textContent('#nuLeft'))), clean(await page.textContent('#nuLeft')));
check('…and the busy parts are out of sight: auto-assign, the levels and aisle grid, the typed row, the board', !(await page.isVisible('#autoPlanCard')) && !(await page.isVisible('#qaAisles')) && !(await page.isVisible('#fAssignTeam')) && !(await page.isVisible('#teamList')) && await page.isVisible('#btnPlanMore'));
await page.fill('#qaScan', '21'); await page.press('#qaScan', 'Enter'); await page.waitForTimeout(900);
check('Scan team 21\'s card: the list is for it - F02 first, with why, and a Queue button on each', /for team 21, A-B, now at F01/.test(clean(await page.textContent('#nuLeft'))) && (await page.$eval('#nuList .nu-row', (r) => r.dataset.aisle)) === 'F02' && (await page.locator('#nuList button[data-queue]').count()) >= 4 && /same racking as F01/.test(clean(await page.textContent('#nuList .nu-row'))), clean(await page.textContent('#nuLeft')));
check('…the held one is greyed and says Queue anyway', await page.$eval('#nuList .nu-row[data-aisle="F04"]', (r) => r.classList.contains('held') && /Queue anyway/.test(r.textContent)));
await page.click('#nuList button[data-queue="F02"]'); await page.waitForTimeout(900);
let rows = await get(`/api/admin/sessions/${S}/assignments`);
check('Press Queue on F02: queued for team 21 on A-B, said so, and it leaves the list', rows.some((r) => r.team === '21' && r.aisle === 'F02' && r.levels === 'AB' && r.status === 'queued') && /Queued F02 \(AB\) for team 21/.test(clean(await page.textContent('#nuMsg'))) && !(await page.$('#nuList .nu-row[data-aisle="F02"]')), clean(await page.textContent('#nuMsg')));
await page.click('#btnNuQueueNext'); await page.waitForTimeout(900);
rows = await get(`/api/admin/sessions/${S}/assignments`);
const q21 = rows.filter((r) => r.team === '21').sort((a, b) => a.position - b.position).map((r) => r.aisle);
check('Queue the next 3 in this order: F03? no - F03 is team 22\'s; so F05, F06 and REC, after F01 and F02', q21.join() === 'F01,F02,F05,F06,REC', q21.join());
await page.click('#btnPlanMore'); await page.waitForTimeout(300);
check('More ways to plan: the auto-assign card, the levels and aisles, the typed row and the board come back', await page.isVisible('#autoPlanCard') && await page.isVisible('#qaAisles') && await page.isVisible('#fAssignTeam') && await page.isVisible('#teamList') && /Fewer ways/.test(clean(await page.textContent('#btnPlanMore'))));
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1500);
check('…and the choice is remembered on this computer', await page.isVisible('#teamList'));
await page.click('#btnPlanMore'); await page.waitForTimeout(300);
check('…until it is folded again', !(await page.isVisible('#teamList')) && await page.isVisible('#nuList'));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
