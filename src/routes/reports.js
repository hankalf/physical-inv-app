import { db, LIVE, getSession } from '../db.js';
import { aisleOverview } from './assignments.js';
import { shortNames } from './people.js';

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
  /* the count in money, when the report carries costs: what the report is worth,
     what has been counted so far, and the difference between them so far */
  const value = db.prepare('SELECT 1 FROM pallets WHERE session_id = ? AND (cost IS NOT NULL OR amount IS NOT NULL) LIMIT 1').get(id) ? (() => {
    let expected = 0, counted = 0, variance = 0, over = 0, under = 0;
    for (const r of palletReport(id)) {
      if (r.expected_amount !== '') expected += Number(r.expected_amount);
      if (r.counted_amount !== '') counted += Number(r.counted_amount);
      if (r.variance_amount !== '') { variance += Number(r.variance_amount); if (r.variance_amount > 0) over += Number(r.variance_amount); else under += Number(r.variance_amount); }
    }
    const cents = (n) => Math.round(n * 100) / 100;
    return { expected: cents(expected), counted: cents(counted), variance: cents(variance), over: cents(over), under: cents(under) };
  })() : null;
  const palletsTotal = db.prepare('SELECT COUNT(*) n FROM pallets WHERE session_id = ?').get(id).n;
  const exceptions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM counts
        WHERE session_id = ? AND voided = 0
          AND (unknown_pallet = 1 OR unknown_location = 1 OR off_assignment = 1
               OR duplicate_pallet = 1 OR override_reason IS NOT NULL)`
    )
    .get(id).n;

  /* One pass for the figures; the scanners and the aisle each team is on come
     from their own small reads rather than a lookup per team inside the pass. */
  const byTeam = db
    .prepare(
      `SELECT c.team,
              COUNT(*) AS lines,
              COUNT(DISTINCT c.location_code) AS bins,
              MAX(c.scanned_at) AS last_scan,
              GROUP_CONCAT(DISTINCT c.device_id) AS devices
         FROM counts c
        WHERE c.session_id = ? AND c.voided = 0
        GROUP BY c.team
        ORDER BY lines DESC`
    )
    .all(id);
  const activeAisle = new Map();
  for (const r of db.prepare("SELECT team, aisle FROM assignments WHERE session_id = ? AND status = 'active' ORDER BY id").all(id)) if (!activeAisle.has(r.team)) activeAisle.set(r.team, r.aisle);
  for (const t of byTeam) t.active_aisle = activeAisle.get(t.team) ?? null;

  // Teams that have signed on but not yet counted anything still belong here.
  const signedOn = db
    .prepare(
      `SELECT team, GROUP_CONCAT(DISTINCT device_id) AS devices, MAX(started_at) AS last_signon,
              (SELECT employees FROM signons x WHERE x.session_id = s.session_id AND x.team = s.team
                ORDER BY x.id DESC LIMIT 1) AS employees
         FROM signons s WHERE session_id = ? GROUP BY team`
    )
    .all(id)
    // who is on the gun, as names for the screen; the numbers stay for the files
    .map((r) => { let b = []; try { b = JSON.parse(r.employees || '[]'); } catch { b = []; } return { ...r, names: shortNames(b) }; });

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
    value,
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
  const secondpass = new Map(db.prepare(
    `SELECT pallet_id, SUM(qty) AS second_qty
       FROM counts WHERE session_id = ? AND voided = 0 AND pass = 2 AND empty_bin = 0${inList} GROUP BY pallet_id`).all(...args).map((r) => [r.pallet_id, r]));
  const tagged = new Map(db.prepare(
    `SELECT alias_of AS pallet_id, GROUP_CONCAT(DISTINCT pallet_id) AS also_tagged
       FROM counts WHERE session_id = ? AND voided = 0 AND alias_of IS NOT NULL GROUP BY alias_of`).all(id).map((r) => [r.pallet_id, r.also_tagged]));
  const openRecounts = new Map(db.prepare(
    `SELECT pallet_id, COUNT(*) AS n FROM recounts WHERE session_id = ? AND status != 'done' AND pallet_id IS NOT NULL GROUP BY pallet_id`).all(id).map((r) => [r.pallet_id, r.n]));
  const master = db.prepare(
    `SELECT pallet_id, sku, description, uom, COALESCE(source, '') AS source, COALESCE(variant, '') AS variant, COALESCE(entry_no, '') AS entry_no,
            expected_qty, expected_location, lot AS expected_lot, expiry AS expected_expiry, cost, amount, cost_source
       FROM pallets WHERE session_id = ?${inList}`).all(...args);
  // a lot the counter never scanned is only worth a word when the count asked for lots
  const asksLot = !!(getSession(id) || {}).ask_lot;
  const seen = new Set(master.map((p) => p.pallet_id));
  const keys = master.map((p) => p.pallet_id);
  for (const k of counted.keys()) if (!seen.has(k)) keys.push(k);
  keys.sort();
  const byId = new Map(master.map((p) => [p.pallet_id, p]));
  // the dates the expiry column is judged against: once, not once a pallet
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  /* One pass: each pallet's master line, what was counted and the first count
     side by side, straight into the row the report shows. */
  return keys.map((k) => {
    const p = byId.get(k) || null;
    const c = counted.get(k) || null;
    const f = firstpass.get(k) || null;
    const timesCounted = c ? c.times_counted : 0;
    const isCounted = timesCounted > 0;
    const expectedQty = p ? p.expected_qty : null;
    const expectedLocation = p ? p.expected_location : null;
    const expectedLot = p ? p.expected_lot : null;
    const foundLocations = c ? c.found_locations : null;
    const variance = isCounted && expectedQty != null ? c.counted_qty - expectedQty : null;
    const misplaced = isCounted && expectedLocation && foundLocations && foundLocations !== expectedLocation;

    /* Lot and expiry are orthogonal to quantity: a pallet can be the right
       count of the wrong lot, so they get their own columns rather than
       competing for the one status. Blank when the site does not track them. */
    const foundLot = (c && c.counted_lots) || '';
    let lotStatus = '';
    if (foundLot && expectedLot) lotStatus = foundLot === expectedLot ? 'LOT MATCH' : 'WRONG LOT';
    else if (foundLot && !expectedLot) lotStatus = 'LOT NOT ON REPORT';
    else if (!foundLot && expectedLot && isCounted && asksLot) lotStatus = 'NO LOT SCANNED';

    const expiry = (c && c.counted_expiry) || (p && p.expected_expiry) || '';
    const expiryStatus = !expiry ? '' : expiry < today ? 'EXPIRED' : expiry <= soon ? 'EXPIRES SOON' : 'IN DATE';

    /* A pallet whose every line is a second label is not a pallet that was
       counted: it is a tag on one that was. Saying so beats MISSING, which
       would send somebody back to look for a pallet that is right there. */
    const aliasOnly = isCounted && c.alias_lines > 0 && c.alias_lines === timesCounted;

    let status;
    if (aliasOnly) status = 'SECOND LABEL';
    else if (!isCounted) status = 'MISSING';
    else if (!p) status = 'NOT IN MASTER';
    else if (timesCounted > 1) status = 'COUNTED TWICE';
    else if (misplaced) status = 'WRONG BIN';
    else if (variance != null && variance !== 0) status = 'QTY VARIANCE';
    else status = 'MATCH';

    const maxPass = c ? c.max_pass : null;
    /* the same difference in money: the report's unit cost, what it said the
       pallet was worth, what was counted, and the difference */
    const cost = p && p.cost != null ? Number(p.cost) : null;
    const cents = (n) => Math.round(n * 100) / 100;
    const expectedAmount = p && p.amount != null ? cents(Number(p.amount)) : cost != null && expectedQty != null ? cents(expectedQty * cost) : null;
    const countedAmount = isCounted && cost != null && !aliasOnly ? cents(c.counted_qty * cost) : null;
    const varianceAmount = variance != null && cost != null && !aliasOnly ? cents(variance * cost) : null;
    return {
      pallet_id: k,
      source: (p && p.source) || '',
      variant: (p && p.variant) || '',
      entry_no: (p && p.entry_no) || '',
      sku: (p && p.sku) || '',
      description: (p && p.description) || '',
      uom: (p && p.uom) || '',
      expected_qty: expectedQty ?? '',
      counted_qty: isCounted ? c.counted_qty : '',
      variance_qty: aliasOnly ? '' : (variance ?? ''),
      cost: cost ?? '',
      cost_source: (p && p.cost_source) || '',
      expected_amount: expectedAmount ?? '',
      counted_amount: countedAmount ?? '',
      variance_amount: varianceAmount ?? '',
      expected_location: expectedLocation || '',
      found_location: foundLocations || '',
      times_counted: timesCounted || 0,
      teams: (c && c.teams) || '',
      comments: (c && c.comments) || '',
      last_scan: (c && c.last_scan) || '',
      recounted: maxPass >= 2 ? 1 : 0,
      first_count_qty: maxPass >= 2 ? ((f ? f.first_qty : null) ?? '') : '',
      // the figure above is the latest count; with a third count, the second is kept here
      second_count_qty: maxPass === 3 ? ((secondpass.get(k) || {}).second_qty ?? '') : '',
      // the second count, whenever there was one - the pallet report shows 1st, 2nd and the count that stands
      second_pass_qty: maxPass >= 2 ? ((secondpass.get(k) || {}).second_qty ?? '') : '',
      count_round: maxPass || 0,
      open_recounts: openRecounts.get(k) || 0,
      alias_of: (c && c.alias_of) || '',
      also_tagged: tagged.get(k) || '',
      expected_lot: expectedLot || '',
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

/* A label somebody printed and put on: ticked off in the office against the
   pallet (its name on the count) or the bin, so the relabel list goes down as
   the labels go out. The count line itself is never touched. */
db.exec(`
CREATE TABLE IF NOT EXISTS label_fixes (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  what       TEXT NOT NULL,          -- BIN | PALLET
  code       TEXT NOT NULL,          -- the bin, or the pallet's name on the count
  fixed_by   TEXT,
  fixed_at   TEXT,
  outcome    TEXT,
  PRIMARY KEY (session_id, what, code)
);
`);
export function labelsToReplace(sessionId) {
  const id = Number(sessionId);
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
    .all(id);
  const fixed = new Map(db.prepare('SELECT what, code, fixed_by, fixed_at, outcome FROM label_fixes WHERE session_id = ?').all(id).map((f) => [`${f.what}:${f.code}`, f]));
  const state = (what, code) => {
    const f = fixed.get(`${what}:${code}`);
    return f ? { status: 'fixed', fixed_by: f.fixed_by, fixed_at: f.fixed_at, outcome: f.outcome || '' } : { status: 'open', fixed_by: '', fixed_at: '', outcome: '' };
  };

  /* One row per label to print, not per line - a pallet with no label sitting in
     a bin with no label is two labels, and whoever walks out there needs both on
     the list. The rack ones come first: every counter after this one walks up to
     that bin too. A bin or pallet counted twice is one label, listed once. */
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.bin_label_issue && !seen.has(`BIN:${r.location_code}`)) {
      seen.add(`BIN:${r.location_code}`);
      out.push({ ...r, what: 'BIN', issue: BIN_ISSUE[r.bin_label_issue] || 'LABEL PROBLEM', ...state('BIN', r.location_code) });
    }
    if (r.label_issue && !seen.has(`PALLET:${r.pallet_id}`)) {
      seen.add(`PALLET:${r.pallet_id}`);
      out.push({ ...r, what: 'PALLET', issue: PALLET_ISSUE[r.label_issue] || 'LABEL PROBLEM', ...state('PALLET', r.pallet_id) });
    }
  }
  return out.sort((a, b) => (a.what === b.what ? 0 : a.what === 'BIN' ? -1 : 1));
}

/** Tick a label off (or back on): the label was printed and put on the pallet or the rack. */
export function fixLabel(sessionId, { what, code, by = '', outcome = '', reopen = false } = {}) {
  const id = Number(sessionId);
  const w = String(what || '').toUpperCase();
  const c = String(code || '').trim().toUpperCase();
  if (!['BIN', 'PALLET'].includes(w) || !c) throw Object.assign(new Error('say which label: BIN or PALLET, and its code'), { status: 400 });
  const row = labelsToReplace(id).find((l) => l.what === w && (w === 'BIN' ? l.location_code : l.pallet_id) === c);
  if (!row) throw Object.assign(new Error(`${c} is not on the relabel list`), { status: 404 });
  if (reopen) db.prepare('DELETE FROM label_fixes WHERE session_id = ? AND what = ? AND code = ?').run(id, w, c);
  else db.prepare('INSERT INTO label_fixes (session_id, what, code, fixed_by, fixed_at, outcome) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, what, code) DO UPDATE SET fixed_by = excluded.fixed_by, fixed_at = excluded.fixed_at, outcome = excluded.outcome')
    .run(id, w, c, by || 'a supervisor', new Date().toISOString(), String(outcome || '').slice(0, 300) || null);
  return labelsToReplace(id).find((l) => l.what === w && (w === 'BIN' ? l.location_code : l.pallet_id) === c);
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


/**
 * Found in a different bin: every pallet counted somewhere other than where
 * the report has it. Its own list, aisle by aisle, so the moves can be keyed
 * as moves - with the quantity found, who found it and when - instead of
 * walking somebody back for a second count of a bin that was simply wrong on
 * paper. The pallet report still shows them as WRONG BIN.
 */
export function movedPallets(sessionId) {
  const id = Number(sessionId);
  const aisleOf = new Map(db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(id).map((l) => [l.code, l.aisle]));
  const rows = palletReport(id).filter((r) => r.status === 'WRONG BIN').map((r) => {
    const found = String(r.found_location || '').split(',').filter(Boolean);
    return {
      pallet_id: r.pallet_id, source: r.source, sku: r.sku, description: r.description, variant: r.variant,
      expected_location: r.expected_location, expected_aisle: aisleOf.get(r.expected_location) || '',
      found_location: found.join(', '), found_aisle: [...new Set(found.map((b) => aisleOf.get(b) || ''))].filter(Boolean).join(', '),
      expected_qty: r.expected_qty, counted_qty: r.counted_qty, variance_qty: r.variance_qty,
      teams: r.teams, last_scan: r.last_scan, times_counted: r.times_counted, recounted: r.recounted, open_recounts: r.open_recounts,
      comments: r.comments,
    };
  }).sort((a, b) => String(a.found_aisle).localeCompare(String(b.found_aisle), undefined, { numeric: true }) || String(a.found_location).localeCompare(String(b.found_location), undefined, { numeric: true }) || String(a.pallet_id).localeCompare(String(b.pallet_id)));
  const byAisle = new Map();
  for (const r of rows) byAisle.set(r.found_aisle || '(no aisle)', (byAisle.get(r.found_aisle || '(no aisle)') || 0) + 1);
  return { rows, total: rows.length, sameQty: rows.filter((r) => Number(r.variance_qty || 0) === 0).length, byAisle: [...byAisle.entries()].map(([aisle, n]) => ({ aisle, n })) };
}
export const MOVED_COLUMNS = ['Pallet', 'System', 'Item', 'Description', 'Variant', 'Report bin', 'Report aisle', 'Found in', 'Found aisle', 'Report qty', 'Counted qty', 'Difference', 'Counted by', 'Last scan', 'Comments'];
export const movedRows = (rows) => rows.map((r) => ({ 'Pallet': r.pallet_id, 'System': r.source, 'Item': r.sku, 'Description': r.description, 'Variant': r.variant, 'Report bin': r.expected_location, 'Report aisle': r.expected_aisle,
  'Found in': r.found_location, 'Found aisle': r.found_aisle, 'Report qty': r.expected_qty, 'Counted qty': r.counted_qty, 'Difference': r.variance_qty, 'Counted by': r.teams, 'Last scan': r.last_scan, 'Comments': r.comments }));


/**
 * The flagged lines, each with why it is flagged: the lines a counter had to
 * accept past a warning, or that carry a label that would not scan. The
 * Progress tile counts the first kind; this lists both and says which.
 */
export const FLAG_WHY = {
  unknown_pallet: 'Pallet not on the report', unknown_location: 'Bin not on the list', off_assignment: "Outside the team's plan",
  duplicate_pallet: 'Counted twice', override: 'Override', label_issue: 'Pallet label would not scan', bin_label_issue: 'Bin label would not scan',
};
export function flaggedLines(sessionId) {
  const rows = exceptions(sessionId).map((r) => {
    const why = [];
    if (r.unknown_pallet) why.push('unknown_pallet');
    if (r.unknown_location) why.push('unknown_location');
    if (r.off_assignment) why.push('off_assignment');
    if (r.duplicate_pallet) why.push('duplicate_pallet');
    if (r.override_reason) why.push('override');
    if (r.label_issue) why.push('label_issue');
    if (r.bin_label_issue) why.push('bin_label_issue');
    return { ...r, why, whyWords: why.map((k) => (k === 'override' ? `Override: ${r.override_reason}` : k === 'label_issue' ? `${FLAG_WHY[k]} (${r.label_issue})` : k === 'bin_label_issue' ? `${FLAG_WHY[k]} (${r.bin_label_issue})` : FLAG_WHY[k])).join(' · ') };
  }).sort((a, b) => String(b.scanned_at).localeCompare(String(a.scanned_at)));
  const byWhy = {};
  for (const r of rows) for (const k of r.why) byWhy[k] = (byWhy[k] || 0) + 1;
  return { rows, total: rows.length, byWhy, labels: FLAG_WHY };
}


/**
 * The count reconciled in money: every pallet whose count differs from the
 * report, priced at the report's cost, grouped by aisle, by system or by
 * item, the biggest difference first - with how far each group's second
 * counts have got. Needs the report to carry costs; says so when it does not.
 */
export const VALUE_COLUMNS = ['group', 'label', 'pallets', 'over', 'under', 'net', 'abs', 'expected', 'unpriced', 'first_only', 'second_counted', 'recounts_open'];
export function valueReconciliation(sessionId, { by = 'aisle' } = {}) {
  const id = Number(sessionId);
  const priced = !!db.prepare('SELECT 1 FROM pallets WHERE session_id = ? AND (cost IS NOT NULL OR amount IS NOT NULL) LIMIT 1').get(id);
  const aisleOf = new Map(db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(id).map((r) => [r.code, r.aisle || '']));
  const cents = (n) => Math.round(n * 100) / 100;
  const groups = new Map();
  const totals = { pallets: 0, over: 0, under: 0, net: 0, expected: 0, unpriced: 0, firstOnly: 0, secondCounted: 0, recountsOpen: 0 };
  const keyOf = (r) => {
    if (by === 'system') return [r.source || '', r.source || 'no system'];
    if (by === 'sku') return [r.sku || r.pallet_id, r.sku ? `${r.sku}${r.description ? ' — ' + r.description : ''}` : `${r.pallet_id} (no item)`];
    const bin = r.expected_location || String(r.found_location || '').split(/[,;]\s*/)[0] || '';
    const aisle = aisleOf.get(bin) || (bin ? bin.replace(/[A-Z]\d{3}$/, '') : '');
    return [aisle || '—', aisle || 'no aisle'];
  };
  for (const r of palletReport(id)) {
    /* the group's worth is the whole group on the report, matches included */
    const [key, label] = keyOf(r);
    if (!groups.has(key)) groups.set(key, { group: key, label, pallets: 0, over: 0, under: 0, net: 0, abs: 0, expected: 0, unpriced: 0, first_only: 0, second_counted: 0, recounts_open: 0 });
    const g = groups.get(key);
    if (r.expected_amount !== '') { totals.expected += Number(r.expected_amount); g.expected += Number(r.expected_amount); }
    const hasVar = r.variance_qty !== '' && Number(r.variance_qty) !== 0;
    if (!hasVar) continue;
    g.pallets++; totals.pallets++;
    if (r.variance_amount === '') { g.unpriced++; totals.unpriced++; }
    else {
      const v = Number(r.variance_amount);
      g.net += v; totals.net += v; g.abs += Math.abs(v);
      if (v > 0) { g.over += v; totals.over += v; } else { g.under += v; totals.under += v; }
    }
    if (r.open_recounts) { g.recounts_open++; totals.recountsOpen++; }
    else if (r.recounted) { g.second_counted++; totals.secondCounted++; }
    else { g.first_only++; totals.firstOnly++; }
  }
  const rows = [...groups.values()].filter((g) => g.pallets > 0).map((g) => ({ ...g, over: cents(g.over), under: cents(g.under), net: cents(g.net), abs: cents(g.abs), expected: cents(g.expected) }))
    .sort((a, b) => b.abs - a.abs || b.pallets - a.pallets || String(a.group).localeCompare(String(b.group), undefined, { numeric: true }));
  for (const k of ['over', 'under', 'net', 'expected']) totals[k] = cents(totals[k]);
  return { by, priced, rows, totals };
}
