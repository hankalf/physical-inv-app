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
import { Docx, barcodePng, EMU_PER_INCH } from '../util/docx.js';
import { widths as barWidths } from '../util/barcode.js';

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

/* The cycle count on the same wall: a person on their own with a list of bins for
   the day, counting each as it stands and tapping Bin done. The same rack and
   pallet labels; the list is these bins, in this order. */
export const CYCLE_NAME = 'Training cycle count — not real stock';
export const CYCLE_LIST = [
  { bin: 'T01A002', lesson: 'Two pallets in one bin: count both — rack, pallet, quantity, each time — then tap Bin done. The next bin on the list comes up.' },
  { bin: 'T01A003', lesson: 'Nothing in it: scan the rack, Bin is EMPTY, Yes. An empty bin finishes by itself.' },
  { bin: 'T01A007', lesson: 'TRN-1007 and TRN-9999: count TRN-1007, then TRN-9999 asks Count it anyway? — YES, count it. Then Bin done.' },
  { bin: 'T01B001', lesson: 'The torn label: Label will not scan → I can read it — let me type it → TRN-1010 on the scanner’s keys. Then Bin done.' },
  { bin: 'T02A004', lesson: 'Scan the rack of T02A005 first, by mistake: the scanner refuses it — this cycle count is for T02A004. Then count both pallets and tap Bin done.' },
  { bin: 'T02A006', lesson: 'The last bin on the list. Count it and tap Bin done: the list is empty. Sign off this scanner, and the next trainee signs on with their own badge.' },
];
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

/** The training cycle count, if there is one. */
export function trainingCycleSession() {
  const id = Number(settingGet('trainingCycle') || 0);
  const s = id ? getSession(id) : null;
  if (id && !s) settingDel('trainingCycle');
  return s;
}

/* today's list on the training cycle count: the bins above, any team, in order */
function makeCycleList(id) {
  if (db.prepare("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND reason = 'CYCLE' AND status != 'done'").get(id).n) return;
  const now = new Date().toISOString();
  const batch = db.prepare(`INSERT INTO cycle_batches (session_id, name, due_date, target, strategy, scope, auto, created_at) VALUES (?, ?, ?, ?, 'oldest', '{}', 0, ?)`)
    .run(id, 'The classroom list', now.slice(0, 10), CYCLE_LIST.length, now).lastInsertRowid;
  const ins = db.prepare(`INSERT INTO recounts (session_id, bin, reason, detail, source, team, batch_id, status, created_at) VALUES (?, ?, 'CYCLE', ?, 'cycle', NULL, ?, 'open', ?)`);
  for (const c of CYCLE_LIST) ins.run(id, c.bin, 'on the classroom list', batch, now);
}

/** The cycle count on the same wall: made, loaded and given its list - or refreshed. */
function ensureTrainingCycle() {
  let c = trainingCycleSession();
  if (!c) {
    c = createSession({ name: CYCLE_NAME, mode: 'cycle', palletMode: 'warn', askComments: 0 });
    settingSet('trainingCycle', c.id);
  }
  importMaster(c.id, 'bins', binsCsv(), { replace: true });
  importMaster(c.id, 'pallets', reportCsv(), { replace: true, source: 'TRAINING' });
  db.prepare('UPDATE sessions SET ask_comments = 0, auto_recount = 0, show_on_guns = 1, require_approval = 0, master_version = master_version + 1 WHERE id = ?').run(c.id);
  if (!getSession(c.id).trial) setTrial(c.id, true);
  makeCycleList(c.id);
  return c;
}

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
  ensureTrainingCycle();
  return trainingStatus();
}

/** Clear what the class counted and put the aisles back, for the next class. */
export function resetTraining() {
  const s = trainingSession();
  if (!s) throw Object.assign(new Error('there is no training count'), { status: 404 });
  if (!s.trial) setTrial(s.id, true);
  const out = endTrial(s.id);
  setTrial(s.id, true);
  // the cycle count too: what was counted cleared, and the list back as it was
  const c = trainingCycleSession();
  if (c) {
    if (!c.trial) setTrial(c.id, true);
    const oc = endTrial(c.id);
    setTrial(c.id, true);
    makeCycleList(c.id);
    for (const k of Object.keys(out.cleared || {})) if (typeof out.cleared[k] === 'number' && oc.cleared && typeof oc.cleared[k] === 'number') out.cleared[k] += oc.cleared[k];
  } else ensureTrainingCycle();
  return { ...trainingStatus(), cleared: out.cleared };
}

/** Take the training count, its teams and its trainees away. */
export function removeTraining() {
  const s = trainingSession();
  if (!s) throw Object.assign(new Error('there is no training count'), { status: 404 });
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), s.id);
  deleteSession(s.id, { confirmName: s.name });
  settingDel('trainingSession');
  const c = trainingCycleSession();
  if (c) {
    db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), c.id);
    deleteSession(c.id, { confirmName: c.name });
    settingDel('trainingCycle');
  }
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
    cycle: (() => {
      const c = trainingCycleSession();
      if (!c) return null;
      const q = (sql) => db.prepare(sql).get(c.id).n;
      return { id: c.id, name: c.name, trial: !!c.trial, showOnGuns: c.show_on_guns !== 0,
        bins: q("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND reason = 'CYCLE'"), done: q("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND reason = 'CYCLE' AND status = 'done'"),
        lines: q('SELECT COUNT(*) n FROM counts WHERE session_id = ? AND voided = 0') };
    })(),
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
    <h2>Cycle count practice — on the same wall</h2>
    <div class="sub">A second training count, <b>${esc(CYCLE_NAME)}</b>, has a list of ${CYCLE_LIST.length} bins on this wall. On the scanner: tap <b>Cycle count</b> at the top of the sign-on screen, pick it, scan <b>one badge</b> — on a cycle count the person is the team — then <b>Sign on &amp; load list</b> and <b>Start counting the list</b>. Each bin is counted as it stands, then <b>Bin done</b>.</div>
    <table class="key cycle"><tr><th>#</th><th>Bin</th><th>On the wall</th><th>The lesson</th></tr>
    ${CYCLE_LIST.map((c, i) => { const w = WALL.find((b) => b.bin === c.bin); return `<tr><td>${i + 1}</td><td><b>${esc(c.bin)}</b></td><td>${w && w.wall.length ? w.wall.map(esc).join('<br>') : '<i>nothing</i>'}</td><td>${esc(c.lesson)}</td></tr>`; }).join('')}
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

/* ------------------------------------------------------------------ roster
 * Who has been through the classroom: every employee on Teams & crew, ticked
 * off by the trainer as they finish, with who ticked them and when. The
 * trainees printed for the wall are not on it - they are props. A real badge
 * that signed on to the training count shows when, as a hint to the trainer.
 */
db.exec(`CREATE TABLE IF NOT EXISTS training_roster (
  badge      TEXT PRIMARY KEY,
  trained_at TEXT NOT NULL,
  trained_by TEXT,
  note       TEXT
)`);

export function trainingRoster() {
  const t = trainingSession();
  const seen = new Map();   // badge -> first sign-on to the training count
  if (t) {
    for (const r of db.prepare('SELECT employees, started_at FROM signons WHERE session_id = ? ORDER BY started_at').all(t.id)) {
      let list = [];
      try { list = JSON.parse(r.employees || '[]'); } catch { list = []; }
      for (const b of list) { const k = norm(b); if (k && !seen.has(k)) seen.set(k, r.started_at); }
    }
  }
  const ticks = new Map(db.prepare('SELECT * FROM training_roster').all().map((r) => [r.badge, r]));
  const rows = listEmployees()
    .filter((e) => e.active !== 0 && !/^TRN-\d+$/i.test(e.badge) && !/training/i.test(e.dept || ''))
    .map((e) => {
      const k = norm(e.badge);
      const tick = ticks.get(k);
      return { badge: e.badge, name: e.name, dept: e.dept || '', shift: e.shift || '', team: e.team || '', signedOn: seen.get(k) || null,
        trained: !!tick, trainedAt: tick ? tick.trained_at : null, trainedBy: tick ? tick.trained_by : null, note: tick ? tick.note || '' : '' };
    })
    .sort((a, b) => String(a.shift).localeCompare(String(b.shift)) || String(a.team).localeCompare(String(b.team), undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const byShift = {};
  for (const r of rows) { const k = r.shift || '-'; byShift[k] = byShift[k] || { people: 0, trained: 0 }; byShift[k].people++; if (r.trained) byShift[k].trained++; }
  return { rows, totals: { people: rows.length, trained: rows.filter((r) => r.trained).length, signedOn: rows.filter((r) => r.signedOn).length, byShift } };
}

export function markTrained({ badge, trained = true, note = '', by = '' }) {
  const k = norm(badge);
  if (!k) throw Object.assign(new Error('clock in number required'), { status: 400 });
  if (trained) db.prepare('INSERT INTO training_roster (badge, trained_at, trained_by, note) VALUES (?, ?, ?, ?) ON CONFLICT(badge) DO UPDATE SET trained_at = excluded.trained_at, trained_by = excluded.trained_by, note = excluded.note')
    .run(k, new Date().toISOString(), by || null, String(note || '').slice(0, 200) || null);
  else db.prepare('DELETE FROM training_roster WHERE badge = ?').run(k);
  return trainingRoster();
}

export function rosterCsv() {
  const { rows } = trainingRoster();
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return ['Clock In Number,Name,Shift,Team,Department,Trained,Trained On,Trained By,Signed On To Training Count,Note']
    .concat(rows.map((r) => [r.badge, r.name, r.shift, r.team, r.dept, r.trained ? 'yes' : 'no', r.trainedAt ? r.trainedAt.slice(0, 10) : '', r.trainedBy || '', r.signedOn ? r.signedOn.slice(0, 16).replace('T', ' ') : '', r.note].map(q).join(',')))
    .join('\r\n') + '\r\n';
}

/** The roster on paper: a clipboard sheet with a box to tick, by shift. */
export function rosterSheet() {
  const { rows, totals } = trainingRoster();
  const shifts = [...new Set(rows.map((r) => r.shift || ''))];
  const word = (s) => (s === '1' ? '1st shift' : s === '2' ? '2nd shift' : s ? `Shift ${s}` : 'No shift');
  const table = (list) => `<table><thead><tr><th class="bx">Trained</th><th>Clock-in</th><th>Name</th><th>Team</th><th>Dept</th><th>On the wall</th><th>Sign</th></tr></thead><tbody>${list.map((r) => `
    <tr><td class="bx">${r.trained ? '☑' : '☐'}</td><td class="mono">${esc(r.badge)}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.team)}</td><td>${esc(r.dept)}</td><td>${r.signedOn ? esc(r.signedOn.slice(11, 16)) : ''}</td><td class="sig"></td></tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Training roster</title><style>
  @page { size: letter portrait; margin: 12mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; padding: 12px; font-size: 10.5pt; }
  h1 { font-size: 16pt; margin: 0 0 2px; } .sub { color: #444; font-size: 9.5pt; margin-bottom: 10px; }
  h2 { font-size: 12pt; margin: 14px 0 4px; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  th { background: #eee; font-size: 9pt; letter-spacing: .04em; text-transform: uppercase; }
  td.bx { font-size: 16pt; text-align: center; width: 14mm; } td.mono { font-family: ui-monospace, Menlo, Consolas, monospace; } td.sig { width: 34mm; }
  tr { break-inside: avoid; }
  .noprint { margin-bottom: 10px; padding: 6px 12px; } @media print { .noprint { display: none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">Print</button>
<h1>Training roster — classroom training</h1>
<div class="sub">${totals.people} people on Teams &amp; crew · ${totals.trained} trained so far · printed ${esc(localDate())} · tick the box as each person finishes the wall, and sign</div>
${shifts.map((sh) => `<h2>${esc(word(sh))} · ${rows.filter((r) => (r.shift || '') === sh).length} people</h2>${table(rows.filter((r) => (r.shift || '') === sh))}`).join('')}
${!rows.length ? '<p>No employees on Teams &amp; crew yet — upload the crew list first.</p>' : ''}
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


/* ------------------------------------------------------------- in Word
 * The same cards, labels, key and roster as Word documents, for a site that
 * wants them in its own words. Barcodes are pictures (Code 128, the kind the
 * rack labels use); the team cards' QR is left to the printed version.
 */
const BAR = (code, { inches = 2.2, tall = 0.5 } = {}) => [barcodePng(barWidths(code), { scale: 4, height: 60, quiet: 10 }), Math.round(inches * EMU_PER_INCH), Math.round(tall * EMU_PER_INCH)];

export function pocketCardDocx({ lang = 'en', teams = [] } = {}) {
  const es = lang === 'es';
  const c = CARD[es ? 'es' : 'en'];
  const d = new Docx({ margin: 540 });
  const W = Math.floor((12240 - 2 * 540 - 240) / 2);
  const front = () => [
    d.paragraphXml([{ text: c.title, bold: true, size: 26 }], { after: 60 }),
    ...c.steps.map((t, i) => d.paragraphXml([{ text: `${i + 1}. ${t}`, bold: true, size: 22 }], { after: 30 })),
    d.paragraphXml([{ text: c.signon, size: 18 }], { before: 80, after: 60 }),
    d.paragraphXml([{ text: c.offline, size: 18 }], { shade: 'FFF3C4', after: 100 }),
    d.paragraphXml([{ text: es ? 'LAS CINCO REGLAS' : 'THE FIVE RULES', bold: true, size: 16, color: '444444' }], { after: 30 }),
    ...c.rules.map((t) => d.paragraphXml([{ text: t, size: 18 }], { bullet: true, after: 20 })),
    d.paragraphXml([{ text: es ? 'LOS BOTONES' : 'THE BUTTONS', bold: true, size: 16, color: '444444' }], { before: 100, after: 30 }),
    ...c.buttons.map(([b, w]) => d.paragraphXml([{ text: b, bold: true, size: 17 }, { text: ` — ${w}`, size: 17 }], { after: 20 })),
  ];
  const known = new Map(listTeams().map((t) => [String(t.name).toUpperCase(), t]));
  const shiftWord = (name) => {
    const t = known.get(name);
    const sh = t && t.shift ? t.shift : /^S1/i.test(name) ? '1' : /^S2/i.test(name) ? '2' : '';
    return sh === '1' ? (es ? '1ER TURNO' : '1ST SHIFT') : sh === '2' ? (es ? '2DO TURNO' : '2ND SHIFT') : '';
  };
  const back = (name) => {
    if (!name) return [d.paragraphXml('', { after: 0 })];
    const [png, w, h] = BAR(name, { inches: 2.6, tall: 0.7 });
    return [
      d.paragraphXml([{ text: `${es ? 'TARJETA DEL EQUIPO' : 'TEAM CARD'}${shiftWord(name) ? ` · ${shiftWord(name)}` : ''}`, bold: true, size: 17, color: '444444' }], { align: 'center', before: 600, after: 200 }),
      d.paragraphXml([{ text: name, bold: true, size: 60, font: 'Consolas' }], { align: 'center', after: 120 }),
      d.pictureXml(png, { width: w, height: h, name: `team ${name}` }),
      d.paragraphXml([{ text: es ? 'Escanea el código al entrar, en Número de equipo' : 'Scan the code at sign-on, in Team number', size: 17, color: '555555' }], { align: 'center', before: 120, after: 300 }),
      d.paragraphXml([{ text: `${es ? 'Nombre' : 'Name'}: ______________________`, size: 20 }], { align: 'center', after: 400 }),
    ];
  };
  const list = teams.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean);
  const fronts = () => d.tableXml([[front(), front()], [front(), front()]], { widths: [W, W], rowHeight: 6940 });
  if (!list.length) d.body.push(fronts());
  else {
    d.paragraph([{ text: es ? `${list.length} tarjetas · imprime a doble cara, volteando por el lado largo: el equipo de cada persona queda atrás de su tarjeta.` : `${list.length} cards · print double-sided, flipped on the long edge: each person’s team card lands on the back of their pocket card.`, size: 18, color: '555555' }], { after: 120 });
    for (let i = 0; i < list.length; i += 4) {
      const four = [list[i], list[i + 1], list[i + 2], list[i + 3]];
      const mirrored = [four[1], four[0], four[3], four[2]];
      if (i) d.pageBreak();
      d.body.push(fronts());
      d.pageBreak();
      d.body.push(d.tableXml([[back(mirrored[0]), back(mirrored[1])], [back(mirrored[2]), back(mirrored[3])]], { widths: [W, W], rowHeight: 6940 }));
    }
  }
  return d.build({ title: c.title });
}

export function wallDocx({ part = 'all' } = {}) {
  const d = new Docx({ margin: 720 });
  const W = 12240 - 2 * 720;
  const pallets = new Map(palletsOnReport().map((p) => [p.id, p]));
  const label = (kicker, code, lines, how, { tall = true } = {}) => {
    const [png, w, h] = BAR(code, { inches: 5.2, tall: 1.1 });
    return [
      d.paragraphXml([{ text: kicker, bold: true, size: 24, color: '444444' }], { align: 'center', before: tall ? 1200 : 300, after: 200 }),
      d.pictureXml(png, { width: w, height: h, name: code }),
      d.paragraphXml([{ text: code, bold: true, size: 96, font: 'Consolas' }], { align: 'center', before: 200, after: 120 }),
      ...lines.map((t) => d.paragraphXml([{ text: t, size: 28 }], { align: 'center', after: 60 })),
      d.paragraphXml([{ text: how, size: 20, color: '555555' }], { align: 'center', before: 240, after: tall ? 1200 : 300 }),
    ];
  };
  const cards = [];
  if (part === 'all' || part === 'racks') for (const b of WALL) cards.push(label('RACK LABEL · TRAINING WALL', b.bin, [describeTrainingBin(b.bin)], 'Scan first, at every spot'));
  if (part === 'all' || part === 'pallets') for (const b of WALL) for (const id of b.wall) {
    const p = pallets.get(id);
    const [, desc, uom] = p ? itemOf(p.item) : ['', 'Mystery pallet — not on the report', ''];
    cards.push(label('PALLET LABEL', id, [`${desc}${uom ? ` · ${uom}` : ''}`, p ? `Lot ${p.lot}` : 'No lot', b.noScan ? 'PRINTED TORN ON THE WALL: this one will not scan' : ''].filter(Boolean), `Hang under rack ${b.bin}${b.oneSkid ? ' · ONE OF TWO ON THIS SKID' : ''}`));
  }
  if (part === 'all' || part === 'teams') {
    for (const t of TEAMS) cards.push(label(`TEAM CARD · ${t.shift === '1' ? '1ST SHIFT' : '2ND SHIFT'}`, t.name, [t.notes], 'Scan at sign-on, in Team number'));
    for (const [badge, name, team] of TRAINEES) cards.push(label(`CLOCK-IN BADGE · TEAM ${team}`, badge, [name], 'Scan at sign-on, in Clock In Numbers'));
  }
  cards.forEach((xml, i) => { if (i) d.pageBreak(); d.body.push(d.tableXml([[xml]], { widths: [W], border: 'dashed' })); });
  if (part === 'all' || part === 'key') {
    if (cards.length) d.pageBreak();
    d.paragraph([{ text: "The trainer's key", bold: true, size: 36 }], { after: 80 });
    d.paragraph([{ text: 'Every spot on the wall: what the report says is there, what to hang under the rack label, and the lesson. Hang level B above level A.', size: 20 }], { after: 200 });
    const rows = [['Spot', 'On the report', 'Hang under it', 'The lesson']].concat(WALL.map((b) => [
      b.bin,
      b.report.map(([id, , qty]) => `${id} · ${qty}`).join(', ') || 'nothing',
      b.wall.join(', ') + (b.oneSkid ? ' (one skid)' : '') + (b.noScan ? ' (printed torn)' : '') || 'nothing',
      b.lesson,
    ]));
    d.table(rows.map((r, i) => r.map((t) => [d.paragraphXml([{ text: t, size: i ? 18 : 18, bold: !i }], { after: 0 })])), { widths: [1300, 2600, 2400, W - 6300], border: 'single', borderColor: 'BBBBBB', cellMargin: 80, headerShade: 'E8EEF6' });
    d.paragraph([{ text: 'Cycle count practice — on the same wall', bold: true, size: 28 }], { before: 300, after: 80, keepNext: true });
    d.paragraph([{ text: `A second training count, ${CYCLE_NAME}, has a list of ${CYCLE_LIST.length} bins on this wall. On the scanner: tap Cycle count at the top of the sign-on screen, pick it, scan one badge (on a cycle count the person is the team), then Sign on & load list and Start counting the list. Each bin is counted as it stands, then Bin done.`, size: 19 }], { after: 120 });
    const crows = [['#', 'Bin', 'On the wall', 'The lesson']].concat(CYCLE_LIST.map((c, i) => { const w = WALL.find((b) => b.bin === c.bin); return [String(i + 1), c.bin, w && w.wall.length ? w.wall.join(', ') : 'nothing', c.lesson]; }));
    d.table(crows.map((r, i) => r.map((t) => [d.paragraphXml([{ text: t, size: 18, bold: !i }], { after: 0 })])), { widths: [500, 1300, 2200, W - 4000], border: 'single', borderColor: 'BBBBBB', cellMargin: 80, headerShade: 'E8EEF6' });
  }
  return d.build({ title: 'Training wall' });
}

/** The spot in words, for the rack label. */
function describeTrainingBin(code) {
  const m = /^T(\d\d)([A-Z])(\d\d\d)$/.exec(code);
  return m ? `Aisle T${m[1]} · Level ${m[2]} · Position ${m[3]}` : code;
}

export function rosterDocx() {
  const { rows, totals } = trainingRoster();
  const d = new Docx({ margin: 900 });
  const W = 12240 - 2 * 900;
  const word = (s) => (s === '1' ? '1st shift' : s === '2' ? '2nd shift' : s ? `Shift ${s}` : 'No shift');
  d.paragraph([{ text: 'Training roster — classroom training', bold: true, size: 34 }], { after: 60 });
  d.paragraph([{ text: `${totals.people} people on Teams & crew · ${totals.trained} trained so far · ${localDate()} · tick the box as each person finishes the wall, and sign`, size: 19, color: '555555' }], { after: 200 });
  for (const sh of [...new Set(rows.map((r) => r.shift || ''))]) {
    const list = rows.filter((r) => (r.shift || '') === sh);
    d.paragraph([{ text: `${word(sh)} · ${list.length} people`, bold: true, size: 26 }], { before: 200, after: 80, keepNext: true });
    const head = ['Trained', 'Clock-in', 'Name', 'Team', 'Dept', 'On the wall', 'Sign'];
    const body = list.map((r) => [r.trained ? '☑' : '☐', r.badge, r.name, r.team, r.dept, r.signedOn ? r.signedOn.slice(11, 16) : '', '']);
    d.table([head].concat(body).map((r, i) => r.map((t, c) => [d.paragraphXml([{ text: t, size: c === 0 && i ? 28 : 19, bold: !i, font: c === 1 && i ? 'Consolas' : undefined }], { after: 0, align: c === 0 ? 'center' : 'left' })])), { widths: [900, 1300, 2800, 1300, 1600, 1200, W - 9100], border: 'single', borderColor: '999999', cellMargin: 70, headerShade: 'EEEEEE' });
  }
  if (!rows.length) d.paragraph('No employees on Teams & crew yet — upload the crew list first.');
  return d.build({ title: 'Training roster' });
}

/* ------------------------------------------------------------ more for the classroom
 * For a crew to whom the whole system is new: a check-off sheet the trainer signs
 * for each person, a short quiz with its answers, the scanner's words in English
 * and Spanish, and a page for the supervisors on count day. Each prints, and each
 * comes as Word to edit.
 */
const SKILLS = {
  en: [
    ['Signs on', 'Team card into Team number, then their badge — or one badge alone on a cycle count'],
    ['Follows Next bin', 'Scans the rack label of the spot in front of them, every time'],
    ['Rack · pallet · quantity', 'Types the cases that are really there, not what the label says'],
    ['Several pallets in a spot', 'Counts every one before moving on'],
    ['An empty spot', 'Bin is EMPTY, then Yes'],
    ['Two labels on one pallet', 'This pallet has more than one label, each label with its cases, Done'],
    ['A torn label', 'Label will not scan → types it on the scanner’s keys'],
    ['No label at all', 'Label will not scan → Nothing readable on it'],
    ['A pallet not on the list', 'Count it anyway? → YES'],
    ['A mistake', 'Back before the line is saved; History → Void after, and goes back to that bin'],
    ['A second count', 'Counts the spot blind; Bin done when there are fewer pallets than expected'],
    ['SOS or Report a problem', 'Knows which is which, and that SOS with no signal is not sent'],
    ['No Wi-Fi', 'Keeps counting; signs off only with nothing queued'],
    ['Finishing', 'Tells the supervisor; Sign off this scanner; scanner on the charger'],
  ],
  es: [
    ['Entra', 'Tarjeta del equipo en Número de equipo, luego su gafete — o un solo gafete en un conteo cíclico'],
    ['Sigue Siguiente ubicación', 'Escanea la etiqueta del rack del lugar que tiene enfrente, cada vez'],
    ['Rack · tarima · cantidad', 'Escribe las cajas que de verdad hay, no lo que dice la etiqueta'],
    ['Varias tarimas en un lugar', 'Cuenta cada una antes de seguir'],
    ['Un lugar vacío', 'Ubicación VACÍA, luego Sí'],
    ['Dos etiquetas en una tarima', 'Esta tarima tiene más de una etiqueta, cada etiqueta con sus cajas, Listo'],
    ['Una etiqueta rota', 'La etiqueta no escanea → la escribe con las teclas del escáner'],
    ['Sin etiqueta', 'La etiqueta no escanea → No se puede leer nada'],
    ['Una tarima que no está en la lista', '¿Contarla de todos modos? → SÍ'],
    ['Un error', 'Atrás antes de guardar; Historial → Anular después, y regresa a esa ubicación'],
    ['Un segundo conteo', 'Cuenta el lugar a ciegas; Ubicación terminada cuando hay menos tarimas de las esperadas'],
    ['SOS o Reportar un problema', 'Sabe cuál es cuál, y que un SOS sin señal no se manda'],
    ['Sin Wi-Fi', 'Sigue contando; sale solo cuando no queda nada en cola'],
    ['Terminar', 'Avisa al supervisor; Salir de este escáner; escáner al cargador'],
  ],
};
const CHECK_WORDS = {
  en: { title: 'Scanner check-off', name: 'Name', badge: 'Clock-in number', team: 'Team', date: 'Date', skill: 'Can do it on the wall', ok: 'Done', trainer: 'Trainer', sign: 'Signature',
    note: 'The trainer ticks each one as the person does it on the training wall, on a real scanner. All ticked: trained — tick them on the Training roster too.' },
  es: { title: 'Revisión del escáner', name: 'Nombre', badge: 'Número de gafete', team: 'Equipo', date: 'Fecha', skill: 'Lo hace en la pared', ok: 'Hecho', trainer: 'Entrenador', sign: 'Firma',
    note: 'El entrenador marca cada una cuando la persona la hace en la pared de entrenamiento, con un escáner real. Todas marcadas: entrenado — márcalo también en la lista de entrenamiento.' },
};

/** One check-off per person: from the roster (the not-yet-trained first), or blank ones to fill in. */
export function checkoffPeople({ who = 'blank', count = 4 } = {}) {
  if (who === 'roster') {
    const rows = trainingRoster().rows.filter((r) => !r.trained);
    if (rows.length) return rows.map((r) => ({ name: r.name, badge: r.badge, team: r.team }));
  }
  return Array.from({ length: Math.max(1, Math.min(200, Number(count) || 4)) }, () => ({ name: '', badge: '', team: '' }));
}

export function checkoffSheet({ lang = 'en', who = 'blank', count = 4 } = {}) {
  const es = lang === 'es';
  const W = CHECK_WORDS[es ? 'es' : 'en'];
  const people = checkoffPeople({ who, count });
  const one = (p) => `
    <div class="co">
      <div class="h"><b>${esc(W.title)}</b><span>Full Harvest Inventory</span></div>
      <table class="who"><tr><td>${esc(W.name)}: <b>${esc(p.name)}</b></td><td>${esc(W.badge)}: <b>${esc(p.badge)}</b></td><td>${esc(W.team)}: <b>${esc(p.team)}</b></td><td>${esc(W.date)}:</td></tr></table>
      <table class="sk"><tr><th></th><th>${esc(W.skill)}</th><th class="ok">${esc(W.ok)}</th></tr>
      ${SKILLS[es ? 'es' : 'en'].map(([a, b], i) => `<tr><td class="n">${i + 1}</td><td><b>${esc(a)}</b> — ${esc(b)}</td><td class="ok">☐</td></tr>`).join('')}</table>
      <div class="foot"><span>${esc(W.trainer)}: ____________________</span><span>${esc(W.sign)}: ____________________</span></div>
      <div class="note">${esc(W.note)}</div>
    </div>`;
  return `<!doctype html><html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><title>${esc(W.title)}</title><style>
  @page { size: letter portrait; margin: 9mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; margin: 0; padding: 6px; font-size: 9pt; }
  .co { border: 1.5px dashed #777; border-radius: 8px; padding: 3.5mm 5mm 3mm; margin-bottom: 4mm; break-inside: avoid; page-break-inside: avoid; height: 126mm; box-sizing: border-box; overflow: hidden; }
  .h { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1e4f8f; padding-bottom: 1mm; margin-bottom: 2mm; }
  .h b { font-size: 13pt; } .h span { color: #666; font-size: 8pt; }
  table { width: 100%; border-collapse: collapse; }
  .who td { padding: 1mm 0; font-size: 9pt; }
  .sk th { text-align: left; font-size: 7.5pt; letter-spacing: .06em; text-transform: uppercase; color: #444; border-bottom: 1px solid #999; padding: 1mm; }
  .sk td { border-bottom: 1px solid #ddd; padding: .45mm 1mm; vertical-align: top; line-height: 1.15; font-size: 8.4pt; }
  .sk .n { width: 5mm; color: #666; } .sk .ok { width: 12mm; text-align: center; font-size: 11pt; line-height: 1; }
  .foot { display: flex; justify-content: space-between; margin-top: 2.5mm; font-size: 9pt; }
  .note { color: #555; font-size: 7.5pt; margin-top: 2mm; font-style: italic; }
  .noprint { margin-bottom: 8px; padding: 6px 12px; } @media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body><button class="noprint" onclick="window.print()">Print</button>
${people.map(one).join('')}
</body></html>`;
}

export function checkoffDocx({ lang = 'en', who = 'blank', count = 4 } = {}) {
  const es = lang === 'es';
  const W = CHECK_WORDS[es ? 'es' : 'en'];
  const d = new Docx({ margin: 720 });
  const TW = 12240 - 2 * 720;
  checkoffPeople({ who, count }).forEach((p, i) => {
    if (i && i % 2 === 0) d.pageBreak();
    d.paragraph([{ text: W.title, bold: true, size: 26 }, { text: '   Full Harvest Inventory', size: 16, color: '666666' }], { before: i % 2 ? 240 : 0, after: 60 });
    d.paragraph([{ text: `${W.name}: ${p.name || '____________________'}    ${W.badge}: ${p.badge || '________'}    ${W.team}: ${p.team || '________'}    ${W.date}: ________`, size: 18 }], { after: 80 });
    const rows = [['', W.skill, W.ok]].concat(SKILLS[es ? 'es' : 'en'].map(([a, b], k) => [String(k + 1), `${a} — ${b}`, '☐']));
    d.table(rows.map((r, k) => r.map((t, c) => [d.paragraphXml([{ text: t, size: c === 2 && k ? 24 : 17, bold: !k }], { after: 0, align: c === 2 ? 'center' : 'left' })])), { widths: [400, TW - 1300, 900], border: 'single', borderColor: 'BBBBBB', cellMargin: 50, headerShade: 'EEEEEE' });
    d.paragraph([{ text: `${W.trainer}: ____________________      ${W.sign}: ____________________`, size: 18 }], { before: 120, after: 40 });
    d.paragraph([{ text: W.note, size: 15, italic: true, color: '555555' }], { after: 0 });
  });
  return d.build({ title: W.title });
}

/* ---- the quiz: what do you do when ... ---- */
const QUIZ = {
  en: { title: 'Scanner quiz', sub: 'Circle one answer. Then the trainer goes through the answers with the group.', key: 'Answers', name: 'Name', qs: [
    ['The label says 48 cases. You count 45. What do you type?', ['48', '45', 'Nothing — tell the office'], 1],
    ['There is nothing at all in the spot. What do you do?', ['Walk past it', 'Scan the rack label, Bin is EMPTY, Yes', 'Scan the next spot’s label'], 1],
    ['The pallet label is torn but you can read the number.', ['Skip the pallet', 'Label will not scan → I can read it — let me type it', 'Count it under the pallet next to it'], 1],
    ['A pallet has two labels on it.', ['Count one label and add both quantities', 'This pallet has more than one label — each label with its own cases', 'Count it twice'], 1],
    ['The scanner asks “Count it anyway?” for a pallet not on the list.', ['YES, and count it', 'NO, it is not ours', 'Take the label off'], 0],
    ['The top of the screen says OFFLINE.', ['Stop and wait for Wi-Fi', 'Keep counting — it sends when the signal is back', 'Sign off'], 1],
    ['You saved a line with the wrong number.', ['History → Void this line, then count that bin again', 'Count the next spot twice', 'Tell nobody'], 0],
    ['Someone is hurt in the aisle.', ['Report a problem', 'SOS — I need help, and get help', 'Finish the aisle first'], 1],
    ['Every spot in your aisle has a count.', ['Tap a button to finish the aisle', 'Tell your supervisor — they mark it done', 'Start the next aisle on your own'], 1],
    ['A second count asks you to count a spot again. What were the first count’s numbers?', ['You are told them', 'You are not told — count what is there', 'Ask the other team'], 1],
  ] },
  es: { title: 'Prueba del escáner', sub: 'Encierra una respuesta. Luego el entrenador repasa las respuestas con el grupo.', key: 'Respuestas', name: 'Nombre', qs: [
    ['La etiqueta dice 48 cajas. Cuentas 45. ¿Qué escribes?', ['48', '45', 'Nada — avisar a la oficina'], 1],
    ['No hay nada en el lugar. ¿Qué haces?', ['Pasar de largo', 'Escanear el rack, Ubicación VACÍA, Sí', 'Escanear la etiqueta del siguiente lugar'], 1],
    ['La etiqueta de la tarima está rota pero puedes leer el número.', ['Saltar la tarima', 'La etiqueta no escanea → La puedo leer — la escribo', 'Contarla con la tarima de al lado'], 1],
    ['Una tarima tiene dos etiquetas.', ['Contar una etiqueta y sumar las dos cantidades', 'Esta tarima tiene más de una etiqueta — cada etiqueta con sus cajas', 'Contarla dos veces'], 1],
    ['El escáner pregunta “¿Contarla de todos modos?” por una tarima que no está en la lista.', ['SÍ, y contarla', 'NO, no es nuestra', 'Quitar la etiqueta'], 0],
    ['Arriba de la pantalla dice SIN SEÑAL.', ['Parar y esperar el Wi-Fi', 'Seguir contando — se manda cuando regresa la señal', 'Salir'], 1],
    ['Guardaste una línea con el número equivocado.', ['Historial → Anular esta línea, y volver a contar esa ubicación', 'Contar dos veces el siguiente lugar', 'No decir nada'], 0],
    ['Alguien está lastimado en el pasillo.', ['Reportar un problema', 'SOS — necesito ayuda, y buscar ayuda', 'Terminar el pasillo primero'], 1],
    ['Cada lugar de tu pasillo tiene un conteo.', ['Tocar un botón para terminar el pasillo', 'Avisar a tu supervisor — él lo marca terminado', 'Empezar el siguiente pasillo solo'], 1],
    ['Un segundo conteo te pide volver a contar un lugar. ¿Cuáles eran los números del primer conteo?', ['Te los dicen', 'No te los dicen — cuenta lo que hay', 'Preguntar al otro equipo'], 1],
  ] },
};

export function quizSheet({ lang = 'en' } = {}) {
  const Q = QUIZ[lang === 'es' ? 'es' : 'en'];
  const letters = ['A', 'B', 'C'];
  return `<!doctype html><html lang="${lang === 'es' ? 'es' : 'en'}"><head><meta charset="utf-8"><title>${esc(Q.title)}</title><style>
  @page { size: letter portrait; margin: 13mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; margin: 0; padding: 6px; font-size: 10.3pt; line-height: 1.3; }
  h1 { font-size: 17pt; margin: 0 0 1mm; } .sub { color: #444; margin-bottom: 2mm; } .nm { margin-bottom: 3.5mm; }
  ol { padding-left: 6mm; margin: 0; } li { margin-bottom: 2.2mm; break-inside: avoid; } li b { display: block; margin-bottom: .6mm; }
  .opt { display: block; margin-left: 2mm; } .key { page-break-before: always; break-before: page; }
  .key table { border-collapse: collapse; width: 100%; } .key td { border-bottom: 1px solid #ccc; padding: 2mm; vertical-align: top; }
  .noprint { margin-bottom: 8px; padding: 6px 12px; } @media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body><button class="noprint" onclick="window.print()">Print</button>
<h1>${esc(Q.title)}</h1><div class="sub">${esc(Q.sub)}</div><div class="nm">${esc(Q.name)}: ______________________________</div>
<ol>${Q.qs.map(([q, opts]) => `<li><b>${esc(q)}</b>${opts.map((o, i) => `<span class="opt">${letters[i]}. ${esc(o)}</span>`).join('')}</li>`).join('')}</ol>
<div class="key"><h1>${esc(Q.title)} — ${esc(Q.key)}</h1><table>${Q.qs.map(([q, opts, a], i) => `<tr><td>${i + 1}</td><td>${esc(q)}</td><td><b>${letters[a]}. ${esc(opts[a])}</b></td></tr>`).join('')}</table></div>
</body></html>`;
}

export function quizDocx({ lang = 'en' } = {}) {
  const Q = QUIZ[lang === 'es' ? 'es' : 'en'];
  const letters = ['A', 'B', 'C'];
  const d = new Docx({ margin: 900 });
  d.paragraph([{ text: Q.title, bold: true, size: 36 }], { after: 40 });
  d.paragraph([{ text: Q.sub, size: 20, color: '444444' }], { after: 80 });
  d.paragraph([{ text: `${Q.name}: ______________________________`, size: 20 }], { after: 200 });
  const list = d.newList();
  for (const [q, opts] of Q.qs) {
    d.paragraph([{ text: q, bold: true, size: 21 }], { numbered: list, after: 40, keepNext: true });
    for (const [i, o] of opts.entries()) d.paragraph([{ text: `${letters[i]}. ${o}`, size: 20 }], { after: 20 });
    d.paragraph('', { after: 80 });
  }
  d.paragraph([{ text: `${Q.title} — ${Q.key}`, bold: true, size: 30 }], { pageBreakBefore: true, after: 120 });
  const W = 12240 - 2 * 900;
  d.table(Q.qs.map(([q, opts, a], i) => [String(i + 1), q, `${letters[a]}. ${opts[a]}`].map((t, c) => [d.paragraphXml([{ text: t, size: 19, bold: c === 2 }], { after: 0 })])), { widths: [500, W - 3700, 3200], border: 'single', borderColor: 'CCCCCC', cellMargin: 70 });
  return d.build({ title: Q.title });
}

/* ---- the scanner's words, English and Spanish ---- */
const WORDS = [
  ['Rack label / Bin', 'Etiqueta del rack / Ubicación', 'The yellow label on the beam under the spot. Scanned first, every spot.'],
  ['Pallet label', 'Etiqueta de la tarima', 'The barcode on the pallet. Scanned second.'],
  ['Quantity', 'Cantidad', 'The cases that are really there. Typed on the keys, never scanned.'],
  ['Aisle · level · position', 'Pasillo · nivel · posición', 'F01A003: aisle F01, level A, position 003.'],
  ['Team card · Team number', 'Tarjeta del equipo · Número de equipo', 'Scanned into Team number at sign-on.'],
  ['Badge · Clock In Numbers', 'Gafete · Números de gafete', 'Everyone on the crew scans theirs.'],
  ['Sign on & load list', 'Entrar y cargar la lista', 'Starts the count on this scanner.'],
  ['My aisle', 'Mi pasillo', 'Your aisle and levels, and second counts when there are some.'],
  ['Next bin', 'Siguiente ubicación', 'Where to go next. Follow it.'],
  ['Still in this bin', 'Sigues en esta ubicación', 'More pallets expected in this spot.'],
  ['Bin is EMPTY', 'Ubicación VACÍA', 'Nothing in the spot.'],
  ['Several empty bins in a row', 'Varias ubicaciones vacías seguidas', 'A run of empty spots in one go.'],
  ['This pallet has more than one label', 'Esta tarima tiene más de una etiqueta', 'Two loads on one pallet, each with its cases.'],
  ['Label will not scan', 'La etiqueta no escanea', 'Torn, iced or faded: type it, or count it with no label.'],
  ['Count it anyway?', '¿Contarla de todos modos?', 'A pallet not on the list: YES.'],
  ['Back · History · Void this line', 'Atrás · Historial · Anular esta línea', 'Fixing a mistake.'],
  ['Second count', 'Segundo conteo', 'A spot counted again, blind, by another team.'],
  ['Bin done — nothing more here', 'Ubicación terminada — no hay más aquí', 'The spot is finished.'],
  ['Cycle count', 'Conteo cíclico', 'One person, a short list of bins for the day.'],
  ['OFFLINE', 'SIN SEÑAL', 'No Wi-Fi. Keep counting: nothing is lost.'],
  ['Report a problem', 'Reportar un problema', 'Damage or a blocked spot. Not an emergency.'],
  ['SOS — I need help', 'SOS — necesito ayuda', 'An emergency. The office is told at once.'],
  ['Got it', 'Entendido', 'You read the office’s message.'],
  ['Sign off this scanner', 'Salir de este escáner', 'Break or end of shift. Then the charger.'],
];
export function glossarySheet() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scanner words — English and Spanish</title><style>
  @page { size: letter portrait; margin: 11mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; margin: 0; padding: 6px; font-size: 10pt; }
  h1 { font-size: 17pt; margin: 0 0 1mm; } .sub { color: #444; margin-bottom: 3mm; }
  table { width: 100%; border-collapse: collapse; } th { text-align: left; background: #1e4f8f; color: #fff; font-size: 8.5pt; padding: 1.8mm 2mm; letter-spacing: .05em; text-transform: uppercase; }
  td { border-bottom: 1px solid #ddd; padding: 1.1mm 2mm; vertical-align: top; line-height: 1.25; } td.en, td.es { font-weight: 700; width: 30%; } td.es { color: #1e4f8f; }
  tr:nth-child(even) td { background: #f6f8fb; }
  .noprint { margin-bottom: 8px; padding: 6px 12px; } @media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body><button class="noprint" onclick="window.print()">Print</button>
<h1>Scanner words — English and Spanish · Palabras del escáner</h1><div class="sub">What the scanner says, in both languages. The Español / English button at the top of the scanner switches every screen.</div>
<table><tr><th>English</th><th>Español</th><th>What it means</th></tr>${WORDS.map(([en, es, w]) => `<tr><td class="en">${esc(en)}</td><td class="es">${esc(es)}</td><td>${esc(w)}</td></tr>`).join('')}</table>
</body></html>`;
}
export function glossaryDocx() {
  const d = new Docx({ margin: 720 });
  const W = 12240 - 2 * 720;
  d.paragraph([{ text: 'Scanner words — English and Spanish · Palabras del escáner', bold: true, size: 32 }], { after: 60 });
  d.paragraph([{ text: 'What the scanner says, in both languages. The Español / English button at the top of the scanner switches every screen.', size: 19, color: '444444' }], { after: 160 });
  d.table([['English', 'Español', 'What it means'], ...WORDS].map((r, i) => r.map((t, c) => [d.paragraphXml([{ text: t, size: 18, bold: !i || c < 2, color: i && c === 1 ? '1E4F8F' : undefined }], { after: 0 })])), { widths: [3000, 3200, W - 6200], border: 'single', borderColor: 'CCCCCC', cellMargin: 60, headerShade: 'DCE6F2' });
  return d.build({ title: 'Scanner words' });
}
