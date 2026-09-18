import { db, getSession } from '../db.js';
import { palletReport } from './reports.js';
import { toCsv } from '../util/csv.js';

/*
 * How good was the count, by how much the item matters.
 *
 * "We counted 14,000 bins" is not a measure of anything. The one an operation
 * is judged on is accuracy, and the one worth acting on is accuracy by class:
 * a warehouse can be 98% accurate overall and still be losing money, because
 * the misses are all on the fast movers. So the A items - the handful of SKUs
 * that are most of the throughput - get their own line, their own target, and
 * their own pass or fail.
 *
 * Three numbers, because they answer different questions:
 *
 *   pallet accuracy    - of the pallets the report expected, how many were
 *                        exactly where and what it said. The number an auditor
 *                        asks for.
 *   quantity accuracy  - of the units the report expected, how many were not in
 *                        dispute. Forgiving of one bad pallet, unforgiving of a
 *                        thousand small differences.
 *   bin accuracy       - of the bins counted, how many held no surprises. The
 *                        one that tells you whether put-away is the problem.
 *
 * Off unless a count turns it on, and then classes come from the report if it
 * has a column for them, or are worked out from it if it does not.
 */

const DEFAULT_TARGETS = { A: 99, B: 97, C: 95, '': 95 };
export const CLASSES = ['A', 'B', 'C'];

export function accuracyTargets() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'accuracyTargets'").get();
  if (!row) return { targets: { ...DEFAULT_TARGETS }, isDefault: true };
  try {
    const saved = JSON.parse(row.value) || {};
    const targets = { ...DEFAULT_TARGETS };
    for (const c of CLASSES) {
      if (saved[c] != null && Number.isFinite(Number(saved[c]))) targets[c] = Math.max(0, Math.min(100, Number(saved[c])));
    }
    return { targets, isDefault: false };
  } catch { return { targets: { ...DEFAULT_TARGETS }, isDefault: true }; }
}

export function saveAccuracyTargets(body = {}) {
  const targets = {};
  for (const c of CLASSES) {
    if (body[c] != null && body[c] !== '') targets[c] = Math.max(0, Math.min(100, Number(body[c]) || 0));
  }
  if (!Object.keys(targets).length) {
    db.prepare("DELETE FROM settings WHERE key = 'accuracyTargets'").run();
    return accuracyTargets();
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('accuracyTargets', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(targets));
  return accuracyTargets();
}

export const normClass = (v) => {
  const c = String(v == null ? '' : v).trim().toUpperCase();
  return CLASSES.includes(c[0]) ? c[0] : '';
};

/**
 * Work the classes out from the report, for the sites whose ERP will not export
 * them.
 *
 * Pareto on what the report says is in the building: sort the items by how much
 * of the warehouse they are, and the first 80% of the quantity is A, the next
 * 15% B, the tail C. It is a proxy - the textbook does this by annual usage
 * value and nobody has that in a count file - so it is offered as a button a
 * supervisor presses, never something that happens quietly, and anything the
 * report classified itself is left alone.
 */
export function deriveAbc(sessionId, { force = false } = {}) {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  const bySku = db
    .prepare(
      `SELECT COALESCE(NULLIF(sku, ''), pallet_id) AS sku, SUM(COALESCE(expected_qty, 0)) AS qty
         FROM pallets WHERE session_id = ? GROUP BY COALESCE(NULLIF(sku, ''), pallet_id)
        ORDER BY qty DESC`
    )
    .all(id);
  const total = bySku.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  if (!bySku.length) return { classified: 0, skus: 0, byClass: { A: 0, B: 0, C: 0 }, reason: 'no pallets on this count yet' };

  const klass = new Map();
  let run = 0;
  for (const r of bySku) {
    /* Where this item starts in the running total decides its class. With no
       quantities in the file at all, an even split by rank is still better than
       calling the whole warehouse class C. */
    const before = total ? run / total : klass.size / bySku.length;
    run += total ? Number(r.qty) || 0 : 1;
    klass.set(r.sku, before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C');
  }

  const rows = db.prepare(`SELECT pallet_id, sku, abc FROM pallets WHERE session_id = ?`).all(id);
  const set = db.prepare('UPDATE pallets SET abc = ? WHERE session_id = ? AND pallet_id = ?');
  const byClass = { A: 0, B: 0, C: 0 };
  let classified = 0;
  db.exec('BEGIN');
  try {
    for (const p of rows) {
      const already = normClass(p.abc);
      if (already && !force) { byClass[already]++; continue; }
      const c = klass.get(p.sku || p.pallet_id) || 'C';
      set.run(c, id, p.pallet_id);
      byClass[c]++;
      classified++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { classified, skus: bySku.length, byClass, kept: rows.length - classified };
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * The scorecard. One row per class, plus the whole count.
 *
 * Second labels are left out - a tag on a pallet already counted is not a
 * pallet that was right or wrong - and so are pallets nobody has reached yet on
 * a count still running, because "not counted" is not "counted wrong".
 */
export function accuracy(sessionId) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });

  const abc = new Map(
    db.prepare("SELECT pallet_id, COALESCE(abc, '') AS abc FROM pallets WHERE session_id = ?").all(id)
      .map((r) => [r.pallet_id, normClass(r.abc)])
  );
  const classified = [...abc.values()].filter(Boolean).length;

  const blank = () => ({ pallets: 0, exact: 0, expected_units: 0, counted_units: 0, variance_units: 0, missing: 0, extra: 0, wrong_bin: 0, qty_variance: 0 });
  const rows = { A: blank(), B: blank(), C: blank(), '': blank() };
  const all = blank();

  for (const r of palletReport(id)) {
    if (r.status === 'SECOND LABEL') continue;
    /* A count still running: a pallet nobody has walked to yet is not a miss.
       One the report never listed is, though - it is in the building and the
       system does not know. */
    const counted = r.counted_qty !== '';
    if (!counted && r.status === 'MISSING' && session.status === 'open') continue;
    const c = abc.get(r.pallet_id) || '';
    const bucket = rows[c];
    for (const b of [bucket, all]) {
      b.pallets++;
      if (r.status === 'MATCH') b.exact++;
      b.expected_units += Number(r.expected_qty) || 0;
      b.counted_units += Number(r.counted_qty) || 0;
      b.variance_units += Math.abs(Number(r.variance_qty) || (r.status === 'MISSING' ? Number(r.expected_qty) || 0 : 0));
      if (r.status === 'MISSING') b.missing++;
      else if (r.status === 'NOT IN MASTER') b.extra++;
      else if (r.status === 'WRONG BIN') b.wrong_bin++;
      else if (r.status === 'QTY VARIANCE') b.qty_variance++;
    }
  }

  /* Bins with nothing odd about them, out of the bins somebody counted. Kept
     whole-count: a bin is not an A item or a C item, it holds both. */
  const bins = db
    .prepare(
      `SELECT COUNT(DISTINCT location_code) AS counted,
              COUNT(DISTINCT CASE WHEN unknown_pallet = 1 OR unknown_location = 1 OR off_assignment = 1
                                    OR duplicate_pallet = 1 OR override_reason IS NOT NULL
                                 THEN location_code END) AS flagged
         FROM counts WHERE session_id = ? AND voided = 0`
    )
    .get(id);

  const { targets } = accuracyTargets();
  const line = (name, b) => {
    const palletAccuracy = pct(b.exact, b.pallets);
    const qtyAccuracy = b.expected_units > 0
      ? Math.round(Math.max(0, 1 - b.variance_units / b.expected_units) * 1000) / 10
      : (b.pallets ? pct(b.exact, b.pallets) : null);
    const target = targets[name] ?? targets[''] ?? null;
    return {
      class: name,
      label: name ? `Class ${name}` : 'Unclassified',
      pallets: b.pallets,
      exact: b.exact,
      pallet_accuracy: palletAccuracy,
      expected_units: Math.round(b.expected_units * 100) / 100,
      counted_units: Math.round(b.counted_units * 100) / 100,
      variance_units: Math.round(b.variance_units * 100) / 100,
      qty_accuracy: qtyAccuracy,
      missing: b.missing, extra: b.extra, wrong_bin: b.wrong_bin, qty_variance: b.qty_variance,
      target,
      meets: palletAccuracy == null || target == null ? null : palletAccuracy >= target,
    };
  };

  const byClass = [...CLASSES.map((c) => line(c, rows[c])), line('', rows[''])].filter((r) => r.pallets > 0);
  return {
    on: !!session.track_abc,
    classified,
    unclassified: abc.size - classified,
    pallets_on_report: abc.size,
    byClass,
    overall: { ...line('', all), label: 'Whole count', class: 'ALL' },
    bins: {
      counted: bins.counted || 0,
      clean: (bins.counted || 0) - (bins.flagged || 0),
      accuracy: pct((bins.counted || 0) - (bins.flagged || 0), bins.counted || 0),
    },
    targets,
  };
}

/** The scorecard as a file, for the pack that goes to finance. */
export function accuracyCsv(sessionId) {
  const a = accuracy(sessionId);
  const headers = ['Class', 'Pallets', 'Exact', 'Pallet Accuracy %', 'Target %', 'Meets Target',
    'Expected Units', 'Counted Units', 'Variance Units', 'Quantity Accuracy %',
    'Missing', 'Not On Report', 'Wrong Bin', 'Qty Variance'];
  const row = (r) => [r.label, r.pallets, r.exact, r.pallet_accuracy ?? '', r.target ?? '',
    r.meets == null ? '' : (r.meets ? 'YES' : 'NO'), r.expected_units, r.counted_units, r.variance_units,
    r.qty_accuracy ?? '', r.missing, r.extra, r.wrong_bin, r.qty_variance];
  const lines = [...a.byClass.map(row), row(a.overall),
    ['Bins with nothing odd in them', a.bins.counted, a.bins.clean, a.bins.accuracy ?? '']];
  return toCsv(lines.map((l) => Object.fromEntries(headers.map((h, i) => [h, l[i] ?? '']))), headers);
}
