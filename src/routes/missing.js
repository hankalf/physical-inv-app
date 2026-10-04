import { db, norm } from '../db.js';
import { parseRecords, pick } from '../util/csv.js';

/*
 * Not in location: pallets the system has lost track of.
 *
 * A pallet the ERP says is in F03B012 and is not; one that came off a trailer
 * and never got a bin; one somebody moved and did not say. The office uploads
 * the list - pallet, what it is, the last place it was seen - and the inventory
 * team keeps an eye out. The app does the watching: the moment any gun scans a
 * pallet on the list, during any count or move, it is marked found, where, by
 * whom. The gun tells the counter too, so they do not walk past it.
 *
 * The list is the site's, not a count's: a pallet stays lost across counts
 * until it turns up or is written off.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS missing (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pallet_id      TEXT NOT NULL,
  sku            TEXT, description TEXT, qty REAL, uom TEXT, lot TEXT,
  last_location  TEXT,
  note           TEXT,
  batch          TEXT,                       -- the upload it came in on
  status         TEXT NOT NULL DEFAULT 'missing',   -- missing | found | closed
  found_bin      TEXT, found_team TEXT, found_device TEXT, found_session INTEGER, found_at TEXT, found_how TEXT,
  closed_by      TEXT, closed_at TEXT, outcome TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missing_status ON missing(status, pallet_id);
`);
/* A row planted by the Testing Suite belongs to one person's practice: their
   practice gun is the only gun that watches for it, and the real Not in
   Location page never lists it. NULL is the site's own list. */
if (!db.prepare("PRAGMA table_info('missing')").all().some((c) => c.name === 'practice_owner')) db.exec('ALTER TABLE missing ADD COLUMN practice_owner TEXT');

const now = () => new Date().toISOString();
const COL = {
  pallet: ['pallet', 'pallet id', 'pallet number', 'lpn', 'tag', 'license plate', 'package no'],
  sku: ['item', 'sku', 'item no', 'item number', 'product'],
  description: ['description', 'desc', 'item description'],
  qty: ['qty', 'quantity', 'cases', 'units'],
  uom: ['uom', 'unit', 'unit of measure'],
  lot: ['lot', 'lot no', 'lot code', 'batch'],
  last: ['last known location', 'last location', 'last seen', 'location', 'bin', 'bin code', 'expected location'],
  note: ['note', 'notes', 'comment'],
};

/** Upload a list. A pallet already open on the list is updated, not doubled. */
export function importMissing(text, { label = '', owner = null } = {}) {
  const { records } = parseRecords(String(text || ''));
  if (!records.length) throw Object.assign(new Error('no rows found - the headings should include Pallet and Last known location'), { status: 400 });
  const batch = String(label || '').replace(/\.(csv|xlsx?|xlsm|txt)$/i, '').slice(0, 60) || now().slice(0, 10);
  let added = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    records.forEach((r, i) => {
      const pallet = norm(pick(r, COL.pallet));
      if (!pallet) { if (Object.values(r).some((v) => v)) throw Object.assign(new Error(`row ${i + 2}: no pallet`), { status: 400 }); return; }
      const rawQty = pick(r, COL.qty);
      const qty = rawQty === '' ? null : Number(String(rawQty).replace(/[\s,]/g, ''));
      if (rawQty !== '' && !Number.isFinite(qty)) throw Object.assign(new Error(`row ${i + 2}: "${rawQty}" is not a quantity for ${pallet}`), { status: 400 });
      const vals = [pick(r, COL.sku) || null, pick(r, COL.description) || null, qty, pick(r, COL.uom) || null, norm(pick(r, COL.lot)) || null,
        norm(pick(r, COL.last)) || null, pick(r, COL.note) || null, batch];
      const open = db.prepare("SELECT id FROM missing WHERE pallet_id = ? AND status = 'missing' AND practice_owner IS ?").get(pallet, owner);
      if (open) {
        db.prepare(`UPDATE missing SET sku = COALESCE(?, sku), description = COALESCE(?, description), qty = COALESCE(?, qty), uom = COALESCE(?, uom),
                      lot = COALESCE(?, lot), last_location = COALESCE(?, last_location), note = COALESCE(?, note), batch = ? WHERE id = ?`).run(...vals, open.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO missing (pallet_id, sku, description, qty, uom, lot, last_location, note, batch, created_at, practice_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(pallet, ...vals, now(), owner);
        added++;
      }
    });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { added, updated, batch, summary: missingSummary(owner) };
}

export function addMissing(body = {}) {
  const pallet = norm(body.pallet);
  if (!pallet) throw Object.assign(new Error('pallet required'), { status: 400 });
  return importMissing(`Pallet,Item,Description,Qty,Lot,Last known location,Note\n${[pallet, body.sku, body.description, body.qty, body.lot, body.last, body.note]
    .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')}\n`, { label: 'typed in' });
}

export function missingSummary(owner = null) {
  const out = { missing: 0, found: 0, closed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM missing WHERE practice_owner IS ? GROUP BY status').all(owner)) out[r.status] = r.n;
  out.total = out.missing + out.found + out.closed;
  return out;
}

export function listMissing({ status = '', owner = null } = {}) {
  const rows = status ? db.prepare('SELECT * FROM missing WHERE status = ? AND practice_owner IS ? ORDER BY id DESC').all(status, owner)
    : db.prepare("SELECT * FROM missing WHERE practice_owner IS ? ORDER BY status = 'closed', status = 'found', id DESC").all(owner);
  return { summary: missingSummary(owner), rows };
}

/** The gun's copy: every pallet still lost, and where it was last seen. */
export const missingForGun = (owner = null) =>
  db.prepare("SELECT pallet_id, last_location, description FROM missing WHERE status = 'missing' AND practice_owner IS ? ORDER BY id").all(owner)
    .map((r) => [r.pallet_id, r.last_location || '', r.description || '']);

/**
 * A pallet on the list has been scanned somewhere. Called for every count line
 * and every move that lands; cheap when the list is empty.
 */
export function markFound(palletId, { bin, team = '', device = '', sessionId = null, how = 'counted', owner = null } = {}) {
  const p = norm(palletId);
  if (!p) return null;
  const row = db.prepare("SELECT id FROM missing WHERE pallet_id = ? AND status = 'missing' AND practice_owner IS ?").get(p, owner);
  if (!row) return null;
  db.prepare(`UPDATE missing SET status = 'found', found_bin = ?, found_team = ?, found_device = ?, found_session = ?, found_at = ?, found_how = ? WHERE id = ?`)
    .run(norm(bin) || null, norm(team) || null, norm(device) || null, sessionId ? Number(sessionId) : null, now(), how, row.id);
  return db.prepare('SELECT * FROM missing WHERE id = ?').get(row.id);
}

export function foundByHand(id, { bin, by }) {
  const row = db.prepare('SELECT * FROM missing WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('not on the list'), { status: 404 });
  db.prepare(`UPDATE missing SET status = 'found', found_bin = ?, found_team = NULL, found_device = ?, found_at = ?, found_how = 'by hand' WHERE id = ?`)
    .run(norm(bin) || null, by || 'a supervisor', now(), row.id);
  return db.prepare('SELECT * FROM missing WHERE id = ?').get(row.id);
}

export function closeMissing(id, { by, outcome = '', reopen = false }) {
  const row = db.prepare('SELECT * FROM missing WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('not on the list'), { status: 404 });
  if (reopen) db.prepare("UPDATE missing SET status = 'missing', found_bin = NULL, found_team = NULL, found_device = NULL, found_at = NULL, found_how = NULL, closed_by = NULL, closed_at = NULL, outcome = NULL WHERE id = ?").run(row.id);
  else db.prepare("UPDATE missing SET status = 'closed', closed_by = ?, closed_at = ?, outcome = ? WHERE id = ?").run(by || 'a supervisor', now(), String(outcome || '').slice(0, 300) || null, row.id);
  return db.prepare('SELECT * FROM missing WHERE id = ?').get(row.id);
}

export const deleteMissing = (id) => db.prepare('DELETE FROM missing WHERE id = ?').run(Number(id)).changes;

/* The Testing Suite's own rows: planted for one person, cleared with their run. */
export const practiceMissingRows = (owner) => db.prepare('SELECT * FROM missing WHERE practice_owner = ? ORDER BY id').all(owner);
export const clearPracticeMissing = (owner) => db.prepare('DELETE FROM missing WHERE practice_owner = ?').run(owner).changes;
