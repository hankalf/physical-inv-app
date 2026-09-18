import { db } from '../db.js';
import { progress } from './reports.js';

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
 * people stand and watch, so it wins over a cycle programme that runs all year.
 */
export function defaultBoardSession() {
  return db.prepare("SELECT * FROM sessions WHERE status = 'open' AND mode != 'cycle' ORDER BY id DESC LIMIT 1").get()
    || db.prepare("SELECT * FROM sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1").get()
    || db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').get()
    || null;
}

export function listBoardSessions() {
  return db.prepare("SELECT id, name, mode, status FROM sessions WHERE status = 'open' ORDER BY id DESC")
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

  const aisles = p.byAisle
    .filter((a) => a.bins > 0)
    .map((a) => ({
      aisle: a.aisle, zone: a.zone || '', bins: a.bins, counted: a.bins_counted,
      active: a.active_detail || '', done: !!a.done_count,
    }));

  return {
    session: { id: session.id, name: session.name, mode: session.mode || 'full', status: session.status },
    sessions: listBoardSessions(),
    /* The line the office writes for the floor: when lunch is, which dock is
       blocked. It sits above everything else on the board because that is the
       one thing somebody walking past is looking for. */
    note: session.board_note || '',
    noteBy: session.board_note_by || '',
    noteAt: session.board_note_at || '',
    at: new Date().toISOString(),
    pct,
    bins: { counted: p.bins_counted, total: p.bins_total },
    pallets: { found: p.pallets_counted, total: p.pallets_total },
    emptyBins: p.empty_bins || 0,
    lines: p.lines,
    flagged: p.exceptions,
    recounts: { open: p.recounts_open, done: p.recounts_done },
    aislesDone: aisles.filter((a) => a.done).length,
    aislesTotal: aisles.length,
    teams: [...teams.values()].sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true })),
    aisles,
  };
}
