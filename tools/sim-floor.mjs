/*
 * The whole floor, for a whole count.
 *
 * Twenty teams, two scanners each, counting twenty thousand bins over three
 * shifts - and the three shifts played out in six hours of real time, so what
 * a count day does to the app (the sign-on rush, forty guns posting at once, a
 * lunch break that trips the stopped-scanning alert, second counts piling up
 * behind the variances, SOS calls, the office approving adjustments over the
 * top of it all) happens in front of a camera. Every few minutes the dashboard
 * and the office board are photographed, and the frames are stitched into a
 * page you can scroll or scrub through to watch the count go.
 *
 *   node tools/sim-floor.mjs                  the full thing: 6 hours
 *   SIM_HOURS=0.1 SIM_BINS=1500 SIM_SNAP_MIN=1 node tools/sim-floor.mjs      a six-minute rehearsal
 *
 * Everything is driven through the same HTTP API the guns and the pages use.
 * Nothing is written into the database behind the app's back. The output goes
 * to docs/load-test: frames/, timeline.json, summary.json, index.html.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const OUT = process.env.SIM_OUT || join(ROOT, 'docs', 'load-test');
const FRAMES = join(OUT, 'frames');
const PORT = Number(process.env.SIM_PORT || 3900);
const BASE = `http://127.0.0.1:${PORT}`;

const HOURS = Number(process.env.SIM_HOURS || 6);           // wall-clock hours for the whole count
const DAYS = Number(process.env.SIM_DAYS || 3);              // shifts the count takes
const TEAMS = Number(process.env.SIM_TEAMS || 20);
const GUNS_PER_TEAM = 2;
const BINS = Number(process.env.SIM_BINS || 20000);
const SNAP_MIN = Number(process.env.SIM_SNAP_MIN || 10);     // minutes between snapshots
const SHIFT_START = 6 * 60;                                  // 06:00
const SHIFT_MIN = 510;                                       // to 14:30
const WALL_DAY_MS = (HOURS * 3600000) / DAYS;                // one shift in wall time
const SCALE = SHIFT_MIN * 60000 / WALL_DAY_MS;               // sim minutes per wall minute
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const SITE_DATE = new Date('2026-10-05T06:00:00-04:00');     // the Monday the count starts

/* the shift, in minutes after 06:00: when the guns count and when they stop */
const BREAKS = [[165, 180, 'morning break'], [330, 360, 'lunch'], [435, 450, 'afternoon break']];
const COUNT_UNTIL = DAYS === 1 ? 480 : 495;                  // 14:15 - hand-backs and sign-off after
const SIGNON_RUSH = 10;                                      // 06:00-06:10: everyone signs on

const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); try { logLines.push(line); } catch { /* early */ } };
const logLines = [];

mkdirSync(FRAMES, { recursive: true });

/* ------------------------------------------------------------ the server */
const dataDir = mkdtempSync(join(tmpdir(), 'simfloor-'));
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'floor.db'), SUPERADMIN_USER: 'DANA-WHITFIELD', SUPERADMIN_NAME: 'Dana Whitfield', SUPERADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; if (serverErr.length > 20000) serverErr = serverErr.slice(-10000); });

/* latencies, by what a person would feel them as */
const lat = { count: [], signon: [], master: [], dashboard: [], board: [], office: [] };
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const stat = (a) => ({ n: a.length, p50: Math.round(pct(a, 0.5)), p95: Math.round(pct(a, 0.95)), max: Math.round(Math.max(0, ...a)) });
let failures = 0;
const failed = [];
async function call(path, { method = 'GET', headers = hdr, body, bucket, retries = 3 } = {}) {
  for (let i = 0; ; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      const ms = performance.now() - t0;
      if (bucket) lat[bucket].push(ms);
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!r.ok) {
        const err = new Error((data && data.error) || `${r.status} on ${path}`);
        err.status = r.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.status && err.status < 500) throw err;            // a refusal is an answer
      if (i >= retries) { failures++; if (failed.length < 50) failed.push(`${method} ${path}: ${err.message}`); throw err; }
      await wait(300 * (i + 1));
    }
  }
}

let browser = null;
const state = { phase: 'starting', day: 0, simTime: '', lines: 0, startedAt: new Date().toISOString(), snapshots: 0, sos: 0, approved: 0, rejected: 0, secondCounts: 0, handbacks: 0 };
const saveState = () => { try { writeFileSync(join(OUT, 'state.json'), JSON.stringify({ ...state, failures, failed: failed.slice(0, 10), at: new Date().toISOString() }, null, 2)); } catch { /* best effort */ } };

try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await wait(200);
  }
  log(`server up on ${BASE}; ${TEAMS} teams, ${BINS.toLocaleString()} bins, ${DAYS} shifts in ${HOURS} h (x${SCALE.toFixed(1)} time)`);

  /* ---------------------------------------------------------------- people */
  const tok = (await call('/api/admin/login', { method: 'POST', body: { username: 'DANA-WHITFIELD', password: 'changeme' } })).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  const csvH = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
  const post = (p, body, h = A, bucket) => call(p, { method: 'POST', headers: h, body, bucket });
  const get = (p, h = A, bucket) => call(p, { headers: h, bucket });

  await post('/api/admin/users', { username: 'MARCUS-OBI', name: 'Marcus Obi', password: 'dock-side-77', mustChange: false, profile: 'supervisor' }).catch(() => {});
  await post('/api/admin/users', { username: 'IVY-CHEN', name: 'Ivy Chen', password: 'cold-room-11', mustChange: false, profile: 'inventory' }).catch(() => {});
  const marcusTok = (await call('/api/admin/login', { method: 'POST', body: { username: 'MARCUS-OBI', password: 'dock-side-77' } })).token;
  const M = { ...hdr, authorization: 'Bearer ' + marcusTok };

  /* ---------------------------------------------------------------- the bins
     The real Front Royal list, and when the count wants more bins than it has,
     more freezer aisles in the same shape - F25 onwards, as if the extension
     were racked. */
  const template = readFileSync(join(ROOT, 'public', 'templates', 'front-royal-bins.csv'), 'utf8').trim().split(/\r?\n/);
  const head = template[0];
  let rows = template.slice(1).filter((l) => /^F\d\d/.test(l));          // the freezer - this is a freezer count
  const donors = ['F02', 'F03', 'F04', 'F05', 'F07', 'F09', 'F10', 'F11'];
  let extra = 25;
  while (rows.length < BINS) {
    const donor = donors[(extra - 25) % donors.length];
    const code = `F${pad(extra)}`;
    const cloned = template.slice(1).filter((l) => l.startsWith(donor)).map((l) => l.split(donor).join(code).replace(`Rack ${donor.slice(1)}`, `Rack ${code.slice(1)}`));
    rows = rows.concat(cloned);
    extra++;
  }
  rows = rows.slice(0, BINS);
  const binCsv = head + '\n' + rows.join('\n') + '\n';
  const binCodes = rows.map((l) => l.split(',')[0]);
  const aisleOf = (code) => code.slice(0, 3);
  const byAisle = new Map();
  for (const b of binCodes) { if (!byAisle.has(aisleOf(b))) byAisle.set(aisleOf(b), []); byAisle.get(aisleOf(b)).push(b); }
  const aisles = [...byAisle.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  log(`${binCodes.length.toLocaleString()} bins in ${aisles.length} aisles (${aisles[0]}–${aisles[aisles.length - 1]})`);

  /* ------------------------------------------------------------ the report
     Frozen fruit, in the site's own formats: lot FXXXXX, pallet FXXXXX-XXX,
     case UOM, best-before as MM/DD/YYYY, three source systems. And the truth
     under it: what the counters will actually find. */
  const ITEMS = [
    ['WFC1085316', 'WFC Conv. Mango Chunks 16oz/12', 'CS', 75], ['MMC1742964', 'Strawberry sliced IQF', 'CS30LB', 40], ['BLUCWHCL', 'Blueberry wild IQF', 'CS30LB', 48],
    ['SCC1742001', 'Peach slices IQF', 'C10KG', 42], ['WFO1203344', 'Raspberry whole IQF', 'CASE', 60], ['1140-GTV', 'Pineapple tidbits IQF', 'C10KG', 48],
    ['SCC1742018', 'Dark sweet cherries pitted IQF', 'CS30LB', 36], ['BLKCWHCL', 'Blackberry whole IQF', 'CS30LB', 40], ['WFO1203391', 'Mixed berries IQF', 'CS40LB', 30],
    ['1177-GTV', 'Banana slices IQF', 'BAG', 32], ['WFC1085402', 'Avocado halves IQF', 'BOX', 50], ['SCC1742077', 'Cranberry whole IQF', 'CS30LB', 40],
  ];
  const SYSTEMS = ['JustFood', 'SGI', 'NTFF'];
  const d9 = () => 1 + Math.floor(Math.random() * 9);
  const lotOf = () => `F${d9()}${d9()}${d9()}${d9()}${d9()}`;
  const usDate = (days) => { const d = new Date(Date.now() + days * 86400000); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`; };
  let report = 'Bin Code,Container No.,Item No.,Description,Variant Code,Quantity,Unit of Measure Code,Entry No.,Lot No.,System,Best Before\n';
  let entryNo = 2500000;
  const truth = new Map();              // bin -> [{ id, qty, sku, kind }] what is physically there
  const planted = { short: 0, over: 0, missing: 0, unlisted: 0, moved: 0, label: 0, expired: 0 };
  const usedIds = new Set();
  const newId = (lot) => { let id; do { id = Math.random() < 0.7 ? `FR${10000000 + Math.floor(Math.random() * 89999999)}` : `${lot}-${d9()}${d9()}${d9()}`; } while (usedIds.has(id)); usedIds.add(id); return id; };
  let reportRows = 0;
  for (let i = 0; i < binCodes.length; i++) {
    const bin = binCodes[i];
    const r = Math.random();
    const n = r < 0.14 ? 0 : r < 0.92 ? 1 : 2;                 // 14% empty, 78% one pallet, 8% two
    if (!n) report += `${bin},,,,,,,,,OPEN,\n`;              // the report lists its empty positions too
    const here = [];
    for (let k = 0; k < n; k++) {
      const [sku, desc, uom, base] = ITEMS[(i * 7 + k * 3) % ITEMS.length];
      const lot = lotOf();
      const id = newId(lot);
      const qty = base + Math.floor(rnd(-6, 7));
      const days = Math.random() < 0.015 ? -Math.floor(rnd(1, 40)) : Math.floor(rnd(45, 540));
      if (days < 0) planted.expired++;
      const sys = SYSTEMS[i % 97 < 55 ? 0 : i % 97 < 85 ? 1 : 2];
      report += `${bin},${id},${sku},"${desc}",${i % 53 === 0 ? 'DIST' : i % 211 === 0 ? 'REWORK' : ''},${qty},${uom},${entryNo++},${lot},${sys},${usDate(days)}\n`;
      reportRows++;
      // what the shelf really holds
      const f = Math.random();
      let kind = 'ok', found = qty, where = bin;
      if (f < 0.025) { kind = 'short'; found = Math.max(0, qty - Math.floor(rnd(1, 7))); planted.short++; }
      else if (f < 0.035) { kind = 'over'; found = qty + Math.floor(rnd(1, 5)); planted.over++; }
      else if (f < 0.047) { kind = 'missing'; found = 0; planted.missing++; }
      else if (f < 0.052 && i + 1 < binCodes.length && aisleOf(binCodes[i + 1]) === aisleOf(bin)) { kind = 'moved'; where = binCodes[i + 1]; planted.moved++; }
      else if (f < 0.055) { kind = 'label'; planted.label++; }
      if (kind !== 'missing') {
        if (!truth.has(where)) truth.set(where, []);
        truth.get(where).push({ id, qty: found, sku, kind, expected: bin });
      }
    }
    // a pallet nobody has on paper
    if (Math.random() < 0.008) {
      const lot = lotOf();
      const [sku] = ITEMS[i % ITEMS.length];
      if (!truth.has(bin)) truth.set(bin, []);
      truth.get(bin).push({ id: newId(lot), qty: Math.floor(rnd(20, 50)), sku, kind: 'unlisted', expected: '' });
      planted.unlisted++;
    }
  }
  log(`report: ${reportRows.toLocaleString()} pallets; planted ${JSON.stringify(planted)}`);

  /* ------------------------------------------------------------- the count */
  const sess = await post('/api/admin/sessions', { name: 'October 2026 wall-to-wall' });
  const t0b = performance.now();
  const binImp = await call(`/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csvH, body: binCsv, retries: 0 });
  const t0p = performance.now();
  const palImp = await call(`/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csvH, body: report, retries: 0 });
  log(`bin list loaded in ${((t0p - t0b) / 1000).toFixed(1)} s (${binImp.bins} bins); report in ${((performance.now() - t0p) / 1000).toFixed(1)} s (${palImp.rows} rows)`);
  await post(`/api/admin/sessions/${sess.id}/settings`, {
    guided: true, askComments: true, autoRecount: true, palletMode: 'warn', layout: 'front-royal',
    recountMinQty: 3, recountMinPct: 5, recountCap: 400,
    requireApproval: true, approvalMinQty: 8, approvalMinPct: 10,
  });
  await post(`/api/admin/sessions/${sess.id}/aisles/auto-block`, { size: 2, offset: 0 }).catch(() => {});
  await post('/api/admin/default-session', { sessionId: sess.id }).catch(() => {});
  await post('/api/admin/idle-config', { minutes: 5, teams: true }).catch(() => {});
  await post(`/api/admin/sessions/${sess.id}/notes`, { note: `Wall-to-wall freezer count · ${DAYS} days · ${TEAMS} teams · lunch 11:30–12:00 · dock 4 closed to counters` }).catch(() => {});

  /* the crew: two to a team, a high reach and a dock truck between them */
  const FIRST = ['Marcus', 'Priya', 'Tom', 'Ava', 'Luis', 'Grace', 'Nadia', 'Owen', 'Elena', 'Jamal', 'Sofia', 'Diego', 'Hana', 'Kwame', 'Ingrid', 'Mateo', 'Yuki', 'Rosa', 'Caleb', 'Zara', 'Noah', 'Amara', 'Felix', 'Leila', 'Ivan', 'Maya', 'Omar', 'Tessa', 'Rafael', 'Chloe', 'Kenji', 'Bianca', 'Arjun', 'Freya', 'Samir', 'Nora', 'Theo', 'Lina', 'Jonah', 'Esme'];
  const LAST = ['Obi', 'Raman', 'Zielinski', 'Delgado', 'Ferreira', 'Kim', 'Haddad', 'Blackwell', 'Petrova', 'Carter', 'Moreno', 'Silva', 'Sato', 'Mensah', 'Larsen', 'Rossi', 'Tanaka', 'Alvarez', 'Hughes', 'Khan', 'Fischer', 'Okafor', 'Novak', 'Nasser', 'Volkov', 'Patel', 'Farouk', 'Byrne', 'Costa', 'Dubois', 'Mori', 'Lombardi', 'Mehta', 'Lund', 'Haque', 'Berg', 'Quinn', 'Weber', 'Reyes', 'Walsh'];
  const teams = [];
  for (let t = 1; t <= TEAMS; t++) {
    const crew = [0, 1].map((k) => ({ badge: `E${pad(1000 + t * 10 + k, 4)}`, name: `${FIRST[(t * 2 + k) % FIRST.length]} ${LAST[(t * 3 + k * 7) % LAST.length]}`, equipment: k === 0 ? ['HIGH REACH', 'SCISSOR LIFT'] : ['DOCK TRUCK', 'FOOT'] }));
    teams.push({ name: String(t), crew, guns: [], queue: [], active: null, handed: new Set(), claimed: new Set(), bins: 0, done: 0, lines: 0 });
  }
  let rosterCsv = 'Clock in number,Name,Department,Equipment\n';
  for (const t of teams) for (const c of t.crew) rosterCsv += `${c.badge},${c.name},${Number(t.name) <= 10 ? 'Freezer A' : 'Freezer B'},"${c.equipment.join(', ')}"\n`;
  await call('/api/admin/people/employees/import', { method: 'POST', headers: csvH, body: rosterCsv });
  for (const t of teams) {
    const made = await post('/api/admin/people/teams', { name: t.name, shift: Number(t.name) <= 10 ? '1st' : '2nd' }).catch(() => null);
    if (made && made.id) for (const c of t.crew) await post('/api/admin/people/assign', { badge: c.badge, teamId: made.id }).catch(() => {});
  }

  /* the plan: with more teams than racking blocks, an aisle is two jobs - the
     low levels for a team on a dock truck, the high levels for one with the
     reach - and the lightest-loaded team takes the next job, biggest first.
     Two teams in one block on different levels is what the block rule allows;
     a team that would clash simply waits for the racking to free up. */
  const levelOf = (code) => code.replace(/^[A-Z]+\d+/, '')[0] || '';
  const expandLevels = (v) => String(v || '').toUpperCase().replace(/([A-Z])-([A-Z])/g, (m, a, b) => { let out = ''; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out += String.fromCharCode(c); return out; }).replace(/[^A-Z]/g, '');
  const jobs = [];
  for (const a of aisles) {
    const low = byAisle.get(a).filter((b) => 'ABC'.includes(levelOf(b))).length;
    const high = byAisle.get(a).length - low;
    if (high && low) { jobs.push({ aisle: a, levels: 'A-C', bins: low }); jobs.push({ aisle: a, levels: 'D-F', bins: high }); }
    else jobs.push({ aisle: a, levels: 'A-F', bins: byAisle.get(a).length });
  }
  jobs.sort((x, y) => y.bins - x.bins || x.aisle.localeCompare(y.aisle, undefined, { numeric: true }));
  for (const job of jobs) {
    const t = teams.reduce((a, b) => (a.bins <= b.bins ? a : b));
    t.queue.push(job); t.bins += job.bins;
  }
  for (const t of teams) {
    // the same aisle's two halves back to back are no use to one team: spread the queue
    t.queue.sort((x, y) => x.aisle.localeCompare(y.aisle, undefined, { numeric: true }));
    for (const job of t.queue) await post(`/api/admin/sessions/${sess.id}/assignments`, { team: t.name, aisles: [job.aisle], levels: job.levels, force: true });
  }
  log(`plan: ${teams.map((t) => `${t.name}:${t.queue.map((j) => j.aisle + (j.levels === 'A-F' ? '' : j.levels === 'A-C' ? 'lo' : 'hi')).join('+')}(${t.bins})`).join(' ')}`);

  /* forty scanners, registered in the office */
  for (const t of teams) {
    for (let g = 1; g <= GUNS_PER_TEAM; g++) {
      const name = `MC93-${pad((Number(t.name) - 1) * GUNS_PER_TEAM + g)}`;
      const d = await post('/api/admin/devices', { name, notes: `team ${t.name}` });
      t.guns.push({ name, uid: d.uid, team: t, H: null, lines: 0, bin: null, idle: false });
    }
  }
  const guns = teams.flatMap((t) => t.guns);
  const sosReasons = (await get('/api/admin/sos-reasons')).reasons || ['Lift truck down', 'Need a supervisor'];
  const adjReasons = ((await get('/api/admin/adjustment-reasons')).reasons || []).map((r) => (typeof r === 'string' ? r : r.label || r.reason)).filter(Boolean);

  /* ----------------------------------------------------------- the camera */
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const desk = await ctx.newPage();
  desk.on('dialog', (d) => d.accept().catch(() => {}));
  await desk.goto(`${BASE}/admin`);
  await desk.fill('#fUser', 'DANA-WHITFIELD');
  await desk.fill('#fPassword', 'changeme');
  await desk.click('#btnLogin');
  await desk.waitForSelector('#scrMain.active', { timeout: 20000 });
  const boardPage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await boardPage.goto(`${BASE}/board?session=${sess.id}`);
  const other = await ctx.newPage();
  other.on('dialog', (d) => d.accept().catch(() => {}));
  const ROTATE = [['/admin', 'map'], ['/admin', 'teams'], ['/admin', 'alerts'], ['/admin', 'second'], ['/admin', 'adjust'], ['/teams', ''], ['/admin', 'reports']];
  const timeline = [];
  let frameNo = 0;
  async function shot(page, name) {
    const file = `${pad(frameNo, 3)}-${name}.jpg`;
    await page.screenshot({ path: join(FRAMES, file), type: 'jpeg', quality: 62 });
    return `frames/${file}`;
  }
  /* one photograph at a time: an event's snapshot waits for the scheduled one */
  let snapChain = Promise.resolve();
  const snapshot = (label, opts) => (snapChain = snapChain.catch(() => {}).then(() => takeSnapshot(label, opts)));
  async function takeSnapshot(label, { extra = null, event = '' } = {}) {
    const t = clock();
    frameNo++;
    const frames = {};
    const prog = await get(`/api/admin/sessions/${sess.id}/progress`).catch(() => null);
    const alerts = await get(`/api/admin/sessions/${sess.id}/alerts`).catch(() => ({ alerts: [] }));
    const adj = await get(`/api/admin/sessions/${sess.id}/adjustments`).catch(() => ({ adjustments: [] }));
    const recAll = await get(`/api/admin/sessions/${sess.id}/recounts`).catch(() => []);
    const rec = { tasks: Array.isArray(recAll) ? recAll : (recAll.tasks || recAll.recounts || []) };
    try {
      await desk.reload({ waitUntil: 'domcontentloaded' });
      await desk.waitForSelector('#scrMain.active', { timeout: 15000 });
      await desk.evaluate(() => window.appApi && window.appApi.showSub && window.appApi.showSub('progress'));
      await wait(2500);
      frames.progress = await shot(desk, 'progress');
    } catch (err) { log('snapshot (progress) failed:', err.message); }
    try {
      await boardPage.reload({ waitUntil: 'domcontentloaded' });
      await wait(2500);
      frames.board = await shot(boardPage, 'board');
    } catch (err) { log('snapshot (board) failed:', err.message); }
    const [path, sub] = extra || ROTATE[(frameNo - 1) % ROTATE.length];
    try {
      await other.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      if (await other.$('#scrLogin.active')) { await other.fill('#fUser', 'DANA-WHITFIELD'); await other.fill('#fPassword', 'changeme'); await other.click('#btnLogin'); }
      await other.waitForSelector('#scrMain.active', { timeout: 15000 });
      if (sub) await other.evaluate((s) => window.appApi && window.appApi.showSub && window.appApi.showSub(s), sub);
      await wait(sub === 'map' ? 4000 : 2500);
      frames.other = await shot(other, (sub || path.replace('/', '')) || 'page');
      frames.otherLabel = sub ? ({ map: 'Map', teams: 'Team plan', alerts: 'Alerts', second: 'Second counts', adjust: 'Adjustments', reports: 'Reports' })[sub] || sub : 'Teams & crew';
    } catch (err) { log('snapshot (other) failed:', err.message); }
    const entry = {
      n: frameNo, at: new Date().toISOString(), wall: Math.round((Date.now() - T0) / 60000), day: t.day, dayName: t.dayName, sim: t.hhmm, label, event,
      lines: prog ? prog.lines : 0, bins: prog ? prog.bins_counted : 0, binsTotal: prog ? prog.bins_total : binCodes.length, pallets: prog ? prog.pallets_counted : 0,
      exceptions: prog ? prog.exceptions : 0, teams: prog ? prog.teams : 0,
      sosOpen: (alerts.alerts || []).filter((a) => a.status !== 'closed').length, sosTotal: (alerts.alerts || []).length,
      pending: (adj.adjustments || []).filter((a) => a.status === 'pending').length, approved: (adj.adjustments || []).filter((a) => a.status === 'approved').length, rejected: (adj.adjustments || []).filter((a) => a.status === 'rejected').length,
      secondOpen: (rec.tasks || []).filter((r) => r.status !== 'done').length, secondDone: (rec.tasks || []).filter((r) => r.status === 'done').length,
      lat: { count: stat(lat.count), dashboard: stat(lat.dashboard) },
      frames,
    };
    timeline.push(entry);
    state.snapshots = frameNo;
    writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
    writePage(timeline, null);
    log(`snapshot #${frameNo} ${t.dayName} ${t.hhmm}: ${entry.lines.toLocaleString()} lines, ${entry.bins.toLocaleString()} bins, ${entry.sosOpen} SOS open, ${entry.pending} adjustments waiting, ${entry.secondOpen} second counts open`);
  }

  /* ------------------------------------------------------------ the clock */
  const T0 = Date.now();
  function clock(now = Date.now()) {
    const elapsed = now - T0;
    const day = Math.min(DAYS - 1, Math.floor(elapsed / WALL_DAY_MS));
    const inDay = elapsed - day * WALL_DAY_MS;
    const simMin = Math.min(SHIFT_MIN, (inDay / WALL_DAY_MS) * SHIFT_MIN);
    const m = SHIFT_START + simMin;
    const brk = BREAKS.find(([a, b]) => simMin >= a && simMin < b);
    return { day, dayName: DAY_NAMES[day % 5], simMin, hhmm: `${pad(Math.floor(m / 60))}:${pad(Math.floor(m % 60))}`, brk: brk ? brk[2] : '', counting: !brk && simMin >= SIGNON_RUSH && simMin < COUNT_UNTIL, over: elapsed >= DAYS * WALL_DAY_MS, dayOver: simMin >= SHIFT_MIN - 0.01 && elapsed >= (day + 1) * WALL_DAY_MS - 1000 };
  }
  const wallFor = (simMin) => simMin * 60000 / SCALE;               // sim minutes -> wall ms
  const untilSim = async (day, simMin) => { const target = T0 + day * WALL_DAY_MS + wallFor(simMin); while (Date.now() < target) await wait(Math.min(5000, Math.max(50, target - Date.now()))); };

  /* ----------------------------------------------------------- one gun
     The pace is set from what is left: each gun has its share of the bins its
     team still owes, and the counting minutes left in the count, so the floor
     finishes on the last afternoon however the jitter falls. */
  const totalCountingMin = DAYS * (COUNT_UNTIL - SIGNON_RUSH - BREAKS.reduce((n, [a, b]) => n + (b - a), 0));
  const countingSimMinLeft = (now = Date.now()) => {
    const c = clock(now);
    let left = 0;
    for (let d = c.day; d < DAYS; d++) {
      const from = d === c.day ? c.simMin : 0;
      let span = Math.max(0, COUNT_UNTIL - Math.max(from, SIGNON_RUSH));
      for (const [a, b] of BREAKS) span -= Math.max(0, Math.min(b, COUNT_UNTIL) - Math.max(a, from, SIGNON_RUSH));
      left += Math.max(0, span);
    }
    return left;
  };
  let binsLeft = binCodes.length;
  const teamBinsLeft = (t) => t.queue.reduce((n, j) => n + j.bins, 0) + (t.activeBins ? t.activeBins.length : 0);

  const clientIds = new Set();
  const cid = (gun) => { let id; do { id = `${gun.name}-${Math.random().toString(36).slice(2, 10)}`; } while (clientIds.has(id)); clientIds.add(id); return id; };
  const linesFor = (gun, bin) => {
    const t = gun.team;
    const now = new Date().toISOString();
    const base = { location: bin, team: t.name, employees: t.crew.map((c) => c.badge), deviceId: gun.name, aisle: aisleOf(bin), pass: 1, scannedAt: now };
    const here = truth.get(bin) || [];
    if (!here.length) return [{ ...base, clientId: cid(gun), emptyBin: true, palletId: '', qty: 0 }];
    return here.map((p) => ({
      ...base, clientId: cid(gun), palletId: p.id, qty: p.qty, sku: p.sku,
      unknownPallet: p.kind === 'unlisted' ? 1 : 0,
      overrideReason: p.kind === 'unlisted' ? 'Not on the list - counted anyway' : undefined,
      labelIssue: p.kind === 'label' ? 'typed' : undefined,
      comments: Math.random() < 0.03 ? pick(['Damaged wrap', 'Ice on the label', 'Pallet leaning', 'Frozen to the rack']) : undefined,
    }));
  };

  async function signOn(gun) {
    const t = gun.team;
    if (!gun.H) {
      const tk = (await call(`/api/devices/${gun.uid}`, { method: 'POST' })).token;
      gun.H = { ...hdr, authorization: 'Device ' + tk };
    }
    const st = await post(`/api/sessions/${sess.id}/signon`, { deviceId: gun.name, deviceUid: gun.uid, team: t.name, employees: t.crew.map((c) => c.badge) }, gun.H, 'signon');
    await get(`/api/sessions/${sess.id}/master`, gun.H, 'master');
    await get('/api/missing', gun.H).catch(() => {});
    await get(`/api/sessions/${sess.id}/recounts?team=${t.name}`, gun.H).catch(() => {});
    return st;
  }

  /* the team's active aisle, from the server's point of view */
  /* one gun asks at a time: two asking together would each build the bin list
     and the second copy would hand the first gun's bins out again */
  async function takeActive(t, H) {
    if (t.taking) return t.taking;
    t.taking = (async () => {
      const st = await get(`/api/sessions/${sess.id}/team-status?team=${t.name}`, H);
      if (st.active && t.handed.has(st.active.id)) return st;        // the hand-back is still landing
      if (st.active && (!t.active || t.active.id !== st.active.id)) {
        t.active = st.active;
        // the server says which bins the job covers (the aisle, on the levels given)
        t.activeBins = (st.bins && st.bins.length ? st.bins : byAisle.get(st.active.aisle) || []).slice();
        // the server writes a level band out in full ("ABC" for "A-C"): compare them expanded
        const i = t.queue.findIndex((j) => j.aisle === st.active.aisle && (!st.active.levels || expandLevels(j.levels) === expandLevels(st.active.levels)));
        if (i >= 0) t.queue.splice(i, 1);
      } else if (!st.active) { t.active = null; t.activeBins = null; }
      return st;
    })().finally(() => { t.taking = null; });
    return t.taking;
  }

  async function handBack(t, gun) {
    if (!t.active || t.handed.has(t.active.id)) return;
    const a = t.active;
    t.handed.add(a.id);
    t.active = null; t.activeBins = null;
    try {
      await post(`/api/sessions/${sess.id}/assignments/${a.id}/complete`, { team: t.name }, gun.H);
      state.handbacks++;
      log(`team ${t.name} handed back ${a.aisle}`);
    } catch (err) { log(`team ${t.name} could not hand back ${a.aisle}: ${err.message}`); }
  }

  /* second counts: the bin again, by a different team, pass 2 */
  async function doSecondCounts(gun, max = 3) {
    const t = gun.team;
    let done = 0;
    const list = await get(`/api/sessions/${sess.id}/recounts?team=${t.name}`, gun.H).catch(() => ({ tasks: [] }));
    for (const task of (list.tasks || []).filter((x) => x.kind !== 'cycle')) {
      if (done >= max || !clock().counting) break;
      // the team's other gun may already be on this bin: one of them walks it
      if (t.claimed.has(task.id) || (task.status === 'taken' && !task.mine)) continue;
      t.claimed.add(task.id);
      try { await post(`/api/sessions/${sess.id}/recounts/${task.id}/take`, { team: t.name }, gun.H); } catch { continue; }
      await wait(rnd(1500, 4000));
      const lines = linesFor(gun, task.bin).map((l) => ({ ...l, pass: 2, recountId: task.id }));
      await post(`/api/sessions/${sess.id}/counts`, lines, gun.H, 'count').catch(() => {});
      await post(`/api/sessions/${sess.id}/recounts/${task.id}/done`, { team: t.name }, gun.H).catch(() => {});
      done++; state.secondCounts++;
    }
    return done;
  }

  async function sos(gun) {
    const t = gun.team;
    const reason = pick(sosReasons);
    const bin = gun.bin || (t.activeBins && t.activeBins[0]) || '';
    const clientId = cid(gun);
    const out = await post(`/api/sessions/${sess.id}/alerts`, { clientId, team: t.name, deviceId: gun.name, employees: t.crew.map((c) => c.badge), reason, detail: pick(['', 'Aisle blocked by a pallet on the floor', 'Rack beam bent at level D', 'Need the high reach', 'Battery flat']), aisle: t.active ? t.active.aisle : '', bin }, gun.H).catch(() => null);
    if (out && out.alert) { state.sos++; log(`SOS from team ${t.name} (${gun.name}): ${reason}`); if (state.sos === 1) snapshot('First SOS of the count', { extra: ['/admin', 'alerts'], event: 'sos' }).catch(() => {}); }
    await wait(rnd(60000, 180000));          // stood waiting for the supervisor
  }

  async function runGun(gun) {
    const t = gun.team;
    let signedOnDay = -1;
    let sinceAisleRecounts = 0;
    while (!clock().over) {
      const c = clock();
      // a new shift: sign on again (the rush is everyone within ten minutes)
      if (c.day !== signedOnDay) {
        await wait(rnd(0, wallFor(SIGNON_RUSH) * 0.9));
        try { await signOn(gun); signedOnDay = c.day; } catch (err) { log(`${gun.name} sign-on failed: ${err.message}`); await wait(5000); continue; }
        await takeActive(t, gun.H).catch(() => {});
        continue;
      }
      if (!c.counting) {
        // end of the shift: hand back a finished aisle, sign the gun off, wait for tomorrow
        if (c.simMin >= COUNT_UNTIL) {
          if (t.active && t.activeBins && !t.activeBins.length) await handBack(t, gun);
          if (signedOnDay === c.day && c.simMin >= COUNT_UNTIL + 5) {
            await post(`/api/sessions/${sess.id}/signoff`, { deviceId: gun.name, team: t.name }, gun.H).catch(() => {});
            signedOnDay = -2;                                    // off until the next shift
            const nextDay = c.day + 1;
            if (nextDay >= DAYS) return;
            await untilSim(nextDay, 0);
            continue;
          }
        }
        await wait(3000);
        continue;
      }
      // the team's aisle: take one, or wait for the racking to free up
      if (!t.active) {
        await takeActive(t, gun.H).catch(() => {});
        if (!t.active) {
          // nothing of their own left: the second counts are everybody's
          if (!t.queue.length) { await doSecondCounts(gun, 5); await wait(rnd(4000, 10000)); continue; }
          await wait(rnd(8000, 20000));
          continue;
        }
      }
      const bin = t.activeBins ? t.activeBins.shift() : null;
      if (!bin) {
        // the aisle is finished: a few second counts on the way out, then hand it back
        if (sinceAisleRecounts < 1) { sinceAisleRecounts++; await doSecondCounts(gun, 3); continue; }
        sinceAisleRecounts = 0;
        await handBack(t, gun);
        await wait(rnd(3000, 9000));
        continue;
      }
      gun.bin = bin;
      const lines = linesFor(gun, bin);
      try {
        await post(`/api/sessions/${sess.id}/counts`, lines, gun.H, 'count');
        gun.lines += lines.length; t.lines += lines.length; t.done++; binsLeft--; state.lines += lines.length;
      } catch (err) {
        t.activeBins.unshift(bin);              // the gun keeps it queued and tries again
        await wait(3000);
        continue;
      }
      // once in a long while, something goes wrong enough to call for help
      if (Math.random() < 1 / 900) { await sos(gun); continue; }
      // the pace: what this gun owes, over the counting time left
      const owed = teamBinsLeft(t) / GUNS_PER_TEAM;
      const minutesLeft = countingSimMinLeft();
      const simPerBin = owed > 0 ? Math.max(0.6, (minutesLeft * 0.93) / Math.max(1, owed)) : 3;
      await wait(wallFor(simPerBin) * rnd(0.55, 1.45));
    }
  }

  /* -------------------------------------------------------- the office
     A supervisor at the desk: approves what is waiting, closes the SOS calls,
     tells the floor about lunch, and leaves a note for the next shift. */
  async function runOffice() {
    let saidLunch = -1, saidMorning = -1;
    while (!clock().over) {
      const c = clock();
      try {
        if (c.simMin >= 0 && saidMorning !== c.day && c.simMin < 60) {
          saidMorning = c.day;
          await post(`/api/admin/sessions/${sess.id}/messages`, { body: c.day === 0 ? 'Morning all — count what you see, not what the sheet says. SOS if a rack is blocked.' : `Day ${c.day + 1}: pick up where you left off. Second counts first if you have any.`, urgent: false });
        }
        if (c.simMin >= 320 && saidLunch !== c.day) {
          saidLunch = c.day;
          await post(`/api/admin/sessions/${sess.id}/messages`, { body: 'Lunch 11:30–12:00. Finish the bin you are on and leave the aisle where it is.', urgent: true });
          await post(`/api/admin/sessions/${sess.id}/notes`, { note: `${c.dayName}: lunch 11:30–12:00 · ${state.lines.toLocaleString()} lines so far` }).catch(() => {});
        }
        // adjustments waiting for a signature
        const adj = await get(`/api/admin/sessions/${sess.id}/adjustments`, M, 'office');
        const pending = (adj.adjustments || []).filter((a) => a.status === 'pending');
        if (pending.length) {
          const batch = Math.max(25, Math.ceil(pending.length * 0.6));
          const approve = pending.filter(() => Math.random() < 0.85).slice(0, batch);
          const reject = pending.filter((a) => !approve.includes(a)).slice(0, Math.max(5, Math.ceil(batch / 6)));
          if (approve.length) { await post(`/api/admin/sessions/${sess.id}/adjustments/decide`, { palletIds: approve.map((a) => a.pallet_id), decision: 'approve', reason: pick(adjReasons.length ? adjReasons : ['Miscount — first count was wrong']) }, M); state.approved += approve.length; }
          if (reject.length) { await post(`/api/admin/sessions/${sess.id}/adjustments/decide`, { palletIds: reject.map((a) => a.pallet_id), decision: 'reject', reason: 'Recount it first', note: 'Second count requested' }, M); state.rejected += reject.length; }
        }
        // SOS calls: seen within a minute, closed once somebody has been
        const alerts = await get(`/api/admin/sessions/${sess.id}/alerts`, A, 'office');
        for (const a of (alerts.alerts || []).filter((x) => x.status !== 'closed')) {
          const age = Date.now() - new Date(a.created_at).getTime();
          if (a.status === 'open' && age > 20000) await post(`/api/admin/sessions/${sess.id}/alerts/${a.id}/seen`, {}, M).catch(() => {});
          if (age > rnd(90000, 240000)) await post(`/api/admin/sessions/${sess.id}/alerts/${a.id}/close`, { outcome: pick(['Sorted on the spot', 'Pallet moved, aisle clear', 'Spare battery brought out', 'Maintenance called']) }, M).catch(() => {});
        }
      } catch (err) { log('office:', err.message); }
      await wait(rnd(45000, 90000));
    }
  }

  /* the dashboards and the board, refreshing over the top of everything */
  let polling = true;
  const poller = async (path, headers, bucket, every) => {
    while (polling) {
      try { await get(path, headers, bucket); } catch { /* counted in failures */ }
      await wait(every);
    }
  };

  /* --------------------------------------------------------- the page */
  function writePage(tl, summary) {
    const data = JSON.stringify({ meta: { teams: TEAMS, guns: guns.length, bins: binCodes.length, pallets: reportRows, days: DAYS, hours: HOURS, scale: SCALE, planted, startedAt: new Date(T0).toISOString() }, timeline: tl, summary });
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Floor simulation — ${TEAMS} teams, ${binCodes.length.toLocaleString()} bins</title>
<style>
  :root { --bg:#0f1216; --surface:#171b21; --line:#2a3039; --text:#e8ebef; --dim:#aab2bd; --accent:#f0b429; --ok:#3fcf68; --warn:#f5a524; --err:#ff6b62; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { position: sticky; top:0; z-index:5; background: rgba(15,18,22,.96); border-bottom:1px solid var(--line); padding: 12px 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h1 span { color: var(--dim); font-weight: 400; }
  .scrub { display:flex; gap:12px; align-items:center; margin-top:8px; flex-wrap: wrap; }
  .scrub input[type=range] { flex: 1 1 320px; accent-color: var(--accent); }
  .scrub button { background: var(--accent); color:#1a1300; border:0; border-radius:8px; padding:6px 14px; font-weight:800; cursor:pointer; }
  .scrub .when { font-variant-numeric: tabular-nums; font-weight: 700; min-width: 220px; }
  .figs { display:flex; gap:18px; flex-wrap:wrap; margin-top:6px; color: var(--dim); font-size: 13px; }
  .figs b { color: var(--text); font-size: 16px; }
  main { padding: 16px 20px 60px; max-width: 1400px; margin: 0 auto; }
  .stage { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .stage figure { margin:0; background: var(--surface); border:1px solid var(--line); border-radius: 12px; overflow:hidden; }
  .stage figure.wide { grid-column: 1 / -1; }
  .stage img { display:block; width:100%; height:auto; }
  .stage figcaption { padding: 8px 12px; font-size: 13px; color: var(--dim); border-top: 1px solid var(--line); }
  h2 { font-size: 16px; margin: 28px 0 10px; color: var(--dim); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .timeline { display:flex; flex-direction:column; gap: 18px; }
  .snap { background: var(--surface); border:1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .snap .head { display:flex; gap:14px; align-items:baseline; flex-wrap: wrap; }
  .snap .head b { font-size: 17px; } .snap .head .ev { color: var(--accent); font-weight: 700; }
  .snap .row { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; margin-top: 10px; }
  .snap img { width:100%; height:auto; border-radius: 8px; border:1px solid var(--line); background:#000; cursor: zoom-in; }
  .snap .cap { font-size: 12px; color: var(--dim); margin-top: 4px; }
  .bar { height: 8px; background: #22272f; border-radius: 99px; overflow: hidden; margin-top: 8px; } .bar i { display:block; height:100%; background: var(--ok); }
  .summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 10px; }
  .summary div { background: var(--surface); border:1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .summary div b { display:block; font-size: 22px; } .summary div span { color: var(--dim); font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { text-align:left; padding: 6px 8px; border-bottom: 1px solid var(--line); } th { color: var(--dim); font-weight: 700; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.92); display:none; align-items:center; justify-content:center; z-index: 20; cursor: zoom-out; }
  .lightbox img { max-width: 98vw; max-height: 96vh; }
  .note { color: var(--dim); font-size: 13px; }
  @media (max-width: 900px) { .stage { grid-template-columns: 1fr; } }
</style></head>
<body>
<header>
  <h1>Floor simulation <span>— ${TEAMS} teams · ${guns.length} scanners · ${binCodes.length.toLocaleString()} bins · ${DAYS} shifts played in ${HOURS} hours</span></h1>
  <div class="scrub">
    <button id="play">▶ Play</button>
    <input type="range" id="scrub" min="1" max="${Math.max(1, tl.length)}" value="${Math.max(1, tl.length)}" step="1">
    <span class="when" id="when"></span>
  </div>
  <div class="figs" id="figs"></div>
</header>
<main>
  <div class="stage" id="stage"></div>
  <div id="summary"></div>
  <h2>Every snapshot, in order</h2>
  <div class="timeline" id="timeline"></div>
</main>
<div class="lightbox" id="lightbox"><img id="lightimg" alt=""></div>
<script id="data" type="application/json">${data.replace(/</g, '\\u003c')}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const tl = D.timeline, meta = D.meta;
  const $ = (id) => document.getElementById(id);
  const n = (v) => Number(v || 0).toLocaleString();
  const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  function show(i) {
    const s = tl[i - 1]; if (!s) return;
    $('scrub').value = i;
    $('when').textContent = s.dayName + ' ' + s.sim + ' · snapshot ' + s.n + ' of ' + tl.length + ' · ' + s.wall + ' min in';
    $('figs').innerHTML = '<span><b>' + n(s.bins) + '</b> of ' + n(s.binsTotal) + ' bins (' + pctOf(s.bins, s.binsTotal) + '%)</span>'
      + '<span><b>' + n(s.lines) + '</b> lines</span><span><b>' + n(s.pallets) + '</b> pallets counted</span>'
      + '<span><b>' + s.sosOpen + '</b> SOS open (' + s.sosTotal + ' so far)</span><span><b>' + s.pending + '</b> adjustments waiting · ' + s.approved + ' approved</span>'
      + '<span><b>' + s.secondOpen + '</b> second counts open · ' + s.secondDone + ' done</span>'
      + '<span>count post p95 <b>' + (s.lat && s.lat.count ? s.lat.count.p95 : 0) + ' ms</b></span>';
    const f = s.frames || {};
    $('stage').innerHTML = (f.progress ? '<figure><img src="' + f.progress + '" alt="Dashboard"><figcaption>Dashboard · Progress — ' + s.dayName + ' ' + s.sim + '</figcaption></figure>' : '')
      + (f.other ? '<figure><img src="' + f.other + '" alt=""><figcaption>' + (f.otherLabel || '') + '</figcaption></figure>' : '')
      + (f.board ? '<figure class="wide"><img src="' + f.board + '" alt="Office board"><figcaption>Office board</figcaption></figure>' : '');
  }
  $('scrub').addEventListener('input', () => show(Number($('scrub').value)));
  let timer = null;
  $('play').onclick = () => {
    if (timer) { clearInterval(timer); timer = null; $('play').textContent = '▶ Play'; return; }
    let i = Number($('scrub').value); if (i >= tl.length) i = 0;
    $('play').textContent = '❚❚ Pause';
    timer = setInterval(() => { i++; if (i > tl.length) { clearInterval(timer); timer = null; $('play').textContent = '▶ Play'; return; } show(i); }, 1400);
  };
  $('timeline').innerHTML = tl.map((s) => {
    const f = s.frames || {};
    const img = (src, cap) => src ? '<div><img loading="lazy" src="' + src + '" alt="" data-full="' + src + '"><div class="cap">' + cap + '</div></div>' : '';
    return '<div class="snap" id="s' + s.n + '"><div class="head"><b>' + s.dayName + ' ' + s.sim + '</b><span>snapshot ' + s.n + ' · ' + s.wall + ' min of real time</span>'
      + (s.event ? '<span class="ev">' + s.label + '</span>' : '')
      + '<span>' + n(s.bins) + ' bins · ' + n(s.lines) + ' lines · ' + s.sosOpen + ' SOS open · ' + s.pending + ' adjustments waiting · ' + s.secondOpen + ' second counts open</span></div>'
      + '<div class="bar"><i style="width:' + pctOf(s.bins, s.binsTotal) + '%"></i></div>'
      + '<div class="row">' + img(f.progress, 'Dashboard · Progress') + img(f.other, f.otherLabel || '') + img(f.board, 'Office board') + '</div></div>';
  }).join('');
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.tagName === 'IMG' && t.dataset.full) { $('lightimg').src = t.dataset.full; $('lightbox').style.display = 'flex'; }
    else if (t.closest('#lightbox')) $('lightbox').style.display = 'none';
  });
  const S = D.summary;
  if (S) {
    const card = (b, s) => '<div><b>' + b + '</b><span>' + s + '</span></div>';
    const l = S.latency;
    $('summary').innerHTML = '<h2>How it went</h2><div class="summary">'
      + card(n(S.bins) + ' / ' + n(S.binsTotal), 'bins counted · ' + pctOf(S.bins, S.binsTotal) + '%')
      + card(n(S.lines), 'count lines from ' + meta.guns + ' scanners')
      + card(n(S.pallets) + ' / ' + n(meta.pallets), 'pallets on the report seen')
      + card(S.match + ' match · ' + S.variance + ' variances', 'pallet report: ' + S.missing + ' missing, ' + S.unlisted + ' not on the report')
      + card(S.approved + ' approved · ' + S.rejected + ' rejected', 'adjustments, ' + S.pending + ' still waiting')
      + card(S.secondDone + ' done · ' + S.secondOpen + ' open', 'second counts raised by the variances')
      + card(S.sos + ' SOS', S.sosClosed + ' closed by the office')
      + card(S.handbacks + ' aisles handed back', 'of ' + S.aisles + ' in the plan')
      + card(S.failures + ' failed requests', 'out of ' + n(S.requests) + ' made')
      + '</div><h2>What a person felt</h2><table><tr><th>Action</th><th class="n">calls</th><th class="n">typical</th><th class="n">slowest 5%</th><th class="n">worst</th></tr>'
      + Object.entries(l).map(([k, v]) => '<tr><td>' + ({ count: 'A count line reaching the server', signon: 'Signing a scanner on', master: 'A scanner pulling the whole bin list', dashboard: 'A dashboard refresh', board: 'The office board refresh', office: 'Approving and closing from the desk' })[k] + '</td><td class="n">' + n(v.n) + '</td><td class="n">' + v.p50 + ' ms</td><td class="n">' + v.p95 + ' ms</td><td class="n">' + v.max + ' ms</td></tr>').join('')
      + '</table><p class="note">Planted in the data: ' + Object.entries(meta.planted).map(([k, v]) => v + ' ' + k).join(', ') + '. Time ran at ' + meta.scale.toFixed(1) + '× — a ' + Math.round(510 / meta.scale) + '-minute block of real time per shift.</p>';
  }
  show(tl.length);
})();
</script>
</body></html>`;
    writeFileSync(join(OUT, 'index.html'), html);
  }

  /* ------------------------------------------------------------- go */
  state.phase = 'counting'; saveState();
  const watchers = [
    poller(`/api/admin/sessions/${sess.id}/progress`, A, 'dashboard', 10000),
    poller(`/api/admin/sessions/${sess.id}/map`, A, 'dashboard', 15000),
    poller(`/api/admin/sessions/${sess.id}/pallets?limit=200`, M, 'dashboard', 20000),
    poller(`/api/board?session=${sess.id}`, {}, 'board', 15000),
  ];
  const office = runOffice();
  const floor = Promise.all(guns.map((g) => runGun(g).catch((err) => log(`${g.name} stopped: ${err.message}`))));

  // the camera, every SNAP_MIN minutes, plus one as the doors open
  await wait(wallFor(SIGNON_RUSH) + 5000);
  await snapshot('The sign-on rush is over, counting has begun', { extra: ['/admin', 'teams'], event: 'start' });
  let nextSnap = Date.now() + SNAP_MIN * 60000;
  let lastDay = 0;
  const stateTick = setInterval(() => { const c = clock(); state.day = c.day + 1; state.simTime = `${c.dayName} ${c.hhmm}${c.brk ? ' (' + c.brk + ')' : ''}`; state.phase = c.over ? 'finishing' : c.counting ? 'counting' : c.brk || (c.simMin < SIGNON_RUSH ? 'sign-on' : 'end of shift'); saveState(); }, 15000);
  while (!clock().over) {
    const c = clock();
    if (c.day !== lastDay) { lastDay = c.day; await snapshot(`${c.dayName} morning: the teams sign back on`, { extra: ['/admin', 'teams'], event: 'day' }).catch(() => {}); }
    if (Date.now() >= nextSnap) {
      nextSnap = Date.now() + SNAP_MIN * 60000;
      const lunch = c.brk === 'lunch';
      await snapshot(lunch ? 'Lunch: the floor stops, the clocks notice' : `${c.dayName} ${c.hhmm}`, lunch ? { extra: ['/admin', 'teams'], event: 'lunch' } : {}).catch((err) => log('snapshot failed:', err.message));
    }
    await wait(5000);
  }
  clearInterval(stateTick);
  state.phase = 'finishing'; saveState();
  await Promise.race([floor, wait(120000)]);
  polling = false;
  await Promise.race([office, wait(5000)]);
  // the office clears what is left on its desk
  try {
    const adj = await get(`/api/admin/sessions/${sess.id}/adjustments`, M);
    const pending = (adj.adjustments || []).filter((a) => a.status === 'pending').map((a) => a.pallet_id);
    for (let i = 0; i < pending.length; i += 50) await post(`/api/admin/sessions/${sess.id}/adjustments/decide`, { palletIds: pending.slice(i, i + 50), decision: 'approve', reason: 'Counted twice, same result' }, M);
    const alerts = await get(`/api/admin/sessions/${sess.id}/alerts`, A);
    for (const a of (alerts.alerts || []).filter((x) => x.status !== 'closed')) await post(`/api/admin/sessions/${sess.id}/alerts/${a.id}/close`, { outcome: 'Count finished' }, M).catch(() => {});
  } catch (err) { log('final clear-up:', err.message); }

  /* --------------------------------------------------------- the summary */
  const prog = await get(`/api/admin/sessions/${sess.id}/progress`);
  const rep = await get(`/api/admin/sessions/${sess.id}/pallets?limit=100000`, M);
  const adj = await get(`/api/admin/sessions/${sess.id}/adjustments`, M);
  const recRaw = await get(`/api/admin/sessions/${sess.id}/recounts`);
  const rec = { tasks: Array.isArray(recRaw) ? recRaw : (recRaw.tasks || recRaw.recounts || []) };
  const alerts = await get(`/api/admin/sessions/${sess.id}/alerts`);
  const assign = await get(`/api/admin/sessions/${sess.id}/assignments`);
  const statusCount = (s) => rep.rows.filter((r) => r.status === s).length;
  const summary = {
    bins: prog.bins_counted, binsTotal: prog.bins_total, lines: prog.lines, pallets: prog.pallets_counted, exceptions: prog.exceptions,
    match: statusCount('MATCH'), variance: statusCount('QTY VARIANCE') + statusCount('WRONG BIN'), missing: statusCount('MISSING'), unlisted: statusCount('NOT IN MASTER'), twice: statusCount('COUNTED TWICE'),
    statuses: rep.rows.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {}),
    approved: (adj.adjustments || []).filter((a) => a.status === 'approved').length, rejected: (adj.adjustments || []).filter((a) => a.status === 'rejected').length, pending: (adj.adjustments || []).filter((a) => a.status === 'pending').length,
    secondDone: (rec.tasks || []).filter((r) => r.status === 'done').length, secondOpen: (rec.tasks || []).filter((r) => r.status !== 'done').length,
    sos: (alerts.alerts || []).length, sosClosed: (alerts.alerts || []).filter((a) => a.status === 'closed').length,
    handbacks: assign.filter((a) => a.status === 'done').length, aisles: aisles.length,
    failures, failed: failed.slice(0, 20), requests: Object.values(lat).reduce((n, a) => n + a.length, 0),
    latency: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stat(v)])),
    planted, teams: teams.map((t) => ({ team: t.name, aisles: t.bins, binsCounted: t.done, lines: t.lines })),
    startedAt: new Date(T0).toISOString(), finishedAt: new Date().toISOString(), wallMinutes: Math.round((Date.now() - T0) / 60000),
  };
  await snapshot('The count is in: the last hand-backs are done', { extra: ['/admin', 'reports'], event: 'end' }).catch(() => {});
  for (const [p, sub] of [['/admin', 'map'], ['/admin', 'adjust'], ['/admin', 'second'], ['/admin', 'alerts'], ['/teams', '']]) await snapshot(`Final: ${sub || 'teams'}`, { extra: [p, sub], event: 'final' }).catch(() => {});
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  writePage(timeline, summary);
  try {
    const csv = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/adjustments.csv`, { headers: M })).text();
    writeFileSync(join(OUT, 'adjustments.csv'), csv);
    const aisleCsv = ['Aisle,Bins,Team,Status', ...assign.map((a) => `${a.aisle},${(byAisle.get(a.aisle) || []).length},${a.team},${a.status}`)].join('\n') + '\n';
    writeFileSync(join(OUT, 'aisles.csv'), aisleCsv);
  } catch (err) { log('exports:', err.message); }
  writeFileSync(join(OUT, 'sim.log'), logLines.join('\n') + '\n');
  state.phase = 'done'; saveState();
  log(`done: ${summary.bins.toLocaleString()} of ${summary.binsTotal.toLocaleString()} bins, ${summary.lines.toLocaleString()} lines, ${summary.failures} failed requests; count post p95 ${summary.latency.count.p95} ms`);
} catch (err) {
  console.error(err);
  state.phase = 'crashed'; state.error = err.message; saveState();
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch { /* fine */ }
  server.kill();
  await wait(300);
  if (serverErr.trim()) { try { writeFileSync(join(OUT, 'server.log'), serverErr); } catch { /* fine */ } }
  if (!process.env.SIM_KEEP_DB) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* fine */ } }
  process.exit();
}
