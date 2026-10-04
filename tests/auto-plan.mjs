/*
 * Auto-assigning the aisles: one staggered plan for every team.
 *
 * Teams start spread across the building, each with a continuous stretch; a
 * team gets only the levels its equipment reaches and the rest goes to a team
 * that can; the racking blocks still decide who is released into a block.
 */
import { chromium } from 'playwright-core';
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

/* three teams: two with a lift, one on foot */
const crew = [
  ['P1', 'Ana', ['HIGH REACH', 'SCISSOR LIFT'], '1'], ['P1B', 'Ali', ['DOCK TRUCK', 'FOOT'], '1'],
  ['P2', 'Ben', ['HIGH REACH', 'SCISSOR LIFT'], '2'], ['P2B', 'Bea', ['DOCK TRUCK', 'FOOT'], '2'],
  ['P3', 'Cy', ['FOOT'], '3'],
];
const teamIds = {};
for (const n of ['1', '2', '3']) teamIds[n] = (await post('/api/admin/people/teams', { name: n, shift: n === '3' ? '2' : '1' })).id;
for (const [badge, name, equipment, team] of crew) {
  await post('/api/admin/people/employees', { badge, name, equipment });
  await post('/api/admin/people/assign', { badge, teamId: teamIds[team] });
}
const roster = (await get('/api/admin/people')).teams;
const reach = Object.fromEntries(roster.map((t) => [t.name, t.reach]));
check('(the roster knows each team\'s reach)', reach['1'].length > 1 && reach['3'] === 'A', JSON.stringify(reach));
const full = [...'ABCD'].filter((c) => reach['1'].includes(c)).join('');      // what a lift crew reaches of A-D
const rest3 = [...'ABCD'].filter((c) => !reach['3'].includes(c)).join('');   // what the on-foot crew cannot

/* six aisles, levels A-D, paired into blocks of two */
const sess = await post('/api/admin/sessions', { name: 'Plan test' });
let bins = 'Bin Location,Zone,Aisle\n';
for (let a = 1; a <= 6; a++) for (const lv of ['A', 'B', 'C', 'D']) for (let n = 1; n <= 4; n++) bins += `F0${a}${lv}00${n},Freezer,F0${a}\n`;
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await post(`/api/admin/sessions/${sess.id}/aisles/auto-block`, { size: 2 });

const prev = await post(`/api/admin/sessions/${sess.id}/assignments/auto`, { preview: true });
check('A preview plans every team on Teams & crew', prev.teams.map((t) => t.team).join(',') === '1,2,3', prev.teams.map((t) => t.team).join(','));
check('…and nothing is queued by a preview', (await get(`/api/admin/sessions/${sess.id}/assignments`)).length === 0);
const own = (t) => prev.teams.find((x) => x.team === t).aisles.filter((a) => !a.extra).map((a) => a.aisle);
check('Each team gets a continuous stretch, spread across the building', own('1').join(',') === 'F01,F02' && own('2').join(',') === 'F03,F04' && own('3').join(',') === 'F05,F06',
  prev.teams.map((t) => `${t.team}: ${t.text}`).join(' | '));
const t3 = prev.teams.find((x) => x.team === '3');
check('The on-foot team gets only level A of its aisles', t3.aisles.filter((a) => !a.extra).every((a) => a.levels === 'A'), t3.text);
const extras = prev.teams.flatMap((t) => t.aisles.filter((a) => a.extra).map((a) => `${t.team}:${a.aisle}:${a.levels}`));
check('…and the levels it cannot reach go to teams that can, after their own stretch', extras.length === 2 && extras.every((e) => new RegExp(`^[12]:F0[56]:${rest3}$`).test(e)), extras.join(' '));
check('Nothing is left unplaced', prev.unassigned.length === 0 && prev.warnings.length === 0, prev.warnings.join(' | '));
check('The rules it followed are reported', prev.rules.paired === 6 && prev.rules.teamsWithCrew === 3 && prev.rules.levels === 'ABCD', JSON.stringify(prev.rules));

const shift1 = await post(`/api/admin/sessions/${sess.id}/assignments/auto`, { preview: true, shift: '1' });
check('A plan can be for one shift only', shift1.teams.map((t) => t.team).join(',') === '1,2' && shift1.teams.every((t) => t.aisles.length === 3));
const named = await post(`/api/admin/sessions/${sess.id}/assignments/auto`, { preview: true, teams: '2, 9', levels: 'A-B' });
check('…or for named teams and certain levels; a team not on the roster is given every level', named.teams.map((t) => t.team).join(',') === '2,9'
  && named.teams.every((t) => t.aisles.every((a) => a.levels === 'AB')) && named.teams.find((t) => t.team === '9').known === false, JSON.stringify(named.teams.map((t) => t.text)));
const noone = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments/auto`, { method: 'POST', headers: A, body: JSON.stringify({ preview: true, shift: '2', teams: '' }) })).json();
check('(2nd shift has a team, so that plans too)', noone.teams && noone.teams.length === 1);

/* apply it */
const applied = await post(`/api/admin/sessions/${sess.id}/assignments/auto`, {});
check('Queuing the plan creates the assignments', applied.queued === 8, `${applied.queued}`);
check('…and starts every team at once, each in a different racking block', applied.activated.length === 3
  && new Set(applied.activated.map((a) => a.aisle)).size === 3, JSON.stringify(applied.activated));
const asg = await get(`/api/admin/sessions/${sess.id}/assignments`);
const t1 = asg.filter((a) => a.team === '1').sort((a, b) => a.position - b.position);
check('A team\'s queue is in walking order, its own stretch first', t1.map((a) => a.aisle + ':' + a.levels).join(',') === `F01:${full},F02:${full},F05:${rest3}`, t1.map((a) => a.aisle + ':' + a.levels).join(','));
const again = await post(`/api/admin/sessions/${sess.id}/assignments/auto`, { preview: true });
check('Planning again leaves what is queued alone unless asked, and says so', /already queued/.test(again.error || ''), JSON.stringify(again).slice(0, 120));
const re = await post(`/api/admin/sessions/${sess.id}/assignments/auto`, { replace: true, order: 'desc', teams: '1, 2' });
const after = await get(`/api/admin/sessions/${sess.id}/assignments`);
check('Replace re-plans the queued aisles and leaves the active ones alone', after.filter((a) => a.status === 'active').length === 3
  && re.teams.every((t) => t.aisles.every((a) => !['F01', 'F03', 'F05'].includes(a.aisle))), JSON.stringify(re.teams.map((t) => t.text)));

/* the dashboard */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const s2 = await post('/api/admin/sessions', { name: 'Plan test 2' });
await fetch(`${BASE}/api/admin/sessions/${s2.id}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, s2.id);
await page.waitForTimeout(800);
check('The Team plan tab has the auto-assign card, with its rules', await page.isVisible('#autoPlanCard') && /Racking blocks: 0 of 6/.test(clean(await page.textContent('#planRules'))), clean(await page.textContent('#planRules')).slice(0, 120));
check('…which say what to fix when a rule is missing', /Pair the aisles/.test(await page.textContent('#planRules')));
await page.click('#btnPlanPreview');
await page.waitForSelector('#planOut:not([hidden])');
const outText = clean(await page.textContent('#planOut'));
check('Preview shows the plan per team, readable', /Team 1.*F01.*F02/.test(outText) && /Team 3/.test(outText), outText.slice(0, 160));
check('…with a warning when two teams would start in the same block (none paired here)', /start in racking block|nothing is queued/.test(outText + await page.textContent('#planMsg')));
await page.click('#btnPlanApply');
await page.waitForTimeout(1200);
check('Queue this plan puts it on the Team plan', /Queued 8 aisle assignments|Queued \d+ aisle/.test(clean(await page.textContent('#planMsg'))) && (await get(`/api/admin/sessions/${s2.id}/assignments`)).length >= 6, clean(await page.textContent('#planMsg')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} auto-plan checks passed`);
process.exit(failed ? 1 : 0);
