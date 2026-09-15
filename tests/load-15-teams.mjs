/*
 * Fifteen teams, thirty scanners, all counting at once.
 *
 * The question this answers is not "is the code correct" — the other suites do
 * that — but "does it still behave when the whole floor is working". So it runs
 * the real warehouse bin list, hands fifteen teams an aisle each, gives every
 * team two handhelds, and has all thirty post counts simultaneously while the
 * office board and two dashboards poll over the top of them.
 *
 * It asserts the things that only break under load: nothing lost, nothing
 * double-counted, the racking-block rule still honoured when two teams ask at
 * the same instant, and reads still answering while writes are in flight.
 */
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const TEAMS = Number(process.env.LOAD_TEAMS || 15);
const GUNS_PER_TEAM = Number(process.env.LOAD_GUNS || 2);
let BINS_PER_TEAM = Number(process.env.LOAD_BINS || 120);     // bins each team works through
const BATCH = Number(process.env.LOAD_BATCH || 5);            // lines per sync, as the gun sends them

/* Timing: what a counter and a supervisor actually feel. */
const timed = async (bucket, fn) => {
  const t0 = performance.now();
  try { return await fn(); } finally { bucket.push(performance.now() - t0); }
};
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const ms = (n) => `${n.toFixed(0)}ms`;
const stat = (a) => `n=${a.length} p50 ${ms(pct(a, 0.5))} p95 ${ms(pct(a, 0.95))} max ${ms(Math.max(...a, 0))}`;

const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* ---------------------------------------------------------------- the floor */
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'peak load' }) }));
const binCsv = readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8');
const t0Bins = performance.now();
const binImp = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: binCsv }));
const binSecs = (performance.now() - t0Bins) / 1000;
check(`The real bin list loads in one go (${binImp.bins.toLocaleString()} bins, ${binSecs.toFixed(1)}s)`, binImp.bins > 13000 && binSecs < 60);

const allBins = binCsv.trim().split('\n').slice(1).map((l) => l.split(',')[0]);
const byAisle = new Map();
for (const b of allBins) {
  const a = b.slice(0, 3);
  if (!byAisle.has(a)) byAisle.set(a, []);
  byAisle.get(a).push(b);
}
// the aisles with the most bins, so every team has a full day's work in front of it
const biggest = [...byAisle.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, TEAMS);
const aisles = biggest.map(([a]) => a);
BINS_PER_TEAM = Math.min(BINS_PER_TEAM, ...biggest.map(([, v]) => v.length));
check(`There are ${TEAMS} aisles to give one to every team (${BINS_PER_TEAM} bins each)`, aisles.length === TEAMS, aisles.join(' '));

// one pallet per bin the teams will reach, so the report has something to compare against
const work = new Map(aisles.map((a) => [a, byAisle.get(a).slice(0, BINS_PER_TEAM)]));
let palletCsv = 'Pallet ID,SKU,Description,Qty,Location\n';
for (const [a, bins] of work) bins.forEach((b, i) => { palletCsv += `P-${a}-${i},SKU-${i % 40},Frozen case ${i % 40},${20 + (i % 9)},${b}\n`; });
const palImp = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: palletCsv }));
const EXPECTED_LINES = TEAMS * BINS_PER_TEAM;
check(`The inventory report loads (${palImp.rows.toLocaleString()} pallets)`, palImp.rows === EXPECTED_LINES);

/* Fifteen teams, an aisle each, all queued at once. */
const assigned = await Promise.all(aisles.map((a, i) =>
  fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: String(i + 1), aisles: [a], levels: 'A-F' }) }).then(j)));
check('Every team gets its aisle when fifteen assignments are made at once', assigned.every((r) => r.added && r.added.length === 1));

const live = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { headers: A }));
const active = live.filter((r) => r.status === 'active');
const blocks = new Set(active.map((r) => r.block ?? `aisle:${r.aisle}`));
check(`Nobody is sharing racking: ${active.length} teams active across ${blocks.size} blocks`, blocks.size === active.length);

/* Thirty handhelds sign on at the same moment — the 6am rush. */
const signon = [];
const guns = [];
for (let t = 1; t <= TEAMS; t++) for (let g = 1; g <= GUNS_PER_TEAM; g++) guns.push({ team: String(t), name: `GUN-${t}-${g}`, aisle: aisles[t - 1] });
const regs = await Promise.all(guns.map((gn) => fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: gn.name }) }).then(j)));
await Promise.all(regs.map(async (r, i) => {
  const t = (await j(await fetch(`${BASE}/api/devices/${r.uid}`, { method: 'POST' }))).token;
  guns[i].H = { ...hdr, authorization: 'Device ' + t };
}));
check(`All ${guns.length} scanners trade their setup code for a token at once`, guns.every((gn) => gn.H));

await Promise.all(guns.map((gn) => timed(signon, () =>
  fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: gn.H, body: JSON.stringify({ deviceId: gn.name, team: gn.team, employees: [`E${gn.team}01`] }) }).then(j))));
check(`Thirty sign-ons at once are all answered (${stat(signon)})`, pct(signon, 0.95) < 4000);

/* The master list pull is the heaviest read a gun makes, and every gun makes it
   within the same minute of the shift starting. */
const pulls = [];
const masters = await Promise.all(guns.map((gn) => timed(pulls, () => fetch(`${BASE}/api/sessions/${sess.id}/master`, { headers: gn.H }).then(j))));
check(`Every scanner pulls the full master list at once (${stat(pulls)})`, masters.every((mm) => mm.pallets.length === EXPECTED_LINES));
check('...and each gets the whole warehouse, not a truncated copy', masters.every((mm) => mm.locations.length === binImp.bins),
  `${masters[0].locations.length} of ${binImp.bins}`);

/* ------------------------------------------------- everyone counts at once */
// each team splits its aisle between its guns, the way two counters split a row
const plan = guns.map((gn, i) => {
  const bins = work.get(gn.aisle).filter((_, k) => k % GUNS_PER_TEAM === i % GUNS_PER_TEAM);
  return { ...gn, lines: bins.map((b) => {
    const idx = work.get(gn.aisle).indexOf(b);
    return { clientId: `${gn.name}-${idx}`, palletId: `P-${gn.aisle}-${idx}`, qty: 20 + (idx % 9), location: b, sku: `SKU-${idx % 40}`, team: gn.team, employees: [`E${gn.team}01`], deviceId: gn.name, aisle: gn.aisle, pass: 1, scannedAt: new Date().toISOString() };
  }) };
});
const TOTAL = plan.reduce((n, p) => n + p.lines.length, 0);

// the office board and two dashboards, refreshing over the top of the counting
const reads = [];
let polling = true;
const poller = (path, headers) => (async () => {
  while (polling) {
    try { await timed(reads, () => fetch(BASE + path, { headers }).then((r) => r.text())); } catch { /* counted as a miss below */ }
    await new Promise((r) => setTimeout(r, 100));
  }
})();
const watchers = [
  poller(`/api/board?session=${sess.id}`, {}),
  poller(`/api/admin/sessions/${sess.id}/progress`, A),
  poller(`/api/admin/sessions/${sess.id}/map`, A),
];

const posts = [];
const runGun = async (p) => {
  for (let i = 0; i < p.lines.length; i += BATCH) {
    const batch = p.lines.slice(i, i + BATCH);
    const r = await timed(posts, () => fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: p.H, body: JSON.stringify(batch) }).then(j));
    p.accepted = (p.accepted || 0) + (r.accepted || []).length;
    p.rejected = (p.rejected || 0) + (r.rejected || []).length;
  }
};
const t0 = performance.now();
await Promise.all(plan.map(runGun));
const secs = (performance.now() - t0) / 1000;
polling = false;
await Promise.all(watchers);

check(`Every line from all ${guns.length} scanners was accepted (${TOTAL.toLocaleString()} lines in ${secs.toFixed(1)}s, ${(TOTAL / secs).toFixed(0)}/s)`,
  plan.every((p) => p.accepted === p.lines.length) && plan.every((p) => !p.rejected));
check(`Counting stays snappy for the counter under full load (${stat(posts)})`, pct(posts, 0.95) < 1500);
check(`The office board and dashboards keep answering while thirty guns write (${stat(reads)})`, reads.length >= 6 && pct(reads, 0.95) < 3000);

const prog = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/progress`, { headers: A }));
check(`The dashboard total matches what was sent: ${prog.lines.toLocaleString()} lines`, prog.lines === TOTAL);
check(`...and the bins counted match: ${prog.bins_counted.toLocaleString()}`, prog.bins_counted === TOTAL);

/* --------------------------------------------- the dropped-connection storm */
// every gun re-sends its whole shift after a flaky access point: nothing may double up
const t1 = performance.now();
await Promise.all(plan.map(async (p) => {
  for (let i = 0; i < p.lines.length; i += BATCH) {
    await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: p.H, body: JSON.stringify(p.lines.slice(i, i + BATCH)) });
  }
}));
const again = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/progress`, { headers: A }));
check(`All ${guns.length} scanners re-send everything after a wifi drop and nothing doubles (${((performance.now() - t1) / 1000).toFixed(1)}s)`,
  again.lines === TOTAL, `${again.lines} lines`);

const rep = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=50000`, { headers: A }));
check('No pallet is recorded as counted twice', !rep.rows.some((r) => r.status === 'COUNTED TWICE'));
check('Every pallet the teams reached matches the report', rep.rows.filter((r) => r.status === 'MATCH').length === TOTAL,
  `${rep.rows.filter((r) => r.status === 'MATCH').length} of ${TOTAL}`);

const raw = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
const lines = raw.trim().split('\n').slice(1);
check('The export holds one row per count, no more', lines.length === TOTAL, `${lines.length} rows`);
const teamOf = new Map();
for (const l of lines) { const c = l.split(','); teamOf.set(c[1], c[10]); }
check('Every line is filed under the team that counted it',
  plan.every((p) => p.lines.every((ln) => teamOf.get(ln.palletId) === p.team)));

/* ------------------------------------- fifteen teams finish at the same time */
const mine = await Promise.all(plan.filter((p) => p.name.endsWith('-1')).map((p) =>
  fetch(`${BASE}/api/sessions/${sess.id}/team-status?team=${p.team}`, { headers: p.H }).then(j)));
const done = await Promise.all(mine.map((st, i) => {
  const a = st.active;
  return a ? fetch(`${BASE}/api/sessions/${sess.id}/assignments/${a.id}/complete`, { method: 'POST', headers: plan[i * GUNS_PER_TEAM].H, body: JSON.stringify({ team: String(i + 1) }) }).then((r) => r.status) : 0;
}));
check('Fifteen teams hand their aisle back at the same moment and every hand-back is taken', done.every((s) => s === 200 || s === 0), done.join(','));
const after = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { headers: A }));
const stillActive = after.filter((r) => r.status === 'active');
const blocks2 = new Set(stillActive.map((r) => r.block ?? `aisle:${r.aisle}`));
check('The racking-block rule survived the whole run — never two teams in one block', blocks2.size === stillActive.length);

/* ------------------------------------------------ two teams, same aisle, same instant */
const clash = aisles[0];
const race = await Promise.all([16, 17].map((t) =>
  fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: String(t), aisles: [clash], levels: 'A-F' }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }))));
const liveAfter = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { headers: A })))
  .filter((r) => r.aisle === clash && r.status === 'active');
check('Two supervisors sending different teams to one aisle at the same instant: only one team ends up active there',
  liveAfter.length <= 1, `${liveAfter.length} active on ${clash} (${race.map((r) => r.status).join('/')})`);

console.log(`\n  sign-on      ${stat(signon)}`);
console.log(`  master pull  ${stat(pulls)}`);
console.log(`  count post   ${stat(posts)}`);
console.log(`  dashboards   ${stat(reads)}`);
console.log(`  throughput   ${(TOTAL / secs).toFixed(0)} lines/s from ${guns.length} scanners`);
console.log(`\n${results.filter(Boolean).length}/${results.length} load checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
