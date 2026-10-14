/*
 * The team sheet, as the floor keeps it: Team #, Department, Employee,
 * Equipment - one row per seat. S1-DS01 is 1st shift, dock stocker, truck 01.
 * A name on the crew list goes on the team; a blank name is an open seat that
 * Production fills on the day, and its machine still counts toward the reach.
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
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p) => j(await fetch(BASE + p, { headers: A }));

/* the sheet exactly as it was sent: tab-separated, "Employe " with its typo and trailing space */
const SHEET = `Team #\tDepartment\tEmploye \tEquipment
S1-T0L\tWarehouse\tJosue A Saquiche Hercules\tSupervisor
S1-DS01\tWarehouse\tMichael Roman Travera\tDock Stocker
S1-DS01\tProduction\t\tOn Foot with Dock Stockers
S1-DS02\tWarehouse\tJames Lopez\tDock Stocker
S1-DS02\tProduction\t\tOn Foot with Dock Stockers
S1-DS03\tWarehouse\tPercy Gomez\tDock Stocker
S1-DS03\tProduction\t\tOn Foot with Dock Stockers
S1-DS04\tWarehouse\tOmar Nicolas-Jose\tDock Stocker
S1-DS04\tProduction\t\tOn Foot with Dock Stockers
S1-RT05\tWarehouse\tJason Davies\tHigh Reach
S1-RT05\tWarehouse\tDonovan Lopez\tScissor Lift - Counting
S1-RT05\tProduction\t\tScissor Lift - Driving
S1-RT06\tWarehouse\tJoshua Nicoll\tHigh Reach
S1-RT06\tWarehouse\tZackery Shafer\tScissor Lift - Counting
S1-RT06\tProduction\t\tScissor Lift - Driving
S1-RT07\tWarehouse\tGilson Mendoza Ramirez \tHigh Reach
S1-RT07\tWarehouse\tAngel Ulloa\tScissor Lift - Counting
S1-RT07\tProduction\t\tScissor Lift - Driving
S1-RT08\tWarehouse\tWilliam Rodriguez\tHigh Reach
S1-RT08\tProduction\t\tScissor Lift - Counting
S1-RT08\tProduction\t\tScissor Lift - Driving
S1-RT09\tWarehouse\tJosue Aguilar Madrigal\tHigh Reach
S1-RT09\tProduction\t\tScissor Lift - Counting
S1-RT09\tProduction\t\tScissor Lift - Driving
S1-RT10\tWarehouse\tTimothy A Haynes\tHigh Reach
S1-RT10\tProduction\t\tScissor Lift - Counting
S1-RT10\tProduction\t\tScissor Lift - Driving
`;

/* two of them are on the crew list already, with clock-in numbers */
await post('/api/admin/people/employees/import', 'Clock In Number,Name,Department,Equipment\nE2001,Jason Davies,Warehouse,High reach\nE2002,Michael Roman Travera,Warehouse,\n', csv);

let r = await post('/api/admin/people/teams/import', SHEET, csv);
const st = await j(r);
check('The sheet as sent uploads: eleven teams, twenty-seven seats', r.status === 200 && st.teams === 11 && st.created === 11 && st.seats === 27, JSON.stringify([r.status, st.teams, st.seats, st.error]));
check('…fourteen named people, two found on the crew list, thirteen open seats', st.people === 14 && st.matched === 2 && st.open === 13 && st.notOnCrewList.length === 12, JSON.stringify([st.people, st.matched, st.open, st.notOnCrewList.length]));
check('…and every piece of equipment on it understood', st.unknownEquipment.length === 0, st.unknownEquipment.join(', '));
const people = await get('/api/admin/people');
const team = (n) => people.teams.find((t) => t.name === n);
check('S1-DS01 is 1st shift, dock stocker, truck 01', team('S1-DS01') && team('S1-DS01').shift === '1' && /Dock stocker · truck 01/.test(team('S1-DS01').notes), JSON.stringify(team('S1-DS01') && [team('S1-DS01').shift, team('S1-DS01').notes]));
check('S1-RT05 is a reach truck, truck 05; S1-T0L the team lead', /Reach truck · truck 05/.test(team('S1-RT05').notes) && /Team lead/.test(team('S1-T0L').notes) && team('S1-T0L').shift === '1', `${team('S1-RT05').notes} / ${team('S1-T0L').notes}`);
check('A crew-list person on the sheet is put on the team', team('S1-RT05').members.some((m) => m.badge === 'E2001') && team('S1-DS01').members.some((m) => m.badge === 'E2002'));
check('Each team carries its seats in order: who, the department, the job', team('S1-RT05').seats.map((s) => s.role).join('|') === 'High Reach|Scissor Lift - Counting|Scissor Lift - Driving' && team('S1-RT05').seats[2].open && team('S1-RT05').seats[2].dept === 'Production', JSON.stringify(team('S1-RT05').seats));
check('An open seat\'s machine counts: S1-RT08 has a high reach and a scissor lift though only one person is named', team('S1-RT08').equipment.includes('HIGH REACH') && team('S1-RT08').equipment.includes('SCISSOR LIFT'), team('S1-RT08').equipment.join(','));
check('Dock Stocker reads as the dock truck', team('S1-DS02').equipment.includes('DOCK TRUCK'), team('S1-DS02').equipment.join(','));
check('Each team says what it can reach', st.reach.length === 11 && st.reach.every((x) => x.reach.includes('A')), JSON.stringify(st.reach.slice(0, 3)));

/* uploading again replaces a team's seats, never doubles them */
r = await post('/api/admin/people/teams/import', 'Team #,Department,Employee,Equipment\nS1-DS01,Warehouse,Michael Roman Travera,Dock Stocker\n', csv);
const again = await get('/api/admin/people');
check('Uploading a team again replaces its seats, and leaves the other teams alone', again.teams.find((t) => t.name === 'S1-DS01').seats.length === 1 && again.teams.find((t) => t.name === 'S1-RT05').seats.length === 3 && again.teams.length === 11);
r = await post('/api/admin/people/teams/import?replace=1', 'Team #,Department,Employee,Equipment\nS2-DS01,Warehouse,Ann Lee,Dock Stocker\n', csv);
const repl = await j(r);
const after = await get('/api/admin/people');
check('"Remove teams not on the sheet" leaves just the sheet\'s teams; S2 reads as 2nd shift', repl.removed === 11 && after.teams.length === 1 && after.teams[0].name === 'S2-DS01' && after.teams[0].shift === '2', JSON.stringify([repl.removed, after.teams.map((t) => [t.name, t.shift])]));
check('…and the people on removed teams go back to the crew list, not away', after.employees.some((e) => e.badge === 'E2001' && !e.team));
r = await post('/api/admin/people/teams/import', 'Name,Equipment\nAnn,Dock\n', csv);
check('A sheet with no Team # column is refused with a word on the columns', r.status === 400 && /Team #/.test((await j(r)).error));

/* ---- the page */
await post('/api/admin/people/teams/import?replace=1', SHEET, csv);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/teams`);
await signIn(page);
await page.waitForTimeout(1200);
check('Teams & crew has the team-sheet upload and a sample', await page.isVisible('#btnTeamUpload') && (await page.getAttribute('a[href="/templates/team-sheet-template.csv"]', 'href')) !== null);
const cards = clean(await page.textContent('#teams'));
check('The team cards show the shift note, open seats and people not yet on the crew list', /Team S1-RT08/.test(cards) && /Production — open seat/.test(cards) && /Scissor Lift - Driving/.test(cards) && /William Rodriguez/.test(cards) && /not on the crew list/.test(cards), cards.slice(0, 200));
const fileInput = await page.$('#fTeamFile');
await fileInput.setInputFiles({ name: 'teams.csv', mimeType: 'text/csv', buffer: Buffer.from('Team #,Department,Employee,Equipment\nS1-DS09,Warehouse,Jason Davies,Dock Stocker\n') });
await page.click('#btnTeamUpload'); await page.waitForTimeout(1500);
check('Uploading from the page says what it did', /1 teams from teams.csv/.test(clean(await page.textContent('#teamFileMsg'))) && /1 of 1 named people found on the crew list/.test(clean(await page.textContent('#teamFileMsg'))), clean(await page.textContent('#teamFileMsg')));
const sample = await (await fetch(`${BASE}/templates/team-sheet-template.csv`)).text();
check('The sample sheet is the floor\'s own layout', /^Team #,Department,Employee,Equipment/.test(sample) && /S1-DS01/.test(sample));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
