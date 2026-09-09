import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DB_PATH || './data/inventory.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open',
  blind          INTEGER NOT NULL DEFAULT 1,
  require_lpn    INTEGER NOT NULL DEFAULT 0,
  allow_override INTEGER NOT NULL DEFAULT 1,
  master_version INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  closed_at      TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code        TEXT    NOT NULL,
  zone        TEXT,
  description TEXT,
  PRIMARY KEY (session_id, code)
);

CREATE TABLE IF NOT EXISTS items (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sku         TEXT    NOT NULL,
  description TEXT,
  uom         TEXT,
  PRIMARY KEY (session_id, sku)
);

-- Every scannable code that resolves to a SKU: the SKU itself, UPCs,
-- alternates, and case codes (pack_qty > 1 multiplies the entered quantity).
CREATE TABLE IF NOT EXISTS item_barcodes (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  barcode    TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  pack_qty   REAL    NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, barcode)
);

CREATE TABLE IF NOT EXISTS expected (
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  location_code TEXT    NOT NULL,
  sku           TEXT    NOT NULL,
  qty           REAL    NOT NULL,
  PRIMARY KEY (session_id, location_code, sku)
);

CREATE TABLE IF NOT EXISTS counts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT    NOT NULL UNIQUE,
  session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  location_code    TEXT    NOT NULL,
  sku              TEXT    NOT NULL,
  scanned_barcode  TEXT,
  lpn              TEXT,
  qty              REAL    NOT NULL,
  counter          TEXT    NOT NULL,
  device           TEXT,
  pass             INTEGER NOT NULL DEFAULT 1,
  override_reason  TEXT,
  unknown_item     INTEGER NOT NULL DEFAULT 0,
  unknown_location INTEGER NOT NULL DEFAULT 0,
  voided           INTEGER NOT NULL DEFAULT 0,
  scanned_at       TEXT    NOT NULL,
  received_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_counts_session  ON counts(session_id, voided);
CREATE INDEX IF NOT EXISTS idx_counts_loc      ON counts(session_id, location_code, sku);
CREATE INDEX IF NOT EXISTS idx_counts_counter  ON counts(session_id, counter);
CREATE INDEX IF NOT EXISTS idx_locations_zone  ON locations(session_id, zone);
`);

export const norm = (v) => (v == null ? '' : String(v).trim().toUpperCase());

export function listSessions(status) {
  const sql = status
    ? 'SELECT * FROM sessions WHERE status = ? ORDER BY id DESC'
    : 'SELECT * FROM sessions ORDER BY id DESC';
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id));
}

export function createSession({ name, blind = 1, requireLpn = 0, allowOverride = 1 }) {
  const info = db
    .prepare(
      `INSERT INTO sessions (name, blind, require_lpn, allow_override, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, blind ? 1 : 0, requireLpn ? 1 : 0, allowOverride ? 1 : 0, new Date().toISOString());
  return getSession(info.lastInsertRowid);
}

export function bumpMasterVersion(sessionId) {
  db.prepare('UPDATE sessions SET master_version = master_version + 1 WHERE id = ?').run(
    Number(sessionId)
  );
}

// Master payload the handheld caches for offline validation.
export function masterPayload(sessionId) {
  const id = Number(sessionId);
  const session = getSession(id);
  const locations = db
    .prepare('SELECT code, zone, description FROM locations WHERE session_id = ? ORDER BY code')
    .all(id);
  const items = db
    .prepare('SELECT sku, description, uom FROM items WHERE session_id = ? ORDER BY sku')
    .all(id);
  const barcodes = db
    .prepare('SELECT barcode, sku, pack_qty FROM item_barcodes WHERE session_id = ?')
    .all(id);
  return {
    sessionId: id,
    masterVersion: session.master_version,
    blind: !!session.blind,
    requireLpn: !!session.require_lpn,
    allowOverride: !!session.allow_override,
    // Compact tuple form: master files run to six figures of rows.
    locations: locations.map((l) => [l.code, l.zone || '', l.description || '']),
    items: items.map((i) => [i.sku, i.description || '', i.uom || '']),
    barcodes: barcodes.map((b) => [b.barcode, b.sku, b.pack_qty]),
  };
}

const insertCount = db.prepare(`
INSERT INTO counts (client_id, session_id, location_code, sku, scanned_barcode, lpn, qty,
                    counter, device, pass, override_reason, unknown_item, unknown_location,
                    scanned_at, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(client_id) DO NOTHING
`);

// Idempotent: a device that re-sends after a dropped connection is a no-op.
export function saveCounts(sessionId, rows) {
  const id = Number(sessionId);
  const now = new Date().toISOString();
  const accepted = [];
  const rejected = [];
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!r || !r.clientId) {
        rejected.push({ clientId: r?.clientId ?? null, reason: 'missing clientId' });
        continue;
      }
      const qty = Number(r.qty);
      if (!Number.isFinite(qty)) {
        rejected.push({ clientId: r.clientId, reason: 'invalid qty' });
        continue;
      }
      insertCount.run(
        String(r.clientId),
        id,
        norm(r.location),
        norm(r.sku),
        r.scannedBarcode ? norm(r.scannedBarcode) : null,
        r.lpn ? norm(r.lpn) : null,
        qty,
        String(r.counter || 'UNKNOWN').trim(),
        r.device ? String(r.device) : null,
        Number(r.pass) === 2 ? 2 : 1,
        r.overrideReason ? String(r.overrideReason) : null,
        r.unknownItem ? 1 : 0,
        r.unknownLocation ? 1 : 0,
        r.scannedAt || now,
        now
      );
      accepted.push(r.clientId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { accepted, rejected };
}

export function progress(sessionId) {
  const id = Number(sessionId);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS lines,
              COUNT(DISTINCT location_code) AS locations_counted,
              COUNT(DISTINCT counter) AS counters
         FROM counts WHERE session_id = ? AND voided = 0`
    )
    .get(id);
  const locationTotal = db
    .prepare('SELECT COUNT(*) AS n FROM locations WHERE session_id = ?')
    .get(id).n;
  const byZone = db
    .prepare(
      `SELECT COALESCE(l.zone, '(none)') AS zone,
              COUNT(DISTINCT l.code) AS total,
              COUNT(DISTINCT c.location_code) AS counted
         FROM locations l
         LEFT JOIN counts c
           ON c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0
        WHERE l.session_id = ?
        GROUP BY COALESCE(l.zone, '(none)')
        ORDER BY zone`
    )
    .all(id);
  const byCounter = db
    .prepare(
      `SELECT counter, COUNT(*) AS lines, MAX(scanned_at) AS last_scan
         FROM counts WHERE session_id = ? AND voided = 0
        GROUP BY counter ORDER BY lines DESC`
    )
    .all(id);
  const exceptions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM counts
        WHERE session_id = ? AND voided = 0
          AND (unknown_item = 1 OR unknown_location = 1 OR override_reason IS NOT NULL)`
    )
    .get(id).n;
  return {
    ...totals,
    locations_total: locationTotal,
    overrides: exceptions,
    byZone,
    byCounter,
  };
}

// Counted vs expected, including expected rows nobody counted (shorts)
// and counted rows with no expectation (found stock).
export function variance(sessionId) {
  return db
    .prepare(
      `WITH counted AS (
         SELECT location_code, sku, SUM(qty) AS qty, MAX(pass) AS max_pass
           FROM counts WHERE session_id = ? AND voided = 0
          GROUP BY location_code, sku
       ),
       keys AS (
         SELECT location_code, sku FROM counted
         UNION
         SELECT location_code, sku FROM expected WHERE session_id = ?
       )
       SELECT k.location_code, k.sku,
              COALESCE(i.description, '') AS description,
              COALESCE(e.qty, 0) AS expected_qty,
              COALESCE(c.qty, 0) AS counted_qty,
              COALESCE(c.qty, 0) - COALESCE(e.qty, 0) AS variance_qty,
              CASE WHEN e.qty IS NULL THEN 'FOUND'
                   WHEN c.qty IS NULL THEN 'MISSING'
                   WHEN c.qty = e.qty THEN 'MATCH'
                   ELSE 'VARIANCE' END AS status,
              COALESCE(c.max_pass, 0) AS passes
         FROM keys k
         LEFT JOIN counted   c ON c.location_code = k.location_code AND c.sku = k.sku
         LEFT JOIN expected  e ON e.session_id = ? AND e.location_code = k.location_code AND e.sku = k.sku
         LEFT JOIN items     i ON i.session_id = ? AND i.sku = k.sku
        ORDER BY status DESC, ABS(COALESCE(c.qty,0) - COALESCE(e.qty,0)) DESC, k.location_code, k.sku`
    )
    .all(Number(sessionId), Number(sessionId), Number(sessionId), Number(sessionId));
}

export function rawCounts(sessionId) {
  return db
    .prepare(
      `SELECT c.id, c.session_id, c.location_code, c.sku,
              COALESCE(i.description,'') AS description,
              c.scanned_barcode, c.lpn, c.qty, c.counter, c.device, c.pass,
              c.override_reason, c.unknown_item, c.unknown_location, c.voided,
              c.scanned_at, c.received_at
         FROM counts c
         LEFT JOIN items i ON i.session_id = c.session_id AND i.sku = c.sku
        WHERE c.session_id = ?
        ORDER BY c.id`
    )
    .all(Number(sessionId));
}
