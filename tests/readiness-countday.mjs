/*
 * Three more things the count-day check catches, each found on a real site the
 * week before a count: the classroom training count still on the scanners, a
 * level of the racking no team can reach with the equipment on the crew list,
 * and a placeholder where somebody's clock-in number should be.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));
const ready = async (sid) => (await j(await fetch(`${BASE}/api/admin/readiness${sid ? '?session=' + sid : ''}`, { headers: A }))).checks;
const find = (checks, re) => checks.find((c) => re.test(c.title));

/* the real count: bins on levels A, B and C */
const S = (await post('/api/admin/sessions', { name: 'Wall to wall' })).id;
const bins = ['F01A001', 'F01A002', 'F01B001', 'F01B002', 'F01B003', 'F01C001'];
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Freezer,F01`).join('\n') + '\n' });

/* a crew whose teams reach A and C-F between them (a team on foot reaches A only), and somebody whose number is a placeholder */
const rt = await post('/api/admin/people/teams', { name: 'S1-RT05', shift: '1' });
const ds = await post('/api/admin/people/teams', { name: 'S1-DS01', shift: '1' });
for (const [badge, name, equipment, team] of [['999403', 'Jason Davies', ['HIGH REACH'], rt], ['999397', 'Donovan Lopez', ['SCISSOR LIFT'], rt], ['999424', 'Oscar Tomasino', ['FOOT'], ds], ['MISSING', 'Silas Young', ['SCISSOR LIFT'], rt]]) {
  await post('/api/admin/people/employees', { badge, name, shift: '1', equipment });
  await post('/api/admin/people/assign', { badge, teamId: team.id });
}
let c = await ready(S);
const lv = find(c, /No team can reach level/);
check('A level with bins that no team can reach is flagged, with how many bins', lv && lv.level === 'warn' && /level B — 3 bins/.test(lv.title) && /reach A, C, D, E, F/.test(lv.detail), lv ? `${lv.title} | ${lv.detail.slice(0, 80)}` : 'no line');
const ph = find(c, /placeholder/);
check('A placeholder clock-in number is flagged by name', ph && ph.level === 'warn' && /Silas Young \("MISSING"\)/.test(ph.title), ph && ph.title);
check('…no classroom line while there is no training count', !find(c, /classroom/i));

/* fix the reach: a dock truck reaches A and B */
await post('/api/admin/people/employees', { badge: '999265', name: 'James Lopez', shift: '1', equipment: ['DOCK TRUCK'] });
await post('/api/admin/people/assign', { badge: '999265', teamId: rt.id });
c = await ready(S);
check('Put the equipment on a team and the level line turns ok', !find(c, /No team can reach/) && find(c, /Every level on the count has a team/), (find(c, /level/i) || {}).title);

/* the classroom */
await post('/api/admin/training', {});
c = await ready();
const cl = find(c, /classroom training count is still on the scanners/);
check('The classroom training count still on the scanners is flagged, and says to press Remove', cl && cl.level === 'warn' && /Remove on the Classroom training card/.test(cl.detail) && cl.fix && cl.fix.page === '/testing');
check('…and the check is still about the real count, not the training one', /^6 bins on the count/.test((find(c, /bins on the count/) || {}).title), (find(c, /bins on the count/) || {}).title);
await post('/api/admin/training/remove', {});
c = await ready();
check('After Remove the line is gone', !find(c, /classroom/i));
check('…and the real teams are still there with their people', (await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).teams.find((t) => t.name === 'S1-DS01').members.length === 1);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
