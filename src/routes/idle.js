import { db, norm, getSession } from '../db.js';
import { postToTeams, teamsConfig, noticeCard } from '../util/teams.js';

/*
 * The clock on every team, and a nudge when one goes quiet.
 *
 * A supervisor walking the floor cannot see thirty scanners, but the server can:
 * it knows when each team signed on, when it last scanned, and whether it still
 * has an aisle to count. So the dashboard shows each team's time on the count,
 * and when a team that should be counting has not scanned for a while - a truck
 * that broke down, a crew that wandered off, a scanner that died - it says so,
 * on the dashboard and, if the site wants, in the Teams channel.
 *
 * A team is "working" while it is signed on (not signed off, and signed on in
 * the last twelve hours) and still has work: an active or queued aisle on a
 * guided count. Anyone else's clock has stopped, and nobody is nagged about a
 * crew that went home.
 */

const KEY = 'idleAlert';
const now = () => new Date().toISOString();
const SHIFT_HOURS = 12;              // a sign-on older than this is yesterday's
const GONE_MINUTES = 120;            // quiet this long: finished, not stuck

export function idleConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const minutes = Number.isFinite(Number(v.minutes)) ? Math.max(0, Math.min(240, Math.round(Number(v.minutes)))) : 10;
  return { minutes, teams: v.teams !== false };
}

export function saveIdleConfig(body = {}) {
  const cur = idleConfig();
  const next = {
    minutes: body.minutes === undefined ? cur.minutes : Math.max(0, Math.min(240, Math.round(Number(body.minutes) || 0))),
    teams: body.teams === undefined ? cur.teams : !!body.teams,
  };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(next));
  return idleConfig();
}

/** Which shift each named team works, from Teams & crew. */
export function shiftOf() {
  return new Map(db.prepare('SELECT name, shift FROM teams').all().map((t) => [norm(t.name), t.shift || '']));
}

/**
 * One row per team on this count: when it started, when it last did anything,
 * whether it is still meant to be counting, and how long it has been quiet.
 */
export function teamClocks(sessionId, at = Date.now()) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) return [];
  const cutoff = new Date(at - SHIFT_HOURS * 3600000).toISOString();
  const scans = new Map(db.prepare(
    `SELECT team, MIN(scanned_at) AS first, MAX(scanned_at) AS last, COUNT(*) AS lines,
            (SELECT location_code FROM counts x WHERE x.session_id = c.session_id AND x.team = c.team AND x.voided = 0
              ORDER BY x.scanned_at DESC LIMIT 1) AS last_bin
       FROM counts c WHERE session_id = ? AND voided = 0 GROUP BY team`).all(id).map((r) => [r.team, r]));
  const signons = new Map(db.prepare(
    `SELECT team, MIN(started_at) AS first, MAX(started_at) AS last,
            SUM(CASE WHEN ended_at IS NULL AND started_at > ? THEN 1 ELSE 0 END) AS open,
            MAX(ended_at) AS ended
       FROM signons WHERE session_id = ? GROUP BY team`).all(cutoff, id).map((r) => [r.team, r]));
  const work = new Map(db.prepare(
    `SELECT team, SUM(status = 'active') AS active, SUM(status = 'queued') AS queued, COUNT(*) AS n,
            MAX(CASE WHEN status = 'active' THEN aisle END) AS aisle
       FROM assignments WHERE session_id = ? GROUP BY team`).all(id).map((r) => [r.team, r]));
  const shifts = shiftOf();
  const guided = !!s.guided && (s.mode || 'full') === 'full';
  const teams = new Set([...scans.keys(), ...signons.keys()]);
  const out = [];
  for (const team of teams) {
    const sc = scans.get(team) || {};
    const so = signons.get(team) || {};
    const w = work.get(team);
    const firsts = [sc.first, so.first].filter(Boolean).sort();
    const lasts = [sc.last, so.last].filter(Boolean).sort();
    const started = firsts[0] || null;
    let lastActive = lasts[lasts.length - 1] || null;
    if (lastActive && Date.parse(lastActive) > at) lastActive = new Date(at).toISOString();   // a gun's clock running fast
    const quiet = lastActive ? Math.max(0, Math.floor((at - Date.parse(lastActive)) / 60000)) : null;
    const finished = guided && !!w && !w.active && !w.queued;
    const onShift = (so.open || 0) > 0;
    const gone = quiet != null && quiet >= GONE_MINUTES;
    const working = s.status === 'open' && onShift && !finished && !gone;
    out.push({
      team,
      shift: shifts.get(norm(team)) || '',
      started,
      lastScan: sc.last || null,
      lastBin: sc.last_bin || null,
      lastActive,
      lines: sc.lines || 0,
      aisle: (w && w.aisle) || null,
      working,
      state: working ? 'counting' : finished ? 'finished' : !onShift ? 'signed off' : gone ? 'gone quiet' : 'stopped',
      quietMinutes: working ? quiet : null,
      // a clock that has stopped stops at the last thing the team did
      endedAt: working ? null : lastActive,
    });
  }
  return out.sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true }));
}

const latestAlert = (sessionId, team) =>
  db.prepare('SELECT * FROM idle_alerts WHERE session_id = ? AND team = ? ORDER BY id DESC LIMIT 1').get(Number(sessionId), team);

/**
 * Raise or clear stopped-scanning alerts for one count. Called on a timer and
 * whenever the dashboard asks, so a supervisor never waits on the timer.
 * Returns the alerts it raised, so the caller can tell Teams.
 */
export function checkIdle(sessionId, at = Date.now()) {
  const id = Number(sessionId);
  const cfg = idleConfig();
  const raised = [];
  const stamp = new Date(at).toISOString();
  for (const c of teamClocks(id, at)) {
    const last = latestAlert(id, c.team);
    const open = last && !last.cleared_at ? last : null;
    const movedSince = last && c.lastActive && last.last_scan && c.lastActive > last.last_scan;
    if (open) {
      if (movedSince) clear(open.id, 'scanning again', '');
      else if (!c.working) clear(open.id, c.state, '');
      continue;
    }
    if (!cfg.minutes || !c.working || c.quietMinutes < cfg.minutes) continue;
    // "on break" and "seen" hold until the snooze runs out or the team scans again
    if (last && last.snooze_until && last.snooze_until > stamp && !movedSince) continue;
    // one alert per quiet spell: the same silence is not news twice
    if (last && last.last_scan === c.lastActive) continue;
    const info = db.prepare('INSERT INTO idle_alerts (session_id, team, last_scan, raised_at) VALUES (?, ?, ?, ?)')
      .run(id, c.team, c.lastActive, stamp);
    raised.push({ id: Number(info.lastInsertRowid), clock: c });
  }
  return raised;
}

function clear(alertId, why, by) {
  db.prepare('UPDATE idle_alerts SET cleared_at = ?, why = ?, cleared_by = ? WHERE id = ? AND cleared_at IS NULL')
    .run(now(), why, by || null, Number(alertId));
}

/** A supervisor answers one: the crew is on break, or somebody has it in hand. */
export function answerIdle(sessionId, alertId, { action, by }) {
  const a = db.prepare('SELECT * FROM idle_alerts WHERE id = ? AND session_id = ?').get(Number(alertId), Number(sessionId));
  if (!a) throw Object.assign(new Error('no such alert'), { status: 404 });
  const mins = action === 'break' ? 30 : action === 'lunch' ? 45 : 0;
  // "seen" lasts until the team scans again; a break lasts as long as a break
  const until = mins ? new Date(Date.now() + mins * 60000).toISOString() : '9999-12-31T00:00:00.000Z';
  db.prepare('UPDATE idle_alerts SET cleared_at = ?, cleared_by = ?, why = ?, snooze_until = ? WHERE id = ?')
    .run(now(), by || 'a supervisor', mins ? `on ${action}` : 'seen', until, a.id);
  return db.prepare('SELECT * FROM idle_alerts WHERE id = ?').get(a.id);
}

export function openIdleAlerts(sessionId) {
  return db.prepare('SELECT * FROM idle_alerts WHERE session_id = ? AND cleared_at IS NULL ORDER BY id').all(Number(sessionId));
}

export function recentIdleAlerts(sessionId, limit = 50) {
  return db.prepare('SELECT * FROM idle_alerts WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(Number(sessionId), limit);
}

/** Tell the channel about the ones just raised. Never throws. */
export async function tellTeamsIdle(sessionId, raised, { dashboard = '' } = {}) {
  const cfg = idleConfig();
  const tc = teamsConfig();
  const s = getSession(sessionId);
  for (const r of raised) {
    let sent = 'teams off';
    if (cfg.teams && tc.on) {
      const c = r.clock;
      const card = noticeCard({
        title: `Team ${c.team} has stopped scanning`,
        subtitle: `Nothing scanned for ${c.quietMinutes} minutes`,
        tone: 'Warning',
        facts: [
          ['Team', c.team + (c.shift ? ` (${c.shift === '1' ? '1st' : '2nd'} shift)` : '')],
          ['Last bin', c.lastBin || '—'],
          ['Last scan', c.lastScan ? new Date(c.lastScan).toLocaleTimeString('en-US') : 'nothing scanned yet'],
          ['Count', s ? s.name : ''],
        ],
        dashboard,
      });
      const out = await postToTeams(card);
      sent = out.sent ? 'teams' : `teams failed: ${out.why}`;
    }
    db.prepare('UPDATE idle_alerts SET sent_to = ? WHERE id = ?').run(sent, r.id);
  }
}

/** The timer: every open count, practice counts aside. */
export async function idleTick({ dashboard = '' } = {}) {
  const open = db.prepare("SELECT id FROM sessions WHERE status = 'open' AND practice = 0").all();
  for (const s of open) {
    const raised = checkIdle(s.id);
    if (raised.length) await tellTeamsIdle(s.id, raised, { dashboard });
  }
}

/** A gun signing off: that crew's clock stops and nobody is told it went quiet. */
export function recordSignoff(sessionId, { deviceId, team }) {
  const t = norm(team);
  const row = db.prepare(
    `SELECT id FROM signons WHERE session_id = ? AND team = ? AND device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(Number(sessionId), t, norm(deviceId));
  if (row) db.prepare('UPDATE signons SET ended_at = ? WHERE id = ?').run(now(), row.id);
  return { ended: !!row };
}
