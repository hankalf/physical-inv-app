import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, norm, getSession, createSession, createDevice, listDevices, sandboxOf } from '../db.js';
import { refreshAdjustments } from './adjustments.js';
import { exportEverything, when } from './export-all.js';
import { scannerPrompts, scannerLayout } from './scanner-prompts.js';
import { sosReasons } from './alerts.js';
import { importMaster } from './master.js';
import { parseRecords, pick } from '../util/csv.js';
import { queueAssignments } from './assignments.js';
import { importMoves } from './moves.js';
import { importMissing, practiceMissingRows, clearPracticeMissing } from './missing.js';
import { allowed } from './access.js';

/*
 * The practice count behind the Testing tab.
 *
 * Inventory staff need somewhere to try the gun that is not the count the
 * warehouse is actually running: a scan into a live session is a real line on a
 * real report. So the Testing tab gets a count of its own - two short aisles of
 * the real Front Royal racking, with a report laid over them - and a scanner of
 * its own for each supervisor, and neither shows up anywhere a counter on the
 * floor would pick them by mistake:
 *
 *   - a gun lists practice counts only when it was opened as a practice gun,
 *     and a practice gun lists nothing else;
 *   - the office board never falls back to one;
 *   - the dashboards list it last, so it is never the count a page opens on.
 *
 * The shelves are written down twice on purpose. The REPORT is what the system
 * thinks is there; the SHELF is what a counter would actually find. Where they
 * differ is where the app earns its keep - a short pallet, a pallet in the next
 * bay, one the report never heard of, one that has gone - so each difference is
 * a thing to try, with what to do written next to it.
 */

export const PRACTICE_NAME = 'Practice count';
export const PRACTICE_TEAM = '99';
export const PRACTICE_CREW = ['T1001', 'T1002'];

const ITEMS = {
  straw: ['SKU-8840', 'Strawberry sliced IQF', 'CS30LB'],
  blue: ['SKU-8810', 'Blueberry wild IQF', 'CS30LB'],
  mango: ['SKU-8710', 'Mango chunks IQF', 'C10KG'],
  peach: ['SKU-8720', 'Peach slices IQF', 'CS'],
  rasp: ['SKU-8850', 'Raspberry whole IQF', 'CS'],
  pine: ['SKU-8730', 'Pineapple tidbits IQF', 'C10KG'],
  cherry: ['SKU-8860', 'Dark sweet cherries pitted IQF', 'CS30LB'],
  black: ['SKU-8870', 'Blackberry whole IQF', 'CS30LB'],
  mixed: ['SKU-8880', 'Mixed berries IQF', 'CS40LB'],
  banana: ['SKU-8740', 'Banana slices IQF', 'CS40LB'],
};

/*
 * One row per bin, in the order a team walks them.
 *
 *   shelf    what is physically there: [palletId, qty, item, lot, days-to-best-before]
 *   report   what the report says, when that is not simply the shelf
 *   try      what this bin is here to teach, in the words of the sheet
 *   check    the name of the thing-to-try it proves, for the checklist
 */
const P = (id, qty, item, lot, days) => ({ id, qty, item, lot, days });
const BINS = [
  { bin: 'F01A001', shelf: [P('F12311-111', 40, 'straw', 'F12311', 140)],
    try: 'A plain one: pallet, quantity, bin.', check: 'first' },
  { bin: 'F01A002', shelf: [P('F12312-111', 32, 'blue', 'F12312', 210), P('F12312-112', 28, 'blue', 'F12312', 210)],
    try: 'Two pallets in one bin — count both, then scan the bin for each.', check: 'two' },
  { bin: 'F01A003', shelf: [],
    try: 'Nothing here. On the pallet step tap “Bin is EMPTY — scan the bin”, then scan the bin.', check: 'empty' },
  { bin: 'F01A004', shelf: [P('F12313-111', 32, 'mango', 'F12313', 95)], report: [P('F12313-111', 36, 'mango', 'F12313', 95)],
    try: 'The report says 36. There are 32 — type what you see.', check: 'short' },
  { bin: 'F01A005', shelf: [P('F12314-111', 30, 'peach', 'F12314', 260)], report: [],
    try: 'The report has this pallet in F01A006. It is here — the gun will say so; accept it.', check: 'moved' },
  { bin: 'F01A006', shelf: [P('F19999-999', 20, 'rasp', 'F19999', 300)], report: [P('F12314-111', 30, 'peach', 'F12314', 260)],
    try: 'F19999-999 is not on the report. The gun asks “Count it anyway?” — tap YES.', check: 'unlisted' },
  { bin: 'F01B001', shelf: [P('F12315-111', 44, 'pine', 'F12315', 180)], noScan: 'pallet',
    try: 'The pallet label is torn. Tap “Label will not scan”, then type the ID.', check: 'label' },
  { bin: 'F01B002', shelf: [P('F12316-111', 36, 'cherry', 'F12316', -20)],
    try: 'Best before has passed. Count it as normal — it shows as expired on the dashboard.' },
  { bin: 'F01B003', shelf: [P('F12317-111', 40, 'black', 'F12317', 150)], noScan: 'bin',
    try: 'The rack label is missing. At the bin step tap “Bin label will not scan”. If the gun offers “It is F01B003”, take it; if it guesses another bin, tap “I can read it — let me type it” and click F01B003 here.',
    check: 'binLabel' },
  { bin: 'F01B004', shelf: [P('F12318-111', 24, 'mixed', 'F12318', 120), P('F12318-112', 24, 'mixed', 'F12318', 120), P('F12318-113', 26, 'mixed', 'F12318', 120)],
    try: 'Three pallets in one bin.' },
  { bin: 'F01B005', shelf: [P('F12319-111', 36, 'banana', 'F12319', 330)] },
  { bin: 'F01B006', shelf: [], report: [P('F12321-111', 40, 'straw', 'F12321', 160)],
    try: 'The report says F12321-111 is here. It is not — record the bin empty. It shows as missing.', check: 'missing' },

  { bin: 'F02A001', shelf: [P('F23411-111', 40, 'straw', 'F23411', 130)],
    try: 'A new aisle: finish F01 first with “Aisle complete — next aisle”.', check: 'nextAisle' },
  { bin: 'F02A002', shelf: [P('F23412-111', 30, 'peach', 'F23412', 240)] },
  { bin: 'F02A003', shelf: [P('F23413-111', 32, 'blue', 'F23413', 200)],
    try: 'Once counted, scan F23413-111 again — the gun warns it is already counted.' },
  { bin: 'F02A004', shelf: [P('F23414-111', 28, 'mango', 'F23414', 70), P('F23414-112', 28, 'mango', 'F23414', 70)] },
  { bin: 'F02A005', shelf: [P('F23415-111', 44, 'pine', 'F23415', 190)] },
  { bin: 'F02A006', shelf: [P('F23416-111', 36, 'cherry', 'F23416', 110)] },
  { bin: 'F02B001', shelf: [P('F23417-111', 1200, 'rasp', 'F23417', 280)],
    try: 'A big quantity: over the site’s limit, the gun asks you to key 1200 a second time.' },
  { bin: 'F02B002', shelf: [P('F23418-111', 24, 'mixed', 'F23418', 125)] },
  { bin: 'F02B003', shelf: [P('F23419-111', 40, 'black', 'F23419', 155)] },
  { bin: 'F02B004', shelf: [P('F23421-111', 32, 'banana', 'F23421', 320)] },
  { bin: 'F02B005', shelf: [] },
  { bin: 'F02B006', shelf: [P('F23422-111', 40, 'straw', 'F23422', 145)],
    try: 'Last bin — then “Aisle complete”, and look at the dashboard.' },
];

/* What the sheet's checklist ticks off, and how a count proves each one. */
const CHECKS = [
  ['signon', 'Sign on with team 99 and a clock-in number'],
  ['first', 'Count a pallet: pallet, quantity, bin'],
  ['two', 'Count a bin that holds two pallets'],
  ['empty', 'Record an empty bin'],
  ['short', 'Count a pallet short of the report'],
  ['moved', 'Count a pallet found in the wrong bin'],
  ['unlisted', 'Count a pallet that is not on the report'],
  ['label', 'Count a pallet whose label will not scan'],
  ['binLabel', 'Count at a bin whose rack label will not scan'],
  ['missing', 'Find a pallet missing from its bin'],
  ['nextAisle', 'Finish aisle F01 and move to the next'],
  ['sos', 'Send an SOS (and see it on the dashboard)'],
];

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
/* Dates the way the site's systems write them: MM/DD/YYYY. */
export const usDate = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : (iso || ''));
const now = () => new Date().toISOString();

// the practice count's own 24 bins - not the site's bin list, which a site uploads for itself
const TEMPLATE = fileURLToPath(new URL('./practice-bins.csv', import.meta.url));

/** The practice count's bin list: the rows for the bins it uses, shipped with the app. */
function binCsv(codes = BINS.map((b) => b.bin)) {
  const want = new Set(codes);
  let rows = [];
  try {
    rows = readFileSync(TEMPLATE, 'utf8').split(/\r?\n/).filter((l) => want.has(l.split(',')[0]));
  } catch { /* fall back to plain rows below */ }
  const have = new Set(rows.map((l) => l.split(',')[0]));
  // a bin that is not Front Royal racking: its aisle is worked out from the code on import
  for (const c of codes) if (!have.has(c)) rows.push(`${c},,,"Practice bin ${c}"`);
  return 'Bin Location,Zone,Aisle,Description\n' + rows.join('\n') + '\n';
}

/* The report in the site's own layout - the columns its systems export - with
   an OPEN row for each empty position, as the real file has. */
const SYSTEM_OF = (lot) => (['JustFood', 'SGI', 'NTFF'][Number(lot.slice(-1)) % 3]);
function reportCsv() {
  let csv = 'Bin Code,Container No.,Item No.,Description,Variant Code,Quantity,Unit of Measure Code,Entry No.,Lot No.,System,Best Before\n';
  let entry = 2517386;
  for (const b of BINS) {
    const rows = b.report || b.shelf;
    if (!rows.length) { csv += `${b.bin},,,,,,,,,OPEN,\n`; continue; }
    for (const p of rows) {
      const [sku, desc, uom] = ITEMS[p.item];
      csv += `${b.bin},${p.id},${sku},"${desc}",,${p.qty},${uom},${entry++},${p.lot},${SYSTEM_OF(p.lot)},${usDate(day(p.days))}\n`;
    }
  }
  return csv;
}

/*
 * Whose practice it is. Each login has its own practice count, so two people
 * learning at once never see each other's lines, and a new person starts on a
 * clean one. A site still on the shared password is told apart by the name
 * typed at sign-in.
 */
export const ownerOf = (who) => (who && who.username ? `user:${String(who.username).toLowerCase()}`
  : `name:${String((who && who.name) || 'supervisor').trim().toLowerCase()}`);

const HISTORY_KEEP = 10;             // earlier runs kept per person

export const practiceSession = (owner) =>
  db.prepare("SELECT * FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'open' AND COALESCE(mode, 'full') = 'full' ORDER BY id DESC LIMIT 1").get(owner) || null;
/* The cycle count beside the run, when the person has asked to practise one. */
const cycleSession = (owner) =>
  db.prepare("SELECT * FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'open' AND mode = 'cycle' ORDER BY id DESC LIMIT 1").get(owner) || null;

/** Build a practice count from nothing: bins, report, and the team's two aisles. */
/* A practice count starts with the comments step held for five seconds, so a
   person learning the gun has time to read it before it moves on. */
const SANDBOX_START = JSON.stringify({ prompts: { commentTimeout: 5 }, layout: {}, sosReasons: null });

function buildPractice(owner) {
  const s = createSession({ name: PRACTICE_NAME, mode: 'full', palletMode: 'warn', guided: 1, askComments: 1 });
  db.prepare('UPDATE sessions SET practice = 1, practice_owner = ?, sandbox = ?, auto_recount = 0 WHERE id = ?').run(owner, SANDBOX_START, s.id);
  importMaster(s.id, 'bins', binCsv());
  importMaster(s.id, 'pallets', reportCsv());
  queueAssignments(s.id, PRACTICE_TEAM, ['F01', 'F02'], 'A-F', { force: true });
  return getSession(s.id);
}

export function ensurePractice(owner) {
  return practiceSession(owner) || buildPractice(owner);
}

/* ------------------------------------------------- a person's own test data
   The same sheet as the barcode test book - Bin, Pallet, Qty, and a Note - so
   the book that was printed and the data the gun is tested with can be one and
   the same file. Lot and best-before are read if they are there. A row with a
   bin and no pallet is an empty bin. */
const COL = {
  bin: ['bin', 'bin location', 'location', 'bin code', 'rack'],
  pallet: ['pallet', 'pallet id', 'pallet number', 'container no', 'container', 'lpn', 'tag', 'license plate'],
  qty: ['qty', 'quantity', 'count', 'cases'],
  lot: ['lot', 'lot code', 'lot no', 'batch'],
  bestBefore: ['best before', 'expiry', 'expiration', 'expiry date', 'bbd'],
  item: ['item', 'sku', 'item no', 'item number', 'product'],
  note: ['note', 'description', 'desc'],
  uom: ['uom', 'unit', 'unit of measure', 'unit of measure code', 'case'],
};
const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Read and check the file. Throws with the row number for anything a person has to fix. */
export function readPracticeFile(text) {
  const { records } = parseRecords(String(text || ''));
  if (!records.length) throw Object.assign(new Error('no rows found - the first row should be the headings: Bin, Pallet, Qty'), { status: 400 });
  if (records.length > 2000) throw Object.assign(new Error(`${records.length} rows - keep a practice file to 2,000 rows or fewer`), { status: 400 });
  const rows = [];
  const seen = new Map();
  records.forEach((r, i) => {
    const line = i + 2;                    // the heading is row 1
    const bin = norm(pick(r, COL.bin));
    const pallet = norm(pick(r, COL.pallet));
    const rawQty = pick(r, COL.qty);
    if (!bin && !pallet) return;           // a blank line
    if (!bin) throw Object.assign(new Error(`row ${line}: pallet ${pallet} has no bin`), { status: 400 });
    if (pallet) {
      const qty = Number(String(rawQty).replace(/[\s,]/g, ''));
      if (rawQty === '' || !Number.isFinite(qty) || qty < 0) throw Object.assign(new Error(`row ${line}: "${rawQty}" is not a quantity for pallet ${pallet}`), { status: 400 });
      if (seen.has(pallet)) throw Object.assign(new Error(`row ${line}: pallet ${pallet} is already on row ${seen.get(pallet)}`), { status: 400 });
      seen.set(pallet, line);
      rows.push({ bin, pallet, qty, lot: pick(r, COL.lot), bestBefore: pick(r, COL.bestBefore), item: pick(r, COL.item), note: pick(r, COL.note), uom: pick(r, COL.uom) });
    } else {
      rows.push({ bin, pallet: '', qty: 0 });
    }
  });
  if (!rows.some((r) => r.pallet)) throw Object.assign(new Error('no pallets found - check the Pallet column'), { status: 400 });
  return rows;
}

function buildFromRows(owner, rows, label) {
  const s = createSession({ name: `${PRACTICE_NAME} — ${label}`.slice(0, 80), mode: 'full', palletMode: 'warn', guided: 1, askComments: 1 });
  db.prepare("UPDATE sessions SET practice = 1, practice_owner = ?, practice_source = 'upload', practice_rows = ?, sandbox = ?, auto_recount = 0 WHERE id = ?")
    .run(owner, JSON.stringify({ label, rows }), SANDBOX_START, s.id);
  importMaster(s.id, 'bins', binCsv([...new Set(rows.map((r) => r.bin))]));
  let report = 'Pallet ID,SKU,Description,UOM,Qty,Location,Lot Code,Best Before\n';
  for (const r of rows.filter((x) => x.pallet)) {
    report += [r.pallet, r.item || '', r.note || '', r.uom || '', r.qty, r.bin, r.lot || '', r.bestBefore || ''].map(csvCell).join(',') + '\n';
  }
  importMaster(s.id, 'pallets', report);
  const aisles = db.prepare('SELECT aisle FROM aisles WHERE session_id = ? ORDER BY aisle').all(s.id).map((a) => a.aisle);
  if (aisles.length) queueAssignments(s.id, PRACTICE_TEAM, aisles, 'A-Z', { force: true });
  return getSession(s.id);
}

/** A new practice run from the person's own file; the run they were on is kept. */
export function practiceFromFile(owner, text, label = 'your file') {
  const rows = readPracticeFile(text);
  closeRuns(owner);
  return buildFromRows(owner, rows, String(label || 'your file').replace(/\.(csv|xlsx?|xlsm|txt)$/i, '').slice(0, 40));
}

function closeRuns(owner) {
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE practice = 1 AND practice_owner = ? AND status = 'open'")
    .run(new Date().toISOString(), owner);
  // the practice cycle count goes with its run, and so does the planted Not in Location list
  for (const c of db.prepare("SELECT id FROM sessions WHERE practice = 1 AND practice_owner = ? AND mode = 'cycle'").all(owner)) db.prepare('DELETE FROM sessions WHERE id = ?').run(c.id);
  clearPracticeMissing(owner);
  const old = db.prepare("SELECT id FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'closed' AND COALESCE(mode, 'full') = 'full' ORDER BY id DESC")
    .all(owner).slice(HISTORY_KEEP);
  for (const s of old) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
}

/**
 * Start again. The run so far is closed and kept, so a person can look back at
 * what they have tried; only the oldest runs beyond the last ten are deleted.
 */
export function resetPractice(owner, { builtIn = false } = {}) {
  // starting over on your own file starts over on that file, unless you ask for the built-in data
  const cur = practiceSession(owner);
  let own = null;
  if (!builtIn && cur && cur.practice_source === 'upload') { try { own = JSON.parse(cur.practice_rows); } catch { own = null; } }
  closeRuns(owner);
  return own && Array.isArray(own.rows) ? buildFromRows(owner, own.rows, own.label || 'your file') : buildPractice(owner);
}

/** This person's earlier runs, newest first, with how far each one got. */
export function practiceHistory(owner) {
  return db.prepare("SELECT * FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'closed' AND COALESCE(mode, 'full') = 'full' ORDER BY id DESC")
    .all(owner).map((s) => {
      const sheet = practiceSheet(s.id);
      return {
        id: s.id, started: s.created_at, ended: s.closed_at,
        tried: sheet.checklist.filter((c) => c.done).length, of: sheet.checklist.length,
        lines: sheet.totals.lines, bins: sheet.totals.binsCounted,
      };
    });
}

/**
 * Everything this person did here, in one workbook: a sheet per run of what
 * was tried, and then every sheet the real "Export everything" gives a count,
 * for the current run and each earlier one. Nobody else's practice is in it.
 */
export function practiceExport(owner) {
  const cur = practiceSession(owner);
  const runs = [...(cur ? [cur] : []),
    ...db.prepare("SELECT * FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'closed' AND COALESCE(mode, 'full') = 'full' ORDER BY id DESC").all(owner)];
  const runRows = [];
  const tryRows = [];
  const sheets = [];
  for (const s of runs) {
    const sh = practiceSheet(s.id);
    const done = sh.checklist.filter((c) => c.done).length;
    runRows.push({
      'Run': `#${s.id}`, 'Status': s.status === 'closed' ? 'Earlier run' : 'Current run',
      'Started': when(s.created_at), 'Finished': when(s.closed_at),
      'Test data': sh.source === 'upload' ? `Your file: ${sh.label}` : 'Built in',
      'Things tried': `${done} of ${sh.checklist.length}`, 'Bins counted': sh.totals.binsCounted, 'Lines counted': sh.totals.lines,
    });
    for (const c of sh.checklist) tryRows.push({ 'Run': `#${s.id}`, 'Thing to try': c.label, 'Done': c.done ? 'Yes' : 'No' });
    for (const x of exportEverything(s.id).sheets) sheets.push({ ...x, name: `#${s.id} ${x.name}`.slice(0, 31) });
  }
  const who = String(owner).replace(/^(user|name):/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'me';
  return {
    filename: `practice-runs-${who}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    runs: runs.length,
    sheets: [
      { name: 'Runs', columns: ['Run', 'Status', 'Started', 'Finished', 'Test data', 'Things tried', 'Bins counted', 'Lines counted'], rows: runRows },
      { name: 'Things tried', columns: ['Run', 'Thing to try', 'Done'], rows: tryRows },
      ...sheets,
    ],
  };
}

/**
 * The scanner a supervisor tests with: one each, so two people trying the gun at
 * once do not sign each other's scanner out.
 */
export function practiceDevice(who) {
  const base = norm((who && (who.username || who.name)) || 'SUPERVISOR').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'SUPERVISOR';
  const name = `TEST-${base}`;
  const owner = ownerOf(who);
  const d = listDevices().find((x) => x.name === name) || createDevice({ name, notes: 'The Testing tab — counts into this person\'s practice count only' });
  if (d.practice_owner !== owner) db.prepare('UPDATE devices SET practice_owner = ? WHERE uid = ?').run(owner, d.uid);
  return { ...d, practice_owner: owner };
}

/**
 * The sheet beside the gun: every bin in walking order, what is on the shelf,
 * what the report says where that differs, and whether it has been counted yet.
 */
export function practiceSheet(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  const lines = db.prepare(
    `SELECT pallet_id, qty, location_code, empty_bin, label_issue, bin_label_issue, override_reason, team, scanned_at, lot, expiry
       FROM counts WHERE session_id = ? AND voided = 0 ORDER BY id`).all(id);
  const byPallet = new Map();
  const emptyBins = new Set();
  const countedBins = new Set();
  for (const l of lines) {
    countedBins.add(l.location_code);
    if (l.empty_bin) emptyBins.add(l.location_code);
    else byPallet.set(l.pallet_id, l);
  }
  const reportAt = new Map(db.prepare('SELECT pallet_id, expected_qty, expected_location FROM pallets WHERE session_id = ?')
    .all(id).map((p) => [p.pallet_id, p]));
  if (s && s.practice_source === 'upload') return uploadedSheet(s, lines, byPallet, emptyBins, countedBins);
  // a pallet put back in Move pallets is on a different shelf now
  const movedTo = new Map(db.prepare("SELECT pallet_id, actual_bin FROM moves WHERE session_id = ? AND status = 'done'").all(id).map((m) => [m.pallet_id, m.actual_bin]));

  const bins = BINS.map((b) => {
    const shelf = b.shelf.map((p) => {
      const [sku, desc, uom] = ITEMS[p.item];
      const rep = reportAt.get(p.id) || null;
      const got = byPallet.get(p.id) || null;
      const nowIn = movedTo.get(p.id) || '';
      return {
        id: p.id, qty: p.qty, sku, desc, uom, lot: p.lot, bestBefore: usDate(day(p.days)), expired: p.days < 0,
        report: rep ? { qty: rep.expected_qty, bin: rep.expected_location } : null,
        movedTo: nowIn,
        counted: got ? { qty: got.qty, bin: got.location_code, right: got.location_code === (nowIn || b.bin) && Number(got.qty) === p.qty } : null,
      };
    });
    /* on the report here and not on this shelf: gone, or sitting in another bay */
    const missing = (b.report || []).filter((r) => !b.shelf.some((p) => p.id === r.id))
      .map((r) => ({ id: r.id, qty: r.qty, foundIn: BINS.find((o) => o.shelf.some((p) => p.id === r.id))?.bin || '' }));
    return {
      bin: b.bin, aisle: b.bin.slice(0, 3), noScan: b.noScan || '', try: b.try || '',
      shelf, missing, counted: countedBins.has(b.bin), recordedEmpty: emptyBins.has(b.bin),
    };
  });

  const signedOn = !!db.prepare('SELECT 1 FROM signons WHERE session_id = ?').get(id);
  const done = new Set();
  if (signedOn) done.add('signon');
  const counted = (pid, bin) => { const l = byPallet.get(pid); return !!l && (!bin || l.location_code === bin); };
  if (lines.some((l) => !l.empty_bin)) done.add('first');
  if (counted('F12312-111', 'F01A002') && counted('F12312-112', 'F01A002')) done.add('two');
  if (emptyBins.has('F01A003')) done.add('empty');
  if (byPallet.get('F12313-111') && Number(byPallet.get('F12313-111').qty) < 36) done.add('short');
  if (counted('F12314-111', 'F01A005')) done.add('moved');
  if (counted('F19999-999')) done.add('unlisted');
  if (byPallet.get('F12315-111')?.label_issue) done.add('label');
  if (lines.some((l) => l.location_code === 'F01B003' && l.bin_label_issue)) done.add('binLabel');
  if (emptyBins.has('F01B006')) done.add('missing');
  if (db.prepare("SELECT 1 FROM assignments WHERE session_id = ? AND aisle = 'F01' AND status = 'done'").get(id)) done.add('nextAisle');
  if (db.prepare('SELECT 1 FROM alerts WHERE session_id = ?').get(id)) done.add('sos');

  const assignment = db.prepare(
    "SELECT aisle, status FROM assignments WHERE session_id = ? AND team = ? ORDER BY position").all(id, PRACTICE_TEAM);
  const pallets = bins.reduce((n, b) => n + b.shelf.length, 0);
  const feat = featureChecks(s, lines);
  return {
    source: 'built-in',
    extras: feat.counts,
    session: s ? { id: s.id, name: s.name, status: s.status, askLot: !!s.ask_lot, askExpiry: !!s.ask_expiry } : null,
    team: PRACTICE_TEAM,
    crew: PRACTICE_CREW,
    bins,
    assignment,
    checklist: [...CHECKS.map(([key, label]) => ({ key, label, done: done.has(key) })), ...feat.checks, ...(s ? modeChecks(s) : [])],
    totals: { bins: bins.length, binsCounted: bins.filter((b) => b.counted).length, pallets, lines: lines.length },
  };
}

/* The features that are switched on in this sandbox each add a thing to try,
   and the counts the tips need to know when to speak up. A practice count
   starts with every one of them off - second counts included, which real
   counts have on - so the first run is the plain count and each feature is
   something to switch on and try. */
function featureChecks(s, lines) {
  const id = s.id;
  const checks = [];
  if (s.require_approval) { try { refreshAdjustments(id); } catch { /* the count can still be read */ } }
  const counts = {
    pendingApprovals: s.require_approval ? db.prepare("SELECT COUNT(*) n FROM adjustments WHERE session_id = ? AND status = 'pending'").get(id).n : 0,
    openSecondCounts: db.prepare("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND status != 'done'").get(id).n,
  };
  if (s.ask_lot) checks.push({ key: 'lot', label: 'Count a pallet with its lot code (lot codes are on)', done: lines.some((l) => l.lot) });
  if (s.ask_expiry) checks.push({ key: 'expiry', label: 'Enter a best-before date (best-before is on)', done: lines.some((l) => l.expiry) });
  if (s.require_approval) {
    checks.push({ key: 'approve', label: 'Approve or reject an adjustment — Dashboard → Adjustments (approvals are on)',
      done: db.prepare("SELECT 1 FROM adjustments WHERE session_id = ? AND status IN ('approved', 'rejected')").get(id) != null });
  }
  if (s.auto_recount) {
    checks.push({ key: 'second', label: 'Do a second count the gun raised — My aisle → Start second counts',
      done: db.prepare("SELECT 1 FROM recounts WHERE session_id = ? AND status = 'done' AND source = 'auto'").get(id) != null });
  }
  return { checks, counts };
}

/* A run built from a person's own file: the shelf is the file, so there is
   nothing planted to find - the checklist is the plain work of a count. */
function uploadedSheet(s, lines, byPallet, emptyBins, countedBins) {
  const id = s.id;
  let label = 'your file';
  try { label = JSON.parse(s.practice_rows || '{}').label || label; } catch { /* keep the default */ }
  const locs = db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(id)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const pals = db.prepare('SELECT * FROM pallets WHERE session_id = ?').all(id);
  const at = new Map();
  for (const p of pals) { if (!at.has(p.expected_location)) at.set(p.expected_location, []); at.get(p.expected_location).push(p); }
  const bins = locs.map((l) => {
    const shelf = (at.get(l.code) || []).map((p) => {
      const got = byPallet.get(p.pallet_id) || null;
      return {
        id: p.pallet_id, qty: p.expected_qty, sku: p.sku || '', desc: p.description || '', uom: p.uom || '', lot: p.lot || '', bestBefore: usDate(p.expiry || ''),
        expired: !!p.expiry && p.expiry < new Date().toISOString().slice(0, 10),
        report: { qty: p.expected_qty, bin: p.expected_location },
        counted: got ? { qty: got.qty, bin: got.location_code, right: got.location_code === l.code && Number(got.qty) === Number(p.expected_qty) } : null,
      };
    });
    return {
      bin: l.code, aisle: l.aisle || l.code, noScan: '', try: shelf.length ? '' : 'Nothing here — record it empty.',
      shelf, missing: [], counted: countedBins.has(l.code), recordedEmpty: emptyBins.has(l.code),
    };
  });
  const allPallets = pals.length;
  const countedPallets = pals.filter((p) => byPallet.has(p.pallet_id)).length;
  const hasEmpty = bins.some((b) => !b.shelf.length);
  const checks = [
    ['signon', 'Sign on with team 99 and a clock-in number', !!db.prepare('SELECT 1 FROM signons WHERE session_id = ?').get(id)],
    ['first', 'Count a pallet: pallet, quantity, bin', lines.some((l) => !l.empty_bin)],
    ['every', `Count every pallet in your file (${countedPallets} of ${allPallets})`, allPallets > 0 && countedPallets === allPallets],
    ...(hasEmpty ? [['empty', 'Record the empty bins', bins.filter((b) => !b.shelf.length).every((b) => b.recordedEmpty)]] : []),
    ['nextAisle', 'Finish an aisle with “Aisle complete”', !!db.prepare("SELECT 1 FROM assignments WHERE session_id = ? AND status = 'done'").get(id)],
    ['sos', 'Send an SOS (and see it on the dashboard)', !!db.prepare('SELECT 1 FROM alerts WHERE session_id = ?').get(id)],
  ];
  return {
    source: 'upload',
    label,
    session: { id: s.id, name: s.name, status: s.status, askLot: !!s.ask_lot, askExpiry: !!s.ask_expiry },
    team: PRACTICE_TEAM,
    crew: PRACTICE_CREW,
    bins,
    assignment: db.prepare('SELECT aisle, status FROM assignments WHERE session_id = ? AND team = ? ORDER BY position').all(id, PRACTICE_TEAM),
    checklist: [...checks.map(([key, lbl, done]) => ({ key, label: lbl, done })), ...featureChecks(s, lines).checks],
    extras: featureChecks(s, lines).counts,
    totals: { bins: bins.length, binsCounted: bins.filter((b) => b.counted).length, pallets: allPallets, lines: lines.length },
  };
}

/**
 * What has to be true before the Testing tab is any use, each with what to do
 * about it. Most of it the tab does by itself; this is so nobody has to guess.
 */
export function practiceReadiness(who, sessionId, device) {
  const s = sessionId ? getSession(sessionId) : null;
  const n = (sql) => (s ? db.prepare(sql).get(s.id).n : 0);
  const bins = n('SELECT COUNT(*) n FROM locations WHERE session_id = ?');
  const pallets = n('SELECT COUNT(*) n FROM pallets WHERE session_id = ?');
  const aisles = n("SELECT COUNT(*) n FROM assignments WHERE session_id = ? AND status != 'done'")
    + n("SELECT COUNT(*) n FROM assignments WHERE session_id = ? AND status = 'done'");
  const dev = device ? db.prepare('SELECT * FROM devices WHERE uid = ?').get(device.uid) : null;
  return [
    { key: 'login', ok: true, label: `Signed in as ${(who && (who.username || who.name)) || 'you'} — your practice is kept under your login`, fix: '' },
    { key: 'data', ok: bins > 0 && pallets > 0,
      label: bins && pallets ? `Test data loaded — ${bins} bins, ${pallets} pallets${s && s.practice_source === 'upload' ? ' from your file' : ' (built in)'}` : 'Test data loaded',
      fix: bins && pallets ? '' : 'Use the built-in data, or upload a Bin / Pallet / Qty file below.' },
    { key: 'scanner', ok: !!dev, label: dev ? `Test scanner ${dev.name} registered` : 'Test scanner registered', fix: dev ? '' : 'Reload this page — the tab registers one for you.' },
    { key: 'linked', ok: !!(dev && dev.enrolled_at), label: dev && dev.enrolled_at ? 'Test scanner signed in' : 'Test scanner signed in',
      fix: dev && dev.enrolled_at ? '' : 'Wait for the gun on the left to load, or press Restart the gun.' },
    { key: 'plan', ok: aisles > 0, label: aisles ? `Team 99 has ${aisles} aisle${aisles === 1 ? '' : 's'} to count` : 'Team 99 has aisles to count',
      fix: aisles ? '' : 'Press Start over to rebuild the practice count.' },
  ];
}

/* ------------------------------------------- the features that ship turned off
   Each of these is a setting on a count. On a person's practice count they can
   be switched on freely - it changes nothing for anybody else - and each says
   what data it needs, whether the practice data has it, and how to add it. */
export function practiceOptions(sessionId) {
  const s = getSession(sessionId);
  if (!s) return null;
  const n = (sql) => db.prepare(sql).get(s.id).n;
  const pallets = n('SELECT COUNT(*) n FROM pallets WHERE session_id = ?');
  const lots = n("SELECT COUNT(*) n FROM pallets WHERE session_id = ? AND COALESCE(lot, '') != ''");
  const dates = n("SELECT COUNT(*) n FROM pallets WHERE session_id = ? AND COALESCE(expiry, '') != ''");
  const own = s.practice_source === 'upload';
  const need = (have, what, column) => (have
    ? { ok: true, text: `${have} of ${pallets} pallets have ${what}.` }
    : { ok: false, text: own
      ? `None of the pallets in your file have ${what}. Add a “${column}” column to the file and upload it again — or go back to the built-in data, which has them.`
      : `The practice data has no ${what}.` });
  return {
    values: {
      askLot: !!s.ask_lot, askExpiry: !!s.ask_expiry, requireApproval: !!s.require_approval,
      approvalMinQty: s.approval_min_qty || 0, approvalMinPct: s.approval_min_pct || 0,
      autoRecount: !!s.auto_recount, askComments: !!s.ask_comments, palletMode: s.pallet_mode || 'warn',
    },
    needs: {
      askLot: need(lots, 'a lot code', 'Lot'),
      askExpiry: need(dates, 'a best-before date', 'Best Before'),
      requireApproval: { ok: true, text: 'Count a pallet short or over, then approve or reject it under Dashboard → Adjustments.' },
    },
  };
}

const NUM = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));

/** Change the options on this person's practice count, and nothing else. */
export function setPracticeOptions(owner, body = {}) {
  const s = practiceSession(owner);
  if (!s) throw Object.assign(new Error('open the Testing tab first - there is no practice count yet'), { status: 404 });
  const flag = (k, col) => (body[k] === undefined ? s[col] : (body[k] ? 1 : 0));
  const mode = ['off', 'warn', 'strict'].includes(body.palletMode) ? body.palletMode : s.pallet_mode;
  db.prepare(`UPDATE sessions SET ask_lot = ?, ask_expiry = ?, require_approval = ?, approval_min_qty = ?, approval_min_pct = ?,
                auto_recount = ?, ask_comments = ?, pallet_mode = ? WHERE id = ? AND practice = 1 AND practice_owner = ?`)
    .run(flag('askLot', 'ask_lot'), flag('askExpiry', 'ask_expiry'), flag('requireApproval', 'require_approval'),
      body.approvalMinQty === undefined ? s.approval_min_qty : NUM(body.approvalMinQty, 1e6),
      body.approvalMinPct === undefined ? s.approval_min_pct : NUM(body.approvalMinPct, 100),
      flag('autoRecount', 'auto_recount'), flag('askComments', 'ask_comments'), mode, s.id, owner);
  return getSession(s.id);
}

/* ------------------------------------------------------------ the sandbox
   Everything the gun takes from the site - the one-tap reasons, the override
   reasons, how long the comments step waits, the screen settings, the SOS list
   - can be changed here for this person's practice count alone. The site's own
   settings never move. */
const cleanList = (v, max = 30) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/))
  .map((x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, max);

export function practiceSandbox(s) {
  const own = sandboxOf(s);
  const prompts = { ...scannerPrompts(), ...own.prompts };
  const layout = { ...scannerLayout(), ...own.layout };
  return {
    prompts, layout,
    sosReasons: own.sosReasons || sosReasons().reasons,
    site: { prompts: scannerPrompts(), layout: scannerLayout(), sosReasons: sosReasons().reasons },
    overridden: { prompts: Object.keys(own.prompts), layout: Object.keys(own.layout), sosReasons: !!own.sosReasons },
  };
}

export function setPracticeSandbox(owner, body = {}) {
  const s = practiceSession(owner);
  if (!s) throw Object.assign(new Error('open the Testing Suite first - there is no practice count yet'), { status: 404 });
  const own = sandboxOf(s);
  const p = { ...own.prompts };
  const l = { ...own.layout };
  if (body.prompts) {
    const b = body.prompts;
    if (b.commentTimeout !== undefined) p.commentTimeout = Math.max(0, Math.min(60, Number(b.commentTimeout) || 0));
    if (b.comments !== undefined) p.comments = cleanList(b.comments);
    if (b.overrides !== undefined) p.overrides = cleanList(b.overrides);
  }
  if (body.layout) {
    const b = body.layout;
    for (const k of ['showNextBin', 'vibrate', 'portrait', 'fullScreen', 'keepAwake', 'autoUpdate']) if (b[k] !== undefined) l[k] = !!b[k];
    if (b.textSize !== undefined) l.textSize = b.textSize === 'large' ? 'large' : 'normal';
    if (b.confirmOver !== undefined) l.confirmOver = Math.max(0, Math.min(1e6, Number(b.confirmOver) || 0));
    if (b.order !== undefined) {
      const order = cleanList(b.order, 3).map((x) => x.toLowerCase()).filter((x) => ['pallet', 'qty', 'bin'].includes(x));
      if (new Set(order).size === 3) l.order = order;
    }
  }
  let sos = own.sosReasons;
  if (body.sosReasons !== undefined) sos = body.sosReasons === null ? null : cleanList(body.sosReasons, 20);
  if (body.reset) { return resetSandbox(s.id); }
  db.prepare('UPDATE sessions SET sandbox = ?, master_version = master_version + 1 WHERE id = ?')
    .run(JSON.stringify({ prompts: p, layout: l, sosReasons: sos }), s.id);
  return getSession(s.id);
}

function resetSandbox(id) {
  db.prepare('UPDATE sessions SET sandbox = ?, master_version = master_version + 1 WHERE id = ?').run(SANDBOX_START, id);
  return getSession(id);
}


/* ------------------------------------------------- the other jobs a gun does
   A count is not the only thing a scanner is used for: there is the cycle
   count a person does alone off a list, the pallets to move back out of front
   positions, and the Not in Location list it watches for as it goes. Each can
   be practised here on the same two aisles, and each is set up only when asked
   for - and only for a login that may do that job for real. */
export const MODE_ACCESS = { cycle: 'cycle', moves: 'front', missing: 'missing' };
const PRACTICE_CYCLE_NAME = 'Practice cycle count';
/* the bins a practice cycle list puts in front of you: a plain one, two
   pallets, an empty bin, a short pallet, and one whose pallet has gone */
const CYCLE_BINS = ['F01A001', 'F01A002', 'F01A003', 'F01A004', 'F01B006'];
/* pallet, the front bin it is in, the empty bin to put it in, and what the one
   to try is - the third has a pallet sitting in the "empty" bin already */
const PRACTICE_MOVES = [
  ['F12311-111', 'F01A001', 'F01A003', 'A plain move: scan the pallet, put it in F01A003, scan that bin.'],
  ['F23415-111', 'F02A005', 'F02B005', 'Another plain one, in aisle F02.'],
  ['F12319-111', 'F01B005', 'F01A005', 'F01A005 is not empty — F12314-111 is sitting in it. Tap “Cannot move it” and say why.'],
];
/* pallet, where the system last saw it, what it is, and where it really is (blank: nowhere) */
const PRACTICE_MISSING = [
  ['F12317-111', 'F01B002', 'Blackberry whole IQF', 'F01B003'],
  ['F23419-111', 'F02B001', 'Blackberry whole IQF', 'F02B003'],
  ['F18888-888', 'F01B006', 'Peach slices IQF', ''],
];

function buildCyclePractice(owner) {
  const s = createSession({ name: PRACTICE_CYCLE_NAME, mode: 'cycle', palletMode: 'warn', askComments: 1 });
  db.prepare('UPDATE sessions SET practice = 1, practice_owner = ?, sandbox = ?, auto_recount = 0 WHERE id = ?').run(owner, SANDBOX_START, s.id);
  importMaster(s.id, 'bins', binCsv());
  importMaster(s.id, 'pallets', reportCsv());
  // today's list, the way the office's "generate a batch" writes one
  const info = db.prepare(`INSERT INTO cycle_batches (session_id, name, due_date, target, strategy, scope, auto, created_at) VALUES (?, ?, ?, ?, 'oldest', ?, 0, ?)`)
    .run(s.id, 'Practice list', now().slice(0, 10), CYCLE_BINS.length, JSON.stringify({ aisle: 'F01' }), now());
  const ins = db.prepare(`INSERT INTO recounts (session_id, bin, reason, detail, source, team, batch_id, status, created_at) VALUES (?, ?, 'CYCLE', 'never counted', 'cycle', NULL, ?, 'open', ?)`);
  for (const b of CYCLE_BINS) ins.run(s.id, b, info.lastInsertRowid, now());
  return getSession(s.id);
}

/** Set a job up on this person's practice. Asking twice changes nothing. */
export function startPracticeMode(owner, mode) {
  const s = practiceSession(owner);
  if (!s) throw Object.assign(new Error('open the Testing Suite first - there is no practice count yet'), { status: 404 });
  if (s.practice_source === 'upload') throw Object.assign(new Error('the other jobs are practised on the built-in test data - press "Back to the built-in test data" first'), { status: 400 });
  if (mode === 'cycle') {
    if (cycleSession(owner)) return { note: 'already set up' };
    const c = buildCyclePractice(owner);
    return { note: `#${c.id}, ${CYCLE_BINS.length} bins` };
  }
  if (mode === 'moves') {
    if (db.prepare('SELECT 1 FROM moves WHERE session_id = ?').get(s.id)) return { note: 'already set up' };
    importMoves(s.id, 'Pallet,From bin,To bin\n' + PRACTICE_MOVES.map(([p, f, t]) => `${p},${f},${t}`).join('\n') + '\n');
    db.prepare('UPDATE sessions SET master_version = master_version + 1 WHERE id = ?').run(s.id);   // the gun re-reads the count: it has moves now
    return { note: `${PRACTICE_MOVES.length} pallets to move` };
  }
  if (mode === 'missing') {
    if (practiceMissingRows(owner).length) return { note: 'already set up' };
    importMissing('Pallet,Description,Last known location\n' + PRACTICE_MISSING.map(([p, last, desc]) => `${p},"${desc}",${last}`).join('\n') + '\n', { label: 'practice', owner });
    return { note: `${PRACTICE_MISSING.length} pallets on the list` };
  }
  throw Object.assign(new Error('that is not a practice mode'), { status: 400 });
}

/** The state of each job, for the suite's "What to practise" card. */
export function practiceModes(who, owner, s) {
  const shelfOf = (bin) => (BINS.find((b) => b.bin === bin) || { shelf: [] }).shelf.map((p) => {
    const [sku, desc, uom] = ITEMS[p.item];
    return { id: p.id, qty: p.qty, sku, desc, uom, lot: p.lot, bestBefore: usDate(day(p.days)) };
  });
  const out = {
    available: !!s && s.practice_source !== 'upload',
    cycle: { allowed: allowed(who, 'cycle'), on: false, session: null, bins: [], done: 0, signedOn: false },
    moves: { allowed: allowed(who, 'front'), on: false, list: [], done: 0, skipped: 0 },
    missing: { allowed: allowed(who, 'missing'), on: false, rows: [], found: 0 },
  };
  const c = cycleSession(owner);
  if (c) {
    const counted = new Map();
    for (const l of db.prepare('SELECT pallet_id, qty, location_code, empty_bin FROM counts WHERE session_id = ? AND voided = 0').all(c.id)) {
      if (!counted.has(l.location_code)) counted.set(l.location_code, []);
      counted.get(l.location_code).push(l);
    }
    const tasks = db.prepare("SELECT id, bin, status, done_by_team, team FROM recounts WHERE session_id = ? AND source = 'cycle' ORDER BY id").all(c.id);
    out.cycle = {
      ...out.cycle, on: true, session: { id: c.id, name: c.name },
      signedOn: !!db.prepare('SELECT 1 FROM signons WHERE session_id = ?').get(c.id),
      bins: tasks.map((t) => ({
        id: t.id, bin: t.bin, status: t.status, by: t.done_by_team || t.team || '',
        shelf: shelfOf(t.bin).map((p) => ({ ...p, counted: (counted.get(t.bin) || []).some((l) => l.pallet_id === p.id) })),
        recordedEmpty: (counted.get(t.bin) || []).some((l) => l.empty_bin),
      })),
      done: tasks.filter((t) => t.status === 'done').length,
    };
  }
  if (s) {
    const mv = db.prepare('SELECT * FROM moves WHERE session_id = ? ORDER BY id').all(s.id);
    if (mv.length) {
      out.moves = {
        ...out.moves, on: true,
        list: mv.map((m) => ({
          id: m.id, pallet: m.pallet_id, from: m.from_bin, to: m.to_bin, status: m.status, actual: m.actual_bin || '', reason: m.reason || '',
          try: (PRACTICE_MOVES.find(([p]) => p === m.pallet_id) || [])[3] || '',
          occupied: (BINS.find((b) => b.bin === m.to_bin) || { shelf: [] }).shelf.map((p) => p.id),
        })),
        done: mv.filter((m) => m.status === 'done').length,
        skipped: mv.filter((m) => m.status === 'skipped').length,
      };
    }
  }
  const rows = practiceMissingRows(owner);
  if (rows.length) {
    out.missing = {
      ...out.missing, on: true,
      rows: rows.map((r) => ({
        id: r.id, pallet: r.pallet_id, last: r.last_location || '', desc: r.description || '', status: r.status,
        foundBin: r.found_bin || '', foundHow: r.found_how || '',
        where: (PRACTICE_MISSING.find(([p]) => p === r.pallet_id) || [])[3] || '',
      })),
      found: rows.filter((r) => r.status !== 'missing').length,
    };
  }
  return out;
}

/* Each job that is set up adds its thing to try to the checklist. */
function modeChecks(s) {
  const owner = s.practice_owner;
  const checks = [];
  const c = owner ? cycleSession(owner) : null;
  if (c) {
    checks.push({ key: 'cycle', label: 'Count a bin off a cycle-count list — Cycle count on the gun',
      done: db.prepare("SELECT 1 FROM recounts WHERE session_id = ? AND source = 'cycle' AND status = 'done'").get(c.id) != null });
  }
  if (db.prepare('SELECT 1 FROM moves WHERE session_id = ?').get(s.id)) {
    checks.push({ key: 'move', label: 'Move a pallet back — Front2Back on the gun',
      done: db.prepare("SELECT 1 FROM moves WHERE session_id = ? AND status = 'done'").get(s.id) != null });
    checks.push({ key: 'moveSkip', label: 'Skip a move whose bin behind is not empty',
      done: db.prepare("SELECT 1 FROM moves WHERE session_id = ? AND status = 'skipped'").get(s.id) != null });
  }
  if (owner && practiceMissingRows(owner).length) {
    checks.push({ key: 'found', label: 'Find a pallet from the Not in Location list by counting it',
      done: practiceMissingRows(owner).some((r) => r.status !== 'missing') });
  }
  return checks;
}
