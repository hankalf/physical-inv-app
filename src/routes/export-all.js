import { db, getSession } from '../db.js';
import { progress, palletReport, rawCounts, sourcesOf } from './reports.js';
import { adjustmentView } from './adjustments.js';
import { teamClocks } from './idle.js';
import { fixList } from './issues.js';
import { siteTimezone } from '../util/localtime.js';

/*
 * Everything about one count, in a form a person can read.
 *
 * The CSV exports are built for machines - the ERP, a reconciliation script -
 * so they speak in column names like unknown_pallet and 0/1. This is the other
 * one: every table the app keeps for a count, one sheet each, with headings in
 * plain words, Yes and No, and times on the warehouse's clock. It is what goes
 * to an auditor, a manager, or the shared drive when the count is done.
 *
 * The server sends the sheets as data and the browser writes the workbook
 * (SheetJS ships with the app), so nothing is installed on the server.
 */

const TZ = siteTimezone();
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
/** "2026-10-04 14:32", on the site's clock. */
export function when(iso) {
  if (!iso) return '';
  // a date with no time (an ERP's "last counted") is a day, not midnight in London
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
const yes = (v) => (v ? 'Yes' : 'No');
const mins = (a, b) => {
  if (!a) return '';
  const m = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};
const STATUS = {
  'MATCH': 'Matches', 'QTY VARIANCE': 'Quantity differs', 'WRONG BIN': 'In a different bin', 'MISSING': 'Not found',
  'NOT IN MASTER': 'Not on the report', 'COUNTED TWICE': 'Counted twice', 'SECOND LABEL': 'Second label on a pallet',
  'NOT COUNTED': 'Not counted yet',
};
const LABEL = { typed: 'Unreadable — typed in', none: 'Nothing readable', assumed: 'Unreadable — bin confirmed by the counter' };

/** One sheet: a name, its columns in order, and rows keyed by those columns. */
const sheet = (name, columns, rows) => ({ name, columns, rows });

export function exportEverything(sessionId, { by = '' } = {}) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const p = progress(id);
  const adj = adjustmentView(id);
  const counts = rawCounts(id);
  const pallets = palletReport(id);
  const clocks = teamClocks(id);

  const summary = sheet('Summary', ['What', 'Value'], [
    ['Count', s.name],
    ['Type', (s.mode || 'full') === 'cycle' ? 'Cycle count' : 'Full (wall-to-wall) count'],
    ['Status', s.status === 'closed' ? 'Closed' : 'Open'],
    ['Trial run', yes(s.trial)],
    ['Created', when(s.created_at)],
    ['Closed', when(s.closed_at)],
    ['Bins on the list', p.bins_total],
    ['Bins counted', p.bins_counted],
    ['Bins still to count', Math.max(0, p.bins_total - p.bins_counted)],
    ['Percent of bins counted', p.bins_total ? `${Math.round((p.bins_counted / p.bins_total) * 1000) / 10}%` : '—'],
    ['Pallets on the report', p.pallets_total],
    ['Systems on the report', sourcesOf(id).map((x) => `${x.source || 'no system named'}: ${x.counted} of ${x.pallets} found`).join(' · ') || '—'],
    ['Pallets counted', p.pallets_counted],
    ['Pallets found that are not on the report', p.pallets_unknown],
    ['Bins recorded empty', p.empty_bins || 0],
    ['Count lines', p.lines],
    ['Flagged lines', p.exceptions],
    ['Teams', p.teams],
    ['Scanners', p.devices],
    ['Positive adjustments (pallets / units)', `${adj.positive.pallets} / +${adj.positive.units}`],
    ['Negative adjustments (pallets / units)', `${adj.negative.pallets} / ${adj.negative.units}`],
    ['Net adjustment (units)', adj.net],
    ['Times are shown in', TZ],
    ['Exported', when(new Date().toISOString())],
    ['Exported by', by || ''],
  ].map(([w, v]) => ({ What: w, Value: v ?? '' })));

  const lines = sheet('Count lines', [
    'Line', 'Scanned', 'Team', 'Clock-in numbers', 'Scanner', 'Aisle', 'Bin', 'Pallet', 'System', 'Quantity', 'Empty bin',
    'Item', 'Description', 'Lot', 'Best before', 'Second count', 'Pallet not on report', 'Bin not on list',
    'Outside the team\'s aisle', 'Pallet counted twice', 'Pallet label', 'Rack label', 'Second label of',
    'Flag / reason', 'Comments', 'Voided', 'Reached the server',
  ], counts.map((c) => ({
    'Line': c.id, 'Scanned': when(c.scanned_at), 'Team': c.team, 'Clock-in numbers': c.employees, 'Scanner': c.device_id,
    'Aisle': c.aisle || '', 'Bin': c.location_code, 'Pallet': c.empty_bin ? '' : c.pallet_id, 'System': c.source || '', 'Quantity': c.qty,
    'Empty bin': yes(c.empty_bin), 'Item': c.sku || '', 'Description': c.description || '', 'Lot': c.lot || '',
    'Best before': c.expiry || '', 'Second count': yes(c.pass === 2), 'Pallet not on report': yes(c.unknown_pallet),
    'Bin not on list': yes(c.unknown_location), 'Outside the team\'s aisle': yes(c.off_assignment),
    'Pallet counted twice': yes(c.duplicate_pallet), 'Pallet label': LABEL[c.label_issue] || 'OK',
    'Rack label': LABEL[c.bin_label_issue] || 'OK', 'Second label of': c.alias_of || '',
    'Flag / reason': c.override_reason || '', 'Comments': c.comments || '', 'Voided': yes(c.voided),
    'Reached the server': when(c.received_at),
  })));

  const report = sheet('Pallets', [
    'Pallet', 'System', 'Item', 'Description', 'Variant', 'Entry No.', 'Result', 'Report quantity', 'Counted quantity', 'Difference', 'Report bin',
    'Found in', 'Times counted', 'Teams', 'Report lot', 'Counted lot', 'Best before', 'Second label', 'Last scanned', 'Comments',
  ], pallets.map((r) => ({
    'Pallet': r.pallet_id, 'System': r.source || '', 'Item': r.sku || '', 'Description': r.description || '', 'Variant': r.variant || '', 'Entry No.': r.entry_no || '', 'Result': STATUS[r.status] || r.status,
    'Report quantity': r.expected_qty, 'Counted quantity': r.counted_qty, 'Difference': r.variance_qty,
    'Report bin': r.expected_location || '', 'Found in': r.found_location || '', 'Times counted': r.times_counted || 0,
    'Teams': r.teams || '', 'Report lot': r.expected_lot || '', 'Counted lot': r.found_lot || '', 'Best before': r.expiry || '',
    'Second label': r.also_tagged || r.alias_of || '', 'Last scanned': when(r.last_scan), 'Comments': r.comments || '',
  })));

  const adjCols = ['Side', 'Pallet', 'System', 'Item', 'Bin', 'Why', 'Report quantity', 'Counted quantity', 'Adjustment', 'Approval', 'Approval reason', 'Approved by'];
  const adjRow = (side) => (r) => ({
    'Side': side, 'Pallet': r.pallet_id, 'System': r.source || '', 'Item': r.sku || '', 'Bin': r.location || '', 'Why': r.why,
    'Report quantity': r.expected_qty ?? '', 'Counted quantity': r.counted_qty, 'Adjustment': r.variance_qty,
    'Approval': adj.approvals ? (r.status || 'waiting') : 'not required', 'Approval reason': r.reason || '', 'Approved by': r.decided_by || '',
  });
  const adjustments = sheet('Adjustments', adjCols,
    [...adj.positive.rows.map(adjRow('Positive')), ...adj.negative.rows.map(adjRow('Negative'))]);

  const binRows = db.prepare(
    `SELECT l.code, l.zone, l.aisle, l.level, l.description, l.last_counted,
            (SELECT COUNT(*) FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) AS lines,
            (SELECT MAX(c.empty_bin) FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) AS empty
       FROM locations l WHERE l.session_id = ? ORDER BY l.code`).all(id);
  const bins = sheet('Bins', ['Bin', 'Zone', 'Aisle', 'Level', 'Description', 'Counted', 'Recorded empty', 'Lines', 'Last counted'],
    binRows.map((b) => ({
      'Bin': b.code, 'Zone': b.zone || '', 'Aisle': b.aisle || '', 'Level': b.level || '', 'Description': b.description || '',
      'Counted': yes(b.lines > 0), 'Recorded empty': yes(b.empty), 'Lines': b.lines, 'Last counted': when(b.last_counted),
    })));
  const notCounted = sheet('Bins not counted', ['Bin', 'Zone', 'Aisle', 'Level', 'Description'],
    binRows.filter((b) => !b.lines).map((b) => ({ 'Bin': b.code, 'Zone': b.zone || '', 'Aisle': b.aisle || '', 'Level': b.level || '', 'Description': b.description || '' })));

  const teams = sheet('Teams', ['Team', 'Shift', 'Started', 'Last activity', 'Time on count', 'Lines', 'State'],
    clocks.map((c) => ({
      'Team': c.team, 'Shift': c.shift === '1' ? '1st' : c.shift === '2' ? '2nd' : '', 'Started': when(c.started),
      'Last activity': when(c.lastActive), 'Time on count': mins(c.started, c.endedAt || null), 'Lines': c.lines, 'State': c.state,
    })));

  const signons = sheet('Sign-ons', ['Signed on', 'Team', 'Scanner', 'Clock-in numbers', 'Signed off'],
    db.prepare('SELECT * FROM signons WHERE session_id = ? ORDER BY id').all(id).map((r) => ({
      'Signed on': when(r.started_at), 'Team': r.team, 'Scanner': r.device_id,
      'Clock-in numbers': (() => { try { return JSON.parse(r.employees || '[]').join('; '); } catch { return ''; } })(),
      'Signed off': when(r.ended_at),
    })));

  const sos = sheet('SOS', ['Raised', 'Team', 'Scanner', 'On the gun', 'What', 'Note', 'Aisle', 'Last bin', 'State', 'Seen by', 'Seen', 'Closed by', 'Closed', 'Outcome', 'Teams channel'],
    db.prepare('SELECT * FROM alerts WHERE session_id = ? ORDER BY id').all(id).map((a) => ({
      'Raised': when(a.created_at), 'Team': a.team || '', 'Scanner': a.device_id || '', 'On the gun': a.employees || '',
      'What': a.reason, 'Note': a.detail || '', 'Aisle': a.aisle || '', 'Last bin': a.bin || '',
      'State': a.status === 'closed' ? 'Closed' : a.status === 'seen' ? 'Somebody is on it' : 'Open',
      'Seen by': a.seen_by || '', 'Seen': when(a.seen_at), 'Closed by': a.closed_by || '', 'Closed': when(a.closed_at),
      'Outcome': a.outcome || '', 'Teams channel': a.sent_to || '',
    })));

  const quiet = sheet('Stopped scanning', ['Team', 'Last activity', 'Alert raised', 'Cleared', 'Why', 'By', 'Teams channel'],
    db.prepare('SELECT * FROM idle_alerts WHERE session_id = ? ORDER BY id').all(id).map((a) => ({
      'Team': a.team, 'Last activity': when(a.last_scan), 'Alert raised': when(a.raised_at), 'Cleared': when(a.cleared_at),
      'Why': a.why || (a.cleared_at ? '' : 'still open'), 'By': a.cleared_by || '', 'Teams channel': a.sent_to || '',
    })));

  const second = sheet('Second counts', ['Bin', 'Pallet', 'Why', 'Raised by', 'First counted by', 'Team', 'State', 'Raised', 'Done', 'Done by'],
    db.prepare('SELECT * FROM recounts WHERE session_id = ? ORDER BY id').all(id).map((r) => ({
      'Bin': r.bin, 'Pallet': r.pallet_id || '', 'Why': STATUS[r.reason] || (r.reason === 'CYCLE' ? 'Cycle count' : r.reason === 'MANUAL' ? 'Asked for by a supervisor' : r.reason),
      'Raised by': r.source === 'auto' ? 'the app' : r.source === 'cycle' ? 'cycle programme' : 'a supervisor',
      'First counted by': r.first_team || '', 'Team': r.team || '', 'State': r.status === 'done' ? 'Done' : r.status === 'taken' ? 'Being counted' : 'Open',
      'Raised': when(r.created_at), 'Done': when(r.done_at), 'Done by': r.done_by_team || '',
    })));

  const KIND = { label: 'Label to replace', damage: 'Damage', blocked: 'Blocked bin', other: 'Other' };
  const fixes = sheet('Fix list', ['Kind', 'What', 'Bin', 'Aisle', 'Pallet', 'Problem', 'Note', 'Reported by team', 'Reported', 'Status', 'Fixed by', 'Fixed', 'Outcome'],
    fixList(id).rows.map((r) => ({
      'Kind': KIND[r.kind] || r.kind, 'What': r.target ? r.target[0].toUpperCase() + r.target.slice(1) : '', 'Bin': r.bin || '', 'Aisle': r.aisle || '',
      'Pallet': r.pallet_id || '', 'Problem': r.reason, 'Note': r.note || '', 'Reported by team': r.team || '', 'Reported': when(r.created_at),
      'Status': r.status === 'fixed' ? 'Fixed' : 'Open', 'Fixed by': r.fixed_by || '', 'Fixed': when(r.fixed_at), 'Outcome': r.outcome || '',
    })));

  const log = sheet('Log', ['When', 'Who', 'What', 'Detail'],
    db.prepare('SELECT * FROM audit WHERE session_id = ? ORDER BY id').all(id).map((a) => ({
      'When': when(a.at), 'Who': a.actor, 'What': a.action, 'Detail': a.detail || '',
    })));

  return {
    filename: `${String(s.name).replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'count'}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheets: [summary, lines, report, adjustments, bins, notCounted, teams, signons, sos, quiet, second, fixes, log],
  };
}
