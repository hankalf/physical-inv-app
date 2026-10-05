/*
 * How fast the office's pages answer on a full-size count.
 *
 * Loads the real bin list (13,700 bins), a pallet for every bin and a count
 * line for every one of them, then times each read the dashboard and the
 * office board make, one at a time, with nothing else going on - so what is
 * measured is the work each read does, not the queue behind forty guns.
 *
 *   node tools/bench-dashboard.mjs           prints a table, slowest first
 *   BENCH_ROUNDS=40 node tools/bench-dashboard.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const PORT = Number(process.env.BENCH_PORT || 3950);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.env.BENCH_ROUNDS || 15);
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const dataDir = mkdtempSync(join(tmpdir(), 'bench-'));
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'bench.db'), SUPERADMIN_USER: 'DANA-WHITFIELD', SUPERADMIN_NAME: 'Dana', SUPERADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
  const post = (p, b, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) }).then(j);

  const sess = await post('/api/admin/sessions', { name: 'bench' });
  const binCsv = readFileSync(join(ROOT, 'tests', 'fixtures', 'front-royal-bins.csv'), 'utf8');
  await post(`/api/admin/sessions/${sess.id}/master?kind=bins`, binCsv, csv);
  const bins = binCsv.trim().split('\n').slice(1).map((l) => l.split(',')[0]);
  let pal = 'Pallet ID,SKU,Description,Qty,Location\n';
  bins.forEach((b, i) => { pal += `P-${i},SKU-${i % 60},Frozen case ${i % 60},${20 + (i % 9)},${b}\n`; });
  await post(`/api/admin/sessions/${sess.id}/master?kind=pallets`, pal, csv);

  // twenty teams, each with an aisle, and a gun each
  const aisles = [...new Set(bins.map((b) => b.slice(0, 3)))].slice(0, 20);
  for (let t = 0; t < aisles.length; t++) await post(`/api/admin/sessions/${sess.id}/assignments`, { team: String(t + 1), aisles: [aisles[t]], levels: 'A-F', force: true });
  const dev = await post('/api/admin/devices', { name: 'BENCH-1' });
  const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
  await post(`/api/sessions/${sess.id}/signon`, { deviceId: 'BENCH-1', team: '1', employees: ['E1'] }, D);

  // a count line for every bin, a few off so there are variances and second counts
  const t0 = performance.now();
  for (let i = 0; i < bins.length; i += 200) {
    const lines = bins.slice(i, i + 200).map((b, k) => {
      const n = i + k;
      return { clientId: `b-${n}`, palletId: n % 97 === 0 ? `X-${n}` : `P-${n}`, qty: 20 + (n % 9) - (n % 41 === 0 ? 3 : 0), location: b, team: String(1 + (n % 20)), employees: ['E1'], deviceId: 'BENCH-1', aisle: b.slice(0, 3), pass: 1, scannedAt: new Date().toISOString() };
    });
    await post(`/api/sessions/${sess.id}/counts`, lines, D);
  }
  console.log(`loaded ${bins.length.toLocaleString()} bins, pallets and count lines in ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);

  const reads = [
    ['progress', `/api/admin/sessions/${sess.id}/progress`],
    ['map', `/api/admin/sessions/${sess.id}/map`],
    ['pallets (Reports tab)', `/api/admin/sessions/${sess.id}/pallets?limit=100000`],
    ['pallets?limit=200', `/api/admin/sessions/${sess.id}/pallets?limit=200`],
    ['board', `/api/board?session=${sess.id}`],
    ['assignments', `/api/admin/sessions/${sess.id}/assignments`],
    ['recounts', `/api/admin/sessions/${sess.id}/recounts`],
    ['adjustments', `/api/admin/sessions/${sess.id}/adjustments`],
    ['alerts', `/api/admin/sessions/${sess.id}/alerts`],
    ['clocks', `/api/admin/sessions/${sess.id}/clocks`],
    ['sessions', '/api/admin/sessions'],
    ['issues', `/api/admin/sessions/${sess.id}/issues`],
  ];
  /* "after a scan": a count line lands first, so nothing kept can answer;
     "another screen": the same read again with nothing changed in between,
     which is every other screen open on the same count. */
  let seq = 0;
  const scan = () => post(`/api/sessions/${sess.id}/counts`, [{ clientId: `x-${++seq}`, palletId: 'P-1', qty: 20, location: bins[1], team: '1', employees: ['E1'], deviceId: 'BENCH-1', aisle: bins[1].slice(0, 3), pass: 1, scannedAt: new Date().toISOString() }], D);
  const time = async (path, h) => { const s = performance.now(); const res = await fetch(BASE + path, { headers: h }); await res.arrayBuffer(); return [performance.now() - s, res.status]; };
  const rows = [];
  for (const [name, path] of reads) {
    const cold = [], warm = [];
    let status = 0;
    for (let r = 0; r < ROUNDS; r++) {
      await scan();
      const [c, st] = await time(path, name === 'board' ? {} : A);
      const [w] = await time(path, name === 'board' ? {} : A);
      cold.push(c); warm.push(w); status = st;
    }
    const mid = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    rows.push({ name, status, cold: mid(cold), warm: mid(warm) });
  }
  rows.sort((a, b) => b.cold - a.cold);
  console.log('read                 status  after a scan  another screen');
  for (const r of rows) console.log(`${r.name.padEnd(22)} ${String(r.status).padEnd(6)} ${r.cold.toFixed(1).padStart(9)} ms ${r.warm.toFixed(1).padStart(11)} ms`);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  if (process.env.BENCH_KEEP) console.log(`\nkept: ${join(dataDir, 'bench.db')}`);
  else rmSync(dataDir, { recursive: true, force: true });
}
