/*
 * The classroom wall's team names are real team names here: S1-DS01, S1-DS02
 * and S2-DS01 are teams on the crew list, with real people on them. Setting the
 * training up must not put the trainees on those teams, and Remove must not take
 * the real teams - or their people - away with the training.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));
const teams = async () => (await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).teams;
const team = async (name) => (await teams()).find((t) => t.name === name);
const names = (t) => (t ? t.members.map((m) => m.badge || m).sort().join(',') : 'GONE');

/* the real crew: S1-DS01 with two people and a planned seat-less roster, S2-DS01 with one */
const real1 = await post('/api/admin/people/teams', { name: 'S1-DS01', shift: '1' });
const real2 = await post('/api/admin/people/teams', { name: 'S2-DS01', shift: '2' });
await post('/api/admin/people/employees', { badge: '999424', name: 'Michael Roman Travera', shift: '1', equipment: ['DOCK TRUCK'] });
await post('/api/admin/people/employees', { badge: '999387', name: 'Oscar Tomasino', shift: '1', equipment: ['FOOT'] });
await post('/api/admin/people/employees', { badge: '999407', name: 'Joel Mejia', shift: '2', equipment: ['FOOT'] });
await post('/api/admin/people/assign', { badge: '999424', teamId: real1.id });
await post('/api/admin/people/assign', { badge: '999387', teamId: real1.id });
await post('/api/admin/people/assign', { badge: '999407', teamId: real2.id });
const before1 = names(await team('S1-DS01'));

/* the trainer sets the classroom up */
const real = await post('/api/admin/sessions', { name: 'Wednesday wall-to-wall' });
const t = await post('/api/admin/training', {});
const board = await j(await fetch(`${BASE}/api/board`));
check('The office board shows the real count, never the classroom training count by itself', board.session && board.session.id === real.id, JSON.stringify(board.session && { id: board.session.id, name: board.session.name }));
check('…the training count can still be put up by number', (await j(await fetch(`${BASE}/api/board?session=${t.session.id}`))).session.id === t.session.id);
check('Set up works with the real teams already there', t.session && t.loaded.trainees === 8, JSON.stringify(t.loaded));
check('…the trainees are not put on the real team S1-DS01', names(await team('S1-DS01')) === before1, names(await team('S1-DS01')));
check('…nor on S2-DS01', names(await team('S2-DS01')) === '999407', names(await team('S2-DS01')));
check('…the team the training made, S1-DS02, has its three trainees', names(await team('S1-DS02')) === 'TRN-04,TRN-05,TRN-06', names(await team('S1-DS02')));

/* a trainee still signs on with the real team's card */
const dev = await post('/api/admin/devices', { name: 'TRAIN-RT' });
const G = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST', headers: hdr, body: '{}' }))).token };
const so = await j(await fetch(`${BASE}/api/sessions/${t.session.id}/signon`, { method: 'POST', headers: G, body: JSON.stringify({ team: 'S1-DS01', employees: ['TRN-01', 'TRN-02'], deviceId: 'TRAIN-RT' }) }));
check('A trainee still signs on with the S1-DS01 card and gets aisle T01, nobody unknown', so.active && so.active.aisle === 'T01' && so.crew && !so.crew.unknown.length && !so.crew.elsewhere.length, JSON.stringify([so.active && so.active.aisle, so.crew && so.crew.unknown, so.crew && so.crew.elsewhere]));

/* the classes are over: Remove */
const r = await post('/api/admin/training/remove', {});
check('Remove takes the training away', r.removed === t.session.id, JSON.stringify(r));
check('…the real team S1-DS01 stays, its people on it', names(await team('S1-DS01')) === before1, names(await team('S1-DS01')));
check('…so does S2-DS01', names(await team('S2-DS01')) === '999407', names(await team('S2-DS01')));
check('…the team only the training used is gone', !(await team('S1-DS02')));
const people = (await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).employees;
check('…the trainees are off the crew list, the real people are not', !people.some((e) => /^TRN-/.test(e.badge)) && ['999424', '999387', '999407'].every((b) => people.some((e) => e.badge === b)));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
