import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, norm, getSession, createSession, createDevice, listDevices } from '../db.js';
import { importMaster } from './master.js';
import { queueAssignments } from './assignments.js';

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
  chicken: ['SKU-4120', 'Chicken breast IQF 40lb'],
  thigh: ['SKU-4180', 'Chicken thigh boneless 30lb'],
  peas: ['SKU-2210', 'Peas petite 12x2lb'],
  corn: ['SKU-2240', 'Sweetcorn supersweet 20lb'],
  salmon: ['SKU-6610', 'Salmon fillet skin-on 10lb'],
  cod: ['SKU-6640', 'Cod loin 8lb'],
  fries: ['SKU-3310', 'Fries shoestring 6x5lb'],
  hash: ['SKU-3350', 'Hash brown patty 240ct'],
  blue: ['SKU-8810', 'Blueberry wild 30lb'],
  straw: ['SKU-8840', 'Strawberry sliced 20lb'],
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
  { bin: 'F01A001', shelf: [P('F01-001', 40, 'chicken', 'L2026114', 140)],
    try: 'A plain one: pallet, quantity, bin.', check: 'first' },
  { bin: 'F01A002', shelf: [P('F01-002', 32, 'peas', 'L2026127', 210), P('F01-003', 28, 'peas', 'L2026127', 210)],
    try: 'Two pallets in one bin — count both, then scan the bin for each.', check: 'two' },
  { bin: 'F01A003', shelf: [],
    try: 'Nothing here. On the pallet step tap “Bin is EMPTY — scan the bin”, then scan the bin.', check: 'empty' },
  { bin: 'F01A004', shelf: [P('F01-004', 32, 'salmon', 'L2026153', 95)], report: [P('F01-004', 36, 'salmon', 'L2026153', 95)],
    try: 'The report says 36. There are 32 — type what you see.', check: 'short' },
  { bin: 'F01A005', shelf: [P('F01-005', 30, 'fries', 'L2026166', 260)], report: [],
    try: 'The report has this pallet in F01A006. It is here — the gun will say so; accept it.', check: 'moved' },
  { bin: 'F01A006', shelf: [P('F01-099', 20, 'blue', 'L2026179', 300)], report: [P('F01-005', 30, 'fries', 'L2026166', 260)],
    try: 'F01-099 is not on the report. The gun asks “Count it anyway?” — tap YES.', check: 'unlisted' },
  { bin: 'F01B001', shelf: [P('F01-006', 44, 'thigh', 'L2026192', 180)], noScan: 'pallet',
    try: 'The pallet label is torn. Tap “Label will not scan”, then type the ID.', check: 'label' },
  { bin: 'F01B002', shelf: [P('F01-007', 36, 'cod', 'L2026205', -20)],
    try: 'Best before has passed. Count it as normal — it shows as expired on the dashboard.' },
  { bin: 'F01B003', shelf: [P('F01-008', 40, 'hash', 'L2026218', 150)], noScan: 'bin',
    try: 'The rack label is missing. At the bin step tap “Bin label will not scan”. If the gun offers “It is F01B003”, take it; if it guesses another bin, tap “I can read it — let me type it” and click F01B003 here.',
    check: 'binLabel' },
  { bin: 'F01B004', shelf: [P('F01-009', 24, 'straw', 'L2026231', 120), P('F01-010', 24, 'straw', 'L2026231', 120), P('F01-011', 26, 'straw', 'L2026231', 120)],
    try: 'Three pallets in one bin.' },
  { bin: 'F01B005', shelf: [P('F01-012', 36, 'corn', 'L2026244', 330)] },
  { bin: 'F01B006', shelf: [], report: [P('F01-013', 40, 'chicken', 'L2026257', 160)],
    try: 'The report says F01-013 is here. It is not — record the bin empty. It shows as missing.', check: 'missing' },

  { bin: 'F02A001', shelf: [P('F02-001', 40, 'chicken', 'L2026270', 130)],
    try: 'A new aisle: finish F01 first with “Aisle complete — next aisle”.', check: 'nextAisle' },
  { bin: 'F02A002', shelf: [P('F02-002', 30, 'fries', 'L2026283', 240)] },
  { bin: 'F02A003', shelf: [P('F02-003', 32, 'peas', 'L2026296', 200)],
    try: 'Once counted, scan F02-003 again — the gun warns it is already counted.' },
  { bin: 'F02A004', shelf: [P('F02-004', 28, 'salmon', 'L2026309', 70), P('F02-005', 28, 'salmon', 'L2026309', 70)] },
  { bin: 'F02A005', shelf: [P('F02-006', 44, 'thigh', 'L2026322', 190)] },
  { bin: 'F02A006', shelf: [P('F02-007', 36, 'cod', 'L2026335', 110)] },
  { bin: 'F02B001', shelf: [P('F02-008', 1200, 'blue', 'L2026348', 280)],
    try: 'A big quantity: over the site’s limit, the gun asks you to key 1200 a second time.' },
  { bin: 'F02B002', shelf: [P('F02-009', 24, 'straw', 'L2026361', 125)] },
  { bin: 'F02B003', shelf: [P('F02-010', 40, 'hash', 'L2026374', 155)] },
  { bin: 'F02B004', shelf: [P('F02-011', 32, 'corn', 'L2026387', 320)] },
  { bin: 'F02B005', shelf: [] },
  { bin: 'F02B006', shelf: [P('F02-012', 40, 'chicken', 'L2026400', 145)],
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
const now = () => new Date().toISOString();

const TEMPLATE = fileURLToPath(new URL('../../public/templates/front-royal-bins.csv', import.meta.url));

/** The bin list: the real rows from the Front Royal template for the bins used. */
function binCsv() {
  const want = new Set(BINS.map((b) => b.bin));
  let rows = [];
  try {
    rows = readFileSync(TEMPLATE, 'utf8').split(/\r?\n/).filter((l) => want.has(l.split(',')[0]));
  } catch { /* fall back to plain rows below */ }
  const have = new Set(rows.map((l) => l.split(',')[0]));
  for (const b of BINS) if (!have.has(b.bin)) rows.push(`${b.bin},Freezer,${b.bin.slice(0, 3)},"Practice bin ${b.bin}"`);
  return 'Bin Location,Zone,Aisle,Description\n' + rows.join('\n') + '\n';
}

function reportCsv() {
  let csv = 'Pallet ID,SKU,Description,Qty,Location,Lot Code,Best Before\n';
  for (const b of BINS) {
    for (const p of b.report || b.shelf) {
      const [sku, desc] = ITEMS[p.item];
      csv += `${p.id},${sku},"${desc}",${p.qty},${b.bin},${p.lot},${day(p.days)}\n`;
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
  db.prepare("SELECT * FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(owner) || null;

/** Build a practice count from nothing: bins, report, and the team's two aisles. */
function buildPractice(owner) {
  const s = createSession({ name: PRACTICE_NAME, mode: 'full', palletMode: 'warn', guided: 1, askComments: 1 });
  db.prepare('UPDATE sessions SET practice = 1, practice_owner = ? WHERE id = ?').run(owner, s.id);
  importMaster(s.id, 'bins', binCsv());
  importMaster(s.id, 'pallets', reportCsv());
  queueAssignments(s.id, PRACTICE_TEAM, ['F01', 'F02'], 'A-F', { force: true });
  return getSession(s.id);
}

export function ensurePractice(owner) {
  return practiceSession(owner) || buildPractice(owner);
}

/**
 * Start again. The run so far is closed and kept, so a person can look back at
 * what they have tried; only the oldest runs beyond the last ten are deleted.
 */
export function resetPractice(owner) {
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE practice = 1 AND practice_owner = ? AND status = 'open'")
    .run(new Date().toISOString(), owner);
  const old = db.prepare("SELECT id FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'closed' ORDER BY id DESC")
    .all(owner).slice(HISTORY_KEEP);
  for (const s of old) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  return buildPractice(owner);
}

/** This person's earlier runs, newest first, with how far each one got. */
export function practiceHistory(owner) {
  return db.prepare("SELECT * FROM sessions WHERE practice = 1 AND practice_owner = ? AND status = 'closed' ORDER BY id DESC")
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
    `SELECT pallet_id, qty, location_code, empty_bin, label_issue, bin_label_issue, override_reason, team, scanned_at
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

  const bins = BINS.map((b) => {
    const shelf = b.shelf.map((p) => {
      const [sku, desc] = ITEMS[p.item];
      const rep = reportAt.get(p.id) || null;
      const got = byPallet.get(p.id) || null;
      return {
        id: p.id, qty: p.qty, sku, desc, lot: p.lot, bestBefore: day(p.days), expired: p.days < 0,
        report: rep ? { qty: rep.expected_qty, bin: rep.expected_location } : null,
        counted: got ? { qty: got.qty, bin: got.location_code, right: got.location_code === b.bin && Number(got.qty) === p.qty } : null,
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
  if (counted('F01-002', 'F01A002') && counted('F01-003', 'F01A002')) done.add('two');
  if (emptyBins.has('F01A003')) done.add('empty');
  if (byPallet.get('F01-004') && Number(byPallet.get('F01-004').qty) < 36) done.add('short');
  if (counted('F01-005', 'F01A005')) done.add('moved');
  if (counted('F01-099')) done.add('unlisted');
  if (byPallet.get('F01-006')?.label_issue) done.add('label');
  if (lines.some((l) => l.location_code === 'F01B003' && l.bin_label_issue)) done.add('binLabel');
  if (emptyBins.has('F01B006')) done.add('missing');
  if (db.prepare("SELECT 1 FROM assignments WHERE session_id = ? AND aisle = 'F01' AND status = 'done'").get(id)) done.add('nextAisle');
  if (db.prepare('SELECT 1 FROM alerts WHERE session_id = ?').get(id)) done.add('sos');

  const assignment = db.prepare(
    "SELECT aisle, status FROM assignments WHERE session_id = ? AND team = ? ORDER BY position").all(id, PRACTICE_TEAM);
  const pallets = bins.reduce((n, b) => n + b.shelf.length, 0);
  return {
    session: s ? { id: s.id, name: s.name, status: s.status, askLot: !!s.ask_lot, askExpiry: !!s.ask_expiry } : null,
    team: PRACTICE_TEAM,
    crew: PRACTICE_CREW,
    bins,
    assignment,
    checklist: CHECKS.map(([key, label]) => ({ key, label, done: done.has(key) })),
    totals: { bins: bins.length, binsCounted: bins.filter((b) => b.counted).length, pallets, lines: lines.length },
  };
}
