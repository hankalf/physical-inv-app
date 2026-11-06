/*
 * The close-out checklist: what stands between now and done, in one list.
 * Every item is a number with where it comes from and the tab that clears it.
 * The first three hold the final report (a bin with no count, a second or
 * third count still open); the rest are the tidy-up before the count is
 * closed - a team still on an aisle, a bin skipped on the gun, the fix list,
 * adjustments waiting to be approved, approved lines not yet keyed in.
 */
import { db, getSession } from '../db.js';
import { aisleOverview } from './assignments.js';
import { fixList } from './issues.js';
import { summary, approvedAdjustments, adjustmentView, refreshAdjustments } from './adjustments.js';
import { erpEntries, withEntries } from './erp-entries.js';

const plural = (n, one, many = one + 's') => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

export function closeout(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const items = [];
  const few = (list, n = 8) => (list.length > n ? `${list.slice(0, n).join(' · ')} · ${list.length - n} more` : list.join(' · '));

  /* bins with no count, by aisle, the aisle with the most first */
  const aisles = aisleOverview(id);
  const left = aisles.filter((a) => a.bins > a.bins_counted).map((a) => ({ aisle: a.aisle, left: a.bins - a.bins_counted, bins: a.bins })).sort((a, b) => b.left - a.left || a.aisle.localeCompare(b.aisle));
  const binsLeft = left.reduce((t, a) => t + a.left, 0);
  const binsTotal = aisles.reduce((t, a) => t + a.bins, 0);
  items.push({
    key: 'bins', label: 'Bins without a count', n: binsLeft, blocks: true, tab: 'teams',
    detail: !binsTotal ? 'no bin list on this count' : binsLeft ? `by aisle: ${few(left.map((a) => `${a.aisle} ${a.left}`))}` : 'every bin on the list has a count',
    rows: left,
  });

  /* second counts still open, by team; third counts on their own line */
  const rec = db.prepare("SELECT COALESCE(team, '') AS team, COALESCE(round, 2) AS round, COUNT(*) AS n FROM recounts WHERE session_id = ? AND status != 'done' GROUP BY COALESCE(team, ''), COALESCE(round, 2)").all(id);
  const second = rec.filter((r) => Number(r.round) !== 3);
  const third = rec.filter((r) => Number(r.round) === 3);
  const byTeam = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.team, (m.get(r.team) || 0) + r.n);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([team, n]) => ({ team, n }));
  };
  const secondTeams = byTeam(second);
  const secondOpen = second.reduce((t, r) => t + r.n, 0);
  items.push({
    key: 'second', label: 'Second counts open', n: secondOpen, blocks: true, tab: 'second',
    detail: secondOpen ? `by team: ${few(secondTeams.map((t) => `${t.team ? 'team ' + t.team : 'no team yet'} ${t.n}`))}` : 'none open',
    rows: secondTeams,
  });
  const thirdTeams = byTeam(third);
  const thirdOpen = third.reduce((t, r) => t + r.n, 0);
  items.push({
    key: 'third', label: 'Third counts waiting', n: thirdOpen, blocks: true, tab: 'second',
    detail: thirdOpen ? `by team: ${few(thirdTeams.map((t) => `${t.team ? 'team ' + t.team : 'no team yet'} ${t.n}`))}` : 'none waiting',
    rows: thirdTeams,
  });

  /* aisles a team still holds: not handed back, or handed back a level at a time and not every level yet */
  const active = db.prepare("SELECT team, aisle, levels, levels_done FROM assignments WHERE session_id = ? AND status = 'active' ORDER BY aisle, team").all(id);
  items.push({
    key: 'aisles', label: 'Aisles not handed back', n: active.length, blocks: false, tab: 'teams',
    detail: active.length
      ? few(active.map((a) => `${a.aisle} team ${a.team}${a.levels ? ` (${a.levels}${a.levels_done ? ` · ${a.levels_done} done` : ''})` : ''}`))
      : 'no team is on an aisle',
    rows: active,
  });

  /* bins skipped on the gun and not counted since */
  const skipped = db.prepare(`SELECT i.bin, i.aisle, i.team, i.reason FROM issues i
     WHERE i.session_id = ? AND i.status = 'open' AND i.reason LIKE 'Skipped on the gun%' AND i.bin IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM counts c WHERE c.session_id = i.session_id AND c.location_code = i.bin AND c.voided = 0)
     ORDER BY i.bin`).all(id);
  items.push({
    key: 'skipped', label: 'Bins skipped on the gun', n: skipped.length, blocks: false, tab: 'reports',
    detail: skipped.length ? few(skipped.map((b) => `${b.bin} (${String(b.reason).replace(/^Skipped on the gun:\s*/, '')})`)) : 'none still skipped',
    rows: skipped,
  });

  /* the fix list */
  const fix = fixList(id).summary;
  items.push({
    key: 'fixlist', label: 'Fix list open', n: fix.open, blocks: false, tab: 'reports',
    detail: fix.open
      ? [fix.damage && `${fix.damage} damage`, fix.blocked && `${fix.blocked} blocked`, fix.labels && `${plural(fix.labels, 'label')} to replace`, fix.other && `${fix.other} other`].filter(Boolean).join(' · ')
      : 'nothing open',
    rows: [],
  });

  /* adjustments waiting to be approved, when the count asks for approvals */
  const approvals = !!s.require_approval;
  if (approvals) refreshAdjustments(id); // the rows come from the count lines as they stand
  const adj = approvals ? summary(id) : null;
  items.push({
    key: 'approve', label: 'Adjustments to approve', n: adj ? adj.pending : 0, blocks: false, tab: 'adjust',
    detail: !approvals ? 'approvals are off on this count' : adj.pending ? `${plural(adj.pending, 'line')} waiting · ${adj.approved + adj.auto} approved · ${adj.rejected} rejected` : `all decided · ${adj.approved + adj.auto} approved`,
    rows: [],
  });

  /* approved lines not yet keyed into the ERP (every line, with approvals off) */
  const keyed = erpEntries(id);
  let notKeyed = 0;
  let toKey = 0;
  if (approvals) {
    for (const p of approvedAdjustments(id).keys()) { toKey++; if (!keyed.has(p)) notKeyed++; }
  } else {
    const v = withEntries(adjustmentView(id), id).erp;
    toKey = v.total; notKeyed = v.total - v.entered;
  }
  items.push({
    key: 'erp', label: 'Lines not keyed into the ERP', n: notKeyed, blocks: false, tab: 'adjust',
    detail: toKey ? (notKeyed ? `${notKeyed.toLocaleString()} of ${toKey.toLocaleString()} ${approvals ? 'approved ' : ''}lines still to key` : `all ${toKey.toLocaleString()} keyed`) : 'no adjustment lines',
    rows: [],
  });

  const blocking = items.filter((i) => i.blocks && i.n > 0);
  const open = items.filter((i) => i.n > 0);
  return {
    session: { id, name: s.name, status: s.status, closed: s.status === 'closed' },
    items,
    blocking: blocking.length,
    open: open.length,
    ready: binsTotal > 0 && blocking.length === 0,
    clean: binsTotal > 0 && open.length === 0,
    binsTotal,
  };
}
