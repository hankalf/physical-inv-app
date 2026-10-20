/*
 * The crew board: a wall screen of who is on which team, by shift.
 *
 * Like the office board it is read-only and needs no sign-in - it goes on a
 * TV by the time clock, and nobody signs a TV in. So it carries names, teams,
 * where each team is counting and whether it is still scanning - names and
 * teams and nothing else: no clock-in numbers, no departments or equipment,
 * and nobody who is not on a team.
 *
 * The site works two shifts - 1st 6am-2pm and 2nd 2pm-10pm unless an admin
 * sets other hours under Settings → Site & systems → Crew board. A team's
 * shift is what Teams & crew says it is; a team with no shift set takes its
 * members' shift when they all share one. The shift on now comes from the
 * warehouse's clock, not the browser's, against those hours.
 */
import { db } from '../db.js';
import { listTeams } from './people.js';
import { defaultBoardSession } from './board.js';
import { teamClocks, idleConfig } from './idle.js';
import { localMinutes, localTime } from '../util/localtime.js';

/* ------------------------------------------------------------ the shift times
 * Kept as HH:MM on the clock, 24-hour, so a shift that starts on the half
 * hour or runs past midnight (10pm-6am) is as easy to say as 6am-2pm. */
const DEFAULT_SHIFTS = { 1: { from: '06:00', to: '14:00' }, 2: { from: '14:00', to: '22:00' } };
const LABELS = { 1: '1st shift', 2: '2nd shift' };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm) => { const m = HHMM.exec(String(hhmm || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
/** 390 → "6:30am", 840 → "2pm", 0 → "12am". */
export const twelve = (mins) => {
  const h = Math.floor(((mins % 1440) + 1440) % 1440 / 60), mm = ((mins % 60) + 60) % 60;
  return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
};
/** Whether minute-of-day m falls in a shift; a shift whose end is not after its start runs past midnight. */
const within = (s, m) => (s.toMin > s.fromMin ? m >= s.fromMin && m < s.toMin : m >= s.fromMin || m < s.toMin);

/** The two shifts with their hours, as set, in the order they are shown. */
export function shiftTimes(times = crewBoardConfig().shifts) {
  return ['1', '2'].map((key) => {
    const t = times[key] || DEFAULT_SHIFTS[key];
    const fromMin = toMinutes(t.from), toMin = toMinutes(t.to);
    return { key, label: LABELS[key], from: t.from, to: t.to, fromMin, toMin, hours: `${twelve(fromMin)} – ${twelve(toMin)}` };
  });
}
/** The shift times from the body of a save, checked: HH:MM, a start and an end that differ, and no overlap. */
function checkShiftTimes(body, current) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const next = { 1: { ...current[1] }, 2: { ...current[2] } };
  for (const key of ['1', '2']) {
    const t = body[key];
    if (!t || typeof t !== 'object') continue;
    for (const end of ['from', 'to']) if (end in t) {
      if (Number.isNaN(toMinutes(t[end]))) throw bad(`the ${LABELS[key]} ${end === 'from' ? 'start' : 'end'} is a time on the clock, such as 06:30 or 14:00`);
      next[key][end] = String(t[end]).trim();
    }
    if (next[key].from === next[key].to) throw bad(`the ${LABELS[key]} cannot start and end at the same time`);
  }
  const [a, b] = shiftTimes(next);
  // two stretches of the day overlap only when one starts inside the other
  if (within(a, b.fromMin) || within(b, a.fromMin)) throw bad(`the shifts overlap: ${a.label} ${a.hours}, ${b.label} ${b.hours}`);
  return next;
}

/** Which shift it is at the site right now, and what to say about it. */
export function shiftNow(minutes = localMinutes(), shifts = shiftTimes()) {
  const hour = Math.floor(minutes / 60);
  const on = shifts.find((s) => within(s, minutes));
  if (on) return { shift: on.key, hour, minutes, label: `${on.label} · ${on.hours}`, until: twelve(on.toMin), next: on.key };
  // between shifts the board shows the one coming in next: the one whose start is soonest
  const next = [...shifts].sort((a, b) => ((a.fromMin - minutes + 1440) % 1440) - ((b.fromMin - minutes + 1440) % 1440))[0];
  return { shift: '', hour, minutes, label: `Between shifts · ${next.label} starts ${twelve(next.fromMin)}`, until: '', next: next.key };
}

/* ------------------------------------------------------------ what the screen shows
 * An admin decides, under Settings → Site & systems → Crew board: which shift
 * (the one on now by the clock, or a fixed one), what each team card carries,
 * and whether the list scrolls by itself for a screen nobody touches. */
const SPEEDS = { slow: 18, normal: 36, fast: 70 };
const SHOW_KEYS = ['members', 'openSeats', 'notes', 'where', 'lastScan', 'count'];
const DEFAULT_CONFIG = { shift: 'auto', show: { members: true, openSeats: true, notes: true, where: true, lastScan: true, count: true }, scroll: { on: true, speed: 'normal', pause: 6 }, shifts: DEFAULT_SHIFTS };
export function crewBoardConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'crewBoard'").get();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  const show = { ...DEFAULT_CONFIG.show };
  for (const k of SHOW_KEYS) if (saved.show && k in saved.show) show[k] = saved.show[k] !== false;
  const scroll = { ...DEFAULT_CONFIG.scroll, ...(saved.scroll || {}) };
  if (!(scroll.speed in SPEEDS) && !(Number(scroll.speed) >= 5 && Number(scroll.speed) <= 400)) scroll.speed = 'normal';
  scroll.on = scroll.on !== false;
  scroll.pause = Math.max(0, Math.min(60, Number(scroll.pause) || 0));
  const shifts = {};
  for (const k of ['1', '2']) {
    const t = (saved.shifts || {})[k] || {};
    // a saved time that does not read as HH:MM falls back to the usual hours rather than breaking the board
    shifts[k] = { from: Number.isNaN(toMinutes(t.from)) ? DEFAULT_SHIFTS[k].from : t.from, to: Number.isNaN(toMinutes(t.to)) ? DEFAULT_SHIFTS[k].to : t.to };
  }
  return {
    shift: ['auto', '1', '2'].includes(saved.shift) ? saved.shift : 'auto',
    show, scroll, shifts,
    shiftHours: shiftTimes(shifts).map((s) => ({ key: s.key, label: s.label, hours: s.hours })),
    pxPerSecond: SPEEDS[scroll.speed] || Number(scroll.speed),
    isDefault: !row,
  };
}
export function saveCrewBoardConfig(body = {}) {
  const now = crewBoardConfig();
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const next = { shift: now.shift, show: { ...now.show }, scroll: { ...now.scroll }, shifts: now.shifts };
  if (body.shift !== undefined) {
    if (!['auto', '1', '2'].includes(String(body.shift))) throw bad('the shift shown is auto, 1 or 2');
    next.shift = String(body.shift);
  }
  if (body.show && typeof body.show === 'object') for (const k of SHOW_KEYS) if (k in body.show) next.show[k] = body.show[k] !== false;
  if (body.scroll && typeof body.scroll === 'object') {
    if ('on' in body.scroll) next.scroll.on = body.scroll.on !== false;
    if ('speed' in body.scroll) {
      const v = body.scroll.speed;
      if (!(v in SPEEDS) && !(Number(v) >= 5 && Number(v) <= 400)) throw bad('the scroll speed is slow, normal or fast, or 5 to 400 pixels a second');
      next.scroll.speed = v in SPEEDS ? v : Number(v);
    }
    if ('pause' in body.scroll) {
      const n = Number(body.scroll.pause);
      if (!(n >= 0 && n <= 60)) throw bad('the pause at each end is 0 to 60 seconds');
      next.scroll.pause = n;
    }
  }
  if (body.shifts && typeof body.shifts === 'object') next.shifts = checkShiftTimes(body.shifts, now.shifts);
  db.prepare("INSERT INTO settings (key, value) VALUES ('crewBoard', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return crewBoardConfig();
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
  const { isDefault, shiftHours, ...config } = crewBoardConfig();
  const SHIFTS = shiftTimes(config.shifts);
  const now = { ...shiftNow(localMinutes(), SHIFTS), time: localTime() };     // the site's clock, so the screen and "on now" agree
  // the teams and who is on them, nothing else: people on no team are Teams & crew's business
  const group = (key) => ({
    teams: teams.filter((t) => t.shift === key).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  });
  return {
    now,
    session: session ? { id: session.id, name: session.name } : null,
    quietLimit,
    config,
    shifts: [
      ...SHIFTS.map((s) => ({ key: s.key, label: s.label, hours: s.hours, on: now.shift === s.key, ...group(s.key) })),
      { key: '', label: 'Shift not set', hours: '', on: false, ...group('') },
    ],
    people: teams.reduce((n, t) => n + t.members.length, 0),
  };
}
