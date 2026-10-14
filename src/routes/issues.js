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
/* what the counter scanned to say which bin or pallet it is, and how: a report
   about a bin or a pallet is only worth sending somebody to if it is the right one */
const cols = new Set(db.prepare('PRAGMA table_info(issues)').all().map((c) => c.name));
if (!cols.has('confirmed')) db.exec('ALTER TABLE issues ADD COLUMN confirmed TEXT');
if (!cols.has('confirmed_as')) db.exec('ALTER TABLE issues ADD COLUMN confirmed_as TEXT');     // bin | pallet
if (!cols.has('confirmed_how')) db.exec('ALTER TABLE issues ADD COLUMN confirmed_how TEXT');   // scanned | typed

const now = () => new Date().toISOString();
const KINDS = new Set(['damage', 'blocked', 'other']);
const TARGETS = new Set(['pallet', 'rack', 'product', 'bin', '']);

/*
 * What the gun offers, so the words are the same on every scanner and in the
 * list - the shipped set, and the site's own once an admin has edited it
 * (Settings → Scanners → What the scanners offer → Report a problem).
 *
 * Each kind of problem says what the counter must scan before it is sent:
 *   bin     - the bin's label: racking, a blocked bay
 *   pallet  - the pallet's label
 *   either  - the pallet, or the bin it is in: a leaning or tipped pallet whose
 *             own label may be out of reach
 *   none    - nothing to scan: a light out, a spill in the aisle
 */
export const CONFIRMS = ['bin', 'pallet', 'either', 'none'];
export const ISSUE_MENU = [
  { kind: 'damage', target: 'pallet', label: 'Damaged pallet', confirm: 'either', reasons: ['Broken boards', 'Leaning or unstable', 'Tipped over', 'Wrap torn or open', 'Crushed cases'] },
  { kind: 'damage', target: 'rack', label: 'Damaged rack or bin', confirm: 'bin', reasons: ['Beam bent', 'Upright hit', 'Beam or clip missing', 'Decking broken', 'Ice build-up'] },
  { kind: 'damage', target: 'product', label: 'Damaged product', confirm: 'either', reasons: ['Leaking', 'Thawed or soft', 'Crushed', 'Open cases'] },
  { kind: 'blocked', target: 'bin', label: 'Bin blocked — come back later', confirm: 'bin', reasons: ['Trailer in the way', 'Forklift or equipment in the aisle', 'Spill on the floor', 'Locked or caged'] },
  { kind: 'other', target: '', label: 'Something else', confirm: 'none', reasons: ['Wrong product on the pallet', 'Pallet on the floor, not in a bin', 'Light out', 'Needs a supervisor to look'] },
];
const MENU_KEY = 'issueMenu';
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** One kind of problem, checked: a name, what it is about, what to scan, its reasons. */
function cleanItem(raw, i) {
  const label = clip(raw && raw.label, 40);
  if (!label) throw Object.assign(new Error(`problem ${i + 1} needs a name`), { status: 400 });
  const target = TARGETS.has(raw.target) ? raw.target : '';
  const kind = KINDS.has(raw.kind) ? raw.kind : target === 'bin' ? 'blocked' : target ? 'damage' : 'other';
  const confirm = CONFIRMS.includes(raw.confirm) ? raw.confirm : 'none';
  const seen = new Set();
  const reasons = (Array.isArray(raw.reasons) ? raw.reasons : []).map((r) => clip(r, 60)).filter((r) => r && !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase())).slice(0, 12);
  if (!reasons.length) throw Object.assign(new Error(`"${label}" needs at least one reason to pick`), { status: 400 });
  return { kind, target, label, confirm, reasons };
}

/** The menu the guns offer: the site's own, else the shipped one. */
export function issueMenu() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MENU_KEY);
  if (!row) return { menu: ISSUE_MENU, isDefault: true };
  try {
    const menu = JSON.parse(row.value).map(cleanItem);
    return menu.length ? { menu, isDefault: false } : { menu: ISSUE_MENU, isDefault: true };
  } catch { return { menu: ISSUE_MENU, isDefault: true }; }
}

/** An admin's edit. An empty list puts the shipped menu back. */
export function saveIssueMenu(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('send the list of problems'), { status: 400 });
  if (!list.length) { db.prepare('DELETE FROM settings WHERE key = ?').run(MENU_KEY); return issueMenu(); }
  if (list.length > 10) throw Object.assign(new Error('ten kinds of problem at most - the gun has to fit them on one screen'), { status: 400 });
  const menu = list.map(cleanItem);
  const names = new Set();
  for (const m of menu) {
    if (names.has(m.label.toLowerCase())) throw Object.assign(new Error(`"${m.label}" is on the list twice`), { status: 400 });
    names.add(m.label.toLowerCase());
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MENU_KEY, JSON.stringify(menu));
  return issueMenu();
}

/* What a report must carry, by the kind picked on the gun. A gun from before
   the scan was asked for sends no "confirm" at all, and its queued reports
   still go through - nobody loses a report to an update. */
function confirmFor(body) {
  if (!('confirm' in body)) return null;
  const item = issueMenu().menu.find((m) => m.label === clip(body.label, 40)) || null;
  return item ? item.confirm : (CONFIRMS.includes(body.confirm) ? body.confirm : 'none');
}

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
  /* the scan that says which bin or pallet it is: a bin scanned is the bin of
     the report, a pallet scanned is its pallet */
  const need = confirmFor(body);
  const scanned = norm(body.confirmed);
  let as = ['bin', 'pallet'].includes(body.confirmedAs) ? body.confirmedAs : '';
  if (scanned && !as) as = db.prepare('SELECT 1 FROM locations WHERE session_id = ? AND code = ?').get(id, scanned) ? 'bin' : 'pallet';
  if (need && need !== 'none') {
    if (!scanned) throw Object.assign(new Error(need === 'bin' ? 'scan the bin to confirm which one' : need === 'pallet' ? 'scan the pallet to confirm which one' : 'scan the pallet or the bin to confirm which one'), { status: 400 });
    if (need !== 'either' && as !== need) throw Object.assign(new Error(`that is ${as === 'bin' ? 'a bin' : 'a pallet'} - scan the ${need}`), { status: 400 });
  }
  const how = scanned ? (body.confirmedHow === 'typed' ? 'typed' : 'scanned') : null;
  // the aisle is the bin's, when the gun did not know it (a count with no aisle plan)
  const bin = as === 'bin' && scanned ? scanned : norm(body.bin);
  const palletId = as === 'pallet' && scanned ? scanned : norm(body.palletId);
  let aisle = norm(body.aisle);
  if (!aisle && bin) aisle = db.prepare('SELECT aisle FROM locations WHERE session_id = ? AND code = ?').get(id, bin)?.aisle || '';
  const info = db.prepare(
    `INSERT INTO issues (session_id, kind, target, pallet_id, bin, aisle, reason, note, team, device_id, employees, created_at, client_id, confirmed, confirmed_as, confirmed_how)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, target, palletId || null, bin || null, aisle || null, reason,
      body.note ? String(body.note).slice(0, 500) : null, norm(body.team) || null, norm(body.deviceId) || null,
      Array.isArray(body.employees) ? body.employees.map(norm).filter(Boolean).join(', ') : null, now(), clientId,
      scanned || null, scanned ? as : null, how);
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
    menu: issueMenu().menu,
  };
}

/** The bins a team said it would come back to, for the gun's own aisle view. */
export const blockedBins = (sessionId) =>
  db.prepare("SELECT DISTINCT bin FROM issues WHERE session_id = ? AND kind = 'blocked' AND status = 'open' AND bin IS NOT NULL").all(Number(sessionId)).map((r) => r.bin);
