import { db, norm } from '../db.js';
import { progress } from './reports.js';
import { countClock } from './count-clock.js';
import { teamClocks, shiftOf } from './idle.js';
import { shiftNow } from './crew-board.js';

/*
 * The office board.
 *
 * Read-only and unauthenticated - it goes on a screen in the office and nobody
 * is going to sign a TV in every morning. So it carries progress and nothing
 * else: no pallet IDs, no clock in numbers, no exports, no controls. Team
 * numbers and aisle codes are what a manager needs to see from across a room.
 */

/**
 * The count a board should show by default. A wall-to-wall count is the thing
 * people stand and watch, so it wins over a cycle program that runs all year.
 */
export function defaultBoardSession() {
  /* The count the scanners land on, when one is set; else the newest open full
     count. The Testing tab's practice count and the classroom's training counts
     are never what the wall shows by itself - a week of trainees' second counts
     looked like a count day gone wrong - though either can still be put up by
     asking for it by number. */
  const setting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? Number(r.value) || 0 : 0; };
  const skip = [setting('trainingSession'), setting('trainingCycle')].filter(Boolean);
  const landing = setting('defaultSessionId');
  const notTraining = (row) => row && !skip.includes(row.id) ? row : null;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  if (landing && !skip.includes(landing)) { const s = one("SELECT * FROM sessions WHERE id = ? AND status = 'open' AND practice = 0", landing); if (s) return s; }
  const ids = skip.length ? `AND id NOT IN (${skip.join(',')})` : '';
  return notTraining(one(`SELECT * FROM sessions WHERE status = 'open' AND mode != 'cycle' AND practice = 0 ${ids} ORDER BY id DESC LIMIT 1`))
    || notTraining(one(`SELECT * FROM sessions WHERE status = 'open' AND practice = 0 ${ids} ORDER BY id DESC LIMIT 1`))
    || notTraining(one(`SELECT * FROM sessions WHERE practice = 0 ${ids} ORDER BY id DESC LIMIT 1`))
    || null;
}

export function listBoardSessions() {
  return db.prepare("SELECT id, name, mode, status FROM sessions WHERE status = 'open' AND practice = 0 ORDER BY id DESC")
    .all().map((s) => ({ id: s.id, name: s.name, mode: s.mode || 'full' }));
}

export function boardData(sessionId) {
  const session = sessionId
    ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(sessionId))
    : defaultBoardSession();
  if (!session) return { session: null, sessions: [] };

  const p = progress(session.id);
  const pct = p.bins_total ? Math.round((p.bins_counted / p.bins_total) * 1000) / 10 : 0;

  // one row per team: who is where, how much, how recently - never who by name
  const teams = new Map();
  for (const s of p.signedOn) {
    teams.set(String(s.team), {
      team: String(s.team), crew: JSON.parse(s.employees || '[]').length,
      scanners: (s.devices || '').split(',').filter(Boolean).length,
      lines: 0, bins: 0, aisle: '', lastScan: null,
    });
  }
  for (const t of p.byTeam) {
    const k = String(t.team);
    const row = teams.get(k) || { team: k, crew: 0, scanners: 0 };
    teams.set(k, {
      ...row,
      scanners: (t.devices || '').split(',').filter(Boolean).length || row.scanners,
      lines: t.lines, bins: t.bins, aisle: t.active_aisle || '', lastScan: t.last_scan,
    });
  }

  /* The teams on the wall are the ones counting now, on the shift that is on:
     a crew that signed off, went quiet or finished, or the other shift's teams,
     are not what the office is watching. Teams with no shift set are shown. */
  const now = shiftNow();
  const shifts = shiftOf();
  const clocks = new Map(teamClocks(session.id).map((c) => [String(c.team), c]));
  const rows = [...teams.values()].map((t) => ({ ...t, shift: shifts.get(norm(t.team)) || '', state: (clocks.get(t.team) || {}).state || '' }));
  const shown = rows.filter((t) => { const c = clocks.get(t.team); return c && c.working && (!t.shift || t.shift === now.shift); });
  const hidden = rows.length - shown.length;

  /* every level of every aisle, with how far it is: A 100%, B 40%, C 0% */
  const levelRows = db.prepare(
    `SELECT l.aisle, UPPER(TRIM(COALESCE(l.level, ''))) AS level, COUNT(*) AS bins,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) THEN 1 ELSE 0 END) AS counted
       FROM locations l WHERE l.session_id = ? AND TRIM(COALESCE(l.level, '')) != '' GROUP BY l.aisle, level ORDER BY l.aisle, level`).all(session.id);
  const levelsBy = new Map();
  for (const r of levelRows) { if (!levelsBy.has(r.aisle)) levelsBy.set(r.aisle, []); levelsBy.get(r.aisle).push({ level: r.level, bins: r.bins, counted: r.counted, pct: r.bins ? Math.round((r.counted / r.bins) * 100) : 0 }); }

  const aisles = p.byAisle
    .filter((a) => a.bins > 0)
    .map((a) => ({
      aisle: a.aisle, zone: a.zone || '', bins: a.bins, counted: a.bins_counted,
      active: a.active_detail || '', done: !!a.done_count,
      levels: levelsBy.get(a.aisle) || [],
    }));

  const notes = db.prepare('SELECT id, text, by, at, updated_at FROM board_notes WHERE session_id = ? ORDER BY id').all(session.id);
  return {
    session: { id: session.id, name: session.name, mode: session.mode || 'full', status: session.status, trial: !!session.trial },
    sessions: listBoardSessions(),
    /* The line the office writes for the floor: when lunch is, which dock is
       blocked. It sits above everything else on the board because that is the
       one thing somebody walking past is looking for. */
    notes,
    note: notes.length ? notes[notes.length - 1].text : '',
    noteBy: notes.length ? notes[notes.length - 1].by || '' : '',
    noteAt: notes.length ? notes[notes.length - 1].at : '',
    at: new Date().toISOString(),
    pct,
    bins: { counted: p.bins_counted, total: p.bins_total },
    pallets: { found: p.pallets_counted, total: p.pallets_total },
    emptyBins: p.empty_bins || 0,
    lines: p.lines,
    flagged: p.exceptions,
    recounts: { open: p.recounts_open, done: p.recounts_done },
    /* whole: every bin has a count and no second count is open - the wall says
       100% then and not before; bins all counted with second counts still to
       do is 99.9% and says why */
    complete: p.bins_total > 0 && p.bins_counted >= p.bins_total && !p.recounts_open,
    aislesDone: aisles.filter((a) => a.done).length,
    aislesTotal: aisles.length,
    teams: shown.sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true })),
    teamsHidden: hidden,                     // signed on once, but stopped, finished, signed off or on the other shift
    shiftNow: { shift: now.shift, label: now.label },
    aisles,
    /* the clock: how long the count has run, the downtime in it, the pace and
       when it will be done - team numbers only, like the rest of the board */
    clock: countClock(session.id),
  };
}
