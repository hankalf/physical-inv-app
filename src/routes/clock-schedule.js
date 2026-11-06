/* The hours a count is worked.
 *
 * The clock on a count reads its pace from the time the crews were actually
 * counting, and says when the bins left will be done at that pace. Without a
 * schedule it counts every minute from now as a counting minute - so at 11:50
 * it promises 12:20, and lunch makes a liar of it. With one, the finish time
 * steps over the breaks and stops at the end of the shift: what is left at
 * the bell waits for the next shift, and the clock says so.
 *
 * A schedule is kept per count: the shift's start and end, and the breaks in
 * it. A shift that ends before it starts runs over midnight; so does a break.
 */
import { db, getSession } from '../db.js';
import { localDate, localMinutes, localToMs, addDays } from '../util/localtime.js';

const key = (id) => `clock:${Number(id)}`;
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const mins = (hm) => { const m = HHMM.exec(String(hm || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function clockSchedule(sessionId) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key(sessionId));
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const start = mins(v.start) == null ? '' : hm(mins(v.start));
  const end = mins(v.end) == null ? '' : hm(mins(v.end));
  const breaks = (Array.isArray(v.breaks) ? v.breaks : []).map((b) => ({ from: mins(b.from), to: mins(b.to), label: String(b.label || '').trim().slice(0, 40) }))
    .filter((b) => b.from != null && b.to != null && b.from !== b.to).map((b) => ({ from: hm(b.from), to: hm(b.to), label: b.label || 'Break' }));
  const on = !!v.on && (!!start || !!end || breaks.length > 0);
  return { on, start, end, breaks };
}

export function saveClockSchedule(sessionId, body = {}) {
  if (!getSession(sessionId)) throw Object.assign(new Error('session not found'), { status: 404 });
  const bad = (what) => { throw Object.assign(new Error(what), { status: 400 }); };
  const start = String(body.start || '').trim(), end = String(body.end || '').trim();
  if (start && mins(start) == null) bad(`the shift start "${start}" is not a time - write it as 06:00`);
  if (end && mins(end) == null) bad(`the shift end "${end}" is not a time - write it as 14:30`);
  const breaks = (Array.isArray(body.breaks) ? body.breaks : []).map((b, i) => {
    const f = mins(b && b.from), t = mins(b && b.to);
    if (f == null || t == null) bad(`break ${i + 1}: write both times as 12:00 and 12:30`);
    if (f === t) bad(`break ${i + 1}: it starts and ends at the same time`);
    return { from: hm(f), to: hm(t), label: String((b && b.label) || '').trim().slice(0, 40) || 'Break' };
  });
  const v = { on: !!body.on, start, end, breaks };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key(sessionId), JSON.stringify(v));
  return clockSchedule(sessionId);
}

/* ---- the windows: when, between two moments, the count is being worked */

/** [from, to) in minutes on a given site day, as timestamps; an end before the start is the next day. */
function span(dateStr, fromM, toM) {
  const a = localToMs(dateStr, fromM);
  const b = toM > fromM ? localToMs(dateStr, toM) : localToMs(addDays(dateStr, 1), toM);
  return [a, b];
}

/**
 * The off periods (breaks, and the hours outside the shift) that touch the
 * time between two moments, each with its label, oldest first.
 */
export function offPeriods(schedule, fromMs, toMs) {
  if (!schedule.on) return [];
  const out = [];
  const startM = mins(schedule.start), endM = mins(schedule.end);
  let day = addDays(localDate(new Date(fromMs)), -1);
  const last = addDays(localDate(new Date(toMs)), 1);
  for (let guard = 0; guard < 40 && day <= last; guard++, day = addDays(day, 1)) {
    for (const b of schedule.breaks) { const [a, z] = span(day, mins(b.from), mins(b.to)); out.push({ label: b.label, from: a, to: z, kind: 'break' }); }
    if (startM != null && endM != null) {
      // the hours from this day's end to the next day's start are off
      const [, shiftEnd] = span(day, startM, endM);
      const nextStart = localToMs(endM > startM ? addDays(day, 1) : addDays(day, 1), startM);
      const ns = nextStart > shiftEnd ? nextStart : localToMs(addDays(day, 2), startM);
      out.push({ label: `the end of the shift (${schedule.end})`, from: shiftEnd, to: ns, kind: 'shift' });
    }
  }
  return out.filter((o) => o.to > fromMs && o.from < toMs).sort((a, b) => a.from - b.from);
}

/** How much of the time between two moments is scheduled off. */
export function scheduledOffMs(schedule, fromMs, toMs) {
  let off = 0;
  let cursor = fromMs;
  for (const o of offPeriods(schedule, fromMs, toMs)) {
    const a = Math.max(o.from, cursor), z = Math.min(o.to, toMs);
    if (z > a) { off += z - a; cursor = z; }
  }
  return off;
}

/** The off period a moment falls in, if any. */
export function offAt(schedule, ms) {
  return offPeriods(schedule, ms, ms + 1).find((o) => o.from <= ms && ms < o.to) || null;
}

/**
 * When `workMs` of counting will be done, starting now and skipping what is
 * scheduled off. Says which breaks it stepped over, and whether it ran past
 * the end of a shift - and how much of the work would be done by that bell.
 */
export function projectFinish(schedule, fromMs, workMs) {
  if (!schedule.on || !(workMs > 0)) return { finishAt: fromMs + Math.max(0, workMs), skipped: [], pastShift: false, workByShiftEnd: null };
  const horizon = fromMs + 14 * 86400000;
  const offs = offPeriods(schedule, fromMs, horizon);
  let t = fromMs, left = workMs;
  const skipped = [];
  let pastShift = false;
  let workByShiftEnd = null;
  for (const o of offs) {
    if (o.from <= t) { if (o.to > t) { skipped.push(o); t = o.to; } continue; }   // already in it, or over
    const room = o.from - t;
    if (left <= room) { t += left; left = 0; break; }
    left -= room; t = o.to; skipped.push(o);
    if (o.kind === 'shift' && workByShiftEnd == null) { pastShift = true; workByShiftEnd = workMs - left; }
  }
  if (left > 0) t += left;
  return { finishAt: t, skipped, pastShift, workByShiftEnd };
}

/** A schedule in words: "06:00–14:30 · breaks 09:30–09:45 Break, 12:00–12:30 Lunch". */
export function scheduleWords(s) {
  if (!s.on) return '';
  const shift = s.start && s.end ? `${s.start}–${s.end}` : s.start ? `from ${s.start}` : s.end ? `until ${s.end}` : 'any hours';
  const breaks = s.breaks.length ? ` · breaks ${s.breaks.map((b) => `${b.from}–${b.to} ${b.label}`).join(', ')}` : '';
  return `Shift ${shift}${breaks}`;
}

export const minutesOfDay = mins;
export const nowMinutes = () => localMinutes();
