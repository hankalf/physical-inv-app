import { db, norm, getSession } from '../db.js';
import { REASONS, secondCountVerdict } from './recounts.js';

/*
 * Second and third counts, side by side with the first.
 *
 * Every bin that was sent back for another count, one row per pallet that
 * any of its counts or the report puts there: what the report said, what the
 * first, second and third counts found, which team did each, and which number
 * stands. The final figure is the latest count of the bin - a second count
 * stands over the first, a third over both - and the reason it stands is
 * spelled out, so nobody has to work out from three columns what happened.
 */

const ROUND = { 1: '1st', 2: '2nd', 3: '3rd' };

export function recountSideBySide(sessionId, { aisle = '' } = {}) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const onlyAisle = norm(aisle);
  const tasks = db.prepare("SELECT * FROM recounts WHERE session_id = ? AND reason != 'CYCLE' ORDER BY id").all(id);
  const aisleOf = new Map(db.prepare('SELECT code, aisle FROM locations WHERE session_id = ?').all(id).map((l) => [l.code, l.aisle]));
  const byBin = new Map();
  for (const t of tasks) {
    const a = aisleOf.get(t.bin) || '';
    if (onlyAisle && a !== onlyAisle) continue;
    if (!byBin.has(t.bin)) byBin.set(t.bin, []);
    byBin.get(t.bin).push(t);
  }
  const linesOf = db.prepare('SELECT pallet_id, qty, pass, team, empty_bin FROM counts WHERE session_id = ? AND location_code = ? AND voided = 0 AND pass IN (1, 2, 3)');
  const expectedIn = db.prepare('SELECT pallet_id, expected_qty FROM pallets WHERE session_id = ? AND expected_location = ?');
  const palletOf = db.prepare('SELECT pallet_id, sku, description, expected_qty, expected_location FROM pallets WHERE session_id = ? AND pallet_id = ?');

  const rows = [];
  const tally = { bins: 0, third: 0, open: 0, byFirst: 0, byReport: 0, byThird: 0, unsettled: 0 };
  const bins = [...byBin.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const bin of bins) {
    const ts = byBin.get(bin);
    tally.bins++;
    const hasThird = ts.some((t) => Number(t.round) === 3);
    if (hasThird) tally.third++;
    const openNow = ts.some((t) => t.status !== 'done');
    if (openNow) tally.open++;
    const lines = linesOf.all(id, bin);
    const done = new Set(lines.map((l) => l.pass));                 // the counts this bin has had
    const latest = Math.max(0, ...done);
    const qty = { 1: new Map(), 2: new Map(), 3: new Map() };
    const teams = { 1: new Set(), 2: new Set(), 3: new Set() };
    for (const l of lines) {
      teams[l.pass].add(l.team);
      if (l.empty_bin) continue;
      qty[l.pass].set(l.pallet_id, (qty[l.pass].get(l.pallet_id) || 0) + Number(l.qty || 0));
    }
    const report = new Map(expectedIn.all(id, bin).map((p) => [p.pallet_id, Number(p.expected_qty || 0)]));
    const pallets = new Set([...report.keys(), ...qty[1].keys(), ...qty[2].keys(), ...qty[3].keys()]);
    const v = secondCountVerdict(id, bin);
    let settled;
    if (done.has(3)) { settled = 'The third count stands'; tally.byThird++; }
    else if (!done.has(2)) settled = openNow ? 'Waiting for the second count' : 'Not second-counted';
    else if (v.settled && /first/.test(v.why)) { settled = 'The second count agrees with the first'; tally.byFirst++; }
    else if (v.settled) { settled = 'The second count agrees with the report'; tally.byReport++; }
    else { settled = hasThird ? 'Waiting for the third count' : 'The second count agrees with neither'; tally.unsettled++; }
    const why = [...new Set(ts.map((t) => (Number(t.round) === 3 ? 'Third count: ' : '') + (REASONS[t.reason] || t.reason)))].join('; ');
    const state = openNow ? (ts.some((t) => t.status === 'taken') ? 'Being counted' : 'Open') : 'Done';
    const cell = (pass, p) => (done.has(pass) ? (qty[pass].get(p) ?? 0) : '');
    const list = [...pallets].sort();
    if (!list.length) list.push('');                                // an empty bin, counted empty every time
    for (const p of list) {
      const info = p ? palletOf.get(id, p) : null;
      const final = latest ? (p ? (qty[latest].get(p) ?? 0) : 0) : '';
      const want = report.has(p) ? report.get(p) : '';
      rows.push({
        'Aisle': aisleOf.get(bin) || '', 'Bin': bin, 'Pallet': p || '(empty)', 'Item': (info && info.sku) || '', 'Description': (info && info.description) || '',
        'Why it was counted again': why,
        'Report bin': (info && info.expected_location) || '', 'Report quantity': want,
        '1st count': cell(1, p), '1st count team': [...teams[1]].join(', '),
        '2nd count': cell(2, p), '2nd count team': [...teams[2]].join(', '),
        '3rd count': cell(3, p), '3rd count team': [...teams[3]].join(', '),
        'Final count': final, 'Final count is the': latest ? `${ROUND[latest]} count` : '',
        'Final vs report': final === '' ? '' : Number(final) - Number(want || 0),
        'Which number stands': settled, 'State': state,
      });
    }
  }
  const columns = ['Aisle', 'Bin', 'Pallet', 'Item', 'Description', 'Why it was counted again', 'Report bin', 'Report quantity',
    '1st count', '1st count team', '2nd count', '2nd count team', '3rd count', '3rd count team',
    'Final count', 'Final count is the', 'Final vs report', 'Which number stands', 'State'];
  const summary = [
    ['Count', s.name], ['Aisle', onlyAisle || 'every aisle'],
    ['Bins counted again', tally.bins], ['…of them given a third count', tally.third], ['…still being counted', tally.open],
    ['Second count agreed with the first (the difference is real)', tally.byFirst],
    ['Second count agreed with the report (the first count was wrong)', tally.byReport],
    ['Settled by a third count', tally.byThird], ['Second count agreed with neither, no third count yet', tally.unsettled],
    ['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')],
  ].map(([What, Value]) => ({ What, Value }));
  const safe = String(s.name).replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'count';
  return {
    filename: `${safe}-second-and-third-counts${onlyAisle ? '-' + onlyAisle : ''}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    rows, columns, tally,
    sheets: [{ name: 'Summary', columns: ['What', 'Value'], rows: summary }, { name: 'Side by side', columns, rows }],
  };
}
