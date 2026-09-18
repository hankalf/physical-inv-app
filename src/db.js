import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadLayout } from './util/layouts.js';
import { scannerPrompts, scannerLayout, defaultSessionId } from './routes/scanner-prompts.js';
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
  mode           TEXT    NOT NULL DEFAULT 'full',   -- full (wall-to-wall) | cycle
  cycle_schedule TEXT,                               -- JSON: how often to generate a batch
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
  zone         TEXT,
  aisle        TEXT,
  level        TEXT,
  last_counted TEXT,        -- seeded from the ERP export, moved forward as lines land
  description  TEXT,
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
  levels       TEXT    NOT NULL DEFAULT '',          -- e.g. 'ABC'; '' = every level
  status       TEXT    NOT NULL DEFAULT 'queued',   -- queued | active | done
  created_at   TEXT    NOT NULL,
  started_at   TEXT,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assign_unique ON assignments(session_id, team, aisle, levels);
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

/* A word from the office to the floor: "come to the dock", "skip aisle 12, the
   forklift is in it". Addressed to one team or to everybody, and acknowledged
   from the handheld so a supervisor knows it was read rather than hoping. */
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team       TEXT,                          -- NULL: every team on this count
  body       TEXT    NOT NULL,
  sent_by    TEXT    NOT NULL,
  urgent     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id DESC);

CREATE TABLE IF NOT EXISTS message_acks (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id  TEXT    NOT NULL,
  team       TEXT,
  at         TEXT    NOT NULL,
  PRIMARY KEY (message_id, device_id)
);

/*
 * What the count says the ERP should be told, and who said so.
 *
 * A variance is not an adjustment until somebody owns it. On a wall-to-wall
 * count that is thousands of lines, and an auditor asking "who approved writing
 * off 400 cases, and why" wants a name and a reason, not a spreadsheet. Each
 * pallet whose count differs from the report gets a row here; a supervisor
 * approves it with a reason code or rejects it, and only what was approved
 * reaches the ERP file.
 *
 * Off unless a count turns it on, and then thresholds decide what is worth a
 * signature - a one-case difference on a pallet of 600 is not.
 */
CREATE TABLE IF NOT EXISTS adjustments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pallet_id    TEXT    NOT NULL,
  sku          TEXT,
  location     TEXT,
  expected_qty REAL,
  counted_qty  REAL,
  variance_qty REAL,
  kind         TEXT    NOT NULL,                    -- QTY VARIANCE | MISSING | NOT IN MASTER | WRONG BIN | COUNTED TWICE
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | auto (under the threshold)
  reason       TEXT,
  note         TEXT,
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adjust_unique ON adjustments(session_id, pallet_id);
CREATE INDEX IF NOT EXISTS idx_adjust_status ON adjustments(session_id, status);

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
  empty_bin        INTEGER NOT NULL DEFAULT 0,   -- bin checked and found empty (no pallet)
  pass             INTEGER NOT NULL DEFAULT 1,   -- 1 = first count, 2 = second count
  recount_id       INTEGER,
  override_reason  TEXT,
  voided           INTEGER NOT NULL DEFAULT 0,
  scanned_at       TEXT    NOT NULL,
  received_at      TEXT    NOT NULL
);

-- Registered scanners. Each has a unique link (/?d=<uid>) saved on the device
-- as its home-screen shortcut, which is how the app knows which scanner it is.
CREATE TABLE IF NOT EXISTS devices (
  uid          TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  notes        TEXT,
  token_hash   TEXT,                       -- sha256 of the token this scanner sends
  enrolled_at  TEXT,
  enrol_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_seen    TEXT,
  last_team    TEXT,
  last_session INTEGER
);

-- Second-count tasks: a bin to go back to, why, and who may do it.
CREATE TABLE IF NOT EXISTS recounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bin          TEXT    NOT NULL,
  pallet_id    TEXT,
  reason       TEXT    NOT NULL,          -- QTY VARIANCE | WRONG BIN | NOT IN MASTER | COUNTED TWICE | MISSING | MANUAL
  detail       TEXT,                      -- supervisor-only numbers
  source       TEXT    NOT NULL DEFAULT 'manual',   -- auto | manual
  first_team   TEXT,                      -- who did the first count; they may not do the second
  team         TEXT,                      -- assigned to / taken by
  status       TEXT    NOT NULL DEFAULT 'open',     -- open | taken | done
  created_at   TEXT    NOT NULL,
  taken_at     TEXT,
  done_at      TEXT,
  done_by_team TEXT
);
CREATE INDEX IF NOT EXISTS idx_recounts_session ON recounts(session_id, status);

-- Supervisor accounts. Role is 'admin' (may manage accounts) or 'supervisor'.
CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'supervisor',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  last_login    TEXT,
  must_change   INTEGER NOT NULL DEFAULT 0
);

-- Who changed what in the dashboard.
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  session_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(id DESC);

-- Small key/value store for site settings that must be editable without a deploy.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The roster. Employees and teams outlive a count session.
CREATE TABLE IF NOT EXISTS employees (
  badge      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  dept       TEXT,
  equipment  TEXT NOT NULL DEFAULT '[]',   -- JSON array of equipment keys
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  notes      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  badge   TEXT    NOT NULL REFERENCES employees(badge) ON DELETE CASCADE,
  PRIMARY KEY (team_id, badge)
);
CREATE INDEX IF NOT EXISTS idx_member_badge ON team_members(badge);

-- One generated day's (or week's) worth of cycle-count bins.
CREATE TABLE IF NOT EXISTS cycle_batches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  due_date   TEXT    NOT NULL,
  target     INTEGER NOT NULL,
  strategy   TEXT    NOT NULL,
  scope      TEXT,
  auto       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_session ON cycle_batches(session_id, due_date);

CREATE INDEX IF NOT EXISTS idx_counts_session ON counts(session_id, voided);
CREATE INDEX IF NOT EXISTS idx_counts_pallet  ON counts(session_id, pallet_id);
CREATE INDEX IF NOT EXISTS idx_counts_loc     ON counts(session_id, location_code);
CREATE INDEX IF NOT EXISTS idx_counts_team    ON counts(session_id, team);
CREATE INDEX IF NOT EXISTS idx_counts_device  ON counts(session_id, device_id);

-- Every screen that reports by aisle - the map, the progress board, the aisle
-- overview - asks "which bins are in this aisle". Without this it re-scans the
-- whole warehouse once per aisle, which is what makes those screens slow when
-- fifteen teams are refreshing them.
CREATE INDEX IF NOT EXISTS idx_locations_aisle ON locations(session_id, aisle);
`);

// Columns added after the first schema.
const hasCol = (t, c) => db.prepare(`PRAGMA table_info('${t}')`).all().some((x) => x.name === c);
if (!hasCol('sessions', 'layout')) db.exec('ALTER TABLE sessions ADD COLUMN layout TEXT');
if (!hasCol('locations', 'level')) db.exec('ALTER TABLE locations ADD COLUMN level TEXT');
if (!hasCol('counts', 'empty_bin')) db.exec('ALTER TABLE counts ADD COLUMN empty_bin INTEGER NOT NULL DEFAULT 0');
if (!hasCol('devices', 'token_hash')) {
  db.exec('ALTER TABLE devices ADD COLUMN token_hash TEXT');
  db.exec('ALTER TABLE devices ADD COLUMN enrolled_at TEXT');
  db.exec('ALTER TABLE devices ADD COLUMN enrol_count INTEGER NOT NULL DEFAULT 0');
}
if (!hasCol('locations', 'last_counted')) db.exec('ALTER TABLE locations ADD COLUMN last_counted TEXT');
if (!hasCol('sessions', 'mode')) db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'");
if (!hasCol('sessions', 'cycle_schedule')) db.exec('ALTER TABLE sessions ADD COLUMN cycle_schedule TEXT');
if (!hasCol('recounts', 'batch_id')) db.exec('ALTER TABLE recounts ADD COLUMN batch_id INTEGER');
if (!hasCol('counts', 'pass')) db.exec('ALTER TABLE counts ADD COLUMN pass INTEGER NOT NULL DEFAULT 1');
if (!hasCol('counts', 'recount_id')) db.exec('ALTER TABLE counts ADD COLUMN recount_id INTEGER');
if (!hasCol('sessions', 'auto_recount')) db.exec('ALTER TABLE sessions ADD COLUMN auto_recount INTEGER NOT NULL DEFAULT 1');
/* Lot codes and expiry dates. Off unless a count asks for them: a frozen-food
   site needs them for a recall, a spare-parts count would only be slowed down. */
if (!hasCol('counts', 'lot')) {
  db.exec('ALTER TABLE counts ADD COLUMN lot TEXT');
  db.exec('ALTER TABLE counts ADD COLUMN expiry TEXT');
}
if (!hasCol('pallets', 'lot')) {
  db.exec('ALTER TABLE pallets ADD COLUMN lot TEXT');
  db.exec('ALTER TABLE pallets ADD COLUMN expiry TEXT');
}
if (!hasCol('sessions', 'ask_lot')) {
  db.exec('ALTER TABLE sessions ADD COLUMN ask_lot INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN ask_expiry INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_counts_lot ON counts(session_id, lot)');

/* One physical pallet, two labels on it. The second tag is recorded as a line
   of its own so nobody counts it again and the report can explain it - but with
   no quantity, because the pallet under it has already been counted. */
if (!hasCol('counts', 'alias_of')) db.exec('ALTER TABLE counts ADD COLUMN alias_of TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_counts_alias ON counts(session_id, alias_of)');

/* A second count should be raised for a variance that matters, not for every
   unit of difference - otherwise the list buries the ones worth walking to. */
if (!hasCol('sessions', 'recount_min_qty')) {
  db.exec('ALTER TABLE sessions ADD COLUMN recount_min_qty INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN recount_min_pct REAL NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN recount_cap INTEGER NOT NULL DEFAULT 0');
}
/* Approvals on adjustments, and the ABC class an accuracy report is cut by.
   Both off unless a count asks for them: a cycle count run by one supervisor
   needs neither, and a wall-to-wall audited by a third party needs both. */
if (!hasCol('sessions', 'require_approval')) {
  db.exec('ALTER TABLE sessions ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN approval_min_qty INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN approval_min_pct REAL NOT NULL DEFAULT 0');
}
/* A label that will not scan is still a pallet that has to be counted. The line
   says which it was - typed off a damaged barcode, or no readable ID at all -
   so somebody can walk out with a label printer afterwards. */
if (!hasCol('counts', 'label_issue')) db.exec("ALTER TABLE counts ADD COLUMN label_issue TEXT NOT NULL DEFAULT ''");

/* A line on the office board: when lunch is, which dock is blocked. It belongs
   to the count rather than the site - it is about today. */
if (!hasCol('sessions', 'board_note')) {
  db.exec('ALTER TABLE sessions ADD COLUMN board_note TEXT');
  db.exec('ALTER TABLE sessions ADD COLUMN board_note_by TEXT');
  db.exec('ALTER TABLE sessions ADD COLUMN board_note_at TEXT');
}
if (!hasCol('sessions', 'track_abc')) db.exec('ALTER TABLE sessions ADD COLUMN track_abc INTEGER NOT NULL DEFAULT 0');
if (!hasCol('pallets', 'abc')) db.exec('ALTER TABLE pallets ADD COLUMN abc TEXT');

// a login can be handed out with a starter password the person must replace
if (!hasCol('users', 'must_change')) db.exec('ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
if (!hasCol('assignments', 'levels')) {
  // a team is assigned an aisle AND the levels it has the equipment for
  db.exec("ALTER TABLE assignments ADD COLUMN levels TEXT NOT NULL DEFAULT ''");
  db.exec('DROP INDEX IF EXISTS idx_assign_unique');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_assign_unique ON assignments(session_id, team, aisle, levels)');
}

export const norm = (v) => (v == null ? '' : String(v).trim().toUpperCase());

// A count line that still stands: not voided, and not a first-count line in a
// bin that has since been second-counted. `c` is the counts alias.
export const LIVE = (c = 'c') =>
  `${c}.voided = 0 AND NOT (${c}.pass = 1 AND EXISTS (
     SELECT 1 FROM counts s WHERE s.session_id = ${c}.session_id AND s.location_code = ${c}.location_code AND s.pass = 2 AND s.voided = 0))`;

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

/*
 * Sessions, with enough on each row to tell them apart in a picker: how big it
 * is, how far along, and when it was last touched. A name and an id alone are
 * not enough once a site has a few counts and a cycle programme running.
 */
export function listSessions(status) {
  const where = status ? 'WHERE s.status = ?' : '';
  const sql = `
    SELECT s.*,
           (SELECT COUNT(*) FROM locations l WHERE l.session_id = s.id) AS bins,
           (SELECT COUNT(DISTINCT c.location_code) FROM counts c
             WHERE c.session_id = s.id AND c.voided = 0) AS bins_counted,
           (SELECT COUNT(*) FROM counts c WHERE c.session_id = s.id AND c.voided = 0) AS lines,
           (SELECT MAX(c.scanned_at) FROM counts c WHERE c.session_id = s.id AND c.voided = 0) AS last_scan,
           (SELECT COUNT(*) FROM recounts r WHERE r.session_id = s.id AND r.status != 'done') AS recounts_open
      FROM sessions s ${where}
     ORDER BY s.status = 'closed', s.id DESC`;
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

export const getSession = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id));

export function createSession({ name, mode = 'full', palletMode = 'warn', guided = 1, askComments = 1, layout = '' }) {
  const check = ['off', 'warn', 'strict'].includes(palletMode) ? palletMode : 'warn';
  const kind = mode === 'cycle' ? 'cycle' : 'full';
  const info = db
    .prepare(
      `INSERT INTO sessions (name, mode, pallet_mode, guided, ask_comments, layout, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, kind, check, kind === 'cycle' ? 0 : (guided ? 1 : 0), askComments ? 1 : 0,
         String(layout || ''), new Date().toISOString());
  return getSession(info.lastInsertRowid);
}

/** The drawing the site is already using, so a new count is not back on a schematic. */
export const lastUsedLayout = () =>
  db.prepare("SELECT layout FROM sessions WHERE layout IS NOT NULL AND layout != '' ORDER BY id DESC LIMIT 1").get()?.layout || '';

/** What a delete would destroy. Shown before, recorded after. */
export function sessionContents(sessionId) {
  const id = Number(sessionId);
  const n = (sql) => db.prepare(sql).get(id).n;
  return {
    bins: n('SELECT COUNT(*) n FROM locations WHERE session_id = ?'),
    pallets: n('SELECT COUNT(*) n FROM pallets WHERE session_id = ?'),
    counts: n('SELECT COUNT(*) n FROM counts WHERE session_id = ?'),
    assignments: n('SELECT COUNT(*) n FROM assignments WHERE session_id = ?'),
    recounts: n('SELECT COUNT(*) n FROM recounts WHERE session_id = ?'),
    signons: n('SELECT COUNT(*) n FROM signons WHERE session_id = ?'),
    batches: n('SELECT COUNT(*) n FROM cycle_batches WHERE session_id = ?'),
  };
}

/**
 * Delete a count and everything under it.
 *
 * Every child table cascades, so this is one DELETE - but it is the only
 * irreversible thing in the app, so the guards live here rather than in the
 * route: an open count cannot be deleted at all, and one that holds counted
 * lines needs its own name typed back. The audit log keeps no foreign key to
 * sessions on purpose, so the record of what happened outlives the count.
 */
export function checkSessionDeletable(sessionId, { confirmName = '' } = {}) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('no such count'), { status: 404 });
  if (s.status !== 'closed') {
    throw Object.assign(new Error('close the count first - an open one may still have scanners posting to it'), { status: 409 });
  }
  const had = sessionContents(s.id);
  if (had.counts > 0 && String(confirmName).trim() !== String(s.name).trim()) {
    throw Object.assign(
      new Error(`this count holds ${had.counts.toLocaleString()} counted lines - type its name exactly to confirm`),
      { status: 409, needsName: true, name: s.name, contents: had });
  }
  return { session: s, had };
}

export function deleteSession(sessionId, { confirmName = '' } = {}) {
  const { session: s, had } = checkSessionDeletable(sessionId, { confirmName });
  db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  return { id: s.id, name: s.name, mode: s.mode || 'full', had };
}

export const bumpMasterVersion = (sessionId) =>
  db.prepare('UPDATE sessions SET master_version = master_version + 1 WHERE id = ?').run(Number(sessionId));

export const publicSession = (s) => ({
  id: s.id,
  name: s.name,
  palletMode: s.pallet_mode,
  mode: s.mode || 'full',
  guided: !!s.guided && (s.mode || 'full') === 'full',
  askComments: !!s.ask_comments,
  askLot: !!s.ask_lot,
  askExpiry: !!s.ask_expiry,
  autoRecount: !!s.auto_recount,
  masterVersion: s.master_version,
  layout: s.layout || null,
  // odd/even position -> Front/Back, so the gun can tell the counter which face a bin is on
  faces: loadLayout(s.layout)?.faces || null,
  // the one-tap reasons, and how long the comments step waits before moving on
  prompts: scannerPrompts(),
  layout_cfg: scannerLayout(),
  // the count a scanner should land on at sign-on, if a supervisor picked one
  isDefault: defaultSessionId() === s.id,
});

/* ------------------------------------------------------- handheld master data */

/*
 * The two big lists, kept ready between requests.
 *
 * Thirty handhelds pull this within the same minute of a shift starting, and
 * the lists only change when a supervisor uploads a new one - which is exactly
 * what master_version tracks. So build them once per version and hand the same
 * arrays to everyone; the session's own settings are still read fresh, because
 * those change without a new upload.
 */
const masterCache = new Map();

export function masterPayload(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  const hit = masterCache.get(id);
  if (hit && hit.version === s.master_version) {
    return { ...publicSession(s), sessionId: id, locations: hit.locations, pallets: hit.pallets };
  }
  const locations = db
    .prepare('SELECT code, zone, aisle, level FROM locations WHERE session_id = ? ORDER BY code')
    .all(id);
  const pallets = db
    .prepare('SELECT pallet_id, sku, description, expected_qty, expected_location, lot, expiry FROM pallets WHERE session_id = ?')
    .all(id);
  const built = {
    ...publicSession(s),
    sessionId: id,
    // Compact tuples: these lists can run to six figures of rows.
    locations: locations.map((l) => [l.code, l.zone || '', l.aisle || '', l.level || '']),
    // the gun checks a scanned lot against the one the report expects
    pallets: pallets.map((p) => [p.pallet_id, p.sku || '', p.description || '', p.expected_location || '', p.lot || '', p.expiry || '']),
  };
  // one session's lists at a time: a second count is a new upload, not a reason to hold both
  masterCache.clear();
  masterCache.set(id, { version: s.master_version, locations: built.locations, pallets: built.pallets });
  return built;
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
                    off_assignment, duplicate_pallet, empty_bin, pass, recount_id, override_reason,
                    lot, expiry, alias_of, label_issue, scanned_at, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(client_id) DO NOTHING
`);

// Idempotent on client_id: a device that re-sends after a dropped connection
// cannot create a second count line.
export function saveCounts(sessionId, rows) {
  const id = Number(sessionId);
  const now = new Date().toISOString();
  const accepted = [];
  const rejected = [];
  const firstCountPallets = new Set();
  const countedBins = new Set();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!r || !r.clientId) { rejected.push({ clientId: r?.clientId ?? null, reason: 'missing clientId' }); continue; }
      const empty = !!r.emptyBin;
      // a second label on a pallet already counted adds a tag, never a quantity
      const qty = empty || r.aliasOf ? 0 : Number(r.qty);
      if (!Number.isFinite(qty)) { rejected.push({ clientId: r.clientId, reason: 'invalid qty' }); continue; }
      if (!empty && !norm(r.palletId)) { rejected.push({ clientId: r.clientId, reason: 'missing pallet id' }); continue; }
      if (!norm(r.location)) { rejected.push({ clientId: r.clientId, reason: 'missing location' }); continue; }
      insertCount.run(
        String(r.clientId), id, empty ? 'EMPTY' : norm(r.palletId), qty, norm(r.location),
        r.comments ? String(r.comments).slice(0, 500) : null,
        r.sku ? norm(r.sku) : null,
        norm(r.team) || 'UNKNOWN',
        JSON.stringify(r.employees || []),
        norm(r.deviceId) || 'UNKNOWN',
        r.aisle ? norm(r.aisle) : null,
        r.unknownPallet ? 1 : 0, r.unknownLocation ? 1 : 0,
        r.offAssignment ? 1 : 0, r.duplicatePallet ? 1 : 0, empty ? 1 : 0,
        Number(r.pass) === 2 ? 2 : 1, r.recountId ? Number(r.recountId) : null,
        r.overrideReason ? String(r.overrideReason) : null,
        r.lot ? norm(r.lot).slice(0, 64) : null,
        r.expiry ? String(r.expiry).slice(0, 10) : null,
        r.aliasOf ? norm(r.aliasOf) : null,
        // 'typed' - read off a damaged barcode; 'none' - nothing readable on it at all
        ['typed', 'none'].includes(r.labelIssue) ? r.labelIssue : '',
        r.scannedAt || now, now
      );
      accepted.push(r.clientId);
      if (!empty && Number(r.pass) !== 2) firstCountPallets.add(norm(r.palletId));
      countedBins.add(norm(r.location));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // a counted bin is a counted bin: keep the cycle-count clock honest
  if (accepted.length) {
    const stamp = db.prepare('UPDATE locations SET last_counted = ? WHERE session_id = ? AND code = ?');
    for (const bin of countedBins) stamp.run(now, id, bin);
  }
  return { accepted, rejected, firstCountPallets: [...firstCountPallets] };
}

// Pallets already counted, so a device can warn before the same pallet is
// counted twice by two different teams.
export function countedPallets(sessionId, since) {
  const rows = since
    ? db.prepare(
        `SELECT pallet_id, location_code, team, scanned_at FROM counts
          WHERE session_id = ? AND voided = 0 AND empty_bin = 0 AND pass = 1 AND received_at > ? ORDER BY received_at`
      ).all(Number(sessionId), since)
    : db.prepare(
        `SELECT pallet_id, location_code, team, scanned_at FROM counts
          WHERE session_id = ? AND voided = 0 AND empty_bin = 0 AND pass = 1 ORDER BY received_at`
      ).all(Number(sessionId));
  const latest = db.prepare('SELECT MAX(received_at) AS m FROM counts WHERE session_id = ?').get(Number(sessionId)).m;
  return { pallets: rows.map((r) => [r.pallet_id, r.location_code, r.team]), watermark: latest };
}

/* -------------------------------------------------------------------- devices */

// Short, unambiguous id for a scanner link: no 0/O/1/I/L to misread off a label.
function newUid() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export const listDevices = () => db.prepare('SELECT * FROM devices ORDER BY name').all();
export const getDevice = (uid) => db.prepare('SELECT * FROM devices WHERE uid = ?').get(String(uid || ''));

export function createDevice({ name, notes }) {
  const n = norm(name);
  if (!n) throw Object.assign(new Error('scanner name required'), { status: 400 });
  if (db.prepare('SELECT 1 FROM devices WHERE name = ?').get(n)) throw Object.assign(new Error(`a scanner called ${n} already exists`), { status: 409 });
  let uid = newUid();
  while (getDevice(uid)) uid = newUid();
  db.prepare('INSERT INTO devices (uid, name, notes, created_at) VALUES (?, ?, ?, ?)').run(uid, n, notes ? String(notes) : null, new Date().toISOString());
  return getDevice(uid);
}

export function updateDevice(uid, { name, notes }) {
  const d = getDevice(uid);
  if (!d) throw Object.assign(new Error('scanner not found'), { status: 404 });
  const n = name == null ? d.name : norm(name);
  if (!n) throw Object.assign(new Error('scanner name required'), { status: 400 });
  db.prepare('UPDATE devices SET name = ?, notes = ? WHERE uid = ?').run(n, notes == null ? d.notes : String(notes), d.uid);
  return getDevice(uid);
}

export const deleteDevice = (uid) => db.prepare('DELETE FROM devices WHERE uid = ?').run(String(uid || '')).changes;

const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

/**
 * Trade the enrolment link for a token this scanner keeps and sends on every
 * call. Re-enrolment is allowed - a scanner gets wiped, a battery dies mid-setup
 * - but it is counted and timestamped so a leaked link shows up in the dashboard.
 */
export function enrollDevice(uid) {
  const d = getDevice(uid);
  if (!d) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('UPDATE devices SET token_hash = ?, enrolled_at = ?, enrol_count = enrol_count + 1 WHERE uid = ?')
    .run(hashToken(token), new Date().toISOString(), d.uid);
  return { uid: d.uid, name: d.name, token };
}

/** The scanner a token belongs to, or null. Constant-time on the hash. */
export function deviceByToken(token) {
  if (!token) return null;
  const want = Buffer.from(hashToken(token), 'hex');
  for (const d of db.prepare('SELECT * FROM devices WHERE token_hash IS NOT NULL').all()) {
    const have = Buffer.from(d.token_hash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) return d;
  }
  return null;
}

/** New link and new token: use when a link leaks or a scanner is lost. */
export function resetDevice(uid) {
  const d = getDevice(uid);
  if (!d) throw Object.assign(new Error('scanner not found'), { status: 404 });
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let fresh = '';
  for (const b of randomBytes(8)) fresh += alphabet[b % alphabet.length];
  db.prepare('UPDATE devices SET uid = ?, token_hash = NULL, enrolled_at = NULL, enrol_count = 0 WHERE uid = ?').run(fresh, d.uid);
  return getDevice(fresh);
}

export function touchDevice(uid, { team, sessionId } = {}) {
  if (!uid) return;
  db.prepare('UPDATE devices SET last_seen = ?, last_team = COALESCE(?, last_team), last_session = COALESCE(?, last_session) WHERE uid = ?')
    .run(new Date().toISOString(), team ? norm(team) : null, sessionId ? Number(sessionId) : null, String(uid));
}
