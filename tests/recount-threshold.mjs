/* Second counts are for differences worth walking back for. */
import { readFileSync } from 'node:fs';
const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

async function freshSession(name, settings = {}) {
  const s = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name }) }));
  await fetch(`${BASE}/api/admin/sessions/${s.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
  await fetch(`${BASE}/api/admin/sessions/${s.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
  if (Object.keys(settings).length) await fetch(`${BASE}/api/admin/sessions/${s.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify(settings) });
  return s;
}
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'THRESH-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
const pallets = readFileSync(`${S}fixtures/pallets.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const f01 = pallets.filter((c) => /^F01/.test(c[5] || ''));
const post = (id, lines) => fetch(`${BASE}/api/sessions/${id}/counts`, { method: 'POST', headers: D, body: JSON.stringify(lines) });
const openCount = async (id) => (await j(await fetch(`${BASE}/api/admin/sessions/${id}/recounts`, { headers: A }))).filter((r) => r.status !== 'done').length;
const gen = async (id) => j(await fetch(`${BASE}/api/admin/sessions/${id}/recounts/generate`, { method: 'POST', headers: A, body: '{}' }));

/* ---- the flood: a pallet nobody has reached is not a missing pallet ---- */
const a = await freshSession('mid-count generate', { autoRecount: false });
await post(a.id, f01.slice(0, 10).map((c, i) => ({ clientId: 'a' + i, palletId: c[0], qty: Number(c[4]), location: c[5], team: '1', deviceId: 'THRESH-01' })));
const g1 = await gen(a.id);
check('Mid-count, "raise from all variances" does not mark every unreached pallet as missing',
  g1.created === 0 && g1.skippedUnworked > 400,
  `${g1.created} raised, ${g1.skippedUnworked} left alone as not-yet-reached`);
check('...so the open list stays workable', (await openCount(a.id)) === 0, `${await openCount(a.id)} open`);

/* ---- but a pallet genuinely absent from a bin somebody counted IS raised ---- */
const b = await freshSession('genuinely missing', { autoRecount: false });
// count one bin, but not the pallet the report says is in it
const victim = f01[0];
await post(b.id, [{ clientId: 'b1', emptyBin: 1, palletId: '', qty: 0, location: victim[5], team: '1', deviceId: 'THRESH-01' }]);
const g2 = await gen(b.id);
const raised = await j(await fetch(`${BASE}/api/admin/sessions/${b.id}/recounts`, { headers: A }));
check('A pallet absent from a bin that WAS counted is raised as missing',
  raised.some((r) => r.bin === victim[5] && r.reason === 'MISSING'), `${g2.created} raised`);

/* ---- thresholds ---- */
const c = await freshSession('thresholds', { autoRecount: false, recountMinQty: 10, recountMinPct: 5 });
const settings = await j(await fetch(`${BASE}/api/admin/sessions/${c.id}/setup`, { headers: A }));
check('The thresholds are stored on the session', !!settings, '');
const big = f01[0], small = f01[1];
await post(c.id, [
  { clientId: 'c1', palletId: small[0], qty: Math.max(0, Number(small[4]) - 1), location: small[5], team: '1', deviceId: 'THRESH-01' },
  { clientId: 'c2', palletId: big[0], qty: Math.max(0, Number(big[4]) - 40), location: big[5], team: '1', deviceId: 'THRESH-01' },
]);
const g3 = await gen(c.id);
const rc = await j(await fetch(`${BASE}/api/admin/sessions/${c.id}/recounts`, { headers: A }));
check('A difference of one unit is under the threshold and is left alone',
  !rc.some((r) => r.pallet_id === small[0]) && g3.skippedSmall >= 1, `${g3.skippedSmall} under the threshold`);
check('A difference of 40 units is over it and raises a second count',
  rc.some((r) => r.pallet_id === big[0] && r.reason === 'QTY VARIANCE'), '');

/* ---- a small pallet, proportionally way out, still gets raised ---- */
const d = await freshSession('percentage', { autoRecount: false, recountMinQty: 1000, recountMinPct: 20 });
const p2 = f01[2];
await post(d.id, [{ clientId: 'd1', palletId: p2[0], qty: Math.max(0, Math.floor(Number(p2[4]) * 0.5)), location: p2[5], team: '1', deviceId: 'THRESH-01' }]);
await gen(d.id);
const rd = await j(await fetch(`${BASE}/api/admin/sessions/${d.id}/recounts`, { headers: A }));
check('Half a pallet missing clears the percentage threshold even under the unit one',
  rd.some((r) => r.pallet_id === p2[0]), `expected ${p2[4]}, counted half`);

/* ---- the cap ---- */
const e = await freshSession('capped', { autoRecount: false, recountCap: 5 });
await post(e.id, f01.slice(0, 20).map((c2, i) => ({ clientId: 'e' + i, palletId: c2[0], qty: 1, location: c2[5], team: '1', deviceId: 'THRESH-01' })));
const g5 = await gen(e.id);
check('The cap stops the list growing past what a team can work',
  (await openCount(e.id)) <= 5 && g5.cappedAt === 5, `${await openCount(e.id)} open, cap ${g5.cappedAt}`);

/* ---- the default is unchanged: raise everything ---- */
const f = await freshSession('no thresholds', { autoRecount: false });
await post(f.id, [{ clientId: 'f1', palletId: f01[0][0], qty: Math.max(0, Number(f01[0][4]) - 1), location: f01[0][5], team: '1', deviceId: 'THRESH-01' }]);
await gen(f.id);
const rf = await j(await fetch(`${BASE}/api/admin/sessions/${f.id}/recounts`, { headers: A }));
check('With thresholds at 0 a single unit still raises one, as it always did',
  rf.some((r) => r.pallet_id === f01[0][0]), '');

console.log(`\n${results.filter(Boolean).length}/${results.length} recount-threshold checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
