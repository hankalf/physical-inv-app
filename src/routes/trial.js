import { db, getSession } from '../db.js';
import { autoActivate } from './assignments.js';

/*
 * A trial run.
 *
 * The way to find out that a crew does not know the "empty bin" button, that
 * aisle F07 has no rack labels, or that two teams were sent to the same block,
 * is to run the count for real - real guns, real teams, the real bin list - a
 * day or a shift before it matters. A trial run is exactly that, on the count
 * that will be used for real, and then it is cleared:
 *
 *   - every line, sign-on, SOS, stopped-scanning alert, second count and
 *     adjustment goes;
 *   - the bin list, the report, the team plan and every setting stay, and the
 *     aisles go back to the start of each team's queue;
 *   - the guns are told, and forget what they counted (they would otherwise
 *     warn "already counted" on every pallet of the trial), and a line a gun
 *     scanned during the trial but sends later is dropped.
 *
 * While it is a trial the ERP file is refused, and nothing it counts moves the
 * cycle-count clock, so a rehearsal can never reach the system of record.
 */

export function endTrial(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  if (!s.trial) throw Object.assign(new Error('this count is not a trial run'), { status: 409 });
  const n = (sql) => db.prepare(sql).get(id).n;
  const cleared = {
    lines: n('SELECT COUNT(*) n FROM counts WHERE session_id = ?'),
    signons: n('SELECT COUNT(*) n FROM signons WHERE session_id = ?'),
    sos: n('SELECT COUNT(*) n FROM alerts WHERE session_id = ?'),
    secondCounts: n('SELECT COUNT(*) n FROM recounts WHERE session_id = ?'),
  };
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const table of ['counts', 'signons', 'alerts', 'idle_alerts', 'recounts', 'adjustments', 'messages']) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }
    // a cycle count's batches were the trial's work list; the aisles of a full count go back to the start
    db.prepare('DELETE FROM cycle_batches WHERE session_id = ?').run(id);
    db.prepare("UPDATE assignments SET status = 'queued', started_at = NULL, completed_at = NULL WHERE session_id = ?").run(id);
    db.prepare('UPDATE sessions SET trial = 0, cleared_at = ? WHERE id = ?').run(at, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  autoActivate(id);
  // no new master version: the guns pick up clearedAt with the settings they re-read between pallets
  return { cleared, clearedAt: at, session: getSession(id) };
}

export function setTrial(sessionId, on) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  if (on && s.status !== 'open') throw Object.assign(new Error('only an open count can be a trial run'), { status: 409 });
  db.prepare('UPDATE sessions SET trial = ? WHERE id = ?').run(on ? 1 : 0, id);
  return getSession(id);
}
