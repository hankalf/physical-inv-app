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
import { palletReport } from './reports.js';

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

/** A report line's difference as the ERP sees it: not found is all of the report, not on the report is all of the count. */
export function lineVariance(r) {
  if (r.variance_qty !== '' && r.variance_qty != null) return Number(r.variance_qty);
  const counted = r.counted_qty === '' || r.counted_qty == null ? 0 : Number(r.counted_qty);
  return r.expected_qty === '' || r.expected_qty == null ? counted : counted - Number(r.expected_qty);
}

/* The lines that exist to be entered: the adjustment view's rows, by pallet - and, for the
   aisle sheets, every other pallet on the count too, a match included, since an ERP that is
   given the counted quantity of every pallet in an aisle is given the matches as well. */
function liveRows(sessionId) {
  const v = adjustmentView(sessionId);
  const out = new Map([...v.positive.rows, ...v.negative.rows].map((r) => [r.pallet_id, r]));
  for (const r of palletReport(sessionId)) {
    if (out.has(r.pallet_id)) continue;
    out.set(r.pallet_id, { pallet_id: r.pallet_id, variance_qty: lineVariance(r), counted_qty: r.counted_qty === '' ? null : Number(r.counted_qty) });
  }
  return out;
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
  const ins = db.prepare(`INSERT INTO erp_entries (session_id, pallet_id, variance_qty, entered_by, entered_at, note, counted_qty) VALUES (?, ?, ?, ?, ?, ?, ?)
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
      if (on) { if (ins.run(id, p, row.variance_qty, String(actor || '').slice(0, 80), at, String(note || '').slice(0, 200), row.counted_qty ?? null).changes) marked++; else already++; }
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
/* A line counted again after it went in, put right in the ERP since: marked again at the numbers it has now. */
const AGAIN = /^(again|re-?entered|re-?uploaded|updated|corrected|fixed)$/i;
export function readFlag(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (AGAIN.test(s)) return 'again';
  if (NO.test(s)) return false;
  if (YES.test(s)) return true;
  if (/\d/.test(s)) return true;                 // a date, or whoever typed their initials and the day
  return true;                                   // anything else written in the cell: they meant yes
}

/** The worksheet uploaded back: every row with the "In ERP" cell filled is marked or unmarked. */
export function markFromFile(sessionId, text, actor = 'supervisor', note = '') {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  const { records, headers } = parseRecords(String(text || ''));
  if (!records.length) throw Object.assign(new Error('no rows found in the file'), { status: 400 });
  const hasFlag = headers.some((h) => /in\s*erp|entered|uploaded/i.test(h));
  if (!hasFlag) throw Object.assign(new Error('the file has no "In ERP" or "Uploaded to ERP" column - download the ERP worksheet or an aisle\'s sheet, fill that column in, and upload it back'), { status: 400 });
  const yes = [];
  const no = [];
  const again = [];
  let skipped = 0;
  for (const rec of records) {
    const pallet = norm(pick(rec, ['Pallet', 'Pallet ID', 'Container No.', 'Pallet number', 'LPN', 'Tag', 'Container']));
    if (!pallet) { skipped++; continue; }
    const flag = readFlag(pick(rec, ['In ERP', 'Entered in ERP', 'Entered', 'Uploaded to ERP', 'Uploaded', 'ERP']));
    if (flag === null) { skipped++; continue; }
    (flag === 'again' ? again : flag ? yes : no).push(pallet);
  }
  const out = { marked: 0, already: 0, unmarked: 0, remarked: 0, unknown: [], skipped, rows: records.length };
  if (again.length) {
    // off and on again: the mark now holds today's numbers, so the line is no longer "changed"
    markEntered(id, { pallets: again, on: false, actor });
    const r = markEntered(id, { pallets: again, on: true, actor, note: `${note || 'from the worksheet'}, put right in the ERP` });
    out.remarked = r.marked; out.unknown.push(...r.unknown);
  }
  if (yes.length) { const r = markEntered(id, { pallets: yes, on: true, actor, note: note || 'from the worksheet' }); out.marked = r.marked; out.already = r.already; out.unknown.push(...r.unknown); }
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

/** Each pallet report row with its ERP mark: uploaded, by whom and when, and whether the line has moved since. */
export function withErpMarks(sessionId, rows) {
  const marks = erpEntries(sessionId);
  if (!marks.size) return rows;
  return rows.map((r) => {
    const m = marks.get(r.pallet_id);
    if (!m) return r;
    const moved = m.variance_qty != null && Number(m.variance_qty) !== lineVariance(r);
    return { ...r, erp_uploaded: 'yes', erp_by: m.entered_by || '', erp_at: m.entered_at || '', erp_changed: moved ? 1 : 0 };
  });
}
