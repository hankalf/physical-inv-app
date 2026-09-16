import { db, norm } from '../db.js';

/*
 * A word from the office to the floor.
 *
 * A supervisor watching the dashboard can see a team stalled in an aisle, or
 * needs everybody out of the freezer for twenty minutes, and the only way to
 * say so is to walk out there or shout on a radio nobody can hear through ear
 * defenders. A message is addressed to one team or to all of them, lands on the
 * handheld within a sync, and is acknowledged from the gun - so the dashboard
 * shows who has read it rather than who was hoped to have read it.
 */

const now = () => new Date().toISOString();
const MAX_BODY = 400;

export function sendMessage(sessionId, { team, body, sentBy, urgent }) {
  const text = String(body == null ? '' : body).replace(/\s+/g, ' ').trim().slice(0, MAX_BODY);
  if (!text) throw Object.assign(new Error('a message needs something in it'), { status: 400 });
  const info = db
    .prepare('INSERT INTO messages (session_id, team, body, sent_by, urgent, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Number(sessionId), norm(team) || null, text, String(sentBy || 'supervisor'), urgent ? 1 : 0, now());
  return messageById(info.lastInsertRowid);
}

const messageById = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));

/** What a supervisor sees: every message on this count, and who has read it. */
export function listMessages(sessionId, { limit = 50 } = {}) {
  const id = Number(sessionId);
  const rows = db
    .prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM message_acks a WHERE a.message_id = m.id) AS acks,
              (SELECT GROUP_CONCAT(a.device_id, ', ') FROM message_acks a WHERE a.message_id = m.id) AS ack_devices
         FROM messages m WHERE m.session_id = ? ORDER BY m.id DESC LIMIT ?`
    )
    .all(id, Math.max(1, Math.min(500, Number(limit) || 50)));

  /* Who it was meant to reach: the scanners signed on to this count, by team,
     so "3 of 4 read it" means something. */
  const signedOn = db
    .prepare(
      `SELECT team, COUNT(DISTINCT device_id) AS devices FROM signons
        WHERE session_id = ? GROUP BY team`
    )
    .all(id);
  const perTeam = Object.fromEntries(signedOn.map((r) => [r.team, r.devices]));
  const everyone = signedOn.reduce((n, r) => n + r.devices, 0);

  return rows.map((m) => ({
    ...m,
    urgent: !!m.urgent,
    audience: m.team ? `team ${m.team}` : 'every team',
    sent_to: m.team ? (perTeam[m.team] || 0) : everyone,
  }));
}

/** What a handheld should be showing: live messages for its team, unacknowledged. */
export function messagesFor(sessionId, team, deviceId) {
  return db
    .prepare(
      `SELECT m.id, m.body, m.urgent, m.sent_by, m.created_at, m.team
         FROM messages m
        WHERE m.session_id = ? AND m.cleared_at IS NULL
          AND (m.team IS NULL OR m.team = ?)
          AND NOT EXISTS (SELECT 1 FROM message_acks a WHERE a.message_id = m.id AND a.device_id = ?)
        ORDER BY m.urgent DESC, m.id`
    )
    .all(Number(sessionId), norm(team), norm(deviceId))
    .map((m) => ({ ...m, urgent: !!m.urgent }));
}

export function ackMessage(sessionId, messageId, { deviceId, team }) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ? AND session_id = ?').get(Number(messageId), Number(sessionId));
  if (!m) throw Object.assign(new Error('message not found'), { status: 404 });
  db.prepare(
    `INSERT INTO message_acks (message_id, device_id, team, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, device_id) DO NOTHING`
  ).run(m.id, norm(deviceId) || 'UNKNOWN', norm(team) || null, now());
  return { id: m.id, acknowledged: true };
}

/** Take a message off the guns without deleting what was said. */
export function clearMessage(sessionId, messageId) {
  const changed = db
    .prepare('UPDATE messages SET cleared_at = ? WHERE id = ? AND session_id = ? AND cleared_at IS NULL')
    .run(now(), Number(messageId), Number(sessionId)).changes;
  return { cleared: changed > 0 };
}
