/*
 * Crew metrics: how each team and each person worked the count.
 *
 * Nothing here is a judgment; it is the record, laid out so a supervisor can
 * read it in a minute. For each team: time on the count, counting time, the
 * quiet spells over the stopped-scanning limit and how much of that was
 * off-task (a quiet spell that falls in a scheduled break is a break, not
 * off-task), the longest spell, pace in bins and lines an hour, the rhythm
 * between scans, and the habits a count sees - overrides, pallets and bins
 * off the list, bins counted outside the plan, duplicates, voids, empties,
 * second counts worked, stopped-scanning alerts, SOS calls. For each person:
 * the same, credited to everyone signed on to the gun that made the line,
 * with their hours from the sign-ons.
 */
import { db, norm, getSession } from '../db.js';
import { countClock, spanWords } from './count-clock.js';
import { idleConfig } from './idle.js';
import { clockSchedule, offPeriods } from './clock-schedule.js';
import { xlsx, heat } from '../util/xlsx.js';
import { siteTimezone, localHour } from '../util/localtime.js';

const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(norm).filter(Boolean) : []; } catch { return String(s || '').split(/[,;]\s*/).map(norm).filter(Boolean); } };
const perHour = (n, ms) => (ms > 0 ? Math.round((n / (ms / 3600000)) * 10) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/* the quiet spells in a run of moments, and how much of each was a scheduled break */
function spells(times, { gapMs, end, open, sched }) {
  const out = [];
  const offIn = (a, z) => { let off = 0, cur = a; for (const o of offPeriods(sched, a, z)) { const x = Math.max(o.from, cur), y = Math.min(o.to, z); if (y > x) { off += y - x; cur = y; } } return off; };
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > gapMs) out.push({ from: times[i - 1], to: times[i], ms: gap, scheduledMs: offIn(times[i - 1], times[i]), open: false });
  }
  const last = times[times.length - 1];
  if (open && times.length && end - last > gapMs) out.push({ from: last, to: null, ms: end - last, scheduledMs: offIn(last, end), open: true });
  return out;
}

export function crewMetrics(sessionId, at = Date.now()) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) return null;
  const gapMinutes = idleConfig().minutes || 10;
  const gapMs = gapMinutes * 60000;
  const sched = clockSchedule(id);
  const clock = countClock(id, at);
  const byTeamClock = new Map(clock.teams.map((t) => [t.team, t]));
  const people = new Map(db.prepare('SELECT badge, name, dept, shift FROM employees').all().map((e) => [norm(e.badge), e]));
  const teamShift = new Map(db.prepare('SELECT name, shift FROM teams').all().map((t) => [norm(t.name), t.shift || '']));

  const lines = db.prepare(`SELECT team, employees, device_id, location_code, pallet_id, scanned_at, voided, empty_bin, unknown_pallet, unknown_location,
      off_assignment, duplicate_pallet, override_reason, recount_id, label_issue, bin_label_issue, comments FROM counts WHERE session_id = ? ORDER BY scanned_at`).all(id);
  const signons = db.prepare('SELECT team, employees, device_id, started_at, ended_at FROM signons WHERE session_id = ? ORDER BY started_at').all(id);
  const idle = db.prepare('SELECT team, COUNT(*) AS n FROM idle_alerts WHERE session_id = ? GROUP BY team').all(id);
  const sos = db.prepare("SELECT team, COUNT(*) AS n FROM alerts WHERE session_id = ? GROUP BY team").all(id);
  const aislesDone = db.prepare("SELECT team, COUNT(*) AS n FROM assignments WHERE session_id = ? AND status = 'done' GROUP BY team").all(id);
  const idleBy = new Map(idle.map((r) => [r.team, r.n])), sosBy = new Map(sos.map((r) => [r.team, r.n])), doneBy = new Map(aislesDone.map((r) => [r.team, r.n]));

  const blank = () => ({ lines: 0, voided: 0, bins: new Set(), pallets: new Set(), empties: 0, overrides: 0, unknownPallets: 0, unknownBins: 0, offPlan: 0, duplicates: 0, secondCounts: 0, labelIssues: 0, comments: 0, times: [], first: null, last: null, teams: new Set(), devices: new Set(), hours: new Map() });
  const tally = (acc, l) => {
    const t = Date.parse(l.scanned_at);
    acc.teams.add(l.team); acc.devices.add(l.device_id);
    if (Number.isFinite(t)) { acc.times.push(Math.min(t, at)); acc.first = acc.first == null ? t : Math.min(acc.first, t); acc.last = acc.last == null ? t : Math.max(acc.last, t); }
    if (l.voided) { acc.voided++; return; }
    acc.lines++;
    if (Number.isFinite(t)) { const h = localHour(new Date(t)); acc.hours.set(h, (acc.hours.get(h) || 0) + 1); }
    acc.bins.add(l.location_code);
    if (!l.empty_bin) acc.pallets.add(l.pallet_id);
    if (l.empty_bin) acc.empties++;
    if (l.override_reason) acc.overrides++;
    if (l.unknown_pallet) acc.unknownPallets++;
    if (l.unknown_location) acc.unknownBins++;
    if (l.off_assignment) acc.offPlan++;
    if (l.duplicate_pallet) acc.duplicates++;
    if (l.recount_id) acc.secondCounts++;
    if (l.label_issue || l.bin_label_issue) acc.labelIssues++;
    if (l.comments) acc.comments++;
  };
  const teams = new Map(), persons = new Map();
  for (const l of lines) {
    if (!teams.has(l.team)) teams.set(l.team, blank());
    tally(teams.get(l.team), l);
    for (const b of parseList(l.employees)) { if (!persons.has(b)) persons.set(b, blank()); tally(persons.get(b), l); }
  }
  for (const so of signons) { if (!teams.has(so.team)) teams.set(so.team, blank()); for (const b of parseList(so.employees)) { if (!persons.has(b)) persons.set(b, blank()); persons.get(b).teams.add(so.team); } }

  /* the lines in each hour of the day, site time: the shape of the shift */
  const byHour = (hours) => [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, lines]) => ({ hour, lines }));
  /* the rhythm: the typical seconds between one scan and the next, quiet spells left out */
  const rhythm = (times) => { const gaps = []; for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g > 0 && g <= gapMs) gaps.push(g / 1000); } return gaps.length ? Math.round(median(gaps)) : null; };
  const habits = (a) => {
    const w = [];
    if (a.overrides) w.push(`${a.overrides} override${a.overrides === 1 ? '' : 's'}`);
    if (a.unknownPallets) w.push(`${a.unknownPallets} pallet${a.unknownPallets === 1 ? '' : 's'} off the list`);
    if (a.unknownBins) w.push(`${a.unknownBins} bin${a.unknownBins === 1 ? '' : 's'} off the list`);
    if (a.offPlan) w.push(`${a.offPlan} outside the plan`);
    if (a.duplicates) w.push(`${a.duplicates} duplicate${a.duplicates === 1 ? '' : 's'}`);
    if (a.voided) w.push(`${a.voided} voided`);
    if (a.labelIssues) w.push(`${a.labelIssues} label${a.labelIssues === 1 ? '' : 's'} that would not scan`);
    return w.join(' · ') || 'clean';
  };

  const teamRows = [...teams.entries()].map(([team, a]) => {
    const c = byTeamClock.get(team) || {};
    const started = c.started ? Date.parse(c.started) : a.first;
    const end = started == null ? null : c.working ? at : c.endedAt ? Math.max(Date.parse(c.endedAt), started) : (a.last ?? started);
    const ts = [...a.times].sort((x, y) => x - y);
    const sp = started == null ? [] : spells(ts, { gapMs, end, open: !!c.working, sched });
    const downtime = sp.reduce((k, x) => k + x.ms, 0);
    const scheduled = sp.reduce((k, x) => k + x.scheduledMs, 0);
    const offTask = Math.max(0, downtime - scheduled);
    const longest = sp.reduce((best, x) => (!best || x.ms - x.scheduledMs > best.ms - best.scheduledMs ? x : best), null);
    const elapsed = started == null ? 0 : end - started;
    const counting = Math.max(0, elapsed - downtime);
    const crew = [...new Set(signons.filter((x) => x.team === team).flatMap((x) => parseList(x.employees)))];
    return {
      team, shift: teamShift.get(norm(team)) || '', state: c.state || (a.lines ? 'stopped' : 'signed on'),
      people: crew.map((b) => ({ badge: b, name: people.get(b)?.name || '' })),
      started: iso(started), ended: c.working ? null : iso(end), lastActive: c.lastActive || iso(a.last),
      elapsedMs: elapsed, countingMs: counting, downtimeMs: downtime, scheduledOffMs: scheduled, offTaskMs: offTask,
      offTaskPct: elapsed - scheduled > 0 ? Math.round((offTask / (elapsed - scheduled)) * 1000) / 10 : 0,
      spells: sp.length, longestSpellMs: longest ? longest.ms - longest.scheduledMs : 0, longestSpellAt: longest ? iso(longest.from) : null, quietNow: sp.some((x) => x.open),
      lines: a.lines, bins: a.bins.size, pallets: a.pallets.size, empties: a.empties, voided: a.voided,
      linesPerHour: perHour(a.lines, counting), binsPerHour: perHour(a.bins.size, counting), secondsBetweenScans: rhythm(ts),
      overrides: a.overrides, unknownPallets: a.unknownPallets, unknownBins: a.unknownBins, offPlan: a.offPlan, duplicates: a.duplicates,
      secondCounts: a.secondCounts, labelIssues: a.labelIssues, comments: a.comments,
      idleAlerts: idleBy.get(team) || 0, sos: sosBy.get(team) || 0, aislesDone: doneBy.get(team) || 0, devices: [...a.devices],
      linesByHour: byHour(a.hours),
      habits: habits(a),
    };
  }).sort((x, y) => String(x.team).localeCompare(String(y.team), undefined, { numeric: true }));

  /* each person: hours from the sign-ons, and their team's quiet spells while they were signed on */
  const personRows = [...persons.entries()].map(([badge, a]) => {
    const e = people.get(badge);
    const windows = signons.filter((x) => parseList(x.employees).includes(badge)).map((x) => ({ team: x.team, from: Date.parse(x.started_at), to: x.ended_at ? Date.parse(x.ended_at) : at }));
    const signedMs = windows.reduce((k, w) => k + Math.max(0, Math.min(w.to, at) - w.from), 0);
    /* quiet time while signed on: the team's spells clipped to the person's windows */
    let offTask = 0, longest = 0, nSpells = 0;
    for (const w of windows) {
      const t = teamRows.find((r) => r.team === w.team);
      if (!t) continue;
      const ts = [...(teams.get(w.team)?.times || [])].filter((x) => x >= w.from && x <= w.to).sort((x, y) => x - y);
      const sp = spells(ts.length ? [w.from, ...ts, Math.min(w.to, at)] : [w.from, Math.min(w.to, at)], { gapMs, end: Math.min(w.to, at), open: false, sched });
      for (const x of sp) { const off = Math.max(0, x.ms - x.scheduledMs); if (off > 0) { nSpells++; offTask += off; longest = Math.max(longest, off); } }
    }
    const counting = Math.max(0, signedMs - offTask);
    const ts = [...a.times].sort((x, y) => x - y);
    return {
      badge, name: e?.name || '', dept: e?.dept || '', shift: e?.shift || '',
      teams: [...a.teams].sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true })),
      signedOnMs: signedMs, countingMs: counting, offTaskMs: offTask, offTaskPct: signedMs > 0 ? Math.round((offTask / signedMs) * 1000) / 10 : 0,
      spells: nSpells, longestSpellMs: longest, signons: windows.length, onNow: windows.some((w) => w.to >= at),
      first: iso(a.first), last: iso(a.last),
      lines: a.lines, bins: a.bins.size, pallets: a.pallets.size, empties: a.empties, voided: a.voided,
      linesPerHour: perHour(a.lines, counting), binsPerHour: perHour(a.bins.size, counting), secondsBetweenScans: rhythm(ts),
      overrides: a.overrides, unknownPallets: a.unknownPallets, unknownBins: a.unknownBins, offPlan: a.offPlan, duplicates: a.duplicates,
      secondCounts: a.secondCounts, labelIssues: a.labelIssues, comments: a.comments, linesByHour: byHour(a.hours), habits: habits(a),
    };
  }).sort((x, y) => (x.name || x.badge).localeCompare(y.name || y.badge));

  const totalOff = teamRows.reduce((k, t) => k + t.offTaskMs, 0);
  return {
    at: iso(at), gapMinutes, schedule: { on: sched.on, breaks: sched.breaks.length },
    teams: teamRows, people: personRows,
    totals: {
      teams: teamRows.length, people: personRows.length, lines: teamRows.reduce((k, t) => k + t.lines, 0),
      offTaskMs: totalOff, scheduledOffMs: teamRows.reduce((k, t) => k + t.scheduledOffMs, 0),
      overrides: teamRows.reduce((k, t) => k + t.overrides, 0), voided: teamRows.reduce((k, t) => k + t.voided, 0),
      cleanTeams: teamRows.filter((t) => t.habits === 'clean').length,
    },
  };
}

const when = (s) => (s ? new Date(s).toLocaleString('en-US', { timeZone: siteTimezone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const span = (ms) => (ms > 0 ? spanWords(ms) : ms === 0 ? '0 min' : '');
export const hoursWords = (list) => (list || []).map((x) => `${String(x.hour).padStart(2, '0')}:00 ${x.lines}`).join(' · ');
export const TEAM_COLUMNS = ['Team', 'Shift', 'People', 'State', 'Started', 'Last activity', 'Time on count', 'Counting time', 'Quiet spells', 'Off-task', 'Off-task %', 'Longest spell', 'In breaks', 'Lines', 'Bins', 'Pallets', 'Empty bins', 'Lines an hour', 'Bins an hour', 'Seconds between scans', 'Lines by hour', 'Overrides', 'Pallets off the list', 'Bins off the list', 'Outside the plan', 'Duplicates', 'Voided', 'Second counts', 'Labels not scanning', 'Comments', 'Stopped-scanning alerts', 'SOS', 'Aisles handed back', 'Habits'];
export const teamRowsOut = (rows) => rows.map((t) => ({
  'Team': t.team, 'Shift': t.shift === '1' ? '1st' : t.shift === '2' ? '2nd' : t.shift, 'People': t.people.map((p) => p.name ? `${p.name} (${p.badge})` : p.badge).join('; '), 'State': t.state,
  'Started': when(t.started), 'Last activity': when(t.lastActive), 'Time on count': span(t.elapsedMs), 'Counting time': span(t.countingMs),
  'Quiet spells': t.spells, 'Off-task': span(t.offTaskMs), 'Off-task %': t.offTaskPct, 'Longest spell': span(t.longestSpellMs), 'In breaks': span(t.scheduledOffMs),
  'Lines': t.lines, 'Bins': t.bins, 'Pallets': t.pallets, 'Empty bins': t.empties, 'Lines an hour': t.linesPerHour ?? '', 'Bins an hour': t.binsPerHour ?? '', 'Seconds between scans': t.secondsBetweenScans ?? '', 'Lines by hour': hoursWords(t.linesByHour),
  'Overrides': t.overrides, 'Pallets off the list': t.unknownPallets, 'Bins off the list': t.unknownBins, 'Outside the plan': t.offPlan, 'Duplicates': t.duplicates, 'Voided': t.voided,
  'Second counts': t.secondCounts, 'Labels not scanning': t.labelIssues, 'Comments': t.comments, 'Stopped-scanning alerts': t.idleAlerts, 'SOS': t.sos, 'Aisles handed back': t.aislesDone, 'Habits': t.habits,
}));
export const PERSON_COLUMNS = ['Clock-in number', 'Name', 'Department', 'Shift', 'Teams', 'Sign-ons', 'Signed on for', 'Counting time', 'Quiet spells', 'Off-task', 'Off-task %', 'Longest spell', 'First scan', 'Last scan', 'Lines', 'Bins', 'Pallets', 'Empty bins', 'Lines an hour', 'Bins an hour', 'Seconds between scans', 'Lines by hour', 'Overrides', 'Pallets off the list', 'Bins off the list', 'Outside the plan', 'Duplicates', 'Voided', 'Second counts', 'Labels not scanning', 'Comments', 'Habits'];
export const personRowsOut = (rows) => rows.map((p) => ({
  'Clock-in number': p.badge, 'Name': p.name, 'Department': p.dept, 'Shift': p.shift === '1' ? '1st' : p.shift === '2' ? '2nd' : p.shift, 'Teams': p.teams.join(', '), 'Sign-ons': p.signons,
  'Signed on for': span(p.signedOnMs), 'Counting time': span(p.countingMs), 'Quiet spells': p.spells, 'Off-task': span(p.offTaskMs), 'Off-task %': p.offTaskPct, 'Longest spell': span(p.longestSpellMs),
  'First scan': when(p.first), 'Last scan': when(p.last), 'Lines': p.lines, 'Bins': p.bins, 'Pallets': p.pallets, 'Empty bins': p.empties, 'Lines an hour': p.linesPerHour ?? '', 'Bins an hour': p.binsPerHour ?? '', 'Seconds between scans': p.secondsBetweenScans ?? '', 'Lines by hour': hoursWords(p.linesByHour),
  'Overrides': p.overrides, 'Pallets off the list': p.unknownPallets, 'Bins off the list': p.unknownBins, 'Outside the plan': p.offPlan, 'Duplicates': p.duplicates, 'Voided': p.voided,
  'Second counts': p.secondCounts, 'Labels not scanning': p.labelIssues, 'Comments': p.comments, 'Habits': p.habits,
}));

/** The two sheets as a workbook, off-task shaded so the eye finds it. */
export function crewWorkbook(sessionId) {
  const d = crewMetrics(sessionId);
  const s = getSession(sessionId);
  const sheetOf = (name, columns, rows, offKey) => {
    const max = Math.max(1, ...rows.map((r) => Number(r[offKey]) || 0));
    return { name, columns: columns.map((c) => ({ header: c, width: /Habits|People|Name/.test(c) ? 36 : /Started|Last|First/.test(c) ? 16 : 11 })), freeze: 1, autofilter: true,
      rows: rows.map((r) => columns.map((c) => (c === offKey || c === 'Off-task' ? { v: r[c], fill: heat(Number(r['Off-task %']) || 0, max) } : r[c]))) };
  };
  const teams = teamRowsOut(d.teams), people = personRowsOut(d.people);
  const buffer = xlsx([sheetOf('Teams', TEAM_COLUMNS, teams, 'Off-task %'), sheetOf('People', PERSON_COLUMNS, people, 'Off-task %')]);
  const name = String((s && s.name) || 'count').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'count';
  return { buffer, filename: `crew-metrics-${name}.xlsx`, teams: d.teams.length, people: d.people.length };
}
