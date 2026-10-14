/*
 * Entered in the ERP.
 *
 * Inventory control keys the adjustments into the ERP by hand from the
 * downloaded worksheet, over a day or two, and must not key a line twice. So
 * each adjustment line can be marked as entered - from the dashboard, a few
 * at a time, or from the worksheet itself uploaded back with its "In ERP"
 * column filled in. The mark remembers the adjustment as it stood when it was
 * entered: a line counted again since then is flagged, because the number in
 * the ERP is no longer the number on the count.
 */
import { db, norm, getSession } from '../db.js';
import { parseRecords, pick } from '../util/csv.js';
import { adjustmentView } from './adjustments.js';

const now = () => new Date().toISOString();

/** The marks on a count: pallet -> { entered_at, entered_by, variance_qty, note }. */
export function erpEntries(sessionId) {
  return new Map(db.prepare('SELECT * FROM erp_entries WHERE session_id = ?').all(Number(sessionId)).map((r) => [r.pallet_id, r]));
}

/** The adjustment view with each line's mark, and the totals for the card. */
export function withEntries(view, sessionId) {
  const marks = erpEntries(sessionId);
  let entered = 0;
  let changed = 0;
  let total = 0;
  const stamp = (r) => {
    total++;
    const m = marks.get(r.pallet_id);
    if (!m) return { ...r, erp: null };
    entered++;
    const moved = m.variance_qty != null && Number(m.variance_qty) !== Number(r.variance_qty);
    if (moved) changed++;
    return { ...r, erp: { at: m.entered_at, by: m.entered_by || '', note: m.note || '', qty: m.variance_qty, changed: moved } };
  };
  const positive = { ...view.positive, rows: view.positive.rows.map(stamp) };
  const negative = { ...view.negative, rows: view.negative.rows.map(stamp) };
  return { ...view, positive, negative, erp: { entered, total, changed } };
}

/* The lines that exist to be entered: the adjustment view's rows, by pallet. */
function liveRows(sessionId) {
  const v = adjustmentView(sessionId);
  return new Map([...v.positive.rows, ...v.negative.rows].map((r) => [r.pallet_id, r]));
}

/** Mark lines as entered (or not), a list of pallets at a time. */
export function markEntered(sessionId, { pallets = [], on = true, note = '', actor = 'supervisor' } = {}) {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  if (!Array.isArray(pallets) || !pallets.length) throw Object.assign(new Error('say which pallets'), { status: 400 });
  const live = liveRows(id);
  const at = now();
  /* A line already marked keeps its first mark - the number the ERP was
     given and when - so a change since still shows; marking it again is a no-op. */
  const ins = db.prepare(`INSERT INTO erp_entries (session_id, pallet_id, variance_qty, entered_by, entered_at, note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, pallet_id) DO NOTHING`);
  const del = db.prepare('DELETE FROM erp_entries WHERE session_id = ? AND pallet_id = ?');
  let marked = 0;
  let already = 0;
  let unmarked = 0;
  const unknown = [];
  db.exec('BEGIN');
  try {
    for (const raw of pallets) {
      const p = norm(raw);
      if (!p) continue;
      const row = live.get(p);
      if (!row) { unknown.push(p); continue; }
      if (on) { if (ins.run(id, p, row.variance_qty, String(actor || '').slice(0, 80), at, String(note || '').slice(0, 200)).changes) marked++; else already++; }
      else { unmarked += del.run(id, p).changes; }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { marked, already, unmarked, unknown, ...withEntries(adjustmentView(id), id).erp };
}

/* What a filled-in "In ERP" cell means. A date, a tick, a yes or a name all
   mean entered; a no means not; blank means leave it as it is. */
const YES = /^(y|yes|x|✓|✔|true|1|done|entered|ok|in erp|uploaded)$/i;
const NO = /^(n|no|false|0|not yet|pending|-)$/i;
export function readFlag(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (NO.test(s)) return false;
  if (YES.test(s)) return true;
  if (/\d/.test(s)) return true;                 // a date, or whoever typed their initials and the day
  return true;                                   // anything else written in the cell: they meant yes
}

/** The worksheet uploaded back: every row with the "In ERP" cell filled is marked or unmarked. */
export function markFromFile(sessionId, text, actor = 'supervisor') {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  const { records, headers } = parseRecords(String(text || ''));
  if (!records.length) throw Object.assign(new Error('no rows found in the file'), { status: 400 });
  const hasFlag = headers.some((h) => /in\s*erp|entered|uploaded/i.test(h));
  if (!hasFlag) throw Object.assign(new Error('the file has no "In ERP" column - download the ERP worksheet, fill that column in, and upload it back'), { status: 400 });
  const yes = [];
  const no = [];
  let skipped = 0;
  for (const rec of records) {
    const pallet = norm(pick(rec, ['Pallet', 'Pallet ID', 'Container No.', 'Pallet number', 'LPN', 'Tag', 'Container']));
    if (!pallet) { skipped++; continue; }
    const flag = readFlag(pick(rec, ['In ERP', 'Entered in ERP', 'Entered', 'Uploaded to ERP', 'Uploaded', 'ERP']));
    if (flag === null) { skipped++; continue; }
    (flag ? yes : no).push(pallet);
  }
  const out = { marked: 0, already: 0, unmarked: 0, unknown: [], skipped, rows: records.length };
  if (yes.length) { const r = markEntered(id, { pallets: yes, on: true, actor, note: 'from the worksheet' }); out.marked = r.marked; out.already = r.already; out.unknown.push(...r.unknown); }
  if (no.length) { const r = markEntered(id, { pallets: no, on: false, actor }); out.unmarked = r.unmarked; out.unknown.push(...r.unknown); }
  return { ...out, ...withEntries(adjustmentView(id), id).erp };
}

/** The worksheet: every adjustment line with its mark, to download, fill in and bring back. */
export function worksheetRows(sessionId) {
  const v = withEntries(adjustmentView(sessionId), sessionId);
  const row = (side) => (r) => ({
    'Side': side, 'Pallet': r.pallet_id, 'System': r.source || '', 'Item': r.sku || '', 'Bin': r.location || '', 'Why': r.why,
    'Report quantity': r.expected_qty ?? '', 'Counted quantity': r.counted_qty, 'Adjustment': r.variance_qty,
    'Approval': v.approvals ? (r.status || 'waiting') : 'not required',
    'In ERP': r.erp ? 'yes' : '', 'Entered by': r.erp ? r.erp.by : '', 'Entered at': r.erp ? r.erp.at : '',
    'Changed since entered': r.erp && r.erp.changed ? `was ${r.erp.qty}` : '',
  });
  return [...v.positive.rows.map(row('Positive')), ...v.negative.rows.map(row('Negative'))];
}
export const WORKSHEET_COLUMNS = ['Side', 'Pallet', 'System', 'Item', 'Bin', 'Why', 'Report quantity', 'Counted quantity', 'Adjustment', 'Approval', 'In ERP', 'Entered by', 'Entered at', 'Changed since entered'];
