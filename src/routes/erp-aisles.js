import { db, norm, getSession } from '../db.js';
import { palletReport } from './reports.js';
import { erpEntries, lineVariance } from './erp-entries.js';

/*
 * The ERP, an aisle at a time.
 *
 * Inventory control puts a wall-to-wall into the ERP aisle by aisle, as the
 * aisles are finished, rather than in one sitting at the end. Each aisle's
 * sheet has every pallet in it - what the report said, what the count found
 * (the latest count: a second or third count stands over the first), and the
 * difference - and an "Uploaded to ERP" column to fill in as the lines go in.
 * Uploaded back, that column marks the lines here, the same marks as the ERP
 * worksheet's "In ERP": so the dashboard knows what is in the ERP, nothing is
 * keyed twice, and a line counted again after it went in is flagged.
 *
 * The file only ever carries the marks back. The counts themselves change
 * only by being counted.
 */

const RESULT = {
  'MATCH': 'Matches', 'QTY VARIANCE': 'Quantity differs', 'WRONG BIN': 'In a different bin', 'MISSING': 'Not found',
  'NOT IN MASTER': 'Not on the report', 'COUNTED TWICE': 'Counted twice', 'SECOND LABEL': 'Second label on a pallet',
};
const ROUND = { 1: '1st', 2: '2nd', 3: '3rd' };
export const AISLE_COLUMNS = ['Aisle', 'Bin', 'Pallet', 'System', 'Item', 'Description', 'Lot', 'Report bin', 'Report quantity', 'Counted quantity',
  'Adjustment', 'Result', 'Count', 'Uploaded to ERP', 'Uploaded by', 'Uploaded at', 'Changed since uploaded'];

/** Which aisle a pallet's line belongs to: where it was found, else where the report had it. */
function placeOf(r, aisleOf) {
  const bin = String(r.found_location || '').split(',').filter(Boolean)[0] || r.expected_location || '';
  return { bin, aisle: aisleOf.get(bin) || (bin.match(/^[A-Z]+\d+/) || [''])[0] };
}

function rowsByAisle(sessionId) {
  const id = Number(sessionId);
  const aisleOf = new Map(db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(id).map((l) => [l.code, l.aisle]));
  const marks = erpEntries(id);
  const out = new Map();
  for (const r of palletReport(id)) {
    if (r.status === 'SECOND LABEL') continue;                    // a tag on a pallet already on the sheet
    const { bin, aisle } = placeOf(r, aisleOf);
    if (!aisle) continue;
    const m = marks.get(r.pallet_id);
    const counted = r.counted_qty === '' ? null : Number(r.counted_qty);
    const variance = lineVariance(r);
    const changed = !!m && ((m.counted_qty != null && counted != null && Number(m.counted_qty) !== counted) || (m.variance_qty != null && Number(m.variance_qty) !== variance));
    if (!out.has(aisle)) out.set(aisle, []);
    out.get(aisle).push({ r, bin, aisle, counted, variance, mark: m || null, changed });
  }
  return out;
}

/** Every aisle: how many lines, how many differ, how many are in the ERP, what is still being counted. */
export function erpAisles(sessionId) {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  const byAisle = rowsByAisle(id);
  const openTasks = new Map(db.prepare(`SELECT l.aisle, COUNT(*) n FROM recounts r JOIN locations l ON l.session_id = r.session_id AND l.code = r.bin
                                         WHERE r.session_id = ? AND r.status != 'done' GROUP BY l.aisle`).all(id).map((x) => [x.aisle, x.n]));
  const notCounted = new Map(db.prepare(`SELECT l.aisle, COUNT(*) n FROM locations l WHERE l.session_id = ?
      AND NOT EXISTS (SELECT 1 FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) GROUP BY l.aisle`).all(id).map((x) => [x.aisle, x.n]));
  const handedBack = new Set(db.prepare("SELECT DISTINCT aisle FROM assignments WHERE session_id = ? AND status = 'done'").all(id).map((x) => x.aisle));
  return [...byAisle.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((aisle) => {
    const list = byAisle.get(aisle);
    const uploaded = list.filter((x) => x.mark).length;
    return {
      aisle, lines: list.length,
      counted: list.filter((x) => x.counted != null).length,
      differences: list.filter((x) => x.r.status !== 'MATCH').length,
      uploaded, changed: list.filter((x) => x.changed).length,
      openRecounts: openTasks.get(aisle) || 0, binsNotCounted: notCounted.get(aisle) || 0, handedBack: handedBack.has(aisle),
      state: uploaded === 0 ? 'none' : uploaded === list.length ? 'all' : 'some',
    };
  });
}

/** One aisle's sheet, to fill in and bring back. */
export function erpAisleSheet(sessionId, aisle) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const a = norm(aisle);
  const list = (rowsByAisle(id).get(a) || []).sort((x, y) => x.bin.localeCompare(y.bin, undefined, { numeric: true }) || x.r.pallet_id.localeCompare(y.r.pallet_id));
  if (!list.length) throw Object.assign(new Error(`nothing in aisle ${a} on this count`), { status: 404 });
  const rows = list.map(({ r, bin, counted, variance, mark, changed }) => ({
    'Aisle': a, 'Bin': bin, 'Pallet': r.pallet_id, 'System': r.source || '', 'Item': r.sku || '', 'Description': r.description || '',
    'Lot': r.found_lot || r.expected_lot || '', 'Report bin': r.expected_location || '', 'Report quantity': r.expected_qty,
    'Counted quantity': counted == null ? '' : counted, 'Adjustment': r.status === 'MATCH' ? 0 : variance,
    'Result': RESULT[r.status] || r.status, 'Count': r.count_round ? ROUND[r.count_round] : '',
    'Uploaded to ERP': mark ? 'yes' : '', 'Uploaded by': mark ? mark.entered_by || '' : '', 'Uploaded at': mark ? String(mark.entered_at || '').slice(0, 16).replace('T', ' ') : '',
    'Changed since uploaded': changed ? `was ${mark.counted_qty ?? mark.variance_qty}` : '',
  }));
  const safe = String(s.name).replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'count';
  const how = [
    ['What this is', `Every pallet in aisle ${a} on "${s.name}": the report, the count (the latest one - a 2nd or 3rd count stands over the 1st) and the difference.`],
    ['As you put lines into the ERP', 'Write yes (or x, a date or your initials) in the "Uploaded to ERP" column. No takes a mark off; blank leaves a line as it is.'],
    ['Then', 'Dashboard → Adjustments → ERP upload, an aisle at a time → Upload a filled-in sheet. The lines are marked in the app as in the ERP.'],
    ['Changed since uploaded', 'A line counted again after it went into the ERP: the ERP has the old number.'],
    ['Quantities', 'Only the "Uploaded to ERP" column is read back. A count changes only by being counted.'],
  ].map(([What, Value]) => ({ What, Value }));
  return {
    filename: `${safe}-aisle-${a}-for-ERP-${new Date().toISOString().slice(0, 10)}.xlsx`,
    aisle: a, lines: rows.length,
    sheets: [{ name: `Aisle ${a}`, columns: AISLE_COLUMNS, rows }, { name: 'How to use', columns: ['What', 'Value'], rows: how }],
  };
}
