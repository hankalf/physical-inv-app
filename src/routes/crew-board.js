/*
 * The crew board: a wall screen of who is on which team, by shift.
 *
 * Like the office board it is read-only and needs no sign-in - it goes on a
 * TV by the time clock, and nobody signs a TV in. So it carries names, teams,
 * where each team is counting and whether it is still scanning - names and
 * teams and nothing else: no clock-in numbers, no departments or equipment,
 * and nobody who is not on a team.
 *
 * The site works two shifts, 1st 6am-2pm and 2nd 2pm-10pm. A team's shift is
 * what Teams & crew says it is; a team with no shift set takes its members'
 * shift when they all share one. The shift on now comes from the warehouse's
 * clock, not the browser's.
 */
import { db } from '../db.js';
import { listTeams } from './people.js';
import { defaultBoardSession } from './board.js';
import { teamClocks, idleConfig } from './idle.js';
import { localHour, localTime } from '../util/localtime.js';

export const SHIFTS = [
  { key: '1', label: '1st shift', hours: '6am – 2pm', from: 6, to: 14 },
  { key: '2', label: '2nd shift', hours: '2pm – 10pm', from: 14, to: 22 },
];
const twelve = (h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

/** Which shift it is at the site right now, and what to say about it. */
export function shiftNow(hour = localHour()) {
  const on = SHIFTS.find((s) => hour >= s.from && hour < s.to);
  if (on) return { shift: on.key, hour, label: `${on.label} · ${on.hours}`, until: twelve(on.to) };
  const next = SHIFTS.find((s) => s.from > hour) || SHIFTS[0];
  return { shift: '', hour, label: `Between shifts · ${next.label} starts ${twelve(next.from)}`, until: '' };
}

/* What a team is doing on the count, in the words the dashboard uses: counting
   (scanning), stopped scanning (quiet past the site's stopped-scanning limit -
   the same limit that raises the alert), finished, signed off, or not signed on. */
export function teamState(clock, quietLimit) {
  if (!clock) return { state: 'not signed on', stopped: false };
  if (clock.state === 'counting') {
    const q = clock.quietMinutes;
    const stopped = quietLimit > 0 && q != null && q >= quietLimit;
    return { state: stopped ? 'stopped scanning' : 'scanning', stopped };
  }
  if (clock.state === 'finished') return { state: 'finished', stopped: false };
  if (clock.state === 'signed off') return { state: 'signed off', stopped: false };
  return { state: 'stopped scanning', stopped: true };           // gone quiet, or a count that is closed
}

/** A team's shift: set on the team, or the one shift its members all share. */
export function teamShift(t) {
  if (t.shift) return { shift: t.shift, inferred: false };
  const own = [...new Set(t.members.map((m) => m.shift).filter(Boolean))];
  return own.length === 1 && t.members.every((m) => m.shift) ? { shift: own[0], inferred: true } : { shift: '', inferred: false };
}

export function crewBoard(sessionId = '') {
  /* the count the teams are on: the one asked for, else the one the office board shows */
  const session = sessionId ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(sessionId)) : defaultBoardSession();
  const clocks = new Map(session ? teamClocks(session.id).map((c) => [String(c.team), c]) : []);
  const active = new Map(session ? db.prepare("SELECT team, aisle, levels, direction FROM assignments WHERE session_id = ? AND status = 'active'").all(session.id).map((a) => [String(a.team), a]) : []);
  const queued = new Map(session ? db.prepare("SELECT team, MIN(aisle) AS aisle, COUNT(*) AS n FROM assignments WHERE session_id = ? AND status = 'queued' GROUP BY team").all(session.id).map((a) => [String(a.team), a]) : []);
  const quietLimit = idleConfig().minutes;
  const person = (e) => ({ name: e.name });
  const teams = listTeams().map((t) => {
    const { shift, inferred } = teamShift(t);
    const clock = clocks.get(String(t.name)) || null;
    const a = active.get(String(t.name)) || null;
    const q = queued.get(String(t.name)) || null;
    return {
      name: t.name, notes: t.notes || '', shift, shiftInferred: inferred,
      members: [...t.members].sort((a2, b) => a2.name.localeCompare(b.name)).map(person),
      // seats the team sheet keeps open: Production sends someone on the day
      open: t.seats.filter((s) => s.open).map((s) => ({ role: s.role || '', dept: s.dept || '' })),
      // where it is and whether it is scanning, on the count
      now: {
        ...teamState(clock, quietLimit),
        aisle: a ? a.aisle : (clock && clock.aisle) || '', levels: a ? a.levels || '' : '', fromFarEnd: !!(a && a.direction === 'down'),
        next: q ? { aisle: q.aisle, more: q.n - 1 } : null,
        lastScan: clock ? clock.lastScan : null, lastBin: clock ? clock.lastBin : null,
        quietMinutes: clock && clock.state === 'counting' ? clock.quietMinutes : null,
        lines: clock ? clock.lines : 0,
      },
    };
  });
  const now = { ...shiftNow(), time: localTime() };     // the site's clock, so the screen and "on now" agree
  // the teams and who is on them, nothing else: people on no team are Teams & crew's business
  const group = (key) => ({
    teams: teams.filter((t) => t.shift === key).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  });
  return {
    now,
    session: session ? { id: session.id, name: session.name } : null,
    quietLimit,
    shifts: [
      ...SHIFTS.map((s) => ({ key: s.key, label: s.label, hours: s.hours, on: now.shift === s.key, ...group(s.key) })),
      { key: '', label: 'Shift not set', hours: '', on: false, ...group('') },
    ],
    people: teams.reduce((n, t) => n + t.members.length, 0),
  };
}
