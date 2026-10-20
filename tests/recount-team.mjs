/*
 * The second-count team: a count can send every second count to one team -
 * inventory control's - while that is ticked, and a supervisor hands some or
 * all of its open ones to other teams when it is swamped. Still blind: a team
 * never gets the second count of a bin it counted first.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

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
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

const BINS = Array.from({ length: 10 }, (_, i) => `F01A${String(i + 1).padStart(3, '0')}`);
const s = await j(await post('/api/admin/sessions', { name: 'Second-count team' }));
const S = s.id;
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + [...BINS, 'F02A001', 'F02A002'].map((b) => `${b},Freezer,${b.slice(0, 3)}`).join('\n') + '\n', csv);
await post(`/api/admin/sessions/${S}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\n' + [...BINS, 'F02A001', 'F02A002'].map((b, i) => `P-${i + 1},S${i},Mango,40,${b}`).join('\n') + '\n', csv);
const d = await j(await post('/api/admin/devices', { name: 'RTEAM-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${d.uid}`, {}, hdr))).token };
let n = 0;
const line = (pallet, qty, bin, team) => ({ clientId: `rt${++n}`, palletId: pallet, qty, location: bin, team, deviceId: 'RTEAM-01', scannedAt: new Date().toISOString() });
const send = (rows) => post(`/api/sessions/${S}/counts`, rows, G);
const tasks = async () => get(`/api/admin/sessions/${S}/recounts`);
const gunTasks = async (team) => (await get(`/api/sessions/${S}/recounts?team=${team}`, G)).tasks;

/* off: second counts go to any team, as before */
await send([line('P-1', 30, 'F01A001', '1'), line('P-2', 31, 'F01A002', '1')]);
let t = await tasks();
check('Off: a new second count is for any team', t.length === 2 && t.every((x) => !x.team));

/* on, for team 90 (inventory control): the open ones go to it at once */
let r = await post(`/api/admin/sessions/${S}/settings`, { recountTeamOn: true, recountTeam: '90' });
let out = await j(r);
check('Ticking Send them all to team 90 is kept on the count', r.status === 200 && out.recount_team_on === 1 && out.recount_team === '90');
check('…and hands it the open second counts nobody had', out.recountTeamHanded && out.recountTeamHanded.assigned === 2, JSON.stringify(out.recountTeamHanded));
await send([line('P-3', 33, 'F01A003', '2'), line('P-4', 34, 'F01A004', '2'), line('P-5', 35, 'F01A005', '2'), line('P-6', 36, 'F01A006', '3')]);
t = await tasks();
check('On: every new second count goes to team 90', t.length === 6 && t.every((x) => x.team === '90'), t.map((x) => x.team).join());
check('…team 90\'s gun has them all; another team\'s has none', (await gunTasks('90')).length === 6 && (await gunTasks('2')).length === 0 && (await gunTasks('5')).length === 0);

/* a bin team 90 counted first: never its own second count */
await send([line('P-11', 20, 'F02A001', '90')]);
const own = (await tasks()).find((x) => x.bin === 'F02A001');
check('A bin team 90 counted first is not given to team 90 — it stays open for any other team', own && !own.team && !(await gunTasks('90')).some((x) => x.bin === 'F02A001') && (await gunTasks('4')).some((x) => x.bin === 'F02A001'), JSON.stringify(own && own.team));

/* by hand: Request second count with no team also goes to team 90 */
r = await post(`/api/admin/sessions/${S}/recounts`, { bin: 'F01A009' });
check('A second count requested by hand, no team named, goes to team 90 too', (await tasks()).find((x) => x.bin === 'F01A009').team === '90');
r = await post(`/api/admin/sessions/${S}/recounts`, { bin: 'F01A010', team: '4' });
check('…unless a team is named', (await tasks()).find((x) => x.bin === 'F01A010').team === '4');

/* swamped: hand some to team 5, then the rest of an aisle back to any team */
const started = (await tasks()).find((x) => x.bin === 'F01A001');
await post(`/api/sessions/${S}/recounts/${started.id}/take`, { team: '90' }, G);
r = await post(`/api/admin/sessions/${S}/recounts/reassign`, { from: '90', to: '5', limit: 3 });
out = await j(r);
t = await tasks();
check('Hand 3 of team 90\'s open second counts to team 5', r.status === 200 && out.moved === 3 && t.filter((x) => x.team === '5').length === 3, JSON.stringify(out));
check('…the one team 90 has started stays with it, and is said', out.taken === 1 && t.find((x) => x.bin === 'F01A001').team === '90');
check('…team 5\'s gun now has them as its own', (await gunTasks('5')).filter((x) => x.mine).length === 3);
// team 5 has F01A002..F01A004; team 2 counted F01A003 and F01A004 first, so only F01A002 can go to it
r = await post(`/api/admin/sessions/${S}/recounts/reassign`, { from: '5', to: '2' });
out = await j(r);
check('Handing them to a team that counted some of those bins first: the rest move, those stay, and it says which', out.moved === 1 && out.skipped.join() === 'F01A003,F01A004', JSON.stringify(out));
r = await post(`/api/admin/sessions/${S}/recounts/reassign`, { from: '90', to: '', aisle: 'F01' });
out = await j(r);
t = await tasks();
check('The rest of team 90\'s aisle F01 back to any team', out.moved >= 1 && t.filter((x) => x.team === '90' && x.status === 'open' && x.bin.startsWith('F01')).length === 0, JSON.stringify(out));
check('The log says who handed what to whom', (await get('/api/admin/audit?limit=30')).some((x) => x.action === 'handed second counts to another team' && /3 from team 90 to team 5/.test(x.detail)));
r = await post(`/api/admin/sessions/${S}/recounts/reassign`, { from: '5', to: '5' });
check('…and handing a team its own is refused', r.status === 400);

/* off again: new ones are for any team; the handed-out ones stay where they are */
await post(`/api/admin/sessions/${S}/settings`, { recountTeamOn: false });
await send([line('P-7', 37, 'F01A007', '3')]);
t = await tasks();
check('Unticked: a new second count is for any team again, and the others stay where they were', !t.find((x) => x.bin === 'F01A007').team && t.filter((x) => x.team === '5').length === 2);

/* a third count: to team 90 only if it did neither earlier count */
await post(`/api/admin/sessions/${S}/settings`, { recountTeamOn: true, recountTeam: '90', thirdCount: true });
const t2 = (await tasks()).find((x) => x.bin === 'F01A002');
await post(`/api/admin/sessions/${S}/recounts/${t2.id}`, { team: '90' });
await post(`/api/sessions/${S}/recounts/${t2.id}/take`, { team: '90' }, G);
await send([{ ...line('P-2', 38, 'F01A002', '90'), pass: 2, recountId: t2.id }]);
await post(`/api/sessions/${S}/recounts/${t2.id}/done`, { team: '90' }, G);
const third = (await tasks()).find((x) => x.bin === 'F01A002' && Number(x.round) === 3);
check('A third count of a bin team 90 second-counted is not team 90\'s — it goes to a third team', third && !third.team && !(await gunTasks('90')).some((x) => x.bin === 'F01A002'), JSON.stringify(third && [third.team, third.second_team]));

/* ------------------------------------------------------------------ the pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#start`);
await signIn(page);
await pickSession(page, S);
await page.waitForTimeout(800);
check('Settings → Count session: Send them all to team, ticked, team 90', (await page.isChecked('#fRecountTeamOn')) && (await page.inputValue('#fRecountTeam')) === '90');
await page.fill('#fRecountTeam', '');
await page.click('#btnSaveSettings');
await page.waitForTimeout(500);
check('…ticked with no team is refused, asking which', /Which team/.test(await page.textContent('#sessionMsg')));
await page.fill('#fRecountTeam', '91');
await page.click('#btnSaveSettings');
await page.waitForTimeout(900);
check('…and a new team is saved', (await get(`/api/admin/sessions`)).find((x) => x.id === S).recount_team === '91');
await page.goto(`${BASE}/admin#second`);
await page.waitForSelector('#scrMain.active');
await page.addStyleTag({ content: '[data-sub] { display: block !important; }' });
await pickSession(page, S);
await page.waitForTimeout(1200);
check('Dashboard → Second counts says where new ones go', /new second counts go to team 91/.test(clean(await page.textContent('#recTeamChip'))) && await page.isVisible('#recTeamChip'));
check('…the hand-over bar lists who has open ones', (await page.isVisible('#recMoveBar')) && /team 5 — 2 open/.test(clean(await page.textContent('#fMoveFrom'))), clean(await page.textContent('#fMoveFrom')));
await page.selectOption('#fMoveFrom', '5');
await page.fill('#fMoveTo', '6'); await page.fill('#fMoveHow', '2');
await page.click('#btnMove');
await page.waitForTimeout(900);
check('Hand them over: 2 to team 6, said on the card', /2 second counts handed from team 5 to team 6/.test(clean(await page.textContent('#recountMsg'))) && (await tasks()).filter((x) => x.team === '6').length === 2, clean(await page.textContent('#recountMsg')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
