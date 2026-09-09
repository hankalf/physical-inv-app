import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

// node:sqlite needs Node 22.5+. Without this the failure is an opaque module
// error in a deploy log, so say what is actually wrong.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `[fatal] Node ${process.versions.node} is too old - this app needs Node 22.5 or newer for node:sqlite.`
  );
  process.exit(1);
}

/**
 * Resolve the database file, falling back to a local directory when the
 * configured path is not writable - a Railway deploy with no volume mounted
 * would otherwise crash-loop instead of starting.
 */
function resolveDbPath() {
  const wanted = resolve(process.env.DB_PATH || './data/inventory.db');
  try {
    mkdirSync(dirname(wanted), { recursive: true });
    accessSync(dirname(wanted), constants.W_OK);
    return wanted;
  } catch (err) {
    const fallback = resolve('./data/inventory.db');
    if (fallback === wanted) throw err;
    console.warn(
      `[warn] ${dirname(wanted)} is not writable (${err.code || err.message}); using ${fallback}. ` +
      'Counts will NOT survive a redeploy - mount a volume there and set DB_PATH.'
    );
    mkdirSync(dirname(fallback), { recursive: true });
    return fallback;
  }
}

const DB_PATH = resolveDbPath();
console.log(`[db] node ${process.versions.node}, database at ${DB_PATH}`);

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// The first cut of this app counted SKUs; it now counts pallets. Any database
// left over from that version is set aside rather than silently misread.
function setAsideLegacySchema() {
  const cols = db.prepare("PRAGMA table_info('counts')").all();
  if (!cols.length) return;
  if (cols.some((c) => c.name === 'pallet_id')) return;
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  console.warn(`[migrate] pre-pallet schema found; renaming old tables with suffix _v1_${stamp}`);
  for (const t of ['counts', 'expected', 'item_barcodes', 'items', 'locations', 'sessions']) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (exists) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_v1_${stamp}`);
  }
}
setAsideLegacySchema();

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open',
  -- how strictly a scanned pallet id is checked against the uploaded list
  pallet_mode    TEXT    NOT NULL DEFAULT 'warn',   -- off | warn | strict
  guided         INTEGER NOT NULL DEFAULT 1,        -- teams follow aisle assignments
  ask_comments   INTEGER NOT NULL DEFAULT 1,
  master_version INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  closed_at      TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code        TEXT    NOT NULL,
  zone        TEXT,
  aisle       TEXT,
  description TEXT,
  PRIMARY KEY (session_id, code)
);

-- An aisle belongs to a conflict block. Racking that backs onto itself shares a
-- block, so only one team may be active in that block at a time.
CREATE TABLE IF NOT EXISTS aisles (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  aisle      TEXT    NOT NULL,
  block      TEXT    NOT NULL,
  PRIMARY KEY (session_id, aisle)
);

CREATE TABLE IF NOT EXISTS pallets (
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pallet_id         TEXT    NOT NULL,
  sku               TEXT,
  description       TEXT,
  uom               TEXT,
  expected_qty      REAL,
  expected_location TEXT,
  PRIMARY KEY (session_id, pallet_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team         TEXT    NOT NULL,
  aisle        TEXT    NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'queued',   -- queued | active | done
  created_at   TEXT    NOT NULL,
  started_at   TEXT,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assign_unique ON assignments(session_id, team, aisle);
CREATE INDEX IF NOT EXISTS idx_assign_team ON assignments(session_id, team, status);

-- Audit of which employees were on which scanner, and when.
CREATE TABLE IF NOT EXISTS signons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id  TEXT    NOT NULL,
  team       TEXT    NOT NULL,
  employees  TEXT    NOT NULL,
  started_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signon_session ON signons(session_id, started_at);

CREATE TABLE IF NOT EXISTS counts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT    NOT NULL UNIQUE,
  session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pallet_id        TEXT    NOT NULL,
  qty              REAL    NOT NULL,
  location_code    TEXT    NOT NULL,
  comments         TEXT,
  sku              TEXT,
  team             TEXT    NOT NULL,
  employees        TEXT,
  device_id        TEXT    NOT NULL,
  aisle            TEXT,
  unknown_pallet   INTEGER NOT NULL DEFAULT 0,
  unknown_location INTEGER NOT NULL DEFAULT 0,
  off_assignment   INTEGER NOT NULL DEFAULT 0,
  duplicate_pallet INTEGER NOT NULL DEFAULT 0,
  override_reason  TEXT,
  voided           INTEGER NOT NULL DEFAULT 0,
  scanned_at       TEXT    NOT NULL,
  received_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_counts_session ON counts(session_id, voided);
CREATE INDEX IF NOT EXISTS idx_counts_pallet  ON counts(session_id, pallet_id);
CREATE INDEX IF NOT EXISTS idx_counts_loc     ON counts(session_id, location_code);
CREATE INDEX IF NOT EXISTS idx_counts_team    ON counts(session_id, team);
CREATE INDEX IF NOT EXISTS idx_counts_device  ON counts(session_id, device_id);
`);

// Added after the first schema: a drawing the map is laid over, per session.
if (!db.prepare("PRAGMA table_info('sessions')").all().some((c) => c.name === 'layout')) {
  db.exec("ALTER TABLE sessions ADD COLUMN layout TEXT");
}

export const norm = (v) => (v == null ? '' : String(v).trim().toUpperCase());

/**
 * Find a session aisle from what a person typed: exact match first, then by
 * aisle number ("1", "01" and "F01" all mean row 1) when that is unambiguous.
 */
export function resolveAisle(sessionId, raw) {
  const want = norm(raw);
  if (!want) return null;
  const id = Number(sessionId);
  if (db.prepare('SELECT 1 FROM aisles WHERE session_id = ? AND aisle = ?').get(id, want)) return want;
  const num = /(\d+)\s*$/.exec(want);
  if (!num) return null;
  const n = String(Number(num[1]));
  const hits = db
    .prepare('SELECT aisle FROM aisles WHERE session_id = ?').all(id)
    .filter((r) => { const m = /(\d+)\s*$/.exec(r.aisle); return m && String(Number(m[1])) === n; });
  return hits.length === 1 ? hits[0].aisle : null;
}

/* ------------------------------------------------------------------ sessions */

export function listSessions(status) {
  const sql = status
    ? 'SELECT * FROM sessions WHERE status = ? ORDER BY id DESC'
    : 'SELECT * FROM sessions ORDER BY id DESC';
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

export const getSession = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id));

export function createSession({ name, palletMode = 'warn', guided = 1, askComments = 1 }) {
  const mode = ['off', 'warn', 'strict'].includes(palletMode) ? palletMode : 'warn';
  const info = db
    .prepare(
      `INSERT INTO sessions (name, pallet_mode, guided, ask_comments, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, mode, guided ? 1 : 0, askComments ? 1 : 0, new Date().toISOString());
  return getSession(info.lastInsertRowid);
}

export const bumpMasterVersion = (sessionId) =>
  db.prepare('UPDATE sessions SET master_version = master_version + 1 WHERE id = ?').run(Number(sessionId));

export const publicSession = (s) => ({
  id: s.id,
  name: s.name,
  palletMode: s.pallet_mode,
  guided: !!s.guided,
  askComments: !!s.ask_comments,
  masterVersion: s.master_version,
  layout: s.layout || null,
});

/* ------------------------------------------------------- handheld master data */

export function masterPayload(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  const locations = db
    .prepare('SELECT code, zone, aisle FROM locations WHERE session_id = ? ORDER BY code')
    .all(id);
  const pallets = db
    .prepare('SELECT pallet_id, sku, description, expected_qty, expected_location FROM pallets WHERE session_id = ?')
    .all(id);
  return {
    ...publicSession(s),
    sessionId: id,
    // Compact tuples: these lists can run to six figures of rows.
    locations: locations.map((l) => [l.code, l.zone || '', l.aisle || '']),
    pallets: pallets.map((p) => [p.pallet_id, p.sku || '', p.description || '', p.expected_location || '']),
  };
}

/* ------------------------------------------------------------------- sign-ons */

export function recordSignon(sessionId, { deviceId, team, employees }) {
  db.prepare(
    'INSERT INTO signons (session_id, device_id, team, employees, started_at) VALUES (?, ?, ?, ?, ?)'
  ).run(Number(sessionId), norm(deviceId), norm(team), JSON.stringify(employees || []), new Date().toISOString());
}

/* --------------------------------------------------------------------- counts */

const insertCount = db.prepare(`
INSERT INTO counts (client_id, session_id, pallet_id, qty, location_code, comments, sku,
                    team, employees, device_id, aisle, unknown_pallet, unknown_location,
                    off_assignment, duplicate_pallet, override_reason, scanned_at, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(client_id) DO NOTHING
`);

// Idempotent on client_id: a device that re-sends after a dropped connection
// cannot create a second count line.
export function saveCounts(sessionId, rows) {
  const id = Number(sessionId);
  const now = new Date().toISOString();
  const accepted = [];
  const rejected = [];
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!r || !r.clientId) { rejected.push({ clientId: r?.clientId ?? null, reason: 'missing clientId' }); continue; }
      const qty = Number(r.qty);
      if (!Number.isFinite(qty)) { rejected.push({ clientId: r.clientId, reason: 'invalid qty' }); continue; }
      if (!norm(r.palletId)) { rejected.push({ clientId: r.clientId, reason: 'missing pallet id' }); continue; }
      if (!norm(r.location)) { rejected.push({ clientId: r.clientId, reason: 'missing location' }); continue; }
      insertCount.run(
        String(r.clientId), id, norm(r.palletId), qty, norm(r.location),
        r.comments ? String(r.comments).slice(0, 500) : null,
        r.sku ? norm(r.sku) : null,
        norm(r.team) || 'UNKNOWN',
        JSON.stringify(r.employees || []),
        norm(r.deviceId) || 'UNKNOWN',
        r.aisle ? norm(r.aisle) : null,
        r.unknownPallet ? 1 : 0, r.unknownLocation ? 1 : 0,
        r.offAssignment ? 1 : 0, r.duplicatePallet ? 1 : 0,
        r.overrideReason ? String(r.overrideReason) : null,
        r.scannedAt || now, now
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

// Pallets already counted, so a device can warn before the same pallet is
// counted twice by two different teams.
export function countedPallets(sessionId, since) {
  const rows = since
    ? db.prepare(
        `SELECT pallet_id, location_code, team, scanned_at FROM counts
          WHERE session_id = ? AND voided = 0 AND received_at > ? ORDER BY received_at`
      ).all(Number(sessionId), since)
    : db.prepare(
        `SELECT pallet_id, location_code, team, scanned_at FROM counts
          WHERE session_id = ? AND voided = 0 ORDER BY received_at`
      ).all(Number(sessionId));
  const latest = db.prepare('SELECT MAX(received_at) AS m FROM counts WHERE session_id = ?').get(Number(sessionId)).m;
  return { pallets: rows.map((r) => [r.pallet_id, r.location_code, r.team]), watermark: latest };
}
