import { db, norm, getSession } from '../db.js';
import { parseRecords, pick } from '../util/csv.js';
import { loadLayout } from '../util/layouts.js';
import { faceOf } from './cycles.js';
import { parseBinCode } from '../util/bincode.js';

/*
 * Pallets to move back.
 *
 * Double-deep racking has a front position and one behind it. A pallet left in
 * the front with nothing behind it blocks the back slot and halves the aisle's
 * capacity. The list of those - front pallet, empty bin behind - is read off the
 * inventory report, or uploaded, and handed to the guns as a job of its own:
 * walk the aisle, scan the pallet, put it back, scan the bin it went into.
 *
 * Moves belong to the count whose bin list they were built from, because that
 * is where the bins and the pallets are known; they are not count lines, and
 * never touch what was counted.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pallet_id  TEXT NOT NULL,
  from_bin   TEXT NOT NULL,
  to_bin     TEXT NOT NULL,
  aisle      TEXT,
  level      TEXT,
  status     TEXT NOT NULL DEFAULT 'open',    -- open | done | skipped
  team       TEXT,
  device_id  TEXT,
  actual_bin TEXT,                            -- where it really went, when a gun says otherwise
  reason     TEXT,                            -- why it was skipped
  source     TEXT NOT NULL DEFAULT 'report',  -- report | upload
  created_at TEXT NOT NULL,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_moves_session ON moves(session_id, status, aisle);
`);

const now = () => new Date().toISOString();

/** The bin directly behind a front bin: same aisle and level, the next position. */
function behindOf(code, codes) {
  const p = parseBinCode(code);
  const m = /(\d+)$/.exec(code);
  if (!m) return null;
  const next = String(Number(m[1]) + 1).padStart(m[1].length, '0');
  const cand = code.slice(0, code.length - m[1].length) + next;
  if (!codes.has(cand)) return null;
  const q = parseBinCode(cand);
  return q.aisle === p.aisle && q.level === p.level ? cand : null;
}

/**
 * Read the moves off the report: every pallet expected in a front bin whose
 * bin behind exists and has nothing on the report.
 */
export function buildMoves(sessionId, { aisle = '', zone = '', replace = false } = {}) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const faces = loadLayout(s.layout)?.faces || null;
  const locs = db.prepare('SELECT code, zone, aisle, level, description FROM locations WHERE session_id = ?').all(id);
  const codes = new Set(locs.map((l) => l.code));
  const byCode = new Map(locs.map((l) => [l.code, l]));
  const occupied = new Map();
  for (const p of db.prepare('SELECT pallet_id, expected_location FROM pallets WHERE session_id = ?').all(id)) {
    if (!occupied.has(p.expected_location)) occupied.set(p.expected_location, []);
    occupied.get(p.expected_location).push(p.pallet_id);
  }
  const wantAisles = new Set(String(aisle || '').split(/[,\s]+/).map(norm).filter(Boolean));
  const wantZone = norm(zone);
  const found = [];
  for (const l of locs) {
    if (wantAisles.size && !wantAisles.has(l.aisle)) continue;
    if (wantZone && norm(l.zone) !== wantZone) continue;
    if (faceOf(l.code, l.description, faces) !== 'front') continue;
    const here = occupied.get(l.code) || [];
    if (here.length !== 1) continue;                    // nothing to move, or a bay already holding two
    const back = behindOf(l.code, codes);
    if (!back) continue;
    if ((occupied.get(back) || []).length) continue;    // something is behind it already
    found.push({ pallet: here[0], from: l.code, to: back, aisle: l.aisle || '', level: l.level || byCode.get(l.code)?.level || '' });
  }
  return saveMoves(id, found, 'report', replace);
}

function saveMoves(id, list, source, replace) {
  const open = new Set(db.prepare("SELECT pallet_id FROM moves WHERE session_id = ? AND status = 'open'").all(id).map((r) => r.pallet_id));
  let added = 0;
  db.exec('BEGIN');
  try {
    if (replace) db.prepare("DELETE FROM moves WHERE session_id = ? AND status = 'open'").run(id);
    const ins = db.prepare(`INSERT INTO moves (session_id, pallet_id, from_bin, to_bin, aisle, level, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of list) {
      if (!replace && open.has(m.pallet)) continue;      // already on the list
      ins.run(id, m.pallet, m.from, m.to, m.aisle, m.level, source, now());
      added++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { found: list.length, added, summary: moveSummary(id) };
}

/** An uploaded list: Pallet, From bin, To bin. Checked against the bin list. */
export function importMoves(sessionId, text, { replace = false } = {}) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const { records } = parseRecords(String(text || ''));
  if (!records.length) throw Object.assign(new Error('no rows found - the headings should be Pallet, From bin, To bin'), { status: 400 });
  const locs = new Map(db.prepare('SELECT code, aisle, level FROM locations WHERE session_id = ?').all(id).map((l) => [l.code, l]));
  const list = [];
  records.forEach((r, i) => {
    const line = i + 2;
    const pallet = norm(pick(r, ['pallet', 'pallet id', 'lpn', 'tag']));
    const from = norm(pick(r, ['from', 'from bin', 'bin', 'front bin', 'current bin']));
    const to = norm(pick(r, ['to', 'to bin', 'back bin', 'behind', 'destination']));
    if (!pallet && !from && !to) return;
    if (!pallet) throw Object.assign(new Error(`row ${line}: no pallet`), { status: 400 });
    if (!from || !to) throw Object.assign(new Error(`row ${line}: pallet ${pallet} needs a From bin and a To bin`), { status: 400 });
    if (!locs.has(from)) throw Object.assign(new Error(`row ${line}: ${from} is not on this count's bin list`), { status: 400 });
    if (!locs.has(to)) throw Object.assign(new Error(`row ${line}: ${to} is not on this count's bin list`), { status: 400 });
    if (from === to) throw Object.assign(new Error(`row ${line}: ${pallet} is already in ${to}`), { status: 400 });
    const l = locs.get(from);
    list.push({ pallet, from, to, aisle: l.aisle || '', level: l.level || '' });
  });
  if (!list.length) throw Object.assign(new Error('no moves found in the file'), { status: 400 });
  return saveMoves(id, list, 'upload', replace);
}

export function moveSummary(sessionId) {
  const id = Number(sessionId);
  const out = { open: 0, done: 0, skipped: 0, total: 0, aisles: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM moves WHERE session_id = ? GROUP BY status').all(id)) out[r.status] = r.n;
  out.total = out.open + out.done + out.skipped;
  out.aisles = db.prepare("SELECT COUNT(DISTINCT aisle) n FROM moves WHERE session_id = ? AND status = 'open'").get(id).n;
  return out;
}

export function listMoves(sessionId, { status = '', aisle = '' } = {}) {
  const id = Number(sessionId);
  const where = ['session_id = ?'];
  const args = [id];
  if (status) { where.push('status = ?'); args.push(status); }
  if (aisle) { where.push('aisle = ?'); args.push(norm(aisle)); }
  const rows = db.prepare(`SELECT * FROM moves WHERE ${where.join(' AND ')} ORDER BY aisle, from_bin, id`).all(...args)
    .sort((a, b) => (a.aisle || '').localeCompare(b.aisle || '', undefined, { numeric: true }) || a.from_bin.localeCompare(b.from_bin, undefined, { numeric: true }));
  return { summary: moveSummary(id), moves: rows };
}

/** The gun's view: open moves by aisle, in walking order. */
export function movesForGun(sessionId) {
  const rows = listMoves(sessionId, { status: 'open' }).moves;
  const byAisle = new Map();
  for (const m of rows) {
    if (!byAisle.has(m.aisle)) byAisle.set(m.aisle, []);
    byAisle.get(m.aisle).push({ id: m.id, pallet: m.pallet_id, from: m.from_bin, to: m.to_bin, level: m.level || '' });
  }
  return { aisles: [...byAisle].map(([aisle, moves]) => ({ aisle, open: moves.length, moves })) };
}

export function finishMove(sessionId, moveId, { team, deviceId, actualBin = '', status = 'done', reason = '' }) {
  const m = db.prepare('SELECT * FROM moves WHERE id = ? AND session_id = ?').get(Number(moveId), Number(sessionId));
  if (!m) throw Object.assign(new Error('move not found'), { status: 404 });
  if (m.status !== 'open') return { move: m, already: true };     // a re-send after a dropped signal
  const st = status === 'skipped' ? 'skipped' : 'done';
  db.prepare('UPDATE moves SET status = ?, team = ?, device_id = ?, actual_bin = ?, reason = ?, done_at = ? WHERE id = ?')
    .run(st, norm(team) || null, norm(deviceId) || null, st === 'done' ? (norm(actualBin) || m.to_bin) : null, st === 'skipped' ? String(reason || '').slice(0, 200) : null, now(), m.id);
  if (st === 'done') {
    // the report now says the pallet is where it was put, so the count that follows expects it there
    db.prepare('UPDATE pallets SET expected_location = ? WHERE session_id = ? AND pallet_id = ? AND expected_location = ?')
      .run(norm(actualBin) || m.to_bin, m.session_id, m.pallet_id, m.from_bin);
  }
  return { move: db.prepare('SELECT * FROM moves WHERE id = ?').get(m.id), already: false };
}

export const clearOpenMoves = (sessionId) =>
  db.prepare("DELETE FROM moves WHERE session_id = ? AND status = 'open'").run(Number(sessionId)).changes;

/**
 * The bin list the site is working from: the newest real count that has one
 * (an open one first). Front bins and moves are a job on the warehouse, not on
 * a count, so they use this without anybody picking anything.
 */
export function referenceSession() {
  return db.prepare(`SELECT s.* FROM sessions s
    WHERE s.practice = 0 AND EXISTS (SELECT 1 FROM locations l WHERE l.session_id = s.id)
    ORDER BY s.status = 'closed', s.id DESC LIMIT 1`).get() || null;
}

export const openMoveCount = (sessionId) =>
  db.prepare("SELECT COUNT(*) n FROM moves WHERE session_id = ? AND status = 'open'").get(Number(sessionId)).n;
