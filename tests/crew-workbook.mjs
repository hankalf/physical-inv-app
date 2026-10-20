/*
 * The crew workbook: employees and teams in one file, checked against each
 * other before either is touched. Two sheets, or one combined sheet; what
 * stops the upload, what is worth knowing, and both uploads in one go.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: A }));
const wb = (q, employees, teams) => post(`/api/admin/people/crew-workbook?${q}`, { employees, teams }).then(j);

const EMP = 'Clock In Number,Name,Department,Shift,Equipment\nW9001,Ann Able,Warehouse,1,High reach; Scissor lift\nW9002,Bob Baker,Warehouse,1,Dock truck\nW9003,Cy Cole,Production,2,\n';
const TEAMS_BAD = 'Team #,Department,Employee,Equipment,Clock In Number\nS1-DS01,Warehouse,Ann Able,Dock Stocker,W9001\nS1-DS01,Production,,On Foot with Dock Stockers,\nS2-RT02,Warehouse,Bob Baker,High Reach,W9002\nS2-RT02,Warehouse,Dan Dunn,Scissor Lift - Counting,\nS1-DS01,Warehouse,Bob Baker,Dock Stocker,W9002\nX-99,Warehouse,Cy Cole,Hovercraft,W9003\n';

/* ---------------- the check ---------------- */
let r = await wb('apply=0', EMP, TEAMS_BAD);
check('A workbook with mismatches is not ok, and nothing is loaded', !r.ok && !r.applied && (await get('/api/admin/people')).employees.every((e) => !/^W900/.test(e.badge)));
const kinds = r.problems.map((p) => p.kind).sort().join();
check('…it names what stops it: a person on the team sheet who is not on the employees sheet, and a person on two teams', kinds === 'not on crew list,two teams', JSON.stringify(r.problems.map((p) => p.text)));
check('…and what is worth knowing: Bob is 1st shift on a 2nd-shift team, a team number with no shift, equipment nobody knows', r.warnings.some((w) => /Bob Baker is 1st shift but team S2-RT02 is 2nd shift/.test(w.text)) && r.warnings.some((w) => /Team X-99 does not say which shift/.test(w.text)) && r.warnings.some((w) => /Hovercraft/.test(w.text)), JSON.stringify(r.warnings.map((w) => w.text)));
check('…with the sums: 3 people, 3 teams, 6 seats, one open', r.summary.employees === 3 && r.summary.teams === 3 && r.summary.seats === 6 && r.summary.open === 1, JSON.stringify(r.summary));
r = await wb('apply=1', EMP, TEAMS_BAD);
check('Apply with something wrong loads nothing', !r.applied && (await get('/api/admin/people')).teams.every((t) => !/^S[12]-/.test(t.name) || !t.members.some((m) => /^W900/.test(m.badge))));
r = await wb('apply=0', EMP.replace('W9002,Bob Baker', 'W9002,Rob Baker'), TEAMS_BAD);
check('One clock-in number with two names is a problem', r.problems.some((p) => p.kind === 'name differs' && /W9002 is Rob Baker on the employees sheet but Bob Baker on team/.test(p.text)), JSON.stringify(r.problems.map((p) => p.text)));
r = await wb('apply=0', EMP + 'W9001,Ann Again,Warehouse,1,\n', '');
check('A clock-in number on two employee rows is a problem, and a workbook with no teams sheet is still read', r.problems.some((p) => p.kind === 'duplicate badge') && !r.hasTeams);

/* ---------------- fixed, then applied ---------------- */
const TEAMS_OK = 'Team #,Department,Employee,Equipment,Clock In Number\nS1-DS01,Warehouse,Ann Able,Dock Stocker,W9001\nS1-DS01,Production,,On Foot with Dock Stockers,\nS2-RT02,Warehouse,Bob Baker,High Reach,W9002\nS2-RT02,Warehouse,Cy Cole,Scissor Lift - Counting,\n';
r = await wb('apply=0', EMP, TEAMS_OK);
check('Fixed: it checks out, with Bob\'s shift still worth knowing and nobody left off a team', r.ok && r.warnings.length === 1 && /Bob Baker/.test(r.warnings[0].text) && r.summary.noTeam === 0, JSON.stringify(r));
r = await wb('apply=1', EMP, TEAMS_OK);
const people = await get('/api/admin/people');
const team = (n) => people.teams.find((t) => t.name === n);
check('Apply loads both: three people on the crew list, two teams with their people, an open seat kept', r.applied && r.employees.imported === 3 && r.teams.teams === 2 && ['W9001', 'W9002', 'W9003'].every((b) => people.employees.some((e) => e.badge === b))
  && team('S1-DS01') && team('S1-DS01').members.map((m) => m.badge).join() === 'W9001' && team('S1-DS01').seats.some((s) => s.open) && team('S2-RT02') && team('S2-RT02').members.map((m) => m.badge).sort().join() === 'W9002,W9003', JSON.stringify({ applied: r.applied, teams: people.teams.filter((t) => /^S[12]-/.test(t.name)).map((t) => [t.name, t.members.map((m) => m.badge)]) }));
check('…Cy, named without a number, was matched by name; the teams took their shift from their numbers', team('S2-RT02').members.some((m) => m.badge === 'W9003') && team('S2-RT02').shift === '2' && team('S1-DS01').shift === '1');
check('…and the log says so', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'uploaded the crew workbook'));

/* ---------------- one sheet with both ---------------- */
const BOTH = 'Clock In Number,Name,Department,Shift,Equipment,Team #\nW9011,Eve Ellis,Warehouse,1,High reach,S1-RT07\nW9012,Fay Fox,Production,1,,S1-RT07\n,,Warehouse,,Scissor lift,S1-RT07\nW9013,Gus Gray,Warehouse,2,,\n';
r = await wb('apply=0', BOTH, BOTH);
check('One sheet with both sets of columns: a row with a number is a person, a row with a team and no name an open seat, a person with no team is noted', r.ok && r.summary.employees === 3 && r.summary.teams === 1 && r.summary.open === 1 && r.summary.noTeam === 1 && r.notes.some((n) => /Gus Gray/.test(n)), JSON.stringify(r.summary) + ' ' + JSON.stringify(r.notes));
r = await wb('apply=1', BOTH, BOTH);
const p2 = await get('/api/admin/people');
check('…and it loads: Eve and Fay on S1-RT07 with an open scissor-lift seat, Gus on the list and no team', r.applied && p2.teams.find((t) => t.name === 'S1-RT07').members.map((m) => m.badge).sort().join() === 'W9011,W9012' && p2.teams.find((t) => t.name === 'S1-RT07').seats.filter((s) => s.open).length === 1 && p2.employees.some((e) => e.badge === 'W9013' && !e.team));

/* ---------------- replacing ---------------- */
r = await wb('apply=0&replaceEmployees=1&replaceTeams=1', BOTH, BOTH);
check('Replace: the check says who and what would go', r.notes.some((n) => /Replace the crew list: \d+ people/.test(n)) && r.notes.some((n) => /Remove teams not on the sheet: \d+ teams/.test(n)), JSON.stringify(r.notes));
r = await wb('apply=0&replaceEmployees=1', EMP, TEAMS_OK.replace('W9001', ''));
check('With the crew list replaced, a name is matched against the workbook alone', r.ok && r.summary.onTeams === 3, JSON.stringify(r.problems));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/teams#people`);
await signIn(page);
await page.waitForSelector('#workbookCard');
await page.evaluate(() => window.appApi.showSub('people'));
await page.setInputFiles('#fWbFile', { name: 'crew.csv', mimeType: 'text/csv', buffer: Buffer.from(EMP.replace('W900', 'W902') + 'W9024,Hal Hale,Warehouse,2,\n') });
await page.click('#btnWbCheck'); await page.waitForTimeout(900);
const rep = clean(await page.textContent('#wbReport'));
check('Teams & crew → Employees → Crew workbook: Check reads the file and shows the sums and what is worth knowing', /4 people · 0 teams/.test(rep) && /on no team/.test(rep) && !(await page.$eval('#btnWbApply', (b) => b.disabled)), rep.slice(0, 140));
await page.setInputFiles('#fWbFile', { name: 'crew2.csv', mimeType: 'text/csv', buffer: Buffer.from(EMP.replace(/W900/g, 'W903') + '\n') });
check('A new file needs checking again before Apply', await page.$eval('#btnWbApply', (b) => b.disabled));
await page.setInputFiles('#fWbFile', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('Clock In Number,Name,Shift,Team #\nW9041,Ian Ives,1,S1-DS09\nW9041,Jo Jones,1,S1-DS09\n') });
await page.click('#btnWbCheck'); await page.waitForTimeout(900);
check('A problem is shown in red and Apply stays off', /on two rows/.test(clean(await page.textContent('#wbReport .bad'))) && await page.$eval('#btnWbApply', (b) => b.disabled), clean(await page.textContent('#wbMsg')));
await page.setInputFiles('#fWbFile', { name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from('Clock In Number,Name,Shift,Equipment,Team #\nW9051,Kim Kay,1,High reach,S1-RT09\nW9052,Lu Lane,1,,S1-RT09\n') });
await page.click('#btnWbCheck'); await page.waitForTimeout(900);
await page.click('#btnWbApply'); await page.waitForTimeout(1200);
check('Apply loads it and says what went in', /Loaded good\.csv/.test(clean(await page.textContent('#wbMsg'))) && /2 people on the crew list/.test(clean(await page.textContent('#wbMsg'))) && /1 team/.test(clean(await page.textContent('#wbMsg'))), clean(await page.textContent('#wbMsg')));
check('…and the team is on the Teams tab with its people', (await get('/api/admin/people')).teams.some((t) => t.name === 'S1-RT09' && t.members.length === 2));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#btnWbSample')]);
check('The sample workbook downloads as an Excel file with the two sheets', /crew-workbook-sample\.xlsx/.test(dl.suggestedFilename()));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
