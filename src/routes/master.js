import { db, norm, bumpMasterVersion, getSession, resolveAisle } from '../db.js';
import { parseBinCode, normLevels } from '../util/bincode.js';
import { autoActivate } from './assignments.js';
import { loadLayout, classifyByRules } from '../util/layouts.js';
import { parseRecords, pick } from '../util/csv.js';
import { normClass } from './accuracy.js';

const LOCATION_ALIASES = ['location', 'loc', 'bin', 'binlocation', 'locationcode', 'slot', 'code', 'warehouselocation', 'binlocationcode'];
const AISLE_ALIASES = ['aisle', 'row', 'aisleno', 'aislenumber'];
const ZONE_ALIASES = ['zone', 'area', 'section', 'region', 'warehouse'];
const DESC_ALIASES = ['description', 'desc', 'itemdescription', 'name', 'productname', 'palletdescription'];
const PALLET_ALIASES = ['palletid', 'pallet', 'containerid', 'container', 'containernumber', 'containerno', 'lpn', 'license', 'licenseplate', 'palletnumber', 'palletno', 'id', 'tag'];
const SKU_ALIASES = ['sku', 'item', 'itemnumber', 'itemcode', 'partnumber', 'part', 'product', 'productcode', 'material', 'stockcode'];
const UOM_ALIASES = ['uom', 'unit', 'unitofmeasure', 'um'];
const QTY_ALIASES = ['qty', 'quantity', 'onhand', 'onhandqty', 'expected', 'expectedqty', 'systemqty', 'qtyonhand', 'cases', 'units'];
const TEAM_ALIASES = ['team', 'teamnumber', 'teamno', 'crew', 'group'];
const LEVEL_ALIASES = ['level', 'levels', 'tier', 'shelf'];
const LOT_ALIASES = ['lot', 'lotcode', 'lotno', 'lotnumber', 'batch', 'batchcode', 'batchno', 'batchnumber'];
const EXPIRY_ALIASES = ['expiry', 'expirydate', 'expiration', 'expirationdate', 'expires', 'bestbefore', 'bestbeforedate', 'useby', 'usebydate', 'shelflifedate'];
/* The class an ERP calls A/B/C, and the dozen things it calls the column. */
const ABC_ALIASES = ['abc', 'abcclass', 'abccode', 'class', 'itemclass', 'velocity', 'velocitycode', 'movement', 'movementclass', 'category'];
const LASTCOUNT_ALIASES = ['lastphysinvtdate', 'lastphysicalinventorydate', 'lastcounted', 'lastcountdate', 'lastinventorydate', 'lastcount'];

/**
 * Which aisle a bin belongs to when the file has no aisle column - see
 * util/bincode.js for the code shapes understood ("A03-12-1" -> A03,
 * "F01A001" -> F01). A supervisor can always add an Aisle column instead.
 */
export const deriveAisle = (code) => parseBinCode(code).aisle;

const upLocation = db.prepare(
  `INSERT INTO locations (session_id, code, zone, aisle, level, last_counted, description) VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(session_id, code) DO UPDATE SET
     zone = COALESCE(NULLIF(excluded.zone, ''), locations.zone),
     aisle = COALESCE(NULLIF(excluded.aisle, ''), locations.aisle),
     level = COALESCE(NULLIF(excluded.level, ''), locations.level),
     -- a re-upload must never rewind a bin counted in this app since
     last_counted = MAX(COALESCE(locations.last_counted, ''), COALESCE(excluded.last_counted, '')),
     description = COALESCE(NULLIF(excluded.description, ''), locations.description)`
);

// "3/14/2026", "2026-03-14", "14/03/2026 08:00" -> "2026-03-14"; anything else -> null
export function parseDate(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t);
  if (m) {
    // US exports are M/D/Y; a first number above 12 can only be the day
    const [, a, b, y] = m;
    const [mo, day] = Number(a) > 12 ? [b, a] : [a, b];
    return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const upAisle = db.prepare(
  `INSERT INTO aisles (session_id, aisle, block) VALUES (?, ?, ?)
   ON CONFLICT(session_id, aisle) DO NOTHING`
);
const upPallet = db.prepare(
  `INSERT INTO pallets (session_id, pallet_id, sku, description, uom, expected_qty, expected_location, lot, expiry, abc)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(session_id, pallet_id) DO UPDATE SET
     sku = COALESCE(NULLIF(excluded.sku, ''), pallets.sku),
     description = COALESCE(NULLIF(excluded.description, ''), pallets.description),
     uom = COALESCE(NULLIF(excluded.uom, ''), pallets.uom),
     expected_qty = COALESCE(excluded.expected_qty, pallets.expected_qty),
     expected_location = COALESCE(NULLIF(excluded.expected_location, ''), pallets.expected_location),
     lot = COALESCE(NULLIF(excluded.lot, ''), pallets.lot),
     expiry = COALESCE(NULLIF(excluded.expiry, ''), pallets.expiry),
     abc = COALESCE(NULLIF(excluded.abc, ''), pallets.abc)`
);

/**
 * Import a master-data CSV into a session.
 *
 *   'bins'     - location, zone, aisle, description   (the validation list for question 3)
 *   'pallets'  - pallet id, sku, description, qty, location  (validation + SKU for question 1)
 *   'plan'     - team, aisle   (the guided-counting assignment plan)
 */
export function importMaster(sessionId, kind, text, { replace = false } = {}) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  if (session.status !== 'open') throw Object.assign(new Error('session is closed'), { status: 409 });

  const { headers, records } = parseRecords(text);
  if (!records.length) throw Object.assign(new Error('no data rows found'), { status: 400 });

  const stats = { kind, rows: records.length, bins: 0, aisles: 0, pallets: 0, planned: 0, skipped: 0, headers };
  const newAisles = new Set();
  const layout = loadLayout(session.layout);
  const areas = new Set(((layout && layout.areas) || []).map(norm));
  const excluded = new Set(((layout && layout.excluded) || []).map(norm));
  stats.excluded = 0;
  stats.excludedGroups = [...excluded];
  const RACK = /^[A-Z]+\d+[A-Z]\d+$/;

  db.exec('BEGIN');
  try {
    if (replace) {
      if (kind === 'bins') {
        db.prepare('DELETE FROM locations WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM aisles WHERE session_id = ?').run(id);
      } else if (kind === 'pallets') {
        db.prepare('DELETE FROM pallets WHERE session_id = ?').run(id);
      } else if (kind === 'plan') {
        db.prepare("DELETE FROM assignments WHERE session_id = ? AND status != 'done'").run(id);
      }
    }

    for (const rec of records) {
      if (kind === 'bins') {
        const code = norm(pick(rec, LOCATION_ALIASES));
        if (!code) { stats.skipped++; continue; }
        const desc = pick(rec, DESC_ALIASES);
        let aisle = norm(pick(rec, AISLE_ALIASES));
        let zone = norm(pick(rec, ZONE_ALIASES));
        if (!aisle) {
          const rule = !RACK.test(code) && classifyByRules(layout, code, desc);
          aisle = rule ? norm(rule.aisle) : deriveAisle(code);
          if (!zone && rule) zone = norm(rule.zone);
          if (!zone && layout && layout.zones) zone = norm(layout.zones[/^[A-Z]+/.exec(code)?.[0]] || '');
        }
        // groups counted by hand stay out of the app entirely
        if (excluded.has(aisle)) { stats.excluded++; continue; }
        const level = norm(pick(rec, LEVEL_ALIASES)) || parseBinCode(code).level || '';
        const lastCounted = parseDate(pick(rec, LASTCOUNT_ALIASES));
        if (lastCounted) stats.withDates = (stats.withDates || 0) + 1;
        upLocation.run(id, code, zone, aisle, level, lastCounted, desc);
        // areas (WIP, system bins, ...) are countable bins but not aisles
        if (!areas.has(aisle)) { upAisle.run(id, aisle, aisle); newAisles.add(aisle); }
        stats.bins++;
        continue;
      }

      if (kind === 'pallets') {
        const pallet = norm(pick(rec, PALLET_ALIASES));
        if (!pallet) { stats.skipped++; continue; }
        const qtyRaw = pick(rec, QTY_ALIASES);
        const qty = Number(String(qtyRaw).replace(/[, ]/g, ''));
        upPallet.run(
          id, pallet,
          norm(pick(rec, SKU_ALIASES)),
          pick(rec, DESC_ALIASES),
          norm(pick(rec, UOM_ALIASES)),
          qtyRaw !== '' && Number.isFinite(qty) ? qty : null,
          norm(pick(rec, LOCATION_ALIASES)),
          norm(pick(rec, LOT_ALIASES)),
          parseDate(pick(rec, EXPIRY_ALIASES)),
          normClass(pick(rec, ABC_ALIASES))
        );
        if (norm(pick(rec, LOT_ALIASES))) stats.withLots = (stats.withLots || 0) + 1;
        if (parseDate(pick(rec, EXPIRY_ALIASES))) stats.withExpiry = (stats.withExpiry || 0) + 1;
        if (normClass(pick(rec, ABC_ALIASES))) stats.withAbc = (stats.withAbc || 0) + 1;
        stats.pallets++;
        continue;
      }

      if (kind === 'plan') {
        const team = norm(pick(rec, TEAM_ALIASES));
        const aisle = resolveAisle(id, pick(rec, AISLE_ALIASES));
        if (!team || !aisle) { stats.skipped++; continue; }
        const levels = normLevels(pick(rec, LEVEL_ALIASES));
        if (!levels) { stats.skipped++; stats.skippedNoLevels = (stats.skippedNoLevels || 0) + 1; continue; }
        const pos = db
          .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM assignments WHERE session_id = ? AND team = ?')
          .get(id, team).p;
        db.prepare(
          `INSERT INTO assignments (session_id, team, aisle, levels, position, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?)
           ON CONFLICT(session_id, team, aisle, levels) DO NOTHING`
        ).run(id, team, aisle, levels, pos, new Date().toISOString());
        stats.planned++;
        continue;
      }

      throw Object.assign(new Error(`unknown file type "${kind}"`), { status: 400 });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  stats.aisles = newAisles.size;
  if (kind === 'bins') pruneAreaAisles(id, layout);
  if (kind === 'plan') stats.activated = autoActivate(id);
  bumpMasterVersion(id);
  stats.totals = {
    bins: db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(id).n,
    aisles: db.prepare('SELECT COUNT(*) n FROM aisles WHERE session_id = ?').get(id).n,
    pallets: db.prepare('SELECT COUNT(*) n FROM pallets WHERE session_id = ?').get(id).n,
    assignments: db.prepare('SELECT COUNT(*) n FROM assignments WHERE session_id = ?').get(id).n,
  };
  return stats;
}

/** Drop aisle rows (and their assignments) for groups the layout says are areas, not aisles. */
export function pruneAreaAisles(sessionId, layout) {
  const areas = ((layout && layout.areas) || []).map(norm);
  const excluded = ((layout && layout.excluded) || []).map(norm);
  const id = Number(sessionId);
  let removed = 0;
  for (const a of [...areas, ...excluded]) {
    db.prepare('DELETE FROM assignments WHERE session_id = ? AND aisle = ?').run(id, a);
    removed += db.prepare('DELETE FROM aisles WHERE session_id = ? AND aisle = ?').run(id, a).changes;
  }
  // bins of an excluded group already in the session go too
  for (const a of excluded) db.prepare('DELETE FROM locations WHERE session_id = ? AND aisle = ?').run(id, a);
  if (excluded.length) bumpMasterVersion(id);
  return removed;
}
