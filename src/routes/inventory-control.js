/*
 * Inventory Control: the dashboard's second counts, adjustments and reports
 * under a tab of their own, for the people who turn a count into stock. The
 * tabs are the dashboard's own; this is the one thing the page adds - where a
 * count stands for inventory control, in one read: how much is counted, what
 * is still being counted again, what the count adds and takes off, how much
 * of it is in the ERP, and whether the final report can be filed. With cycle
 * counts on, the cycle counts still open are listed beside it; with Not in
 * Location on, how many pallets are still being looked for.
 */
import { db, getSession } from '../db.js';
import { adjustmentView, summary } from './adjustments.js';
import { withEntries } from './erp-entries.js';
import { erpAisles } from './erp-aisles.js';
import { missingSummary } from './missing.js';

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export function inventoryOverview(sessionId, { cycleOn = true, missingOn = true } = {}) {
  const id = Number(sessionId);
  const session = getSession(id);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  const bins = db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(id).n;
  const binsCounted = db.prepare('SELECT COUNT(DISTINCT location_code) n FROM counts WHERE session_id = ? AND voided = 0').get(id).n;

  const rec = { open: 0, taken: 0, done: 0, thirdOpen: 0, total: 0 };
  for (const r of db.prepare('SELECT status, COALESCE(round, 2) AS round, COUNT(*) n FROM recounts WHERE session_id = ? GROUP BY status, COALESCE(round, 2)').all(id)) {
    if (rec[r.status] !== undefined) rec[r.status] += r.n;
    if (r.status !== 'done' && Number(r.round) === 3) rec.thirdOpen += r.n;
    rec.total += r.n;
  }

  const view = withEntries(adjustmentView(id), id);
  const signed = session.require_approval ? summary(id) : null;
  const aisles = erpAisles(id);

  const cycles = !cycleOn ? null : db.prepare(`
    SELECT s.id, s.name,
           (SELECT COUNT(*) FROM locations l WHERE l.session_id = s.id) AS bins,
           (SELECT COUNT(DISTINCT c.location_code) FROM counts c WHERE c.session_id = s.id AND c.voided = 0) AS bins_counted,
           (SELECT COUNT(*) FROM recounts r WHERE r.session_id = s.id AND r.status != 'done') AS recounts_open
      FROM sessions s WHERE s.mode = 'cycle' AND s.status = 'open' AND s.practice = 0 ORDER BY s.id DESC LIMIT 12`).all();

  const recountsOpen = rec.open + rec.taken;
  return {
    session: { id, name: session.name, mode: session.mode === 'cycle' ? 'cycle' : 'full', status: session.status, bins, binsCounted },
    recounts: { ...rec, stillOpen: recountsOpen },
    adjustments: {
      approvals: !!session.require_approval,
      positive: { pallets: view.positive.pallets, units: round2(view.positive.units), value: view.positive.value },
      negative: { pallets: view.negative.pallets, units: round2(view.negative.units), value: view.negative.value },
      net: round2(view.net),
      netValue: view.netValue,
      pending: signed ? signed.pending : 0, approved: signed ? signed.approved + signed.auto : 0, rejected: signed ? signed.rejected : 0,
    },
    erp: {
      lines: view.erp.total, entered: view.erp.entered, changed: view.erp.changed, left: view.erp.total - view.erp.entered,
      aisles: aisles.length, aislesAll: aisles.filter((a) => a.state === 'all').length, aislesSome: aisles.filter((a) => a.state === 'some').length,
    },
    final: { ready: recountsOpen === 0 && session.status !== 'closed', closed: session.status === 'closed', blockedBy: recountsOpen },
    cycles,
    missing: missingOn ? missingSummary() : null,
  };
}
