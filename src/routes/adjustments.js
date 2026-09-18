import { db, getSession } from '../db.js';
import { palletReport } from './reports.js';

/*
 * Approving what the count is about to do to the ERP.
 *
 * A count produces variances; the ERP wants adjustments. Between the two there
 * is a decision - write off 400 cases of chicken, or go and look again - and on
 * a wall-to-wall count nobody can make that decision for six thousand pallets
 * at once. So each pallet that differs from the report becomes a row here with
 * a reason code and a name against it, and the ERP file carries only what was
 * approved. An auditor asking "who signed off writing off that pallet, and why"
 * gets an answer.
 *
 * The thresholds are what keep it usable: a one-case difference on a pallet of
 * 600 is noise, and a count where every line needs a signature does not get
 * signed - it gets rubber-stamped. Anything under the threshold is marked
 * "auto" and goes to the ERP without anybody being asked.
 *
 * Off unless a count turns it on. With it off nothing here runs and the export
 * behaves exactly as it always did.
 */

const now = () => new Date().toISOString();

/* The reasons a warehouse actually gives, in the order they are actually given.
   Editable per site - every operation has its own vocabulary, and a reason list
   somebody else wrote is a list everyone picks the first item from. */
export const DEFAULT_REASONS = [
  'Miscount — first count was wrong',
  'Damaged / dumped, not reported',
  'Received, not entered in the system',
  'Shipped, not relieved from the system',
  'Put away to the wrong bin',
  'Pallet ID or label error',
  'System / interface error',
  'Unknown — investigate',
];

export function adjustmentReasons() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'adjustmentReasons'").get();
  if (!row) return { reasons: DEFAULT_REASONS, isDefault: true };
  try {
    const saved = JSON.parse(row.value);
    const reasons = (Array.isArray(saved) ? saved : [])
      .map((r) => String(r || '').trim()).filter(Boolean).slice(0, 30);
    return reasons.length ? { reasons, isDefault: false } : { reasons: DEFAULT_REASONS, isDefault: true };
  } catch { return { reasons: DEFAULT_REASONS, isDefault: true }; }
}

export function saveAdjustmentReasons(list) {
  const reasons = (Array.isArray(list) ? list : []).map((r) => String(r || '').trim()).filter(Boolean).slice(0, 30);
  if (!reasons.length) {
    db.prepare("DELETE FROM settings WHERE key = 'adjustmentReasons'").run();
    return adjustmentReasons();
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('adjustmentReasons', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(reasons));
  return adjustmentReasons();
}

/* A pallet the ERP would have to be told about. A second label is a tag on a
   pallet already in the file, never an adjustment of its own. */
const ADJUSTABLE = new Set(['QTY VARIANCE', 'MISSING', 'NOT IN MASTER', 'COUNTED TWICE']);

function adjustmentRows(sessionId, session) {
  /* A pallet nobody has walked to yet is not an adjustment - on a count still
     running it is simply not counted, and a list that opened with every pallet
     in the warehouse on it would never be read. Once the count is closed, a
     pallet that was never found IS the adjustment: the report says it is there
     and it is not. */
  const open = !session || session.status !== 'closed';
  return palletReport(sessionId)
    .filter((r) => ADJUSTABLE.has(r.status) && !(open && r.status === 'MISSING'))
    .map((r) => {
      const expected = r.expected_qty === '' ? null : Number(r.expected_qty);
      const counted = r.counted_qty === '' ? 0 : Number(r.counted_qty);
      /* What the ERP would move. A pallet that was never found is the whole of
         what the report believed; one that is not on the report at all is the
         whole of what was counted. */
      const variance = r.variance_qty === '' ? (expected == null ? counted : counted - expected) : Number(r.variance_qty);
      return {
        pallet_id: r.pallet_id,
        sku: r.sku || '',
        location: String(r.found_location || '').split(',')[0] || r.expected_location || '',
        expected_qty: expected,
        counted_qty: counted,
        variance_qty: variance,
        kind: r.status,
      };
    })
    .filter((r) => r.variance_qty !== 0);
}

/** Does this one need a signature, or is it small enough to go through? */
function needsApproval(row, session) {
  const minQty = Number(session.approval_min_qty) || 0;
  const minPct = Number(session.approval_min_pct) || 0;
  if (!minQty && !minPct) return true;                 // no thresholds: everything is approved by hand
  const size = Math.abs(Number(row.variance_qty) || 0);
  const base = Math.abs(Number(row.expected_qty) || 0);
  const pct = base ? (size / base) * 100 : 100;        // nothing expected: the whole line is the variance
  /* Either test can send it for approval. A site that sets both is saying "big
     in cases, or big for the pallet it is on". */
  if (minQty && size >= minQty) return true;
  if (minPct && pct >= minPct) return true;
  return false;
}

/**
 * Bring the list in line with what has been counted since it was last looked at.
 *
 * Counting carries on while a supervisor approves, and a second count can turn
 * a variance into a match. So this is rebuilt from the report every time it is
 * read: new variances arrive as pending, ones that have gone away are dropped,
 * and - the one that matters for an audit - a line whose numbers have changed
 * since it was approved goes back to pending rather than quietly exporting a
 * number nobody agreed to.
 */
export function refreshAdjustments(sessionId) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  if (!session.require_approval) return { on: false, changed: 0, reopened: 0 };

  const live = adjustmentRows(id, session);
  const have = new Map(db.prepare('SELECT * FROM adjustments WHERE session_id = ?').all(id).map((r) => [r.pallet_id, r]));
  const at = now();
  let changed = 0;
  let reopened = 0;

  db.exec('BEGIN');
  try {
    for (const row of live) {
      const was = have.get(row.pallet_id);
      const status = needsApproval(row, session) ? 'pending' : 'auto';
      if (!was) {
        db.prepare(
          `INSERT INTO adjustments (session_id, pallet_id, sku, location, expected_qty, counted_qty, variance_qty, kind, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, row.pallet_id, row.sku, row.location, row.expected_qty, row.counted_qty, row.variance_qty, row.kind, status, at);
        changed++;
        continue;
      }
      const moved = Number(was.variance_qty) !== row.variance_qty || Number(was.counted_qty) !== row.counted_qty;
      if (!moved) {
        /* The numbers are the same; only the threshold verdict can have changed,
           and a decision already taken stands. */
        if (was.status === 'pending' && status === 'auto') {
          db.prepare("UPDATE adjustments SET status = 'auto' WHERE id = ?").run(was.id);
          changed++;
        }
        continue;
      }
      const decided = was.status === 'approved' || was.status === 'rejected';
      db.prepare(
        `UPDATE adjustments SET sku = ?, location = ?, expected_qty = ?, counted_qty = ?, variance_qty = ?, kind = ?,
                status = ?, reason = ?, note = ?, decided_by = ?, decided_at = ?
          WHERE id = ?`
      ).run(row.sku, row.location, row.expected_qty, row.counted_qty, row.variance_qty, row.kind,
            status,
            decided ? null : was.reason, decided ? null : was.note,
            decided ? null : was.decided_by, decided ? null : was.decided_at,
            was.id);
      changed++;
      if (decided) reopened++;
      have.set(row.pallet_id, { ...was, status });
    }
    /* Counted again and it matches now: there is nothing to adjust, so the row
       goes. What was decided about it is in the audit log either way. */
    const liveIds = new Set(live.map((r) => r.pallet_id));
    for (const [palletId, row] of have) {
      if (liveIds.has(palletId)) continue;
      db.prepare('DELETE FROM adjustments WHERE id = ?').run(row.id);
      changed++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { on: true, changed, reopened };
}

export function listAdjustments(sessionId, { status = '', limit = 500 } = {}) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  const refreshed = refreshAdjustments(id);
  const where = status ? ' AND status = ?' : '';
  const rows = db
    .prepare(`SELECT * FROM adjustments WHERE session_id = ?${where} ORDER BY ABS(variance_qty) DESC, pallet_id LIMIT ?`)
    .all(...(status ? [id, status, Math.max(1, Math.min(2000, Number(limit) || 500))] : [id, Math.max(1, Math.min(2000, Number(limit) || 500))]));
  return {
    on: !!session.require_approval,
    thresholds: { minQty: session.approval_min_qty || 0, minPct: session.approval_min_pct || 0 },
    reopened: refreshed.reopened || 0,
    summary: summary(id),
    reasons: adjustmentReasons().reasons,
    adjustments: rows,
  };
}

/** The one line a supervisor reads: how much of this count is still unsigned. */
export function summary(sessionId) {
  const id = Number(sessionId);
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n, SUM(ABS(variance_qty)) AS units FROM adjustments
        WHERE session_id = ? GROUP BY status`
    )
    .all(id);
  const out = { pending: 0, approved: 0, rejected: 0, auto: 0, units: { pending: 0, approved: 0, rejected: 0, auto: 0 } };
  for (const r of rows) {
    if (out[r.status] === undefined) continue;
    out[r.status] = r.n;
    out.units[r.status] = Math.round((r.units || 0) * 100) / 100;
  }
  out.total = out.pending + out.approved + out.rejected + out.auto;
  return out;
}

/**
 * Approve or reject, one pallet or a screenful.
 *
 * Approving without saying why is the thing this feature exists to prevent, so
 * a reason is required and has to be one the site listed (or a written one -
 * "Other" with a note beats a wrong code picked to get past the dialog).
 */
export function decideAdjustments(sessionId, { palletIds = [], decision = 'approve', reason = '', note = '', actor = 'supervisor' } = {}) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  if (!session.require_approval) throw Object.assign(new Error('approvals are off for this count'), { status: 409 });
  const verdict = decision === 'reject' ? 'rejected' : 'approved';
  const why = String(reason || '').trim();
  const detail = String(note || '').trim().slice(0, 300);
  if (!why && !detail) {
    throw Object.assign(new Error('a reason is required — pick one, or write one in the note'), { status: 400 });
  }
  const ids = [...new Set((Array.isArray(palletIds) ? palletIds : [palletIds]).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) throw Object.assign(new Error('nothing selected'), { status: 400 });

  const at = now();
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const pallet of ids) {
      changed += db
        .prepare(
          `UPDATE adjustments SET status = ?, reason = ?, note = ?, decided_by = ?, decided_at = ?
            WHERE session_id = ? AND pallet_id = ?`
        )
        .run(verdict, why || 'Other', detail, String(actor || 'supervisor'), at, id, pallet).changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { decided: changed, status: verdict, reason: why || 'Other', summary: summary(id) };
}

/** What the ERP file may carry: approved by hand, or under the threshold. */
export function approvedAdjustments(sessionId) {
  return new Map(
    db
      .prepare("SELECT * FROM adjustments WHERE session_id = ? AND status IN ('approved', 'auto')")
      .all(Number(sessionId))
      .map((r) => [r.pallet_id, r])
  );
}

