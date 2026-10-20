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
 *
 * A third count settles a bin the second count did not: when the bin's second
 * count agrees with neither its first count nor the report, nobody knows which
 * number is right. With the count's Third count option on, that raises a
 * round-3 task for a team that did neither of the first two; its lines are
 * pass 3 and stand over both. A supervisor can raise one by hand on any
 * finished second count, option or not.
 */

const now = () => new Date().toISOString();

// What the counter is told. Deliberately no numbers: the second count is blind.
export const REASONS = {
  'QTY VARIANCE': 'Quantity differs from the inventory report',
  'WRONG BIN': 'Pallet found in an unexpected bin',
  // the bin the report had a pallet in, when it turned up elsewhere: is there a second pallet carrying the same label?
  'LABEL CHECK': 'Check for a pallet with a duplicate label',
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
              (SELECT GROUP_CONCAT(pallet_id || ' ×' || qty, ', ') FROM counts c WHERE c.session_id = r.session_id AND c.location_code = r.bin AND c.voided = 0 AND c.pass = 2) AS second_result,
              (SELECT GROUP_CONCAT(pallet_id || ' ×' || qty, ', ') FROM counts c WHERE c.session_id = r.session_id AND c.location_code = r.bin AND c.voided = 0 AND c.pass = 3) AS third_result,
              (SELECT x.id FROM recounts x WHERE x.parent_id = r.id ORDER BY x.id DESC LIMIT 1) AS third_id
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

export function createRecount(sessionId, { bin, palletId, reason = 'MANUAL', detail = '', source = 'manual', firstTeam = null, team = null, round = 2, secondTeam = null, parentId = null }) {
  const id = Number(sessionId);
  const b = norm(bin);
  if (!b) throw Object.assign(new Error('bin required'), { status: 400 });
  const existing = openTaskForBin(id, b);
  if (existing) return { id: existing.id, created: false };
  const info = db
    .prepare(
      `INSERT INTO recounts (session_id, bin, pallet_id, reason, detail, source, first_team, team, status, created_at, round, second_team, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    )
    .run(id, b, palletId ? norm(palletId) : null, REASONS[reason] ? reason : 'MANUAL', String(detail || ''), source,
         firstTeam ? norm(firstTeam) : null, team ? norm(team) : null, now(),
         Number(round) === 3 ? 3 : 2, secondTeam ? norm(secondTeam) : null, parentId ? Number(parentId) : null);
  return { id: info.lastInsertRowid, created: true };
}

/**
 * Is this quantity difference worth sending somebody back for?
 *
 * Either threshold is enough: a hundred units off matters on a big pallet even
 * at one percent, and sixty percent off matters on a small one even at six
 * units. Both default to zero, which raises everything, as it always did.
 */
function materialQty(session, expected, counted) {
  const minQty = Number(session.recount_min_qty || 0);
  const minPct = Number(session.recount_min_pct || 0);
  if (!minQty && !minPct) return true;
  const diff = Math.abs(Number(counted || 0) - Number(expected || 0));
  if (!diff) return false;
  const pct = expected ? (diff / Math.abs(Number(expected))) * 100 : 100;
  return (minQty > 0 && diff >= minQty) || (minPct > 0 && pct >= minPct);
}

const openRecounts = (id) =>
  db.prepare("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND status != 'done'").get(id).n;

/**
 * Raise tasks for every pallet that currently disagrees with the report.
 *
 * MISSING is the one that needs care: a pallet nobody has counted is only
 * missing if somebody has actually been to look. Mid-count, every aisle not
 * reached yet would otherwise be raised as missing stock, which buries the
 * real exceptions - so a pallet counts as missing only once its bin has been
 * counted or its aisle has been handed back.
 */
export function generateFromVariances(sessionId, { onlyPallets = null, includeMissing = true, labelChecks = true } = {}) {
  const id = Number(sessionId);
  const session = getSession(id) || {};
  const cap = Number(session.recount_cap || 0);
  const rows = palletReport(id, { only: onlyPallets }).filter((r) => r.status !== 'MATCH');
  let created = 0;
  let skippedSmall = 0;
  let skippedUnworked = 0;
  let cappedAt = 0;
  const room = () => {
    if (!cap) return true;
    if (openRecounts(id) < cap) return true;
    cappedAt = cap;
    return false;
  };

  /* Reading every counted bin in the warehouse only pays for itself if a MISSING
     row actually turns up, and the check that runs on each gun batch never has
     one - so it is read on first use, not on the way in. */
  let sets = null;
  const lookedIn = (bin) => {
    if (!sets) {
      sets = {
        workedAisles: new Set(
          db.prepare("SELECT DISTINCT aisle FROM assignments WHERE session_id = ? AND status = 'done'").all(id).map((x) => x.aisle)),
        countedBins: new Set(
          db.prepare('SELECT DISTINCT location_code FROM counts WHERE session_id = ? AND voided = 0').all(id).map((x) => x.location_code)),
      };
    }
    if (sets.countedBins.has(bin)) return true;
    const aisle = db.prepare('SELECT aisle FROM locations WHERE session_id = ? AND code = ?').get(id, bin)?.aisle || '';
    return sets.workedAisles.has(aisle);
  };

  for (const r of rows) {
    if (r.recounted) continue; // a second count already settled this bin
    if (r.status === 'SECOND LABEL') continue;   // a tag on a pallet that was counted, not a variance
    if (r.status === 'MISSING') {
      if (!includeMissing || !r.expected_location) continue;
      if (!lookedIn(r.expected_location)) { skippedUnworked++; continue; }
      if (!room()) break;
      if (createRecount(id, { bin: r.expected_location, palletId: r.pallet_id, reason: 'MISSING', detail: `expected ${r.expected_qty ?? '?'} in ${r.expected_location}, never counted`, source: 'auto' }).created) created++;
      continue;
    }
    if (r.status === 'QTY VARIANCE' && !materialQty(session, r.expected_qty, r.counted_qty)) { skippedSmall++; continue; }
    const firstTeam = db.prepare(
      `SELECT team FROM counts WHERE session_id = ? AND pallet_id = ? AND voided = 0 AND pass = 1 ORDER BY id DESC LIMIT 1`).get(id, r.pallet_id)?.team || null;
    const bins = String(r.found_location || '').split(',').filter(Boolean);
    const detail = r.status === 'QTY VARIANCE' ? `expected ${r.expected_qty}, first count ${r.counted_qty}`
      : r.status === 'WRONG BIN' ? `expected in ${r.expected_location}, found in ${r.found_location}`
      : r.status === 'COUNTED TWICE' ? `found in ${r.found_location}`
      : `qty ${r.counted_qty}, not on the report`;
    for (const bin of bins) {
      if (!room()) break;
      if (createRecount(id, { bin, palletId: r.pallet_id, reason: r.status, detail, source: 'auto', firstTeam }).created) created++;
    }
    /* Found somewhere other than the report said: the report's own bin is
       counted again too, in case a second pallet there carries the same label -
       one label printed twice is the thing this catches. Once that bin has been
       counted (or its aisle handed back), so a second count never runs ahead
       of the first. */
    if (labelChecks && r.status === 'WRONG BIN' && r.expected_location && !bins.includes(r.expected_location)) {
      if (!lookedIn(r.expected_location)) { skippedUnworked++; continue; }
      if (!room()) break;
      if (labelCheck(id, r).created) created++;
    }
  }
  return { created, considered: rows.length, skippedSmall, skippedUnworked, cappedAt };
}

/* The report's bin, counted again: a blind count, by a team other than the one that first counted it. */
function labelCheck(id, r) {
  /* once: a bin that has had a second count already - this check, or one for
     another reason, done or still open - has been looked at by a second team */
  if (db.prepare('SELECT 1 FROM recounts WHERE session_id = ? AND bin = ?').get(id, norm(r.expected_location))) return { created: false };
  const firstTeam = db.prepare(
    'SELECT team FROM counts WHERE session_id = ? AND location_code = ? AND voided = 0 AND pass = 1 ORDER BY id LIMIT 1').get(id, r.expected_location)?.team || null;
  return createRecount(id, { bin: r.expected_location, palletId: r.pallet_id, reason: 'LABEL CHECK',
    detail: `the report had ${r.pallet_id} here; it was found in ${r.found_location} - is there a second pallet with the same label?`, source: 'auto', firstTeam });
}

/* Pallets found in the wrong bin whose report bin has now been counted: the label check, raised then. */
function labelChecksForBins(id, bins) {
  const want = [...new Set([...bins].map(norm).filter(Boolean))];
  if (!want.length) return 0;
  // one read, not the whole pallet report on every batch: report pallets of these bins counted only somewhere else
  const rows = db.prepare(
    `SELECT p.pallet_id, p.expected_location, GROUP_CONCAT(DISTINCT c.location_code) AS found_location
       FROM pallets p JOIN counts c ON c.session_id = p.session_id AND c.pallet_id = p.pallet_id AND c.voided = 0 AND c.empty_bin = 0
      WHERE p.session_id = ? AND p.expected_location IN (SELECT value FROM json_each(?))
      GROUP BY p.pallet_id
     HAVING SUM(c.location_code = p.expected_location) = 0`).all(id, JSON.stringify(want));
  let created = 0;
  for (const r of rows) if (labelCheck(id, r).created) created++;
  return created;
}

/** Called after a batch of first-count lines lands, when the session auto-recounts. */
export function autoAfterCounts(sessionId, palletIds, bins = []) {
  const s = getSession(sessionId);
  if (!s || !s.auto_recount || (!palletIds.length && !bins.length)) return { created: 0 };
  const out = palletIds.length ? generateFromVariances(sessionId, { onlyPallets: new Set(palletIds.map(norm)), includeMissing: false }) : { created: 0 };
  // a bin just counted may be the report's bin of a pallet already found elsewhere
  out.created += labelChecksForBins(Number(sessionId), bins);
  return out;
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
  // the aisle handed back: its bins are looked in, so pallets found elsewhere get their label check here
  const binsHere = db.prepare('SELECT code FROM locations WHERE session_id = ? AND aisle = ?').all(id, norm(aisle)).map((x) => x.code)
    .filter((b) => !levels || levels.includes(b.replace(/^[A-Z]+\d+/, '')[0] || ''));
  created += labelChecksForBins(id, binsHere);
  return { created };
}

/** Tasks a team may work: assigned to it, or unassigned and not its own first count. */
export function tasksForTeam(sessionId, team) {
  const t = norm(team);
  const id = Number(sessionId);
  /* Nearest first. A list in bin order sends a team that has just finished F11
     to F01; this one starts with the aisle they are in, then the racking block
     they are in, then the aisles nearest by number - still their own tasks
     before anybody's. */
  const where = db.prepare(
    "SELECT aisle FROM assignments WHERE session_id = ? AND team = ? AND status IN ('active', 'done') ORDER BY status = 'done', position DESC, id DESC LIMIT 1")
    .get(id, t)?.aisle
    || db.prepare('SELECT aisle FROM counts WHERE session_id = ? AND team = ? AND voided = 0 ORDER BY id DESC LIMIT 1').get(id, t)?.aisle
    || null;
  const aisleOf = new Map(db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(id).map((l) => [l.code, l.aisle]));
  const blockOf = new Map(db.prepare('SELECT aisle, block FROM aisles WHERE session_id = ?').all(id).map((a) => [a.aisle, a.block]));
  const num = (a) => Number(String(a || '').replace(/\D/g, '')) || 0;
  const distance = (bin) => {
    if (!where) return 0;
    const a = aisleOf.get(bin) || String(bin).slice(0, 3);
    if (a === where) return 0;
    if (blockOf.has(a) && blockOf.get(a) === blockOf.get(where)) return 1;
    return 2 + Math.abs(num(a) - num(where));
  };
  return db
    .prepare(
      `SELECT id, bin, pallet_id, reason, status, team, batch_id, round
         FROM recounts
        WHERE session_id = ? AND status != 'done'
          AND (team = ? OR (team IS NULL AND COALESCE(first_team, '') != ? AND COALESCE(second_team, '') != ?))
        ORDER BY CASE WHEN team = ? THEN 0 ELSE 1 END, bin`
    )
    .all(id, t, t, t, t)
    .map((r) => ({ id: r.id, bin: r.bin, palletId: r.pallet_id, round: r.reason === 'CYCLE' ? 1 : (Number(r.round) === 3 ? 3 : 2),
                   reason: Number(r.round) === 3 ? `Third count — ${REASONS[r.reason] || r.reason}` : (REASONS[r.reason] || r.reason),
                   kind: r.reason === 'CYCLE' ? 'cycle' : 'recount', mine: r.team === t, status: r.status }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || distance(a.bin) - distance(b.bin) || a.bin.localeCompare(b.bin, undefined, { numeric: true }));
}

export function takeRecount(sessionId, recountId, team) {
  const t = norm(team);
  const r = db.prepare('SELECT * FROM recounts WHERE id = ? AND session_id = ?').get(Number(recountId), Number(sessionId));
  if (!r) throw Object.assign(new Error('recount not found'), { status: 404 });
  if (r.status === 'done') throw Object.assign(new Error('this recount is already done'), { status: 409 });
  if (r.team && r.team !== t) throw Object.assign(new Error(`team ${r.team} already has this recount`), { status: 409 });
  if (Number(r.round) === 3) {
    // a supervisor who hands it to a team has made the call; an open one goes to a team that did neither count
    if (!r.team && [r.first_team, r.second_team].includes(t)) throw Object.assign(new Error('a third team must do the third count - not one that did the first or the second'), { status: 409 });
  } else if (r.reason !== 'CYCLE' && r.first_team && r.first_team === t) throw Object.assign(new Error('a different team must do the second count'), { status: 409 });
  db.prepare("UPDATE recounts SET team = ?, status = 'taken', taken_at = COALESCE(taken_at, ?) WHERE id = ?").run(t, now(), r.id);
  return db.prepare('SELECT * FROM recounts WHERE id = ?').get(r.id);
}

export function finishRecount(sessionId, recountId, team) {
  const r = db.prepare('SELECT * FROM recounts WHERE id = ? AND session_id = ?').get(Number(recountId), Number(sessionId));
  if (!r) throw Object.assign(new Error('recount not found'), { status: 404 });
  db.prepare("UPDATE recounts SET status = 'done', done_at = ?, done_by_team = ?, team = COALESCE(team, ?) WHERE id = ?")
    .run(now(), norm(team) || null, norm(team) || null, r.id);
  const done = db.prepare('SELECT * FROM recounts WHERE id = ?').get(r.id);
  // the second count did not settle it: a third, when the count asks for them
  const s = getSession(sessionId);
  const third = s && s.third_count && r.status !== 'done' ? autoThirdCount(sessionId, done) : null;
  return third ? { ...done, third } : done;
}

/* ------------------------------------------------------------- third counts */

/** What a bin holds by one count: pallet -> quantity. An empty bin is an empty map. */
function binByPass(id, bin, pass) {
  const out = new Map();
  for (const c of db.prepare('SELECT pallet_id, qty FROM counts WHERE session_id = ? AND location_code = ? AND pass = ? AND voided = 0 AND empty_bin = 0').all(id, bin, pass)) {
    out.set(c.pallet_id, (out.get(c.pallet_id) || 0) + Number(c.qty || 0));
  }
  return out;
}
const binExpected = (id, bin) => new Map(db.prepare('SELECT pallet_id, expected_qty FROM pallets WHERE session_id = ? AND expected_location = ?').all(id, bin)
  .map((p) => [p.pallet_id, Number(p.expected_qty || 0)]));
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && Number(b.get(k)) === Number(v));
const words = (m) => (m.size ? [...m].map(([k, v]) => `${k} ×${v}`).join(', ') : 'nothing');

/** Does this bin's second count leave it open? It agrees with neither the first count nor the report. */
export function secondCountVerdict(sessionId, bin) {
  const id = Number(sessionId);
  const b = norm(bin);
  const first = binByPass(id, b, 1);
  const second = binByPass(id, b, 2);
  const report = binExpected(id, b);
  const counted = db.prepare('SELECT 1 FROM counts WHERE session_id = ? AND location_code = ? AND pass = 2 AND voided = 0 LIMIT 1').get(id, b);
  if (!counted) return { settled: false, why: 'not second-counted yet', first, second, report };
  if (same(second, first)) return { settled: true, why: 'the second count agrees with the first', first, second, report };
  if (same(second, report)) return { settled: true, why: 'the second count agrees with the report', first, second, report };
  return { settled: false, why: 'the second count agrees with neither the first count nor the report', first, second, report };
}

/** A third count of a bin: by hand, or when its second count settled nothing. */
export function raiseThirdCount(sessionId, recountId, { source = 'manual', team = null } = {}) {
  const id = Number(sessionId);
  const r = db.prepare('SELECT * FROM recounts WHERE id = ? AND session_id = ?').get(Number(recountId), id);
  if (!r) throw Object.assign(new Error('second count not found'), { status: 404 });
  if (r.reason === 'CYCLE') throw Object.assign(new Error('a cycle count is not second-counted, so it has no third count'), { status: 409 });
  if (Number(r.round) === 3) throw Object.assign(new Error('this is a third count already'), { status: 409 });
  if (r.status !== 'done') throw Object.assign(new Error('the second count is not finished yet'), { status: 409 });
  const v = secondCountVerdict(id, r.bin);
  const created = createRecount(id, {
    bin: r.bin, palletId: r.pallet_id, reason: r.reason, source, round: 3, parentId: r.id, team,
    firstTeam: r.first_team || db.prepare('SELECT team FROM counts WHERE session_id = ? AND location_code = ? AND pass = 1 AND voided = 0 ORDER BY id LIMIT 1').get(id, r.bin)?.team || null,
    secondTeam: r.done_by_team || r.team || db.prepare('SELECT team FROM counts WHERE session_id = ? AND location_code = ? AND pass = 2 AND voided = 0 ORDER BY id LIMIT 1').get(id, r.bin)?.team || null,
    detail: `third count: first ${words(v.first)}; second ${words(v.second)}; report ${words(v.report)}`,
  });
  return { ...created, bin: r.bin, why: v.why };
}

function autoThirdCount(sessionId, task) {
  if (task.reason === 'CYCLE' || Number(task.round) === 3) return null;
  if (db.prepare('SELECT 1 FROM recounts WHERE parent_id = ?').get(task.id)) return null;   // raised already
  const v = secondCountVerdict(sessionId, task.bin);
  // its lines not in yet (a gun sends them when it has signal): judged when they arrive
  if (v.settled || v.why === 'not second-counted yet') return null;
  const out = raiseThirdCount(sessionId, task.id, { source: 'auto' });
  return out.created ? out : null;
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

/** Second-count lines that reached the server after their task was finished: judged now. */
export function thirdCountsForBins(sessionId, bins = []) {
  const s = getSession(sessionId);
  if (!s || !s.third_count || !bins.length) return { created: 0 };
  let created = 0;
  for (const bin of new Set(bins.map(norm))) {
    const task = db.prepare("SELECT * FROM recounts WHERE session_id = ? AND bin = ? AND status = 'done' AND round = 2 AND reason != 'CYCLE' ORDER BY id DESC LIMIT 1").get(Number(sessionId), bin);
    if (task && autoThirdCount(sessionId, task)) created++;
  }
  return { created };
}
