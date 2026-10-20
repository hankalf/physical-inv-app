/*
 * The crew board: a wall screen of who is on which team, by shift.
 *
 * Like the office board it is read-only and needs no sign-in - it goes on a
 * TV by the time clock, and nobody signs a TV in. So it carries names, teams,
 * departments and equipment, and nothing else: no clock-in numbers.
 *
 * The site works two shifts, 1st 6am-2pm and 2nd 2pm-10pm. A team's shift is
 * what Teams & crew says it is; a team with no shift set takes its members'
 * shift when they all share one. The shift on now comes from the warehouse's
 * clock, not the browser's.
 */
import { listTeams, listEmployees, getConfig } from './people.js';
import { localHour } from '../util/localtime.js';

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

/** A team's shift: set on the team, or the one shift its members all share. */
export function teamShift(t) {
  if (t.shift) return { shift: t.shift, inferred: false };
  const own = [...new Set(t.members.map((m) => m.shift).filter(Boolean))];
  return own.length === 1 && t.members.every((m) => m.shift) ? { shift: own[0], inferred: true } : { shift: '', inferred: false };
}

export function crewBoard() {
  const cfg = getConfig();
  const kit = (keys) => keys.filter((k) => k !== 'FOOT' && cfg.equipment[k]).map((k) => cfg.equipment[k]);
  const person = (e) => ({ name: e.name, dept: e.dept || '', shift: e.shift || '', equipment: kit(e.equipment), reach: e.reach || '' });
  const teams = listTeams().map((t) => {
    const { shift, inferred } = teamShift(t);
    return {
      name: t.name, notes: t.notes || '', shift, shiftInferred: inferred, reachLabel: t.reachLabel,
      members: [...t.members].sort((a, b) => a.name.localeCompare(b.name)).map(person),
      // seats the team sheet keeps open: Production sends someone on the day
      open: t.seats.filter((s) => s.open).map((s) => ({ role: s.role || '', dept: s.dept || '' })),
    };
  });
  const onTeam = new Set(listTeams().flatMap((t) => t.members.map((m) => m.badge)));
  const loose = listEmployees().filter((e) => e.active && !onTeam.has(e.badge));
  const now = shiftNow();
  const group = (key) => ({
    teams: teams.filter((t) => t.shift === key).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    unassigned: loose.filter((e) => (e.shift || '') === key).sort((a, b) => a.name.localeCompare(b.name)).map(person),
  });
  return {
    now,
    shifts: [
      ...SHIFTS.map((s) => ({ key: s.key, label: s.label, hours: s.hours, on: now.shift === s.key, ...group(s.key) })),
      { key: '', label: 'Shift not set', hours: '', on: false, ...group('') },
    ],
    people: listEmployees().filter((e) => e.active).length,
  };
}
