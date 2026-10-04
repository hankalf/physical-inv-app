/* The count, filed as it goes.
 *
 * Every aisle a team hands back is written out at once - its count lines, the
 * pallet report for it, its bins - as CSV files under the exports folder beside
 * the backups, so a count that stops halfway has every finished aisle on disk in
 * a form anyone can read. When the whole count is in - every bin counted,
 * nothing waiting on a second count - the final report files every sheet of
 * Export everything the same way. Nothing here is a database backup; that is
 * admin-ops. These are the numbers, in words. */
import { mkdirSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { db, getSession } from '../db.js';
import { exportEverything } from './export-all.js';
import { progress } from './reports.js';
import { localDate } from '../util/localtime.js';

const EXPORT_DIR = resolve(process.env.EXPORT_DIR || join(dirname(resolve(process.env.DB_PATH || './data/inventory.db')), 'exports'));

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns, rows) => [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40);
const sessionDir = (id) => join(EXPORT_DIR, `session-${Number(id)}`);

/** The aisle a bin code is in on this count, from the bin list. */
function aisleOf(sessionId) {
  const rows = db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(Number(sessionId));
  const map = new Map(rows.map((r) => [r.code, r.aisle || '']));
  return (code) => (code ? map.get(String(code).toUpperCase()) || '' : '');
}

/** Write the sheets of an export as one CSV each, into a new folder. Returns the folder's name. */
function writeSheets(sessionId, name, sheets, note) {
  const dir = join(sessionDir(sessionId), name);
  mkdirSync(dir, { recursive: true });
  for (const sh of sheets) writeFileSync(join(dir, `${safe(sh.name.toLowerCase().replace(/\s+/g, '-'))}.csv`), toCsv(sh.columns, sh.rows));
  writeFileSync(join(dir, 'README.txt'), note);
  return name;
}

/**
 * One aisle, as it was handed back: its count lines, the pallets expected or
 * found in it, its bins. Called from the hand-back; never throws, because a
 * folder that could not be written must not stop the gun's next aisle.
 */
export function archiveAisle(sessionId, aisle, { team = '', by = '' } = {}) {
  try {
    const id = Number(sessionId);
    const s = getSession(id);
    if (!s || !aisle) return null;
    const a = String(aisle).toUpperCase();
    const inAisle = aisleOf(id);
    const all = exportEverything(id, { by: by || 'the hand-back' });
    const pick = (sheetName, keep) => {
      const sh = all.sheets.find((x) => x.name === sheetName);
      return sh ? { ...sh, rows: sh.rows.filter(keep) } : null;
    };
    const sheets = [
      pick('Count lines', (r) => String(r.Aisle || '').toUpperCase() === a),
      pick('Pallets', (r) => inAisle(r['Report bin']) === a || inAisle(r['Found in']) === a),
      pick('Bins', (r) => String(r.Aisle || '').toUpperCase() === a),
      pick('Bins not counted', (r) => String(r.Aisle || '').toUpperCase() === a),
      pick('Second counts', (r) => inAisle(r.Bin) === a),
      pick('Fix list', (r) => String(r.Aisle || '').toUpperCase() === a || inAisle(r.Bin) === a),
    ].filter(Boolean);
    const lines = sheets[0] ? sheets[0].rows.length : 0;
    const name = `aisle-${safe(a)}-${stamp()}`;
    const note = `${s.name} — aisle ${a}, handed back${team ? ` by team ${team}` : ''} on ${localDate()} at ${new Date().toISOString()}.\n`
      + `Filed by the app the moment the aisle was handed back: ${lines} count lines, the pallet report for the aisle, its bins, second counts and fix-list items.\n`
      + `Every file is CSV; the final report at the end of the count has the whole count.\n`;
    writeSheets(id, name, sheets, note);
    return { name, lines, aisle: a };
  } catch (err) {
    console.warn('[archive] could not file aisle', aisle, err.message);
    return null;
  }
}

/** Whether the count is finished enough for a final report, and if not, why not. */
export function finalReadiness(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const p = progress(id);
  const left = Math.max(0, (p.bins_total || 0) - (p.bins_counted || 0));
  const reasons = [];
  if (!p.bins_total) reasons.push('no bin list on this count');
  if (left) reasons.push(`${left.toLocaleString()} bin${left === 1 ? '' : 's'} still to count`);
  if (p.recounts_open) reasons.push(`${p.recounts_open.toLocaleString()} second count${p.recounts_open === 1 ? '' : 's'} still open`);
  return { ready: reasons.length === 0, reasons, binsLeft: left, recountsOpen: p.recounts_open || 0, binsTotal: p.bins_total || 0, binsCounted: p.bins_counted || 0 };
}

/** The whole count, every sheet, once it is complete. Refuses until it is. */
export function finalReport(sessionId, { by = '' } = {}) {
  const id = Number(sessionId);
  const ready = finalReadiness(id);
  if (!ready.ready) throw Object.assign(new Error(`not yet: ${ready.reasons.join(', ')}`), { status: 409 });
  const s = getSession(id);
  const all = exportEverything(id, { by });
  const name = `final-${stamp()}`;
  const note = `${s.name} — the final report, filed on ${localDate()} at ${new Date().toISOString()}${by ? ` by ${by}` : ''}.\n`
    + `Every bin counted (${ready.binsCounted.toLocaleString()} of ${ready.binsTotal.toLocaleString()}), no second counts open. One CSV per sheet of Export everything.\n`;
  writeSheets(id, name, all.sheets, note);
  return { name, sheets: all.sheets.length };
}

/** What has been filed for a count: folders, newest first, with their files. */
export function listArchives(sessionId) {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .map((n) => {
      const files = readdirSync(join(dir, n)).sort().map((f) => ({ name: f, bytes: statSync(join(dir, n, f)).size }));
      const st = statSync(join(dir, n));
      return { name: n, kind: n.startsWith('final-') ? 'final' : 'aisle', aisle: n.startsWith('aisle-') ? n.split('-')[1] : '', at: st.mtime.toISOString(), files };
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** A file inside a count's archive, or null for a path that tries to leave it. */
export function archivePath(sessionId, folder, file) {
  const base = sessionDir(sessionId);
  const full = resolve(join(base, String(folder), String(file)));
  if (!full.startsWith(base + '/') || !existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}
