import { db, norm, getSession } from '../db.js';
import { labelsToReplace } from './reports.js';

/*
 * The fix list: what the floor found that somebody has to go and put right.
 *
 * A count walks every bin in the building, which makes it the best inspection
 * the warehouse gets all year - as long as what the counters see is written
 * down somewhere other than a radio call. So the gun has one button for it: a
 * damaged pallet, racking that is bent or leaning, product that is leaking, a
 * bin blocked by a trailer that the team will come back to. Each lands here
 * with the bin, the pallet, who saw it and when, and stays until a supervisor
 * marks it fixed. The labels that would not scan are the same kind of thing,
 * so the list shows them together.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,              -- damage | blocked | other
  target     TEXT NOT NULL DEFAULT '',   -- pallet | rack | product | bin
  pallet_id  TEXT,
  bin        TEXT,
  aisle      TEXT,
  reason     TEXT NOT NULL,
  note       TEXT,
  team       TEXT,
  device_id  TEXT,
  employees  TEXT,
  status     TEXT NOT NULL DEFAULT 'open',   -- open | fixed
  fixed_by   TEXT,
  fixed_at   TEXT,
  outcome    TEXT,
  created_at TEXT NOT NULL,
  client_id  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_issues_session ON issues(session_id, status, id);
`);

const now = () => new Date().toISOString();
const KINDS = new Set(['damage', 'blocked', 'other']);
const TARGETS = new Set(['pallet', 'rack', 'product', 'bin', '']);

/** What the gun offers, so the words are the same on every scanner and in the list. */
export const ISSUE_MENU = [
  { kind: 'damage', target: 'pallet', label: 'Damaged pallet', reasons: ['Broken boards', 'Leaning or unstable', 'Wrap torn or open', 'Crushed cases'] },
  { kind: 'damage', target: 'rack', label: 'Damaged rack or bin', reasons: ['Beam bent', 'Upright hit', 'Beam or clip missing', 'Decking broken', 'Ice build-up'] },
  { kind: 'damage', target: 'product', label: 'Damaged product', reasons: ['Leaking', 'Thawed or soft', 'Crushed', 'Open cases'] },
  { kind: 'blocked', target: 'bin', label: 'Bin blocked — come back later', reasons: ['Trailer in the way', 'Forklift or equipment in the aisle', 'Spill on the floor', 'Locked or caged'] },
  { kind: 'other', target: '', label: 'Something else', reasons: ['Wrong product on the pallet', 'Pallet on the floor, not in a bin', 'Light out', 'Needs a supervisor to look'] },
];

export function raiseIssue(sessionId, body = {}) {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  const clientId = body.clientId ? String(body.clientId).slice(0, 64) : null;
  if (clientId) {
    const have = db.prepare('SELECT * FROM issues WHERE client_id = ?').get(clientId);
    if (have) return { issue: have, already: true };
  }
  const kind = KINDS.has(body.kind) ? body.kind : 'other';
  const target = TARGETS.has(body.target) ? body.target : '';
  const reason = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!reason) throw Object.assign(new Error('say what the problem is'), { status: 400 });
  // the aisle is the bin's, when the gun did not know it (a count with no aisle plan)
  const bin = norm(body.bin);
  let aisle = norm(body.aisle);
  if (!aisle && bin) aisle = db.prepare('SELECT aisle FROM locations WHERE session_id = ? AND code = ?').get(id, bin)?.aisle || '';
  const info = db.prepare(
    `INSERT INTO issues (session_id, kind, target, pallet_id, bin, aisle, reason, note, team, device_id, employees, created_at, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, target, norm(body.palletId) || null, bin || null, aisle || null, reason,
      body.note ? String(body.note).slice(0, 500) : null, norm(body.team) || null, norm(body.deviceId) || null,
      Array.isArray(body.employees) ? body.employees.map(norm).filter(Boolean).join(', ') : null, now(), clientId);
  return { issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(info.lastInsertRowid), already: false };
}

export function fixIssue(sessionId, issueId, { by = '', outcome = '', reopen = false } = {}) {
  const i = db.prepare('SELECT * FROM issues WHERE id = ? AND session_id = ?').get(Number(issueId), Number(sessionId));
  if (!i) throw Object.assign(new Error('no such item'), { status: 404 });
  if (reopen) db.prepare("UPDATE issues SET status = 'open', fixed_by = NULL, fixed_at = NULL, outcome = NULL WHERE id = ?").run(i.id);
  else db.prepare("UPDATE issues SET status = 'fixed', fixed_by = ?, fixed_at = ?, outcome = ? WHERE id = ?").run(by || 'a supervisor', now(), String(outcome || '').slice(0, 300) || null, i.id);
  return db.prepare('SELECT * FROM issues WHERE id = ?').get(i.id);
}

/**
 * The whole list for one count: labels to replace (from the count lines) and
 * everything reported, as one set of rows a person can sort and tick off.
 */
export function fixList(sessionId, { status = '' } = {}) {
  const id = Number(sessionId);
  const issues = db.prepare('SELECT * FROM issues WHERE session_id = ? ORDER BY status = \'fixed\', id DESC').all(id);
  const labels = labelsToReplace(id).map((l) => ({
    id: null, kind: 'label', target: l.what === 'BIN' ? 'rack' : 'pallet',
    pallet_id: l.pallet_id, bin: l.location_code, aisle: l.aisle || '', reason: l.issue, note: l.comments || '',
    team: l.team, device_id: l.device_id, status: 'open', created_at: l.scanned_at,
  }));
  const rows = [...issues, ...labels].filter((r) => !status || r.status === status);
  const open = (k) => rows.filter((r) => r.status === 'open' && r.kind === k).length;
  return {
    rows,
    summary: { open: rows.filter((r) => r.status === 'open').length, fixed: rows.filter((r) => r.status === 'fixed').length,
      damage: open('damage'), blocked: open('blocked'), labels: open('label'), other: open('other') },
    menu: ISSUE_MENU,
  };
}

/** The bins a team said it would come back to, for the gun's own aisle view. */
export const blockedBins = (sessionId) =>
  db.prepare("SELECT DISTINCT bin FROM issues WHERE session_id = ? AND kind = 'blocked' AND status = 'open' AND bin IS NOT NULL").all(Number(sessionId)).map((r) => r.bin);
