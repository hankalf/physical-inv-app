import { db, norm } from '../db.js';
import { listTeams } from './people.js';
import { queueAssignments, autoActivate } from './assignments.js';
import { normLevels, levelsLabel } from '../util/bincode.js';

/*
 * A staggered plan for the whole count, in one go.
 *
 * Handing out aisles by hand works for four teams and goes wrong at twelve:
 * somebody gets two teams started back to back in the same racking, somebody
 * else gets an on-foot crew sent up to level E. This does what a good
 * supervisor does with the floor plan and a pencil:
 *
 *   - the aisles are walked in order and split into one continuous stretch per
 *     team, each stretch about the same amount of racking, so the teams start
 *     spread across the building and never bunch up;
 *   - a team gets only the levels its equipment reaches (Teams & crew), and the
 *     levels it cannot reach are handed to the nearest team that can, after its
 *     own stretch;
 *   - the racking blocks (Settings) still decide who may actually be in a block
 *     at once - the plan only sets the order, the server releases each aisle.
 *
 * Preview first: the plan comes back as a list a person can read, with what it
 * could not place and why.
 */

const sortAisles = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const sortLevels = (s) => [...new Set(Array.isArray(s) ? s : String(s || ''))].sort().join('');
const inter = (a, b) => sortLevels([...a].filter((c) => b.includes(c)));
const minus = (a, b) => sortLevels([...a].filter((c) => !b.includes(c)));

export function autoPlan(sessionId, opts = {}) {
  const id = Number(sessionId);
  const wantLevels = normLevels(opts.levels || '');
  const shift = ['1', '2'].includes(String(opts.shift || '')) ? String(opts.shift) : '';
  const desc = opts.order === 'desc';

  /* the teams: named, or every team on Teams & crew (on one shift, if asked) */
  const roster = listTeams();
  let names = String(opts.teams || '').split(/[,\s;]+/).map(norm).filter(Boolean);
  if (!names.length) names = roster.filter((t) => !shift || t.shift === shift).map((t) => t.name);
  names = [...new Set(names)].sort(sortAisles);
  if (!names.length) throw Object.assign(new Error(shift ? `no ${shift === '1' ? '1st' : '2nd'}-shift teams on Teams & crew - set each team's shift there, or type the teams here` : 'no teams: type them, or add them on Teams & crew'), { status: 400 });
  const teams = names.map((name) => {
    const t = roster.find((x) => x.name === name);
    // a team not on the roster, or with nobody on it, is not second-guessed
    const reach = t && t.members.length ? sortLevels(t.reach) : '';
    return { team: name, shift: t ? t.shift : '', reach, known: !!(t && t.members.length), aisles: [], bins: 0 };
  });

  /* the aisles, in walking order, with the levels that exist in each */
  const rows = db.prepare(
    `SELECT a.aisle, a.block,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(l.level, '')) FROM locations l WHERE l.session_id = a.session_id AND l.aisle = a.aisle) AS levels,
            (SELECT COUNT(*) FROM locations l WHERE l.session_id = a.session_id AND l.aisle = a.aisle) AS bins,
            (SELECT COUNT(*) FROM assignments s WHERE s.session_id = a.session_id AND s.aisle = a.aisle AND s.status != 'queued') AS busy,
            (SELECT COUNT(*) FROM assignments s WHERE s.session_id = a.session_id AND s.aisle = a.aisle AND s.status = 'queued') AS queued
       FROM aisles a WHERE a.session_id = ?`).all(id);
  const skipped = [];
  let aisles = rows.map((r) => ({
    aisle: r.aisle, block: r.block, bins: r.bins,
    levels: sortLevels(String(r.levels || '').replace(/,/g, '')),
    busy: r.busy > 0, queued: r.queued > 0,
  })).sort((a, b) => sortAisles(a.aisle, b.aisle));
  if (desc) aisles.reverse();
  aisles = aisles.filter((a) => {
    if (!a.bins) { skipped.push({ aisle: a.aisle, why: 'no bins' }); return false; }
    if (a.busy) { skipped.push({ aisle: a.aisle, why: 'already being counted, or done' }); return false; }
    if (a.queued && !opts.replace) { skipped.push({ aisle: a.aisle, why: 'already queued - tick Replace to re-plan it' }); return false; }
    return true;
  });
  for (const a of aisles) {
    a.levels = a.levels || 'A';                        // a list with no level letters is one level
    a.want = wantLevels ? inter(a.levels, wantLevels) : a.levels;
  }
  aisles = aisles.filter((a) => a.want);
  if (!aisles.length) {
    const why = skipped.some((s) => /queued/.test(s.why)) ? 'the aisles are already queued - tick Replace what is queued to plan them again'
      : skipped.length ? 'every aisle is already being counted, or done' : 'no aisle has bins on those levels';
    throw Object.assign(new Error(`nothing to plan: ${why}`), { status: 400 });
  }

  /* one continuous stretch per team, about the same racking each */
  const total = aisles.reduce((n, a) => n + a.bins, 0);
  const per = total / teams.length;
  let acc = 0;
  let k = 0;
  const leftover = [];                                  // levels a team cannot reach in its own stretch
  for (let i = 0; i < aisles.length; i++) {
    const a = aisles[i];
    // move to the next team once this one has its share - but never leave a team with nothing
    while (k < teams.length - 1 && acc >= per * (k + 1) && aisles.length - i >= teams.length - k) k++;
    const t = teams[k];
    const mine = t.reach ? inter(a.want, t.reach) : a.want;
    if (mine) { t.aisles.push({ aisle: a.aisle, levels: mine, bins: a.bins, block: a.block }); t.bins += a.bins; }
    const rest = minus(a.want, mine);
    if (rest) leftover.push({ aisle: a.aisle, levels: rest, bins: a.bins, block: a.block, from: t.team });
    acc += a.bins;
  }

  /* what a team could not reach goes to whoever can, least loaded first */
  const unassigned = [];
  for (const l of leftover) {
    let left = l.levels;
    const able = teams.filter((t) => !t.reach || inter(left, t.reach)).sort((x, y) => x.bins - y.bins);
    for (const t of able) {
      const take = t.reach ? inter(left, t.reach) : left;
      if (!take) continue;
      t.aisles.push({ aisle: l.aisle, levels: take, bins: l.bins, block: l.block, extra: true });
      t.bins += l.bins;
      left = minus(left, take);
      if (!left) break;
    }
    if (left) unassigned.push({ aisle: l.aisle, levels: left, why: `nobody in this plan has the equipment for ${levelsLabel(left)}` });
  }

  /* the plan, readable, and anything a supervisor should know */
  const warnings = [];
  const starts = new Map();
  for (const t of teams) {
    if (!t.aisles.length) { warnings.push(`Team ${t.team} gets nothing - ${t.known && !t.reach ? 'its crew has no equipment for any level' : 'there are more teams than aisles'}.`); continue; }
    const b = t.aisles[0].block;
    if (starts.has(b)) warnings.push(`Teams ${starts.get(b)} and ${t.team} both start in racking block ${b}; the second waits until the first is clear.`);
    else starts.set(b, t.team);
  }
  return {
    teams: teams.map((t) => ({
      team: t.team, shift: t.shift, reach: t.reach, known: t.known, bins: t.bins,
      aisles: t.aisles.map((a) => ({ aisle: a.aisle, levels: a.levels, bins: a.bins, extra: !!a.extra })),
      text: t.aisles.map((a) => `${a.aisle} (${levelsLabel(a.levels)})${a.extra ? '*' : ''}`).join(' → '),
    })),
    unassigned, skipped, warnings,
    rules: planRules(id, roster),
  };
}

/** What the plan is working from - so a thin plan is explained, not a mystery. */
export function planRules(sessionId, roster = listTeams()) {
  const id = Number(sessionId);
  const aisles = db.prepare('SELECT aisle, block FROM aisles WHERE session_id = ?').all(id);
  const paired = aisles.filter((a) => aisles.some((b) => b.block === a.block && b.aisle !== a.aisle)).length;
  const levels = sortLevels(db.prepare("SELECT GROUP_CONCAT(DISTINCT COALESCE(level, '')) AS l FROM locations WHERE session_id = ?").get(id)?.l?.replace(/,/g, '') || '');
  return {
    aisles: aisles.length, paired,
    levels,
    teams: roster.length,
    teamsWithCrew: roster.filter((t) => t.members.length).length,
    teamsWithShift: roster.filter((t) => t.shift).length,
  };
}

/** Put the plan into the queue. Replace drops what was queued (never what is active or done). */
export function applyPlan(sessionId, opts = {}) {
  const id = Number(sessionId);
  const plan = autoPlan(id, opts);
  if (opts.replace) db.prepare("DELETE FROM assignments WHERE session_id = ? AND status = 'queued'").run(id);
  let queued = 0;
  const activated = [];
  for (const t of plan.teams) {
    for (const a of t.aisles) {
      // queueing releases a team's first free aisle on the spot; keep the list of who started
      const r = queueAssignments(id, t.team, [a.aisle], a.levels, { force: true });
      queued += r.added.length;
      activated.push(...r.activated);
    }
  }
  activated.push(...autoActivate(id));
  return { ...plan, queued, activated };
}
