import { db, norm, bumpMasterVersion, getSession } from '../db.js';
import { parseRecords, pick } from '../util/csv.js';

const LOCATION_ALIASES = ['location', 'loc', 'bin', 'binlocation', 'locationcode', 'slot', 'code', 'warehouselocation', 'binlocationcode'];
const AISLE_ALIASES = ['aisle', 'row', 'aisleno', 'aislenumber'];
const ZONE_ALIASES = ['zone', 'area', 'section', 'region', 'warehouse'];
const DESC_ALIASES = ['description', 'desc', 'itemdescription', 'name', 'productname', 'palletdescription'];
const PALLET_ALIASES = ['palletid', 'pallet', 'containerid', 'container', 'containernumber', 'containerno', 'lpn', 'license', 'licenseplate', 'palletnumber', 'palletno', 'id', 'tag'];
const SKU_ALIASES = ['sku', 'item', 'itemnumber', 'itemcode', 'partnumber', 'part', 'product', 'productcode', 'material', 'stockcode'];
const UOM_ALIASES = ['uom', 'unit', 'unitofmeasure', 'um'];
const QTY_ALIASES = ['qty', 'quantity', 'onhand', 'onhandqty', 'expected', 'expectedqty', 'systemqty', 'qtyonhand', 'cases', 'units'];
const TEAM_ALIASES = ['team', 'teamnumber', 'teamno', 'crew', 'group'];

/**
 * Work out which aisle a bin belongs to when the file has no aisle column.
 * Takes the first separated segment ("A-01-02" -> "A", "03.14.2" -> "03"), and
 * failing that the leading letters ("AA0102" -> "AA"). A supervisor can always
 * add an Aisle column, or re-map aisles in the dashboard afterwards.
 */
export function deriveAisle(code) {
  const c = norm(code);
  const seg = c.split(/[-_./\\ ]/).filter(Boolean);
  if (seg.length > 1) return seg[0];
  const alpha = /^([A-Z]+)/.exec(c);
  return alpha ? alpha[1] : c;
}

const upLocation = db.prepare(
  `INSERT INTO locations (session_id, code, zone, aisle, description) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(session_id, code) DO UPDATE SET
     zone = COALESCE(NULLIF(excluded.zone, ''), locations.zone),
     aisle = COALESCE(NULLIF(excluded.aisle, ''), locations.aisle),
     description = COALESCE(NULLIF(excluded.description, ''), locations.description)`
);
const upAisle = db.prepare(
  `INSERT INTO aisles (session_id, aisle, block) VALUES (?, ?, ?)
   ON CONFLICT(session_id, aisle) DO NOTHING`
);
const upPallet = db.prepare(
  `INSERT INTO pallets (session_id, pallet_id, sku, description, uom, expected_qty, expected_location)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(session_id, pallet_id) DO UPDATE SET
     sku = COALESCE(NULLIF(excluded.sku, ''), pallets.sku),
     description = COALESCE(NULLIF(excluded.description, ''), pallets.description),
     uom = COALESCE(NULLIF(excluded.uom, ''), pallets.uom),
     expected_qty = COALESCE(excluded.expected_qty, pallets.expected_qty),
     expected_location = COALESCE(NULLIF(excluded.expected_location, ''), pallets.expected_location)`
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
        const aisle = norm(pick(rec, AISLE_ALIASES)) || deriveAisle(code);
        upLocation.run(id, code, norm(pick(rec, ZONE_ALIASES)), aisle, pick(rec, DESC_ALIASES));
        upAisle.run(id, aisle, aisle);
        newAisles.add(aisle);
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
          norm(pick(rec, LOCATION_ALIASES))
        );
        stats.pallets++;
        continue;
      }

      if (kind === 'plan') {
        const team = norm(pick(rec, TEAM_ALIASES));
        const aisle = norm(pick(rec, AISLE_ALIASES));
        if (!team || !aisle) { stats.skipped++; continue; }
        const known = db.prepare('SELECT 1 FROM aisles WHERE session_id = ? AND aisle = ?').get(id, aisle);
        if (!known) { stats.skipped++; continue; }
        const pos = db
          .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM assignments WHERE session_id = ? AND team = ?')
          .get(id, team).p;
        db.prepare(
          `INSERT INTO assignments (session_id, team, aisle, position, status, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?)
           ON CONFLICT(session_id, team, aisle) DO NOTHING`
        ).run(id, team, aisle, pos, new Date().toISOString());
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
  bumpMasterVersion(id);
  stats.totals = {
    bins: db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(id).n,
    aisles: db.prepare('SELECT COUNT(*) n FROM aisles WHERE session_id = ?').get(id).n,
    pallets: db.prepare('SELECT COUNT(*) n FROM pallets WHERE session_id = ?').get(id).n,
    assignments: db.prepare('SELECT COUNT(*) n FROM assignments WHERE session_id = ?').get(id).n,
  };
  return stats;
}
