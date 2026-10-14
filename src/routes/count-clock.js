/*
 * The clock on the count.
 *
 * A count is judged by how long it took, and a supervisor watching one wants
 * to know whether it will be done by the end of the shift. So the server keeps
 * one clock for the whole count, from the first sign-on, and says how much of
 * that time was downtime - nobody on the count scanning, signing on or signing
 * off for longer than the site's stopped-scanning limit: lunch, a fire drill,
 * the night between two days of counting - and how long was spent actually
 * counting. The pace comes from the counting time, not the wall clock, so a
 * long lunch does not make the crews look slow; and the pace over the last
 * half hour, when there is one, says when the count will be done.
 *
 * A closed count ends at the last thing anybody did on it, not at the click
 * that closed it on Monday morning. Each team gets the same reckoning: its own
 * downtime, its own counting time, its own pace.
 */
import { db, getSession } from '../db.js';
import { idleConfig, teamClocks } from './idle.js';

const HOUR = 3600000;
const RECENT_MINUTES = 30;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** Everything anybody did on the count, in time order: a scan, a sign-on, a sign-off. */
function activity(id, at) {
  const rows = db.prepare(
    `SELECT scanned_at AS at, team FROM counts WHERE session_id = ?
     UNION ALL SELECT started_at, team FROM signons WHERE session_id = ?
     UNION ALL SELECT ended_at, team FROM signons WHERE session_id = ? AND ended_at IS NOT NULL`).all(id, id, id);
  const out = [];
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (Number.isFinite(t)) out.push({ t: Math.min(t, at), team: r.team });   // a gun's clock running fast is not the future
  }
  return out.sort((a, b) => a.t - b.t);
}

/* The quiet spells in a run of moments: every gap longer than the limit, and
   the one still running if nothing has happened for that long. */
function spellsOf(times, { gapMs, end, open }) {
  const spells = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > gapMs) spells.push({ from: times[i - 1], to: times[i], ms: gap, open: false });
  }
  const last = times[times.length - 1];
  if (open && times.length && end - last > gapMs) spells.push({ from: last, to: null, ms: end - last, open: true });
  return spells;
}

const perHour = (n, ms) => (ms >= 5 * 60000 ? Math.round(n / (ms / HOUR)) : null);   // five minutes before a rate means anything
const minutes = (ms) => Math.round(ms / 60000);

/**
 * The clock on one count, as of `at`.
 *   started, ended, running        - from the first sign-on or line; ended is the last activity once closed
 *   elapsedMs, downtimeMs, countingMs
 *   spells                         - the quiet spells, oldest first; the last may still be open
 *   quietMinutes                   - how long nothing has happened, when that is already downtime
 *   lines, bins, binsTotal, binsLeft, linesPerHour, binsPerHour   - over the counting time
 *   recent                         - the last half hour's lines, bins and pace, while the count runs
 *   finishAt, finishBasis          - when the bins left will be done at the recent pace (or the average)
 *   teams                          - the same reckoning per team
 */
export function countClock(sessionId, at = Date.now()) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) return null;
  const gapMinutes = idleConfig().minutes || 10;
  const gapMs = gapMinutes * 60000;
  const acts = activity(id, at);
  const times = acts.map((a) => a.t);
  const running = s.status === 'open';
  const started = times.length ? times[0] : null;
  const last = times.length ? times[times.length - 1] : null;
  const end = started == null ? null : running ? at : Math.max(last, started);
  const spells = started == null ? [] : spellsOf(times, { gapMs, end, open: running });
  const downtimeMs = spells.reduce((k, x) => k + x.ms, 0);
  const closedMs = spells.filter((x) => !x.open).reduce((k, x) => k + x.ms, 0);
  const elapsedMs = started == null ? 0 : end - started;
  const countingMs = Math.max(0, elapsedMs - downtimeMs);
  const openSpell = spells.find((x) => x.open) || null;

  const tot = db.prepare('SELECT COUNT(*) AS lines, COUNT(DISTINCT location_code) AS bins FROM counts WHERE session_id = ? AND voided = 0').get(id);
  const binsTotal = db.prepare('SELECT COUNT(*) AS n FROM locations WHERE session_id = ?').get(id).n;
  const binsLeft = Math.max(0, binsTotal - tot.bins);
  const linesPerHour = perHour(tot.lines, countingMs);
  const binsPerHour = perHour(tot.bins, countingMs);

  /* the last half hour: the pace right now, which is what the finish time is read from */
  let recent = null;
  if (running && started != null) {
    const windowMs = Math.min(RECENT_MINUTES * 60000, at - started);
    const since = iso(at - windowMs);
    const r = db.prepare('SELECT COUNT(*) AS lines, COUNT(DISTINCT location_code) AS bins FROM counts WHERE session_id = ? AND voided = 0 AND scanned_at >= ?').get(id, since);
    recent = { minutes: minutes(windowMs), lines: r.lines, bins: r.bins, linesPerHour: perHour(r.lines, windowMs), binsPerHour: perHour(r.bins, windowMs) };
  }
  let finishAt = null;
  let finishBasis = null;
  if (running && binsLeft > 0) {
    if (recent && recent.binsPerHour > 0) { finishBasis = 'recent'; finishAt = at + (binsLeft / recent.binsPerHour) * HOUR; }
    else if (binsPerHour > 0) { finishBasis = 'average'; finishAt = at + (binsLeft / binsPerHour) * HOUR; }
  }

  /* each team, by the same reckoning */
  const byTeam = new Map(db.prepare('SELECT team, COUNT(*) AS lines, COUNT(DISTINCT location_code) AS bins FROM counts WHERE session_id = ? AND voided = 0 GROUP BY team').all(id).map((r) => [r.team, r]));
  const teams = teamClocks(id, at).map((c) => {
    const mine = acts.filter((a) => a.team === c.team).map((a) => a.t);
    const tStart = c.started ? Date.parse(c.started) : null;
    const tEnd = tStart == null ? null : c.working ? at : c.endedAt ? Math.max(Date.parse(c.endedAt), tStart) : (mine[mine.length - 1] ?? tStart);
    const sp = tStart == null ? [] : spellsOf(mine, { gapMs, end: tEnd, open: !!c.working });
    const down = sp.reduce((k, x) => k + x.ms, 0);
    const elapsed = tStart == null ? 0 : tEnd - tStart;
    const counting = Math.max(0, elapsed - down);
    const n = byTeam.get(c.team) || { lines: 0, bins: 0 };
    const openOne = sp.find((x) => x.open);
    return {
      team: c.team, started: c.started, endedAt: c.endedAt, working: c.working, state: c.state,
      elapsedMs: elapsed, downtimeMs: down, countingMs: counting, spells: sp.length,
      quietMinutes: openOne ? minutes(openOne.ms) : null,
      lines: n.lines, bins: n.bins, linesPerHour: perHour(n.lines, counting), binsPerHour: perHour(n.bins, counting),
    };
  });

  return {
    at: iso(at), running, gapMinutes,
    started: iso(started), ended: running ? null : iso(end), lastActivity: iso(last),
    elapsedMs, downtimeMs, countingMs,
    downtimeClosedMs: closedMs,                   // the spells that are over; the open one grows on the screen
    quietMinutes: openSpell ? minutes(openSpell.ms) : null,
    spells: spells.map((x) => ({ from: iso(x.from), to: iso(x.to), minutes: minutes(x.ms), open: x.open })),
    lines: tot.lines, bins: tot.bins, binsTotal, binsLeft, linesPerHour, binsPerHour,
    recent, finishAt: iso(finishAt), finishBasis,
    teams,
  };
}

/** A span of time in words: "2 h 05 min", "48 min". */
export function spanWords(ms) {
  if (!(ms >= 0)) return '';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
