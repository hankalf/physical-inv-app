import { db, norm } from '../db.js';
import { localDate } from '../util/localtime.js';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/*
 * Housekeeping a supervisor depends on but never thinks about: a record of who
 * changed what, and a copy of the database that is not the database.
 */

const BACKUP_DIR = resolve(process.env.BACKUP_DIR || join(dirname(resolve(process.env.DB_PATH || './data/inventory.db')), 'backups'));
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));

/* ------------------------------------------------------------------ audit */

/**
 * Record a change. Never throws: an audit failure must not take down the action
 * it was recording, and a half-written log is better than a lost count.
 */
export function audit(actor, action, detail = '', sessionId = null) {
  try {
    db.prepare('INSERT INTO audit (at, actor, action, detail, session_id) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), String(actor || 'supervisor'), String(action), typeof detail === 'string' ? detail : JSON.stringify(detail), sessionId ? Number(sessionId) : null);
  } catch (err) {
    console.warn('[audit] could not record', action, err.message);
  }
}

export function listAudit({ limit = 200, sessionId = null, actor = '', action = '' } = {}) {
  const where = [];
  const args = [];
  if (sessionId) { where.push('session_id = ?'); args.push(Number(sessionId)); }
  if (actor) { where.push('UPPER(actor) LIKE ?'); args.push('%' + norm(actor) + '%'); }
  if (action) { where.push('action LIKE ?'); args.push('%' + String(action) + '%'); }
  const sql = `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(2000, Number(limit) || 200));
}

/* ---------------------------------------------------------------- backups */

export const backupPath = (name) => {
  if (!/^[A-Za-z0-9_.-]+\.db$/.test(String(name || ''))) return null;
  const full = join(BACKUP_DIR, name);
  return full.startsWith(BACKUP_DIR) ? full : null;
};

/**
 * VACUUM INTO writes a consistent copy while the app keeps running - copying
 * the file by hand mid-write would not be safe.
 */
export function makeBackup(reason = 'manual') {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `inventory-${localDate()}-${stamp.slice(11)}-${reason}.db`;
  const target = join(BACKUP_DIR, name);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  prune();
  const s = statSync(target);
  return { name, bytes: s.size, at: s.mtime.toISOString(), reason };
}

function prune() {
  const files = listBackups();
  for (const f of files.slice(KEEP)) {
    try { unlinkSync(join(BACKUP_DIR, f.name)); } catch { /* it may already be gone */ }
  }
}

export function listBackups() {
  try {
    return readdirSync(BACKUP_DIR)
      .filter((n) => n.endsWith('.db'))
      .map((name) => {
        const s = statSync(join(BACKUP_DIR, name));
        return { name, bytes: s.size, at: s.mtime.toISOString() };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch { return []; }
}

/** One backup a day, taken the first time the app is up after the date rolls. */
export function startBackupSchedule() {
  let lastDate = listBackups().find((b) => b.name.includes('-daily'))?.name.slice(10, 20) || '';
  const tick = () => {
    const today = localDate();
    if (today === lastDate) return;
    try {
      const b = makeBackup('daily');
      lastDate = today;
      console.log(`[backup] ${b.name} (${Math.round(b.bytes / 1024)} KB), keeping ${KEEP}`);
    } catch (err) {
      console.warn('[backup] failed:', err.message);
    }
  };
  tick();
  return setInterval(tick, 30 * 60 * 1000);
}

export const backupDir = () => BACKUP_DIR;
