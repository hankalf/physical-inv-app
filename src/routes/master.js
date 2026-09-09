import { db, norm, bumpMasterVersion, getSession } from '../db.js';
import { parseRecords, pick } from '../util/csv.js';

const LOCATION_ALIASES = ['location', 'loc', 'bin', 'binlocation', 'locationcode', 'slot', 'code', 'warehouselocation'];
const SKU_ALIASES = ['sku', 'item', 'itemnumber', 'itemcode', 'partnumber', 'part', 'product', 'productcode', 'material', 'stockcode'];
const DESC_ALIASES = ['description', 'desc', 'itemdescription', 'name', 'productname'];
const UOM_ALIASES = ['uom', 'unit', 'unitofmeasure', 'um'];
const ZONE_ALIASES = ['zone', 'area', 'aisle', 'section', 'region'];
const QTY_ALIASES = ['qty', 'quantity', 'onhand', 'onhandqty', 'expected', 'expectedqty', 'systemqty', 'qtyonhand', 'stock'];
const BARCODE_ALIASES = ['barcode', 'upc', 'ean', 'gtin', 'altbarcode', 'scancode', 'code'];
const PACK_ALIASES = ['packqty', 'pack', 'casequantity', 'caseqty', 'conversion', 'multiplier'];

const upLocation = db.prepare(
  `INSERT INTO locations (session_id, code, zone, description) VALUES (?, ?, ?, ?)
   ON CONFLICT(session_id, code) DO UPDATE SET
     zone = COALESCE(NULLIF(excluded.zone, ''), locations.zone),
     description = COALESCE(NULLIF(excluded.description, ''), locations.description)`
);
const upItem = db.prepare(
  `INSERT INTO items (session_id, sku, description, uom) VALUES (?, ?, ?, ?)
   ON CONFLICT(session_id, sku) DO UPDATE SET
     description = COALESCE(NULLIF(excluded.description, ''), items.description),
     uom = COALESCE(NULLIF(excluded.uom, ''), items.uom)`
);
const upBarcode = db.prepare(
  `INSERT INTO item_barcodes (session_id, barcode, sku, pack_qty) VALUES (?, ?, ?, ?)
   ON CONFLICT(session_id, barcode) DO UPDATE SET sku = excluded.sku, pack_qty = excluded.pack_qty`
);
// An on-hand export can carry several rows for the same location/SKU (lots,
// serials, pallets), so rows accumulate *within* one file - but a re-upload of
// the same file must overwrite, never double. setExpected is used the first
// time a key appears in the current file, addExpected for later occurrences.
const setExpected = db.prepare(
  `INSERT INTO expected (session_id, location_code, sku, qty) VALUES (?, ?, ?, ?)
   ON CONFLICT(session_id, location_code, sku) DO UPDATE SET qty = excluded.qty`
);
const addExpected = db.prepare(
  `INSERT INTO expected (session_id, location_code, sku, qty) VALUES (?, ?, ?, ?)
   ON CONFLICT(session_id, location_code, sku) DO UPDATE SET qty = expected.qty + excluded.qty`
);

/**
 * Import a master-data CSV into a session.
 *
 * kind:
 *   'onhand'    - location, sku, qty  (also seeds locations + items; the usual ERP export)
 *   'locations' - location, zone, description
 *   'items'     - sku, description, uom, barcode, pack_qty
 *   'barcodes'  - barcode, sku, pack_qty
 */
export function importMaster(sessionId, kind, text, { replace = false } = {}) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  if (session.status !== 'open') throw Object.assign(new Error('session is closed'), { status: 409 });

  const { headers, records } = parseRecords(text);
  if (!records.length) throw Object.assign(new Error('no data rows found'), { status: 400 });

  const stats = { rows: records.length, locations: 0, items: 0, barcodes: 0, expected: 0, skipped: 0, headers };
  const seenExpected = new Set();

  db.exec('BEGIN');
  try {
    if (replace) {
      if (kind === 'onhand') {
        db.prepare('DELETE FROM expected WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM locations WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM items WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM item_barcodes WHERE session_id = ?').run(id);
      } else if (kind === 'locations') {
        db.prepare('DELETE FROM locations WHERE session_id = ?').run(id);
      } else if (kind === 'items') {
        db.prepare('DELETE FROM items WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM item_barcodes WHERE session_id = ?').run(id);
      } else if (kind === 'barcodes') {
        db.prepare('DELETE FROM item_barcodes WHERE session_id = ?').run(id);
      }
    }

    for (const rec of records) {
      if (kind === 'locations') {
        const code = norm(pick(rec, LOCATION_ALIASES));
        if (!code) { stats.skipped++; continue; }
        upLocation.run(id, code, norm(pick(rec, ZONE_ALIASES)), pick(rec, DESC_ALIASES));
        stats.locations++;
        continue;
      }

      if (kind === 'items') {
        const sku = norm(pick(rec, SKU_ALIASES));
        if (!sku) { stats.skipped++; continue; }
        upItem.run(id, sku, pick(rec, DESC_ALIASES), norm(pick(rec, UOM_ALIASES)));
        upBarcode.run(id, sku, sku, 1);
        stats.items++;
        const bc = norm(pick(rec, BARCODE_ALIASES));
        if (bc && bc !== sku) {
          const pack = Number(pick(rec, PACK_ALIASES)) || 1;
          upBarcode.run(id, bc, sku, pack);
          stats.barcodes++;
        }
        continue;
      }

      if (kind === 'barcodes') {
        const bc = norm(pick(rec, BARCODE_ALIASES));
        const sku = norm(pick(rec, SKU_ALIASES));
        if (!bc || !sku) { stats.skipped++; continue; }
        upBarcode.run(id, bc, sku, Number(pick(rec, PACK_ALIASES)) || 1);
        stats.barcodes++;
        continue;
      }

      // onhand
      const code = norm(pick(rec, LOCATION_ALIASES));
      const sku = norm(pick(rec, SKU_ALIASES));
      if (!code || !sku) { stats.skipped++; continue; }
      upLocation.run(id, code, norm(pick(rec, ZONE_ALIASES)), '');
      stats.locations++;
      upItem.run(id, sku, pick(rec, DESC_ALIASES), norm(pick(rec, UOM_ALIASES)));
      upBarcode.run(id, sku, sku, 1);
      stats.items++;
      const bc = norm(pick(rec, BARCODE_ALIASES));
      if (bc && bc !== sku) {
        upBarcode.run(id, bc, sku, Number(pick(rec, PACK_ALIASES)) || 1);
        stats.barcodes++;
      }
      const qtyRaw = pick(rec, QTY_ALIASES);
      const qty = Number(String(qtyRaw).replace(/[, ]/g, ''));
      if (qtyRaw !== '' && Number.isFinite(qty)) {
        const key = code + '\u0000' + sku;
        if (seenExpected.has(key)) {
          addExpected.run(id, code, sku, qty);
        } else {
          seenExpected.add(key);
          setExpected.run(id, code, sku, qty);
        }
        stats.expected++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  bumpMasterVersion(id);
  stats.totals = {
    locations: db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(id).n,
    items: db.prepare('SELECT COUNT(*) n FROM items WHERE session_id = ?').get(id).n,
    barcodes: db.prepare('SELECT COUNT(*) n FROM item_barcodes WHERE session_id = ?').get(id).n,
    expected: db.prepare('SELECT COUNT(*) n FROM expected WHERE session_id = ?').get(id).n,
  };
  return stats;
}
