/*
 * Classroom training: a real count, for real scanners, on a warehouse that
 * fits on a wall.
 *
 * The Testing Suite's practice count lives inside the admin page, one person
 * at a time. A class of twenty with scanners in their hands needs the real
 * thing: a count the floor scanners can sign on to, a bin list and a report
 * behind it, teams and badges to sign on with - and labels to scan. This
 * module makes that count, with a small warehouse whose every rack label,
 * pallet label, team card and badge prints as a real Code 128 barcode (the
 * same symbology as the racking), so the trainer tapes the pages to a wall
 * and the class walks it exactly as they will walk the freezer.
 *
 * The warehouse is built around the things to teach: a plain pallet, two in
 * one spot, an empty spot, a short count, a pallet in the wrong spot, one not
 * on the list, one with two labels, one whose label will not scan - and a
 * second aisle, so the plan, second counts and the next aisle can be shown.
 *
 * It is a trial run: the scanners say so, the ERP file is refused, and
 * "Reset for the next class" clears everything it counted and puts the
 * aisles back. "Remove" takes the count, its teams and its trainees away.
 */
import { db, norm, createSession, getSession, deleteSession } from '../db.js';
import { importMaster } from './master.js';
import { listTeams, createTeam, upsertEmployee, assignMember, deleteTeam, deleteEmployee, getConfig, reachOf, listEmployees } from './people.js';
import { queueAssignments } from './assignments.js';
import { setTrial, endTrial } from './trial.js';
import { barcodeSvg } from '../util/barcode.js';
import { localDate } from '../util/localtime.js';

export const TRAINING_NAME = 'Training count — not real stock';
const ZONE = 'Training';
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------ the warehouse on the wall */
const ITEMS = {
  straw: ['SKU-8840', 'Strawberry sliced IQF', 'CS30LB', 42.5],
  blue: ['SKU-8810', 'Blueberry wild IQF', 'CS30LB', 48.2],
  mango: ['SKU-8710', 'Mango chunks IQF', 'C10KG', 31.25],
  peach: ['SKU-8720', 'Peach slices IQF', 'CS', 29.9],
  rasp: ['SKU-8850', 'Raspberry whole IQF', 'CS', 55.75],
  pine: ['SKU-8730', 'Pineapple tidbits IQF', 'C10KG', 24.4],
  cherry: ['SKU-8860', 'Dark sweet cherries pitted IQF', 'CS30LB', 61.3],
  black: ['SKU-8870', 'Blackberry whole IQF', 'CS30LB', 58.4],
  mixed: ['SKU-8880', 'Mixed berries IQF', 'CS40LB', 36.8],
  banana: ['SKU-8740', 'Banana slices IQF', 'CS40LB', 19.85],
};
/*
 * One entry per bin, in walking order. `report` is what the inventory report
 * says is there; `wall` is what the trainer hangs under that rack label - the
 * pallet labels the class will actually scan. Where they differ is the lesson.
 */
export const WALL = [
  { bin: 'T01A001', report: [['TRN-1001', 'straw', 40, 'L2401']], wall: ['TRN-1001'],
    lesson: 'A plain one: rack, pallet, quantity. Count 40.' },
  { bin: 'T01A002', report: [['TRN-1002', 'blue', 32, 'L2402'], ['TRN-1003', 'blue', 28, 'L2402']], wall: ['TRN-1002', 'TRN-1003'],
    lesson: 'Two pallets in one spot: count both, scanning the rack once for each.' },
  { bin: 'T01A003', report: [], wall: [],
    lesson: 'An empty spot on the report and on the wall: scan the rack, tap Bin is EMPTY, Yes.' },
  { bin: 'T01A004', report: [['TRN-1004', 'mango', 36, 'L2404']], wall: ['TRN-1004'],
    lesson: 'A short count: the report says 36 — have the class count 30. The office gets a QTY VARIANCE and a second count.' },
  { bin: 'T01A005', report: [['TRN-1005', 'peach', 30, 'L2405']], wall: [],
    lesson: 'The report expects TRN-1005 here, but it is hanging under T01A006: scan the rack, Bin is EMPTY. The office sees it MISSING here and WRONG BIN there.' },
  { bin: 'T01A006', report: [], wall: ['TRN-1005'],
    lesson: 'An empty spot on the report with a pallet in it (TRN-1005 from next door): count it as normal. The scanner takes it; the report shows WRONG BIN.' },
  { bin: 'T01A007', report: [['TRN-1007', 'pine', 44, 'L2407']], wall: ['TRN-1007', 'TRN-9999'],
    lesson: 'A pallet nobody expected: TRN-9999 is not on the report. The scanner asks "Count it anyway?" — YES. It shows as NOT IN MASTER.' },
  { bin: 'T01A008', report: [['TRN-1008', 'rasp', 24, 'L2408'], ['TRN-1009', 'rasp', 24, 'L2408']], wall: ['TRN-1008', 'TRN-1009'], oneSkid: true,
    lesson: 'One pallet wearing two labels (TRN-1008 and TRN-1009 are the same skid): tap "This pallet has more than one label", scan the rack once, then each label with its quantity, then Done.' },
  { bin: 'T01B001', report: [['TRN-1010', 'cherry', 36, 'L2410']], wall: ['TRN-1010'], noScan: true,
    lesson: 'A label that will not scan: its barcode is printed torn. Tap "Label will not scan" → "I can read it — let me type it" and type TRN-1010.' },
  { bin: 'T01B002', report: [['TRN-1011', 'black', 40, 'L2411']], wall: ['TRN-1011'],
    lesson: 'Level B: a plain pallet up top. Count 40 — then press Back once to show how a wrong entry is undone.' },
  { bin: 'T01B003', report: [], wall: [],
    lesson: 'Empty, as the report says.' },
  { bin: 'T01B004', report: [['TRN-1012', 'mixed', 26, 'L2412']], wall: ['TRN-1012'],
    lesson: 'The last spot of the aisle. When it is counted the scanner says every bin has a count: tell the supervisor, who marks T01 done on the Team plan, and T02 appears.' },
  { bin: 'T02A001', report: [['TRN-2001', 'banana', 50, 'L2501']], wall: ['TRN-2001'],
    lesson: 'Aisle T02, for the second team or the second half of the class. Plain.' },
  { bin: 'T02A002', report: [['TRN-2002', 'straw', 40, 'L2502']], wall: ['TRN-2002'],
    lesson: 'Plain. Count 38 to raise a second count for the other team to walk.' },
  { bin: 'T02A003', report: [], wall: [],
    lesson: 'Empty.' },
  { bin: 'T02A004', report: [['TRN-2004', 'mango', 36, 'L2504'], ['TRN-2005', 'peach', 30, 'L2504']], wall: ['TRN-2004', 'TRN-2005'],
    lesson: 'Two pallets. After the first, have the class scan the rack of T02A005 by mistake and count TRN-2006 there: the scanner takes it, then Next bin points back at T02A004 (1 of 2 tags) and sends them back for TRN-2005.' },
  { bin: 'T02A005', report: [['TRN-2006', 'pine', 44, 'L2506']], wall: ['TRN-2006'],
    lesson: 'Already counted by the mistake at T02A004 — and the place to press SOS once, so the class sees the office answer on the scanner.' },
  { bin: 'T02A006', report: [['TRN-2007', 'cherry', 36, 'L2507']], wall: ['TRN-2007'],
    lesson: 'The last spot. Then Sign off this scanner, and the next trainee signs on with their own badge.' },
];
export const TEAMS = [
  { name: 'S1-DS01', shift: '1', notes: 'Training · 1st shift · aisle T01' },
  { name: 'S1-DS02', shift: '1', notes: 'Training · 1st shift · aisle T02' },
  { name: 'S2-DS01', shift: '2', notes: 'Training · 2nd shift' },
];
export const TRAINEES = [
  ['TRN-01', 'Marcus Obi', 'S1-DS01'], ['TRN-02', 'Priya Raman', 'S1-DS01'], ['TRN-03', 'Tom Zane', 'S1-DS01'],
  ['TRN-04', 'Ava Diaz', 'S1-DS02'], ['TRN-05', 'Luis Ferrer', 'S1-DS02'], ['TRN-06', 'Grace Kim', 'S1-DS02'],
  ['TRN-07', 'Jordan Lee', 'S2-DS01'], ['TRN-08', 'Sam Ortiz', 'S2-DS01'],
];
const itemOf = (key) => ITEMS[key];
/** The pallets of the report: a label the class scans may be hanging under another rack than the report says. */
export const palletsOnReport = () => WALL.flatMap((b) => b.report.map(([id, item, qty, lot]) => ({ id, item, qty, lot, bin: b.bin })));
const binsCsv = () => 'Bin Code,Zone,Aisle,Level\n' + WALL.map((b) => `${b.bin},${ZONE},${b.bin.slice(0, 3)},${b.bin[3]}`).join('\n') + '\n';
function reportCsv() {
  let csv = 'Bin Code,Container No.,Item No.,Description,Variant Code,Quantity,Unit of Measure Code,Entry No.,Lot No.,System,Cost,Amount\n';
  let entry = 9100001;
  for (const b of WALL) {
    if (!b.report.length) { csv += `${b.bin},,,,,,,,,OPEN,,\n`; continue; }
    for (const [id, item, qty, lot] of b.report) {
      const [sku, desc, uom, cost] = itemOf(item);
      csv += `${b.bin},${id},${sku},"${desc}",,${qty},${uom},${entry++},${lot},TRAINING,${cost},${Math.round(qty * cost * 10000) / 10000}\n`;
    }
  }
  return csv;
}

/* ------------------------------------------------------------ the count */
const settingGet = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
const settingSet = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const settingDel = (k) => db.prepare('DELETE FROM settings WHERE key = ?').run(k);

/** The training count, if there is one. */
export function trainingSession() {
  const id = Number(settingGet('trainingSession') || 0);
  const s = id ? getSession(id) : null;
  if (id && !s) settingDel('trainingSession');
  return s;
}

/* a piece of equipment the site knows that reaches level B, for the trainees who get one */
function liftFor(level) {
  const cfg = getConfig();
  for (const name of Object.keys(cfg.equipment || {})) if (reachOf([name], cfg).includes(level)) return name;
  return '';
}

/** Make the training count, its teams and trainees - or refresh them when they are there. */
export function ensureTraining({ by = '' } = {}) {
  let s = trainingSession();
  if (!s) {
    s = createSession({ name: TRAINING_NAME, mode: 'full', palletMode: 'warn', guided: 1, askComments: 1 });
    settingSet('trainingSession', s.id);
  }
  importMaster(s.id, 'bins', binsCsv(), { replace: true });
  importMaster(s.id, 'pallets', reportCsv(), { replace: true, source: 'TRAINING' });
  // every difference raises a second count, so the lesson about them can be shown on a short wall
  db.prepare(`UPDATE sessions SET guided = 1, ask_comments = 1, auto_recount = 1, third_count = 1, recount_min_qty = 0, recount_min_pct = 0, recount_min_value = 0,
                third_min_value = 0, recount_cap = 0, show_on_guns = 1, require_approval = 0, master_version = master_version + 1 WHERE id = ?`).run(s.id);
  if (!getSession(s.id).trial) setTrial(s.id, true);
  // the teams and the trainees: a crew list entry each, so the scanner's crew check lets them on
  const lift = liftFor('B');
  const byName = new Map(listTeams().map((t) => [t.name, t]));
  for (const t of TEAMS) {
    if (!byName.has(t.name)) byName.set(t.name, createTeam(t));
  }
  TRAINEES.forEach(([badge, name, team], i) => {
    upsertEmployee({ badge, name, dept: ZONE, shift: team.startsWith('S2') ? '2' : '1', equipment: lift && i % 3 === 0 ? [lift] : [] });
    assignMember(badge, byName.get(team).id);
  });
  // the plan: T01 for the first team with every level on the wall, T02 for the second; the night team waits behind
  const planned = db.prepare('SELECT COUNT(*) n FROM assignments WHERE session_id = ?').get(s.id).n;
  if (!planned) {
    queueAssignments(s.id, 'S1-DS01', ['T01'], 'A-B', { force: true });
    queueAssignments(s.id, 'S1-DS02', ['T02'], 'A', { force: true });
    queueAssignments(s.id, 'S2-DS01', ['T01', 'T02'], 'A-B', { force: true });
  }
  return trainingStatus();
}

/** Clear what the class counted and put the aisles back, for the next class. */
export function resetTraining() {
  const s = trainingSession();
  if (!s) throw Object.assign(new Error('there is no training count'), { status: 404 });
  if (!s.trial) setTrial(s.id, true);
  const out = endTrial(s.id);
  setTrial(s.id, true);
  return { ...trainingStatus(), cleared: out.cleared };
}

/** Take the training count, its teams and its trainees away. */
export function removeTraining() {
  const s = trainingSession();
  if (!s) throw Object.assign(new Error('there is no training count'), { status: 404 });
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), s.id);
  deleteSession(s.id, { confirmName: s.name });
  settingDel('trainingSession');
  for (const [badge] of TRAINEES) { try { deleteEmployee(badge); } catch { /* already gone */ } }
  for (const t of listTeams()) if (TEAMS.some((x) => x.name === t.name)) { try { deleteTeam(t.id); } catch { /* has other members: left */ } }
  return { removed: s.id, name: s.name };
}

export function trainingStatus() {
  const s = trainingSession();
  if (!s) return { session: null, wall: { bins: WALL.length, pallets: WALL.reduce((n, b) => n + b.wall.length, 0), teams: TEAMS.length, trainees: TRAINEES.length } };
  const n = (sql) => db.prepare(sql).get(s.id).n;
  const trainees = new Set(listEmployees().map((e) => e.badge));
  return {
    session: { id: s.id, name: s.name, status: s.status, trial: !!s.trial, showOnGuns: s.show_on_guns !== 0 },
    counted: { lines: n('SELECT COUNT(*) n FROM counts WHERE session_id = ? AND voided = 0'), bins: n('SELECT COUNT(DISTINCT location_code) n FROM counts WHERE session_id = ? AND voided = 0'),
      signons: n('SELECT COUNT(*) n FROM signons WHERE session_id = ?'), recounts: n("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND status != 'done'") },
    loaded: { bins: n('SELECT COUNT(*) n FROM locations WHERE session_id = ?'), pallets: n('SELECT COUNT(*) n FROM pallets WHERE session_id = ?'),
      teams: listTeams().filter((t) => TEAMS.some((x) => x.name === t.name)).length, trainees: TRAINEES.filter(([b]) => trainees.has(b)).length },
    wall: { bins: WALL.length, pallets: WALL.reduce((n2, b) => n2 + b.wall.length, 0), teams: TEAMS.length, trainees: TRAINEES.length },
  };
}

/* ------------------------------------------------------------ the printed wall */
const STYLE = `
  @page { size: letter portrait; margin: 10mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; padding: 10px; }
  h1 { font-size: 18pt; margin: 0 0 2px; }
  h2 { font-size: 13pt; margin: 18px 0 6px; }
  .sub { color: #444; font-size: 9.5pt; margin-bottom: 10px; }
  .page { break-after: page; page-break-after: always; }
  .grid { display: grid; gap: 10mm; }
  .big .grid { grid-template-columns: 1fr; }
  .small .grid { grid-template-columns: 1fr 1fr; }
  .label { border: 2px solid #000; border-radius: 6px; padding: 8mm 8mm 6mm; text-align: center; break-inside: avoid; page-break-inside: avoid; position: relative; }
  .big .label { min-height: 105mm; display: flex; flex-direction: column; justify-content: center; }
  .label svg { display: block; width: 100%; height: auto; margin: 0 auto; }
  .big .label svg { max-width: 150mm; }
  .small .label svg { max-width: 80mm; }
  .kicker { font-size: 10pt; font-weight: 800; letter-spacing: .16em; color: #333; margin-bottom: 6px; }
  .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 900; letter-spacing: .04em; margin-top: 6px; }
  .big .code { font-size: 40pt; } .small .code { font-size: 22pt; }
  .rack { background: #ffd54a; }
  .rack .arrow { position: absolute; right: 10mm; top: 8mm; font-size: 28pt; }
  .rack .pos { font-size: 11pt; color: #333; margin-top: 2px; }
  .pallet .item { font-size: 13pt; font-weight: 700; margin-top: 4px; }
  .pallet .lot { font-size: 10pt; color: #333; }
  .torn { position: relative; display: inline-block; }
  .torn::after { content: ''; position: absolute; left: 30%; top: -4px; width: 40%; height: 110%; background: repeating-linear-gradient(135deg, #fff 0 6px, transparent 6px 12px); }
  .torn::before { content: 'TORN'; position: absolute; left: 50%; top: 35%; transform: translateX(-50%) rotate(-12deg); font-weight: 900; font-size: 24pt; color: #c00; letter-spacing: .2em; opacity: .85; }
  .team { background: #e8f0ff; }
  .badge { background: #f4f4f4; }
  .badge .face { width: 26mm; height: 26mm; border-radius: 50%; background: #c9d6e3; margin: 0 auto 4mm; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18pt; color: #223; }
  .badge .name { font-size: 16pt; font-weight: 800; }
  .how { font-size: 9pt; color: #555; margin-top: 6px; }
  table.key { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
  table.key th, table.key td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; text-align: left; }
  table.key th { background: #eee; }
  .noprint { margin-bottom: 10px; padding: 6px 12px; }
  @media print { .noprint { display: none; } }
`;
const bars = (code, big) => barcodeSvg(code, { module: big ? 0.9 : 0.5, height: big ? 26 : 16, quiet: 4, showText: false });

/** Every label the wall needs, as pages to print: racks, pallets, team cards, badges, and the trainer's key. */
export function wallLabels({ size = 'big', part = 'all' } = {}) {
  const big = size !== 'small';
  const pallets = new Map(palletsOnReport().map((p) => [p.id, p]));
  const rackCards = WALL.map((b) => `
    <div class="label rack">
      <div class="arrow">▲</div>
      <div class="kicker">RACK LABEL · ${esc(ZONE.toUpperCase())}</div>
      ${bars(b.bin, big)}
      <div class="code">${esc(b.bin)}</div>
      <div class="pos">Aisle ${esc(b.bin.slice(0, 3))} · Level ${esc(b.bin[3])} · Position ${esc(b.bin.slice(4))}</div>
    </div>`);
  const palletCards = WALL.flatMap((b) => b.wall.map((id) => {
    const p = pallets.get(id);
    const [, desc, uom] = p ? itemOf(p.item) : ['', 'Mystery pallet — not on the report', ''];
    const torn = b.noScan;
    return `
    <div class="label pallet" data-under="${esc(b.bin)}">
      <div class="kicker">PALLET LABEL${b.oneSkid ? ' · ONE OF TWO ON THIS SKID' : ''}</div>
      ${torn ? `<div class="torn">${bars(id, big)}</div>` : bars(id, big)}
      <div class="code">${esc(id)}</div>
      <div class="item">${esc(desc)}${uom ? ` · ${esc(uom)}` : ''}</div>
      <div class="lot">${p ? `Lot ${esc(p.lot)}` : 'No lot'}</div>
      <div class="how">Hang under rack <b>${esc(b.bin)}</b></div>
    </div>`;
  }));
  const teamCards = TEAMS.map((t) => `
    <div class="label team" data-team="${esc(t.name)}">
      <div class="kicker">TEAM CARD · ${t.shift === '1' ? '1ST SHIFT' : '2ND SHIFT'}</div>
      ${bars(t.name, big)}
      <div class="code">${esc(t.name)}</div>
      <div class="how">Scan at sign-on, in <b>Team number</b> · ${esc(t.notes)}</div>
    </div>`);
  const badgeCards = TRAINEES.map(([badge, name, team]) => `
    <div class="label badge" data-badge="${esc(badge)}">
      <div class="kicker">CLOCK-IN BADGE · TEAM ${esc(team)}</div>
      <div class="face">${esc(name.split(' ').map((w) => w[0]).join(''))}</div>
      <div class="name">${esc(name)}</div>
      ${bars(badge, big)}
      <div class="code" style="font-size:${big ? 26 : 16}pt">${esc(badge)}</div>
      <div class="how">Scan at sign-on, in <b>Clock In Numbers</b></div>
    </div>`);
  const key = `
    <h2>The trainer's key — what is where, and what each spot teaches</h2>
    <div class="sub">Hang the rack labels in this order, left to right, level A low and level B above it; hang each pallet label under the rack it names. Keep this page off the wall.</div>
    <table class="key"><tr><th>Rack</th><th>Report says</th><th>On the wall</th><th>The lesson</th></tr>
    ${WALL.map((b) => `<tr><td><b>${esc(b.bin)}</b></td><td>${b.report.length ? b.report.map(([id, item, qty]) => `${esc(id)} · ${esc(itemOf(item)[1])} · ${qty}`).join('<br>') : '<i>empty (OPEN)</i>'}</td><td>${b.wall.length ? b.wall.map(esc).join('<br>') : '<i>nothing</i>'}</td><td>${esc(b.lesson)}</td></tr>`).join('')}
    </table>
    <h2>Teams and badges</h2>
    <table class="key"><tr><th>Team</th><th>Shift</th><th>Plan</th><th>Badges</th></tr>
    ${TEAMS.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${t.shift === '1' ? '1st' : '2nd'}</td><td>${esc(t.name === 'S1-DS01' ? 'T01, levels A–B' : t.name === 'S1-DS02' ? 'T02, level A' : 'T01 then T02, after the day teams')}</td><td>${TRAINEES.filter((x) => x[2] === t.name).map(([b, n]) => `${esc(b)} ${esc(n)}`).join('<br>')}</td></tr>`).join('')}
    </table>
    <div class="sub" style="margin-top:8px">Every code is Code 128, as the racking is. Scan from arm's length on the big labels. The scanners see the count as a <b>trial run</b>; Testing Suite → Classroom training → <b>Reset for the next class</b> clears it.</div>`;
  const section = (title, cards) => cards.length ? `<h2>${esc(title)}</h2><div class="grid">${cards.join('')}</div>` : '';
  const parts = {
    all: section('Rack labels', rackCards) + `<div class="page"></div>` + section('Pallet labels', palletCards) + `<div class="page"></div>` + section('Team cards', teamCards) + section('Badges', badgeCards) + `<div class="page"></div>` + key,
    racks: section('Rack labels', rackCards), pallets: section('Pallet labels', palletCards), teams: section('Team cards', teamCards) + section('Badges', badgeCards), key,
  };
  const total = rackCards.length + palletCards.length + teamCards.length + badgeCards.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Training wall — labels</title><style>${STYLE}</style></head>
<body class="${big ? 'big' : 'small'}">
<h1>Training wall — the warehouse on paper</h1>
<div class="sub">${rackCards.length} rack labels · ${palletCards.length} pallet labels · ${teamCards.length} team cards · ${badgeCards.length} badges · ${total} codes · printed ${esc(localDate())} · ${big ? 'big: one per page, scan from arm\'s length' : 'small: two per page, for a desk'}</div>
<button class="noprint" onclick="window.print()">Print</button>
${parts[part] || parts.all}
</body></html>`;
}

/* ------------------------------------------------------------ the pocket card */
const CARD = {
  en: {
    title: 'The scanner, on one card', steps: ['Scan the RACK label', 'Scan the PALLET label', 'Count. Type the QUANTITY', 'A comment if one fits — or wait'],
    signon: 'Sign on: scan the team card, then every badge, then Sign on & load list.',
    rules: ['Count what is really there — never the report.', 'Every pallet in the spot, every spot in your aisle.', 'Nothing in the spot: Bin is EMPTY.', 'Wrong entry: Back. Wrong line saved: History → Void.', 'Finished the aisle? Tell your supervisor.'],
    buttons: [['Bin is EMPTY', 'nothing in the spot'], ['This pallet has more than one label', 'one skid, two labels'], ['Label will not scan', 'type it, or count it with no label'], ['Report a problem', 'damage, a blocked spot'], ['SOS — I need help', 'now, not later'], ['Start second counts', 'spots to count again'], ['Sign off this scanner', 'break or end of shift']],
    offline: 'OFFLINE at the top? Keep counting. Lines send themselves when the signal is back.',
  },
  es: {
    title: 'El escáner, en una tarjeta', steps: ['Escanea la etiqueta del RACK', 'Escanea la etiqueta de la TARIMA', 'Cuenta. Escribe la CANTIDAD', 'Un comentario si aplica — o espera'],
    signon: 'Entrar: escanea la tarjeta del equipo, luego cada gafete, luego Entrar y cargar lista.',
    rules: ['Cuenta lo que de verdad hay — nunca el reporte.', 'Cada tarima del lugar, cada lugar de tu pasillo.', 'Nada en el lugar: Ubicación VACÍA.', 'Entrada mal: Atrás. Línea guardada mal: Historial → Anular.', '¿Terminaste el pasillo? Avisa a tu supervisor.'],
    buttons: [['Ubicación VACÍA', 'nada en el lugar'], ['Esta tarima tiene más de una etiqueta', 'una tarima, dos etiquetas'], ['La etiqueta no escanea', 'escríbela, o cuéntala sin etiqueta'], ['Reportar un problema', 'daño, un lugar bloqueado'], ['SOS — necesito ayuda', 'ahora, no después'], ['Empezar segundos conteos', 'lugares para volver a contar'], ['Salir de este escáner', 'descanso o fin de turno']],
    offline: '¿SIN CONEXIÓN arriba? Sigue contando. Las líneas se envían solas cuando vuelve la señal.',
  },
};
/**
 * The pocket card: the steps, the sign-on, the offline rule, the five rules and
 * the buttons, four to a Letter page. With `teams` - one team number per card,
 * one card per person - every sheet of fronts is followed by a sheet of backs:
 * that person's team card (the number as a QR and as a Code 128 barcode, the
 * kind the rack labels use), mirrored so a duplex print on the long edge puts
 * each back behind its front.
 */
export function pocketCard({ lang = 'en', teams = [] } = {}) {
  const es = lang === 'es';
  const c = CARD[es ? 'es' : 'en'];
  const front = `
    <div class="pc">
      <div class="pch">${esc(c.title)}</div>
      <ol class="steps">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <div class="pcs">${esc(c.signon)}</div>
      <div class="pcs off">${esc(c.offline)}</div>
      <div class="pct">${es ? 'Las cinco reglas' : 'The five rules'}</div>
      <ul class="rules">${c.rules.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <div class="pct">${es ? 'Los botones' : 'The buttons'}</div>
      <table class="btns">${c.buttons.map(([b, w]) => `<tr><td><b>${esc(b)}</b></td><td>${esc(w)}</td></tr>`).join('')}</table>
    </div>`;
  const known = new Map(listTeams().map((t) => [String(t.name).toUpperCase(), t]));
  const shiftWord = (name) => {
    const t = known.get(name);
    const sh = t && t.shift ? t.shift : /^S1/i.test(name) ? '1' : /^S2/i.test(name) ? '2' : '';
    return sh === '1' ? (es ? '1er turno' : '1st shift') : sh === '2' ? (es ? '2do turno' : '2nd shift') : '';
  };
  const back = (name) => !name ? '<div class="pc back blank"></div>' : `
    <div class="pc back" data-team="${esc(name)}">
      <div class="kicker">${es ? 'TARJETA DEL EQUIPO' : 'TEAM CARD'}${shiftWord(name) ? ` · ${esc(shiftWord(name)).toUpperCase()}` : ''}</div>
      <div class="qr" data-code="${esc(name)}"></div>
      <div class="tname">${esc(name)}</div>
      <div class="bars">${barcodeSvg(name, { module: 0.36, height: 9, quiet: 3, showText: false })}</div>
      <div class="how">${es ? 'Escanea cualquiera de los dos códigos al entrar, en <b>Número de equipo</b>' : 'Scan either code at sign-on, in <b>Team number</b>'}</div>
      <div class="who">${es ? 'Nombre' : 'Name'}: ______________________</div>
    </div>`;
  const list = teams.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean);
  let sheets;
  if (!list.length) sheets = `<div class="sheet">${front}${front}${front}${front}</div>`;
  else {
    const pages = [];
    for (let i = 0; i < list.length; i += 4) {
      const four = [list[i], list[i + 1], list[i + 2], list[i + 3]];
      /* the backs mirrored left-right: flipped on the long edge, B lands behind A */
      const mirrored = [four[1], four[0], four[3], four[2]];
      pages.push(`<div class="sheet page fronts">${front}${front}${front}${front}</div>`);
      pages.push(`<div class="sheet page backs">${mirrored.map(back).join('')}</div>`);
    }
    sheets = pages.join('');
  }
  return `<!doctype html><html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><title>${esc(c.title)}</title><style>
  @page { size: letter portrait; margin: 8mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; padding: 8px; }
  .sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  /* a sheet that is a page: two rows of fixed-height cards, so the backs line up behind the fronts (and the rows never stretch to the page) */
  .page { page-break-after: always; break-after: page; grid-auto-rows: 123mm; align-content: start; gap: 5mm 6mm; }
  .page .pc { height: 123mm; box-sizing: border-box; overflow: hidden; font-size: 8.4pt; line-height: 1.22; padding: 4mm 5mm 3mm; }
  .page .pch { font-size: 12.5pt; margin-bottom: 2px; }
  .page .steps { font-size: 10.5pt; margin: 2px 0 4px; }
  .page .steps li { margin: 1px 0; }
  .page .pcs { font-size: 8pt; margin: 2px 0; }
  .page .pct { margin: 5px 0 1px; font-size: 7.5pt; }
  .page table.btns { font-size: 7.6pt; }
  .page table.btns td { padding: 1px 3px; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .pc { border: 1.5px dashed #777; border-radius: 8px; padding: 6mm 6mm 5mm; break-inside: avoid; page-break-inside: avoid; font-size: 9.5pt; line-height: 1.3; }
  .pch { font-size: 14pt; font-weight: 900; margin-bottom: 4px; }
  .steps { margin: 4px 0 6px; padding-left: 20px; font-size: 12pt; font-weight: 800; }
  .steps li { margin: 2px 0; }
  .pcs { font-size: 9pt; color: #222; margin: 3px 0; }
  .pcs.off { background: #fff3c4; border-radius: 4px; padding: 3px 6px; }
  .pct { font-size: 8.5pt; font-weight: 800; letter-spacing: .14em; color: #444; margin: 8px 0 2px; }
  .rules { margin: 0; padding-left: 16px; }
  .rules li { margin: 1px 0; }
  table.btns { border-collapse: collapse; width: 100%; font-size: 8.8pt; }
  table.btns td { padding: 2px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  /* the back: the team card, centred, the same height as the front */
  .backs .pc { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .backs .pc.blank { border-color: transparent; }
  .kicker { font-size: 9pt; font-weight: 800; letter-spacing: .14em; color: #444; margin-bottom: 8px; }
  .qr { display: flex; justify-content: center; align-items: center; min-height: 170px; }
  .tname { font-size: 30pt; font-weight: 900; letter-spacing: .02em; margin-top: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .bars { margin: 6px auto 0; width: 58mm; }
  .bars svg { display: block; width: 100%; height: auto; }
  .how { font-size: 8.5pt; color: #555; margin-top: 6px; }
  .who { font-size: 10pt; margin-top: 12px; color: #222; }
  .noprint { margin-bottom: 8px; padding: 6px 12px; }
  @media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body>
<button class="noprint" onclick="window.print()">Print</button>
${list.length ? `<div class="noprint" style="font-size:12px;color:#444;margin-bottom:8px">${list.length} ${es ? 'tarjetas · imprime a doble cara, volteando por el lado largo: el equipo de cada persona queda atrás de su tarjeta' : 'cards · print double-sided, flipped on the long edge: each person’s team card lands on the back of their pocket card'}</div>` : ''}
${sheets}
<script src="/vendor/qrcode.min.js"></script>
<script>
  for (const box of document.querySelectorAll('.qr')) {
    try { new QRCode(box, { text: box.dataset.code, width: 170, height: 170, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { box.textContent = 'QR unavailable'; }
  }
</script>
</body></html>`;
}

/** One team number per person on Teams & crew - every member of every team, and at least one card a team. */
export function crewTeamList() {
  const out = [];
  for (const t of listTeams().sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))) {
    const n = Math.max(1, (t.members || []).length);
    for (let i = 0; i < n; i++) out.push(String(t.name));
  }
  return out;
}
