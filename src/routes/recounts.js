import { db, norm, getSession } from '../db.js';
import { palletReport } from './reports.js';

/*
 * Second counts.
 *
 * A recount task is a bin somebody goes back to. Tasks are raised automatically
 * when a first-count line disagrees with the inventory report (quantity differs,
 * pallet in an unexpected bin, pallet not on the list, counted twice), when an
 * aisle is handed back with expected pallets never seen (missing), or by hand
 * from the dashboard. A task is offered to any team except the one that did the
 * first count. Lines recorded during a task are pass 2; for reporting they
 * supersede the pass-1 lines in that bin.
 */

const now = () => new Date().toISOString();

// What the counter is told. Deliberately no numbers: the second count is blind.
export const REASONS = {
  'QTY VARIANCE': 'Quantity differs from the inventory report',
  'WRONG BIN': 'Pallet found in an unexpected bin',
  'NOT IN MASTER': 'Pallet not on the inventory report',
  'COUNTED TWICE': 'Pallet counted in more than one bin',
  'MISSING': 'Expected pallet not found here',
  'MANUAL': 'Requested by a supervisor',
  'CYCLE': 'Cycle count',
};

export function listRecounts(sessionId) {
  return db
    .prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM counts c WHERE c.session_id = r.session_id AND c.location_code = r.bin AND c.voided = 0 AND c.pass = 1) AS first_lines,
              (SELECT GROUP_CONCAT(pallet_id || ' ×' || qty, ', ') FROM counts c WHERE c.session_id = r.session_id AND c.location_code = r.bin AND c.voided = 0 AND c.pass = 1) AS first_result,
              (SELECT GROUP_CONCAT(pallet_id || ' ×' || qty, ', ') FROM counts c WHERE c.session_id = r.session_id AND c.location_code = r.bin AND c.voided = 0 AND c.pass = 2) AS second_result
         FROM recounts r
        WHERE r.session_id = ?
        ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'taken' THEN 1 ELSE 2 END, r.id`
    )
    .all(Number(sessionId));
}

function openTaskForBin(sessionId, bin) {
  return db
    .prepare("SELECT id FROM recounts WHERE session_id = ? AND bin = ? AND status != 'done'")
    .get(Number(sessionId), norm(bin));
}

export function createRecount(sessionId, { bin, palletId, reason = 'MANUAL', detail = '', source = 'manual', firstTeam = null, team = null }) {
  const id = Number(sessionId);
  const b = norm(bin);
  if (!b) throw Object.assign(new Error('bin required'), { status: 400 });
  const existing = openTaskForBin(id, b);
  if (existing) return { id: existing.id, created: false };
  const info = db
    .prepare(
      `INSERT INTO recounts (session_id, bin, pallet_id, reason, detail, source, first_team, team, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    )
    .run(id, b, palletId ? norm(palletId) : null, REASONS[reason] ? reason : 'MANUAL', String(detail || ''), source,
         firstTeam ? norm(firstTeam) : null, team ? norm(team) : null, now());
  return { id: info.lastInsertRowid, created: true };
}

/** Raise tasks for every pallet that currently disagrees with the report. */
export function generateFromVariances(sessionId, { onlyPallets = null, includeMissing = true } = {}) {
  const id = Number(sessionId);
  const rows = palletReport(id).filter((r) => r.status !== 'MATCH' && (!onlyPallets || onlyPallets.has(r.pallet_id)));
  let created = 0;
  for (const r of rows) {
    if (r.recounted) continue; // a second count already settled this bin
    if (r.status === 'MISSING') {
      if (!includeMissing || !r.expected_location) continue;
      if (createRecount(id, { bin: r.expected_location, palletId: r.pallet_id, reason: 'MISSING', detail: `expected ${r.expected_qty ?? '?'} in ${r.expected_location}, never counted`, source: 'auto' }).created) created++;
      continue;
    }
    const firstTeam = db.prepare(
      `SELECT team FROM counts WHERE session_id = ? AND pallet_id = ? AND voided = 0 AND pass = 1 ORDER BY id DESC LIMIT 1`).get(id, r.pallet_id)?.team || null;
    const bins = String(r.found_location || '').split(',').filter(Boolean);
    const detail = r.status === 'QTY VARIANCE' ? `expected ${r.expected_qty}, first count ${r.counted_qty}`
      : r.status === 'WRONG BIN' ? `expected in ${r.expected_location}, found in ${r.found_location}`
      : r.status === 'COUNTED TWICE' ? `found in ${r.found_location}`
      : `qty ${r.counted_qty}, not on the report`;
    for (const bin of bins) {
      if (createRecount(id, { bin, palletId: r.pallet_id, reason: r.status, detail, source: 'auto', firstTeam }).created) created++;
    }
  }
  return { created, considered: rows.length };
}

/** Called after a batch of first-count lines lands, when the session auto-recounts. */
export function autoAfterCounts(sessionId, palletIds) {
  const s = getSession(sessionId);
  if (!s || !s.auto_recount || !palletIds.length) return { created: 0 };
  return generateFromVariances(sessionId, { onlyPallets: new Set(palletIds.map(norm)), includeMissing: false });
}

/** Called when an aisle is handed back: expected pallets in it that nobody saw. */
export function autoAfterAisle(sessionId, aisle, levels, team) {
  const s = getSession(sessionId);
  if (!s || !s.auto_recount) return { created: 0 };
  const id = Number(sessionId);
  const rows = db
    .prepare(
      `SELECT p.pallet_id, p.expected_qty, p.expected_location
         FROM pallets p JOIN locations l ON l.session_id = p.session_id AND l.code = p.expected_location
        WHERE p.session_id = ? AND l.aisle = ?
          AND NOT EXISTS (SELECT 1 FROM counts c WHERE c.session_id = p.session_id AND c.pallet_id = p.pallet_id AND c.voided = 0)`
    )
    .all(id, norm(aisle))
    .filter((r) => !levels || levels.includes(r.expected_location.replace(/^[A-Z]+\d+/, '')[0] || ''));
  let created = 0;
  for (const r of rows) {
    if (createRecount(id, { bin: r.expected_location, palletId: r.pallet_id, reason: 'MISSING',
      detail: `expected ${r.expected_qty ?? '?'} in ${r.expected_location}, not seen when aisle ${aisle} was completed`, source: 'auto', firstTeam: team }).created) created++;
  }
  return { created };
}

/** Tasks a team may work: assigned to it, or unassigned and not its own first count. */
export function tasksForTeam(sessionId, team) {
  const t = norm(team);
  return db
    .prepare(
      `SELECT id, bin, pallet_id, reason, status, team, batch_id
         FROM recounts
        WHERE session_id = ? AND status != 'done'
          AND (team = ? OR (team IS NULL AND COALESCE(first_team, '') != ?))
        ORDER BY CASE WHEN team = ? THEN 0 ELSE 1 END, bin`
    )
    .all(Number(sessionId), t, t, t)
    .map((r) => ({ id: r.id, bin: r.bin, palletId: r.pallet_id, reason: REASONS[r.reason] || r.reason,
                   kind: r.reason === 'CYCLE' ? 'cycle' : 'recount', mine: r.team === t, status: r.status }));
}

export function takeRecount(sessionId, recountId, team) {
  const t = norm(team);
  const r = db.prepare('SELECT * FROM recounts WHERE id = ? AND session_id = ?').get(Number(recountId), Number(sessionId));
  if (!r) throw Object.assign(new Error('recount not found'), { status: 404 });
  if (r.status === 'done') throw Object.assign(new Error('this recount is already done'), { status: 409 });
  if (r.team && r.team !== t) throw Object.assign(new Error(`team ${r.team} already has this recount`), { status: 409 });
  if (r.reason !== 'CYCLE' && r.first_team && r.first_team === t) throw Object.assign(new Error('a different team must do the second count'), { status: 409 });
  db.prepare("UPDATE recounts SET team = ?, status = 'taken', taken_at = COALESCE(taken_at, ?) WHERE id = ?").run(t, now(), r.id);
  return db.prepare('SELECT * FROM recounts WHERE id = ?').get(r.id);
}

export function finishRecount(sessionId, recountId, team) {
  const r = db.prepare('SELECT * FROM recounts WHERE id = ? AND session_id = ?').get(Number(recountId), Number(sessionId));
  if (!r) throw Object.assign(new Error('recount not found'), { status: 404 });
  db.prepare("UPDATE recounts SET status = 'done', done_at = ?, done_by_team = ?, team = COALESCE(team, ?) WHERE id = ?")
    .run(now(), norm(team) || null, norm(team) || null, r.id);
  return db.prepare('SELECT * FROM recounts WHERE id = ?').get(r.id);
}

export function updateRecount(sessionId, recountId, { team, status }) {
  const r = db.prepare('SELECT * FROM recounts WHERE id = ? AND session_id = ?').get(Number(recountId), Number(sessionId));
  if (!r) throw Object.assign(new Error('recount not found'), { status: 404 });
  if (team !== undefined) db.prepare("UPDATE recounts SET team = ?, status = CASE WHEN status = 'done' THEN 'done' ELSE 'open' END WHERE id = ?").run(norm(team) || null, r.id);
  if (status === 'done') db.prepare("UPDATE recounts SET status = 'done', done_at = ? WHERE id = ?").run(now(), r.id);
  if (status === 'open') db.prepare("UPDATE recounts SET status = 'open', done_at = NULL, done_by_team = NULL WHERE id = ?").run(r.id);
  return db.prepare('SELECT * FROM recounts WHERE id = ?').get(r.id);
}

export const deleteRecount = (sessionId, recountId) =>
  db.prepare('DELETE FROM recounts WHERE id = ? AND session_id = ?').run(Number(recountId), Number(sessionId)).changes;
