/*
 * Employees: add someone, edit anything about them (their clock-in number
 * included), and remove them - from the Employees tab's table, and from their
 * card on the Teams tab.
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
const people = async () => (await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).employees;
const person = async (badge) => (await people()).find((e) => e.badge === badge);
const log = async () => { const out = await j(await fetch(`${BASE}/api/admin/audit?limit=50`, { headers: A })); return Array.isArray(out) ? out : out.rows || []; };

/* ------------------------------------------------------------------ the API */
let r = await post('/api/admin/people/employees?new=1', { badge: 'k1', name: 'Kim Ash', dept: 'Freezer', equipment: ['SCISSOR LIFT'], jacket: 'large', boots: '9 1/2' });
let e = await j(r);
check('Add employee: a new person, with sizes', r.status === 200 && e.badge === 'K1' && e.jacket === 'L' && e.boots === '9.5' && e.equipment.join() === 'SCISSOR LIFT', JSON.stringify(e));
r = await post('/api/admin/people/employees?new=1', { badge: 'K1', name: 'Someone Else' });
e = await j(r);
check('…a number already on the list is refused, and says whose it is', r.status === 409 && /K1 is already Kim Ash/.test(e.error) && (await person('K1')).name === 'Kim Ash', e.error);
r = await post('/api/admin/people/employees?new=1', { badge: 'K9', name: '  ' });
check('…and a name is needed', r.status === 400);
r = await post('/api/admin/people/employees', { badge: 'K1', name: 'Kim Ash', dept: 'Freezer', equipment: [] });
check('The old add-or-update call still updates (the crew-list upload relies on it)', r.status === 200 && (await person('K1')).equipment.length === 0);

await post('/api/admin/people/employees?new=1', { badge: 'K2', name: 'Lee Park', dept: 'Dock' });
const team = await j(await post('/api/admin/people/teams', { name: '7' }));
await post('/api/admin/people/assign', { badge: 'K2', teamId: team.id });
r = await post('/api/admin/people/employees/K2', { name: 'Lee Parker', dept: '', equipment: ['HIGH REACH', 'SCISSOR LIFT'], bibs: 'xl' });
e = await j(r);
check('Edit: name, department cleared, equipment, a size', r.status === 200 && e.name === 'Lee Parker' && e.dept === '' && e.equipment.join() === 'HIGH REACH,SCISSOR LIFT' && e.bibs === 'XL' && e.reach.length > 1, JSON.stringify(e));
r = await post('/api/admin/people/employees/K2', { shift: 'second' });
e = await j(r);
check('Edit: the shift, however it is written', r.status === 200 && e.shift === '2', JSON.stringify(e && e.shift));
r = await post('/api/admin/people/employees/K2', { badge: 'k22' });
e = await j(r);
check('…a new clock-in number, and their team place goes with them', r.status === 200 && e.badge === 'K22' && e.team === '7' && e.name === 'Lee Parker' && !(await person('K2')), JSON.stringify(e));
r = await post('/api/admin/people/employees/K22', { badge: 'K1' });
check('…a number someone else has is refused', r.status === 409 && (await person('K22')).name === 'Lee Parker');
r = await post('/api/admin/people/employees/K22', { name: '' });
check('…an empty name is refused', r.status === 400);
r = await post('/api/admin/people/employees/NOBODY', { name: 'X' });
check('…and someone not on the list is a 404', r.status === 404);
const lines = (await log()).map((x) => `${x.action} ${x.detail}`).join('\n');
check('The log says who was added, edited and how', /added an employee K1 Kim Ash/.test(lines) && /edited an employee K22 Lee Parker: badge K2 → K22/.test(lines) && /edited an employee K2 Lee Parker: name Lee Park → Lee Parker/.test(lines), lines.split('\n').slice(0, 4).join(' | '));

/* ------------------------------------------------------------------ the page */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (x) => errors.push(x.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/teams`);
await signIn(page);

const tabs = await page.$$eval('#subTabs button', (bs) => bs.map((b) => b.dataset.goto + ':' + b.textContent.replace(/\d+$/, '').trim()));
check('Teams & crew has an Employees tab', tabs.join(',') === 'crew:Teams,people:Employees,gear:Gear sizes,rules:Equipment rules', tabs.join(','));
check('Employees lists everyone, team or not', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 2 && /Team 7/.test(await page.textContent('#peopleTable tr[data-badge="K22"]')));

/* add from the form */
await page.fill('#fBadge', 'K3');
await page.fill('#fName', 'Mo Diaz');
await page.fill('#fDept', 'Freezer');
await page.selectOption('#fAddShift', '1');
await page.check('#equipPicker input[value="DOCK TRUCK"]');
await page.selectOption('#fAddJacket', 'M');
await page.selectOption('#fAddBoots', '10');
await page.click('#btnAddPerson');
await page.waitForSelector('#peopleTable tr[data-badge="K3"]');
e = await person('K3');
check('Add employee on the page: every field, shift and sizes included', e && e.name === 'Mo Diaz' && e.dept === 'Freezer' && e.shift === '1' && e.equipment.join() === 'DOCK TRUCK' && e.jacket === 'M' && e.boots === '10', JSON.stringify(e));
check('…the form clears for the next person', (await page.inputValue('#fBadge')) === '' && (await page.inputValue('#fAddJacket')) === '' && (await page.inputValue('#fAddShift')) === '' && !(await page.isChecked('#equipPicker input[value="DOCK TRUCK"]')));
check('…the list has a Shift column, and the row says 1st shift', /1st shift/.test(await page.textContent('#peopleTable tr[data-badge="K3"] td.shift')) && /2nd shift/.test(await page.textContent('#peopleTable tr[data-badge="K22"] td.shift')));
check('…and says so', /Mo Diaz added/.test(await page.textContent('#personMsg')));
await page.fill('#fBadge', 'K3'); await page.fill('#fName', 'Not Mo');
await page.click('#btnAddPerson');
await page.waitForTimeout(400);
check('Adding a number already on the list says whose it is, and changes nothing', /already Mo Diaz/.test(await page.textContent('#personMsg')) && (await person('K3')).name === 'Mo Diaz');
await page.fill('#fBadge', ''); await page.fill('#fName', '');

/* edit from the table */
await page.click('#peopleTable button[data-edit="K3"]');
const form = page.locator('#peopleTable .empform[data-badge="K3"]');
check('Edit opens the form under the row, filled in', (await form.count()) === 1 && (await form.locator('input[data-f="name"]').inputValue()) === 'Mo Diaz' && (await form.locator('select[data-gear="jacket"]').inputValue()) === 'M' && (await form.locator('select[data-f="shift"]').inputValue()) === '1');
await form.locator('input[data-f="name"]').fill('Mo Diaz-Lopez');
await form.locator('select[data-f="shift"]').selectOption('2');
await form.locator('input[data-f="badge"]').fill('K33');
await form.locator('input[data-gear="dept"]').fill('Shipping');
await form.locator('.kitpick input[value="DOCK TRUCK"]').uncheck();
await form.locator('.kitpick input[value="HIGH REACH"]').check();
await form.locator('select[data-gear="bibs"]').selectOption('L');
await form.locator('button.primary').click();
await page.waitForSelector('#peopleTable tr[data-badge="K33"]');
e = await person('K33');
check('…Save keeps all of it, the new clock-in number too', e && e.name === 'Mo Diaz-Lopez' && e.dept === 'Shipping' && e.shift === '2' && e.equipment.join() === 'HIGH REACH' && e.bibs === 'L' && e.jacket === 'M' && !(await person('K3')), JSON.stringify(e));
check('…and the form closes', (await page.locator('#peopleTable .empform').count()) === 0);
check('…and their card on the Teams tab wears the shift', (await page.locator('.person[data-badge="K33"] .shiftchip').textContent()).trim() === '2nd shift' && (await page.locator('.person[data-badge="K1"] .shiftchip').count()) === 0);

/* find and filter */
await page.fill('#fPeopleFind', 'parker');
check('Find narrows the list', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 1);
await page.fill('#fPeopleFind', '');
await page.selectOption('#fPeopleTeam', 'none');
check('…so does Not on a team', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 2);
await page.selectOption('#fPeopleTeam', '');
await page.selectOption('#fPeopleDept', '-');
check('…and No department', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 1 && (await page.locator('#peopleTable tr[data-badge="K22"]').count()) === 1);
await page.selectOption('#fPeopleDept', '');
await page.selectOption('#fPeopleShift', '2');
check('…and the shift: 2nd shift is two of them', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 2 && (await page.locator('#peopleTable tr[data-badge="K33"]').count()) === 1);
await page.selectOption('#fPeopleShift', '-');
check('…No shift is the one left', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 1 && (await page.locator('#peopleTable tr[data-badge="K1"]').count()) === 1);
await page.selectOption('#fPeopleShift', '');

/* edit from a card on the Teams tab */
const card = page.locator('.person[data-badge="K1"]');
await card.locator('[data-gear-edit]').click();
check('A crew card opens the same form', (await card.locator('.empform input[data-f="badge"]').count()) === 1 && (await card.getAttribute('draggable')) === 'false');
await card.locator('.empform input[data-f="name"]').fill('Kim Ashworth');
await card.locator('.empform button.primary').click();
await page.waitForTimeout(600);
check('…and saves from there', (await person('K1')).name === 'Kim Ashworth' && /Kim Ashworth/.test(await page.textContent('.person[data-badge="K1"] .who')));

/* remove */
await page.click('#peopleTable button[data-remove="K22"]');
await page.waitForTimeout(600);
check('Remove takes them off the list, and off their team', !(await person('K22')) && (await page.locator('#peopleTable tr[data-badge="K22"]').count()) === 0
  && !(await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).teams.find((t) => t.name === '7').members.length);
check('…the log records it', (await log()).some((x) => x.action === 'removed an employee' && /K22 Lee Parker \(was on team 7\)/.test(x.detail)));
await page.click('#peopleTable button[data-edit="K1"]');
await page.locator('#peopleTable .empform[data-badge="K1"] button.del').click();
await page.waitForTimeout(600);
check('…and so does Remove inside the form', !(await person('K1')));
check('The tab counts who is left', clean(await page.textContent('#peopleChip')) === '1 person');

/* a search hit for a person lands on their row */
await page.evaluate(() => window.appApi.goto({ page: '/teams', sub: 'people', focus: 'fPeopleFind', value: 'K33' }));
await page.waitForTimeout(700);
check('A search hit for a person opens Employees on their row', (await page.locator('#peopleTable tbody tr[data-badge]').count()) === 1 && (await page.inputValue('#fPeopleFind')) === 'K33');
const sr = await j(await fetch(`${BASE}/api/admin/search?q=Diaz`, { headers: A }));
const hit = (sr.groups || []).flatMap((g) => g.rows || []).find((x) => /Mo Diaz-Lopez/.test(x.title));
check('…which is where the search sends it', hit && hit.goto.sub === 'people' && hit.goto.value === 'K33', JSON.stringify(hit && hit.goto));

/* the shift on the crew-list upload and the export: its own column, no longer read as the department */
const csvH = { authorization: A.authorization, 'content-type': 'text/csv' };
r = await fetch(`${BASE}/api/admin/people/employees/import`, { method: 'POST', headers: csvH, body: 'Clock In Number,Name,Department,Shift\nK5,Pat Night,Freezer,2nd\nK6,Dawn Day,Freezer,first\nK33,,,\n' });
check('Upload: a Shift column lands on the shift, the department stays the department', r.status === 200 && (await person('K5')).shift === '2' && (await person('K5')).dept === 'Freezer' && (await person('K6')).shift === '1', JSON.stringify([await person('K5'), await person('K6')].map((x) => x && [x.dept, x.shift])));
check('…and a blank Shift cell leaves what was entered', (await person('K33')).shift === '2');
const exp = await (await fetch(`${BASE}/api/admin/people/export/employees.csv`, { headers: A })).text();
check('Export current list has the shift column', /^badge,name,dept,shift,/.test(exp) && exp.split('\n').some((l) => /^K5,Pat Night,Freezer,2,/.test(l)), exp.split('\n')[0]);
check('No page errors', !errors.length, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
