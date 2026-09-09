import { db } from '../db.js';
import { aisleOverview } from './assignments.js';

export function progress(sessionId) {
  const id = Number(sessionId);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS lines,
              COUNT(DISTINCT CASE WHEN p.pallet_id IS NOT NULL THEN c.pallet_id END) AS pallets_counted,
              COUNT(DISTINCT CASE WHEN p.pallet_id IS NULL THEN c.pallet_id END) AS pallets_unknown,
              COUNT(DISTINCT c.location_code) AS bins_counted,
              COUNT(DISTINCT c.team) AS teams,
              COUNT(DISTINCT c.device_id) AS devices
         FROM counts c
         LEFT JOIN pallets p ON p.session_id = c.session_id AND p.pallet_id = c.pallet_id
        WHERE c.session_id = ? AND c.voided = 0`
    )
    .get(id);

  const binsTotal = db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(id).n;
  const palletsTotal = db.prepare('SELECT COUNT(*) n FROM pallets WHERE session_id = ?').get(id).n;
  const exceptions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM counts
        WHERE session_id = ? AND voided = 0
          AND (unknown_pallet = 1 OR unknown_location = 1 OR off_assignment = 1
               OR duplicate_pallet = 1 OR override_reason IS NOT NULL)`
    )
    .get(id).n;

  const byTeam = db
    .prepare(
      `SELECT c.team,
              COUNT(*) AS lines,
              COUNT(DISTINCT c.location_code) AS bins,
              MAX(c.scanned_at) AS last_scan,
              (SELECT GROUP_CONCAT(DISTINCT device_id) FROM counts d
                WHERE d.session_id = c.session_id AND d.team = c.team AND d.voided = 0) AS devices,
              (SELECT aisle FROM assignments s
                WHERE s.session_id = c.session_id AND s.team = c.team AND s.status = 'active') AS active_aisle
         FROM counts c
        WHERE c.session_id = ? AND c.voided = 0
        GROUP BY c.team
        ORDER BY lines DESC`
    )
    .all(id);

  // Teams that have signed on but not yet counted anything still belong here.
  const signedOn = db
    .prepare(
      `SELECT team, GROUP_CONCAT(DISTINCT device_id) AS devices, MAX(started_at) AS last_signon,
              (SELECT employees FROM signons x WHERE x.session_id = s.session_id AND x.team = s.team
                ORDER BY x.id DESC LIMIT 1) AS employees
         FROM signons s WHERE session_id = ? GROUP BY team`
    )
    .all(id);

  return {
    ...totals,
    bins_total: binsTotal,
    pallets_total: palletsTotal,
    exceptions,
    byTeam,
    signedOn,
    byAisle: aisleOverview(id),
  };
}

/** One row per pallet: expected vs found, with a status a supervisor can act on. */
export function palletReport(sessionId) {
  const id = Number(sessionId);
  const rows = db
    .prepare(
      `WITH counted AS (
         SELECT pallet_id,
                COUNT(*) AS times_counted,
                SUM(qty) AS counted_qty,
                GROUP_CONCAT(DISTINCT location_code) AS found_locations,
                GROUP_CONCAT(DISTINCT team) AS teams,
                MAX(scanned_at) AS last_scan,
                GROUP_CONCAT(comments, ' | ') AS comments
           FROM counts
          WHERE session_id = ? AND voided = 0
          GROUP BY pallet_id
       ),
       keys AS (
         SELECT pallet_id FROM pallets WHERE session_id = ?
         UNION
         SELECT pallet_id FROM counted
       )
       SELECT k.pallet_id,
              p.sku, p.description, p.uom,
              p.expected_qty, p.expected_location,
              c.times_counted, c.counted_qty, c.found_locations, c.teams, c.last_scan, c.comments,
              CASE WHEN p.pallet_id IS NULL THEN 1 ELSE 0 END AS not_in_master
         FROM keys k
         LEFT JOIN pallets p ON p.session_id = ? AND p.pallet_id = k.pallet_id
         LEFT JOIN counted c ON c.pallet_id = k.pallet_id
        ORDER BY k.pallet_id`
    )
    .all(id, id, id);

  return rows.map((r) => {
    const counted = r.times_counted > 0;
    const expectedQty = r.expected_qty;
    const variance = counted && expectedQty != null ? r.counted_qty - expectedQty : null;
    const misplaced =
      counted && r.expected_location && r.found_locations && r.found_locations !== r.expected_location;

    let status;
    if (!counted) status = 'MISSING';
    else if (r.not_in_master) status = 'NOT IN MASTER';
    else if (r.times_counted > 1) status = 'COUNTED TWICE';
    else if (misplaced) status = 'WRONG BIN';
    else if (variance != null && variance !== 0) status = 'QTY VARIANCE';
    else status = 'MATCH';

    return {
      pallet_id: r.pallet_id,
      sku: r.sku || '',
      description: r.description || '',
      uom: r.uom || '',
      expected_qty: expectedQty ?? '',
      counted_qty: counted ? r.counted_qty : '',
      variance_qty: variance ?? '',
      expected_location: r.expected_location || '',
      found_location: r.found_locations || '',
      times_counted: r.times_counted || 0,
      teams: r.teams || '',
      comments: r.comments || '',
      last_scan: r.last_scan || '',
      status,
    };
  });
}

/** Bins that nobody has counted yet, by aisle - the "what is left" list. */
export function uncountedBins(sessionId) {
  return db
    .prepare(
      `SELECT l.code, l.aisle, l.zone
         FROM locations l
        WHERE l.session_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM counts c
             WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0)
        ORDER BY l.aisle, l.code`
    )
    .all(Number(sessionId));
}

export function rawCounts(sessionId) {
  return db
    .prepare(
      `SELECT c.id, c.pallet_id, c.qty, c.location_code, c.aisle, c.sku,
              COALESCE(p.description, '') AS description,
              c.comments, c.team, c.employees, c.device_id,
              c.unknown_pallet, c.unknown_location, c.off_assignment, c.duplicate_pallet,
              c.override_reason, c.voided, c.scanned_at, c.received_at
         FROM counts c
         LEFT JOIN pallets p ON p.session_id = c.session_id AND p.pallet_id = c.pallet_id
        WHERE c.session_id = ?
        ORDER BY c.id`
    )
    .all(Number(sessionId))
    .map((r) => ({ ...r, employees: (JSON.parse(r.employees || '[]') || []).join('; ') }));
}

export const exceptions = (sessionId) =>
  rawCounts(sessionId).filter(
    (r) => r.unknown_pallet || r.unknown_location || r.off_assignment || r.duplicate_pallet || r.override_reason
  );

/** Everything the warehouse map needs: each bin's count state, and each aisle's block and team. */
export function mapData(sessionId) {
  const id = Number(sessionId);
  const bins = db
    .prepare(
      `SELECT l.code, l.aisle,
              (SELECT COUNT(*) FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) AS lines,
              (SELECT COUNT(*) FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0
                  AND (c.unknown_pallet = 1 OR c.unknown_location = 1 OR c.off_assignment = 1 OR c.duplicate_pallet = 1 OR c.override_reason IS NOT NULL)) AS flagged
         FROM locations l WHERE l.session_id = ? ORDER BY l.aisle, l.code`
    )
    .all(id);
  return {
    aisles: aisleOverview(id).map((a) => ({ aisle: a.aisle, block: a.block, activeTeam: a.active_team, queuedTeams: a.queued_teams, done: a.done_count > 0 })),
    bins: bins.map((b) => [b.code, b.aisle, b.lines, b.flagged]),
  };
}
