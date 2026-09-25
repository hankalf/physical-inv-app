import { db, norm, getSession } from '../db.js';
import { alertCard, postToTeams, teamsConfig } from '../util/teams.js';

/*
 * The SOS button.
 *
 * A counter in the middle of a freezer aisle has no radio that works through ear
 * defenders and no line of sight to the office. Until now, "the racking is
 * leaning" or "Marcus has hurt his hand" meant walking out and finding somebody,
 * which is five minutes on a good day.
 *
 * So: one button, a list of what is wrong that the site writes in its own words,
 * and it is on the dashboard before the scanner is back in the holster - with
 * the team, the aisle and the last bin they counted, because where somebody is
 * matters as much as what is wrong. From there it goes on to the office's Teams
 * channel, because nobody watches a dashboard.
 *
 * An alert is never lost to a flaky connection: it carries an id the gun made
 * up, so a handheld that re-sends after a dropped signal raises one alert, not
 * three.
 */

const now = () => new Date().toISOString();

/* What tends to go wrong in a cold store, in the words somebody on the floor
   would use. A site edits these; they are only a starting point. */
export const DEFAULT_REASONS = [
  'Injury — someone needs help now',
  'Someone is stuck or shut in',
  'Racking or a pallet looks unsafe',
  'Forklift or lift truck problem',
  'Spill, leak or damaged stock',
  'Cannot reach the bins — blocked',
  'Scanner or app problem',
  'Need a supervisor',
];

export function sosReasons() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sosReasons'").get();
  if (!row) return { reasons: DEFAULT_REASONS, isDefault: true };
  try {
    const saved = JSON.parse(row.value);
    const reasons = (Array.isArray(saved) ? saved : []).map((r) => String(r || '').trim()).filter(Boolean).slice(0, 20);
    return reasons.length ? { reasons, isDefault: false } : { reasons: DEFAULT_REASONS, isDefault: true };
  } catch { return { reasons: DEFAULT_REASONS, isDefault: true }; }
}

export function saveSosReasons(list) {
  const reasons = (Array.isArray(list) ? list : []).map((r) => String(r || '').trim()).filter(Boolean).slice(0, 20);
  if (!reasons.length) {
    db.prepare("DELETE FROM settings WHERE key = 'sosReasons'").run();
    return sosReasons();
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('sosReasons', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(reasons));
  return sosReasons();
}

const byId = (id) => db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(id));
const shape = (a) => (a ? { ...a, employees: String(a.employees || '').split(';').map((x) => x.trim()).filter(Boolean) } : a);

/**
 * Raise one, from a handheld.
 *
 * The aisle and bin are not asked for - the gun knows where it is, and somebody
 * with a problem should not be filling in a form.
 */
export function raiseAlert(sessionId, { clientId, team, deviceId, employees, reason, detail, aisle, bin } = {}) {
  const id = Number(sessionId);
  if (!getSession(id)) throw Object.assign(new Error('session not found'), { status: 404 });
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!why) throw Object.assign(new Error('say what is wrong'), { status: 400 });
  const key = String(clientId || '').trim() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  /* The gun re-sends anything it has not had an answer for, so the same alert
     can arrive twice. One row, and the first one wins. */
  const existing = db.prepare('SELECT * FROM alerts WHERE client_id = ?').get(key);
  if (existing) return { alert: shape(existing), already: true };

  const info = db.prepare(
    `INSERT INTO alerts (session_id, team, device_id, employees, reason, detail, aisle, bin, status, created_at, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(id, norm(team) || null, norm(deviceId) || null,
    (Array.isArray(employees) ? employees : []).join('; ') || null,
    why, String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    norm(aisle) || null, norm(bin) || null, now(), key);
  return { alert: shape(byId(info.lastInsertRowid)), already: false };
}

/** Send it on to the channel, and remember what happened either way. */
export async function tellTeams(alertId, { dashboard = '' } = {}) {
  const alert = byId(alertId);
  if (!alert) return { sent: false, why: 'gone' };
  const cfg = teamsConfig();
  if (!cfg.on) {
    db.prepare('UPDATE alerts SET sent_to = ? WHERE id = ?').run('teams off', alert.id);
    return { sent: false, why: 'teams off' };
  }
  const out = await postToTeams(alertCard(alert, { dashboard }));
  db.prepare('UPDATE alerts SET sent_to = ? WHERE id = ?')
    .run(out.sent ? 'teams' : `teams failed: ${out.why}`.slice(0, 200), alert.id);
  return out;
}

export function listAlerts(sessionId, { status = '', limit = 50 } = {}) {
  const id = Number(sessionId);
  const where = status === 'open' ? " AND status != 'closed'" : status ? ' AND status = ?' : '';
  const args = status === 'open' ? [id] : status ? [id, status] : [id];
  const rows = db.prepare(
    `SELECT * FROM alerts WHERE session_id = ?${where} ORDER BY status = 'closed', id DESC LIMIT ?`
  ).all(...args, Math.max(1, Math.min(200, Number(limit) || 50)));
  const open = db.prepare("SELECT COUNT(*) n FROM alerts WHERE session_id = ? AND status != 'closed'").get(id).n;
  return { open, alerts: rows.map(shape), reasons: sosReasons().reasons, teams: teamsConfig().on };
}

/** A supervisor has seen it - which the gun is told, so somebody knows help is coming. */
export function seeAlert(sessionId, alertId, who) {
  const changed = db.prepare(
    `UPDATE alerts SET status = 'seen', seen_by = ?, seen_at = ?
      WHERE id = ? AND session_id = ? AND status = 'open'`
  ).run(String(who || 'a supervisor'), now(), Number(alertId), Number(sessionId)).changes;
  return { seen: changed > 0, alert: shape(byId(alertId)) };
}

export function closeAlert(sessionId, alertId, { who, outcome } = {}) {
  const changed = db.prepare(
    `UPDATE alerts SET status = 'closed', closed_by = ?, closed_at = ?, outcome = ?,
            seen_by = COALESCE(seen_by, ?), seen_at = COALESCE(seen_at, ?)
      WHERE id = ? AND session_id = ? AND status != 'closed'`
  ).run(String(who || 'a supervisor'), now(), String(outcome || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    String(who || 'a supervisor'), now(), Number(alertId), Number(sessionId)).changes;
  return { closed: changed > 0, alert: shape(byId(alertId)) };
}

/**
 * What the gun that raised it should be showing.
 *
 * Only this scanner's own alerts, and only while they are live: a counter needs
 * to know somebody has seen it, and nothing else.
 */
export function alertsForDevice(sessionId, deviceId) {
  return db.prepare(
    `SELECT id, reason, status, created_at, seen_by, seen_at, closed_by, closed_at, outcome
       FROM alerts
      WHERE session_id = ? AND device_id = ? AND (status != 'closed' OR closed_at > ?)
      ORDER BY id DESC LIMIT 5`
  ).all(Number(sessionId), norm(deviceId), new Date(Date.now() - 5 * 60000).toISOString());
}
