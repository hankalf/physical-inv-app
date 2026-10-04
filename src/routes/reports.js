import { db, LIVE } from '../db.js';
import { aisleOverview } from './assignments.js';

export function progress(sessionId) {
  const id = Number(sessionId);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS lines,
              COUNT(DISTINCT CASE WHEN p.pallet_id IS NOT NULL THEN c.pallet_id END) AS pallets_counted,
              COUNT(DISTINCT CASE WHEN p.pallet_id IS NULL AND c.empty_bin = 0 THEN c.pallet_id END) AS pallets_unknown,
              SUM(c.empty_bin) AS empty_bins,
              COUNT(DISTINCT c.location_code) AS bins_counted,
              COUNT(DISTINCT c.team) AS teams,
              COUNT(DISTINCT c.device_id) AS devices
         FROM counts c
         LEFT JOIN pallets p ON p.session_id = c.session_id AND p.pallet_id = c.pallet_id
        WHERE c.session_id = ? AND c.voided = 0`
    )
    .get(id);

  const bySource = sourcesOf(id);
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

  const recounts = db.prepare(`SELECT
      SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
      FROM recounts WHERE session_id = ?`).get(id);
  return {
    bySource,
    ...totals,
    recounts_open: recounts.open || 0,
    recounts_done: recounts.done || 0,
    bins_total: binsTotal,
    pallets_total: palletsTotal,
    exceptions,
    byTeam,
    signedOn,
    byAisle: aisleOverview(id),
  };
}

/** One row per pallet: expected vs found, with a status a supervisor can act on. */
/**
 * One row per pallet: expected vs found, with a status a supervisor can act on.
 *
 * `only` narrows it to a handful of pallets. The auto second-count check runs on
 * every batch a gun sends, and a full count has six figures of pallets in it -
 * re-reading all of them to judge five is what would make counting crawl once
 * the whole floor is working.
 */
export function palletReport(sessionId, { only = null } = {}) {
  const id = Number(sessionId);
  const ids = only ? [...only] : null;
  const filter = ids && ids.length ? ` AND pallet_id IN (${ids.map(() => '?').join(',')})` : '';
  if (ids && !ids.length) return [];
  /* Five indexed passes and a join in memory. One query with the aggregates as
     CTEs read well but SQLite joined the materialised CTEs by nested loop: on a
     twenty-thousand-bin count that was six seconds, during which nothing else
     on the server moved. This is under a tenth of a second on the same count. */
  const inList = filter ? ` AND pallet_id IN (${ids.map(() => '?').join(',')})` : '';
  const args = ids ? [id, ...ids] : [id];
  const counted = new Map(db.prepare(
    `SELECT pallet_id,
            COUNT(*) AS times_counted,
            SUM(qty) AS counted_qty,
            GROUP_CONCAT(DISTINCT location_code) AS found_locations,
            GROUP_CONCAT(DISTINCT team) AS teams,
            GROUP_CONCAT(DISTINCT lot) AS counted_lots,
            SUM(CASE WHEN alias_of IS NULL THEN 0 ELSE 1 END) AS alias_lines,
            MAX(alias_of) AS alias_of,
            MIN(expiry) AS counted_expiry,
            MAX(scanned_at) AS last_scan,
            GROUP_CONCAT(comments, ' | ') AS comments,
            MAX(pass) AS max_pass
       FROM counts
      WHERE session_id = ? AND ${LIVE('counts')} AND empty_bin = 0${inList}
      GROUP BY pallet_id`).all(...args).map((r) => [r.pallet_id, r]));
  const firstpass = new Map(db.prepare(
    `SELECT pallet_id, SUM(qty) AS first_qty, GROUP_CONCAT(DISTINCT location_code) AS first_locations
       FROM counts WHERE session_id = ? AND voided = 0 AND pass = 1 AND empty_bin = 0${inList} GROUP BY pallet_id`).all(...args).map((r) => [r.pallet_id, r]));
  const tagged = new Map(db.prepare(
    `SELECT alias_of AS pallet_id, GROUP_CONCAT(DISTINCT pallet_id) AS also_tagged
       FROM counts WHERE session_id = ? AND voided = 0 AND alias_of IS NOT NULL GROUP BY alias_of`).all(id).map((r) => [r.pallet_id, r.also_tagged]));
  const openRecounts = new Map(db.prepare(
    `SELECT pallet_id, COUNT(*) AS n FROM recounts WHERE session_id = ? AND status != 'done' AND pallet_id IS NOT NULL GROUP BY pallet_id`).all(id).map((r) => [r.pallet_id, r.n]));
  const master = db.prepare(
    `SELECT pallet_id, sku, description, uom, COALESCE(source, '') AS source, expected_qty, expected_location, lot AS expected_lot, expiry AS expected_expiry
       FROM pallets WHERE session_id = ?${inList}`).all(...args);
  const seen = new Set(master.map((p) => p.pallet_id));
  const keys = master.map((p) => p.pallet_id);
  for (const k of counted.keys()) if (!seen.has(k)) keys.push(k);
  keys.sort();
  const byId = new Map(master.map((p) => [p.pallet_id, p]));
  const rows = keys.map((k) => {
    const p = byId.get(k) || null;
    const c = counted.get(k) || null;
    const f = firstpass.get(k) || null;
    return {
      pallet_id: k,
      sku: p ? p.sku : null, description: p ? p.description : null, uom: p ? p.uom : null, source: p ? p.source : '',
      expected_qty: p ? p.expected_qty : null, expected_location: p ? p.expected_location : null,
      expected_lot: p ? p.expected_lot : null, expected_expiry: p ? p.expected_expiry : null,
      times_counted: c ? c.times_counted : null, counted_qty: c ? c.counted_qty : null, found_locations: c ? c.found_locations : null,
      teams: c ? c.teams : null, last_scan: c ? c.last_scan : null, comments: c ? c.comments : null, max_pass: c ? c.max_pass : null,
      counted_lots: c ? c.counted_lots : null, counted_expiry: c ? c.counted_expiry : null, alias_lines: c ? c.alias_lines : null, alias_of: c ? c.alias_of : null,
      also_tagged: tagged.get(k) || null,
      first_qty: f ? f.first_qty : null, first_locations: f ? f.first_locations : null,
      open_recounts: openRecounts.get(k) || 0,
      not_in_master: p ? 0 : 1,
    };
  });

  return rows.map((r) => {
    const counted = r.times_counted > 0;
    const expectedQty = r.expected_qty;
    const variance = counted && expectedQty != null ? r.counted_qty - expectedQty : null;
    const misplaced =
      counted && r.expected_location && r.found_locations && r.found_locations !== r.expected_location;

    /* Lot and expiry are orthogonal to quantity: a pallet can be the right
       count of the wrong lot, so they get their own columns rather than
       competing for the one status. Blank when the site does not track them. */
    const foundLot = r.counted_lots || '';
    let lotStatus = '';
    if (foundLot && r.expected_lot) lotStatus = foundLot === r.expected_lot ? 'LOT MATCH' : 'WRONG LOT';
    else if (foundLot && !r.expected_lot) lotStatus = 'LOT NOT ON REPORT';
    else if (!foundLot && r.expected_lot && counted) lotStatus = 'NO LOT SCANNED';

    const expiry = r.counted_expiry || r.expected_expiry || '';
    const today = new Date().toISOString().slice(0, 10);
    let expiryStatus = '';
    if (expiry) {
      const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      expiryStatus = expiry < today ? 'EXPIRED' : expiry <= soon ? 'EXPIRES SOON' : 'IN DATE';
    }

    /* A pallet whose every line is a second label is not a pallet that was
       counted: it is a tag on one that was. Saying so beats MISSING, which
       would send somebody back to look for a pallet that is right there. */
    const aliasOnly = counted && r.alias_lines > 0 && r.alias_lines === r.times_counted;

    let status;
    if (aliasOnly) status = 'SECOND LABEL';
    else if (!counted) status = 'MISSING';
    else if (r.not_in_master) status = 'NOT IN MASTER';
    else if (r.times_counted > 1) status = 'COUNTED TWICE';
    else if (misplaced) status = 'WRONG BIN';
    else if (variance != null && variance !== 0) status = 'QTY VARIANCE';
    else status = 'MATCH';

    return {
      pallet_id: r.pallet_id,
      source: r.source || '',
      sku: r.sku || '',
      description: r.description || '',
      uom: r.uom || '',
      expected_qty: expectedQty ?? '',
      counted_qty: counted ? r.counted_qty : '',
      variance_qty: aliasOnly ? '' : (variance ?? ''),
      expected_location: r.expected_location || '',
      found_location: r.found_locations || '',
      times_counted: r.times_counted || 0,
      teams: r.teams || '',
      comments: r.comments || '',
      last_scan: r.last_scan || '',
      recounted: r.max_pass === 2 ? 1 : 0,
      first_count_qty: r.max_pass === 2 ? (r.first_qty ?? '') : '',
      open_recounts: r.open_recounts || 0,
      alias_of: r.alias_of || '',
      also_tagged: r.also_tagged || '',
      expected_lot: r.expected_lot || '',
      found_lot: foundLot,
      lot_status: lotStatus,
      expiry: expiry,
      expiry_status: expiryStatus,
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

/**
 * The systems the report came from, and how far each is counted. Three ERPs
 * share this warehouse, so the office reads the count per system; a report
 * uploaded without a system shows as one unnamed group.
 */
export function sourcesOf(sessionId) {
  return db.prepare(
    `SELECT COALESCE(p.source, '') AS source, COUNT(*) AS pallets,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM counts c WHERE c.session_id = p.session_id AND c.pallet_id = p.pallet_id AND c.voided = 0) THEN 1 ELSE 0 END) AS counted
       FROM pallets p WHERE p.session_id = ? GROUP BY COALESCE(p.source, '') ORDER BY COALESCE(p.source, '')`).all(Number(sessionId));
}

export function rawCounts(sessionId) {
  return db
    .prepare(
      `SELECT c.id, c.pallet_id, c.qty, c.location_code, c.aisle, c.sku,
              COALESCE(p.description, '') AS description, COALESCE(p.source, '') AS source,
              c.lot, c.expiry, c.alias_of,
              c.comments, c.team, c.employees, c.device_id,
              c.unknown_pallet, c.unknown_location, c.off_assignment, c.duplicate_pallet, c.empty_bin,
              c.label_issue, c.bin_label_issue,
              c.pass, c.recount_id, c.override_reason, c.voided, c.scanned_at, c.received_at
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
      || r.label_issue || r.bin_label_issue
  );

/*
 * Pallets whose label would not scan.
 *
 * A damaged barcode does not stop a count - the counter says so and carries on -
 * but it does leave a pallet in the racking that the next person cannot scan
 * either. This is the walk-round afterwards: which bin, what was counted, and
 * whether there was a number on it at all.
 */
const PALLET_ISSUE = {
  typed: 'BARCODE WOULD NOT SCAN',
  none: 'NO READABLE ID',
};
const BIN_ISSUE = {
  typed: 'BARCODE WOULD NOT SCAN',
  assumed: 'NO READABLE LABEL - BIN TAKEN FROM THE PLAN',
  none: 'NO READABLE LABEL',
};

export function labelsToReplace(sessionId) {
  const rows = db
    .prepare(
      `SELECT c.pallet_id, c.location_code, c.aisle, c.qty, c.label_issue, c.bin_label_issue, c.sku,
              COALESCE(p.description, '') AS description,
              c.team, c.device_id, c.comments, c.scanned_at
         FROM counts c
         LEFT JOIN pallets p ON p.session_id = c.session_id AND p.pallet_id = c.pallet_id
        WHERE c.session_id = ? AND c.voided = 0 AND (c.label_issue != '' OR c.bin_label_issue != '')
        ORDER BY c.location_code, c.scanned_at`
    )
    .all(Number(sessionId));

  /* One row per label to print, not per line - a pallet with no label sitting in
     a bin with no label is two labels, and whoever walks out there needs both on
     the list. The rack ones come first: every counter after this one walks up to
     that bin too. */
  const out = [];
  for (const r of rows) {
    if (r.bin_label_issue) {
      out.push({ ...r, what: 'BIN', issue: BIN_ISSUE[r.bin_label_issue] || 'LABEL PROBLEM' });
    }
    if (r.label_issue) {
      out.push({ ...r, what: 'PALLET', issue: PALLET_ISSUE[r.label_issue] || 'LABEL PROBLEM' });
    }
  }
  return out.sort((a, b) => (a.what === b.what ? 0 : a.what === 'BIN' ? -1 : 1));
}

/** Everything the warehouse map needs: each bin's count state, and each aisle's block and team. */
export function mapData(sessionId) {
  const id = Number(sessionId);
  /* One pass over the counts, not two lookups per bin: the warehouse has ~14,000
     bins and this is the screen supervisors leave open all day. */
  const bins = db
    .prepare(
      `SELECT l.code, l.aisle, COALESCE(c.lines, 0) AS lines, COALESCE(c.flagged, 0) AS flagged
         FROM locations l
         LEFT JOIN (
           SELECT location_code,
                  COUNT(*) AS lines,
                  SUM(CASE WHEN unknown_pallet = 1 OR unknown_location = 1 OR off_assignment = 1
                             OR duplicate_pallet = 1 OR override_reason IS NOT NULL THEN 1 ELSE 0 END) AS flagged
             FROM counts WHERE session_id = ? AND voided = 0 GROUP BY location_code
         ) c ON c.location_code = l.code
        WHERE l.session_id = ? ORDER BY l.aisle, l.code`
    )
    .all(id, id);
  return {
    aisles: aisleOverview(id).map((a) => ({
      aisle: a.aisle, block: a.block, zone: a.zone || '',
      bins: a.bins, counted: a.bins_counted, lines: a.pallets_counted,
      activeTeam: a.active_team, activeDetail: a.active_detail,
      queuedTeams: a.queued_teams, done: a.done_count > 0,
    })),
    bins: bins.map((b) => [b.code, b.aisle, b.lines, b.flagged]),
  };
}

/**
 * Where a lot is, across the whole count. The question after a recall notice:
 * "where is every case of lot 4471?" - answerable from what was counted, not
 * from what the ERP believed before the count started.
 */
export function findLot(sessionId, lot) {
  const id = Number(sessionId);
  const needle = String(lot || '').trim().toUpperCase();
  if (!needle) return { lot: '', counted: [], expected: [] };
  const like = `%${needle}%`;
  return {
    lot: needle,
    counted: db.prepare(
      `SELECT c.pallet_id, c.lot, c.expiry, c.qty, c.location_code, c.aisle, c.team, c.scanned_at,
              COALESCE(p.sku, '') AS sku, COALESCE(p.description, '') AS description
         FROM counts c LEFT JOIN pallets p ON p.session_id = c.session_id AND p.pallet_id = c.pallet_id
        WHERE c.session_id = ? AND c.voided = 0 AND UPPER(COALESCE(c.lot, '')) LIKE ?
        ORDER BY c.location_code LIMIT 500`).all(id, like),
    expected: db.prepare(
      `SELECT pallet_id, lot, expiry, expected_qty, expected_location, COALESCE(sku, '') AS sku,
              COALESCE(description, '') AS description
         FROM pallets WHERE session_id = ? AND UPPER(COALESCE(lot, '')) LIKE ?
        ORDER BY expected_location LIMIT 500`).all(id, like),
  };
}
