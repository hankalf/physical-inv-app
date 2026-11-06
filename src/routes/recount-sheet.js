import { db, norm, getSession } from '../db.js';
import { REASONS, secondCountVerdict, listRecounts } from './recounts.js';
import { xlsx, heat } from '../util/xlsx.js';

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

/*
 * The second counts by aisle, as a workbook with colour.
 *
 *   By aisle    one row an aisle: how many second counts, open, started, done,
 *               by reason, the teams that hold them - the Open column shaded
 *               by how many, so the hot aisles stand out
 *   Heat map    a grid, aisles down and levels across, open second counts in
 *               each cell and shaded the same way; the whole count under it
 *   Second counts   the clean list, aisle by aisle and bin by bin, a row each,
 *               shaded by state
 */

const STATE_FILL = { open: 'FFF3E0', taken: 'E3F2FD', done: 'E8F5E9' };
const nat = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });

export function secondCountsWorkbook(sessionId) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const rows = listRecounts(id).filter((r) => r.reason !== 'CYCLE');
  const aisles = [...new Set(rows.map((r) => r.aisle || '(no aisle)'))].sort(nat);
  const reasons = [...new Set(rows.map((r) => r.reason))].sort();
  const levels = [...new Set(rows.map((r) => r.level).filter(Boolean))].sort();
  const zoneOf = new Map();
  for (const r of rows) if (r.zone && !zoneOf.has(r.aisle)) zoneOf.set(r.aisle, r.zone);
  const binsIn = new Map(db.prepare('SELECT aisle, COUNT(*) AS n FROM locations WHERE session_id = ? GROUP BY aisle').all(id).map((x) => [x.aisle, x.n]));
  const isOpen = (r) => r.status !== 'done';

  /* ---- by aisle */
  const byAisle = aisles.map((a) => {
    const mine = rows.filter((r) => (r.aisle || '(no aisle)') === a);
    const open = mine.filter(isOpen).length;
    return { aisle: a, zone: zoneOf.get(a) || '', bins: binsIn.get(a) || 0, total: mine.length, open, taken: mine.filter((r) => r.status === 'taken').length, done: mine.filter((r) => r.status === 'done').length,
      third: mine.filter((r) => Number(r.round) === 3).length,
      byReason: Object.fromEntries(reasons.map((k) => [k, mine.filter((r) => r.reason === k).length])),
      teams: [...new Set(mine.filter(isOpen).map((r) => r.team).filter(Boolean))].sort(nat).join(', ') };
  });
  const maxOpen = Math.max(0, ...byAisle.map((x) => x.open));
  const sumBy = (k) => byAisle.reduce((n, x) => n + (typeof k === 'function' ? k(x) : x[k]), 0);
  const aisleSheet = {
    name: 'By aisle', freeze: 1, autofilter: true,
    columns: [{ header: 'Aisle', width: 10 }, { header: 'Zone', width: 12 }, { header: 'Bins in aisle', width: 12 }, { header: 'Second counts', width: 14 }, { header: 'Open', width: 8 }, { header: 'Started', width: 9 }, { header: 'Done', width: 8 },
      ...reasons.map((k) => ({ header: k[0] + k.slice(1).toLowerCase(), width: 14 })), { header: '3rd counts', width: 10 }, { header: 'Open ones held by', width: 22 }],
    rows: [
      ...byAisle.map((x) => [x.aisle, x.zone, x.bins, x.total, { v: x.open, fill: heat(x.open, maxOpen), bold: x.open > 0 }, x.taken, { v: x.done, fill: x.done && x.done === x.total ? STATE_FILL.done : '' },
        ...reasons.map((k) => x.byReason[k] || 0), x.third, x.teams]),
      [{ v: 'Every aisle', bold: true }, '', { v: sumBy('bins'), bold: true }, { v: sumBy('total'), bold: true }, { v: sumBy('open'), bold: true }, { v: sumBy('taken'), bold: true }, { v: sumBy('done'), bold: true },
        ...reasons.map((k) => ({ v: sumBy((x) => x.byReason[k] || 0), bold: true })), { v: sumBy('third'), bold: true }, ''],
    ],
  };

  /* ---- the heat map: open second counts, aisle by level; then every second count */
  const grid = (pick, title) => {
    const cellOf = new Map();
    let max = 0;
    for (const r of rows.filter(pick)) { const k = `${r.aisle || '(no aisle)'}|${r.level || '—'}`; const n = (cellOf.get(k) || 0) + 1; cellOf.set(k, n); if (n > max) max = n; }
    const cols = [...levels, ...(rows.some((r) => pick(r) && !r.level) ? ['—'] : [])];
    const out = [[{ v: title, bold: true }], [{ v: 'Aisle', bold: true, fill: 'E7EDF5' }, ...cols.map((l) => ({ v: l === '—' ? 'No level' : `Level ${l}`, bold: true, fill: 'E7EDF5', align: 'center' })), { v: 'Total', bold: true, fill: 'E7EDF5', align: 'center' }]];
    for (const a of aisles) {
      const vals = cols.map((l) => cellOf.get(`${a}|${l}`) || 0);
      const total = vals.reduce((n, v) => n + v, 0);
      if (!total) continue;
      out.push([{ v: a, bold: true }, ...vals.map((v) => ({ v: v || '', fill: heat(v, max), align: 'center' })), { v: total, bold: true, align: 'center' }]);
    }
    out.push([{ v: 'Total', bold: true }, ...cols.map((l) => ({ v: aisles.reduce((n, a) => n + (cellOf.get(`${a}|${l}`) || 0), 0), bold: true, align: 'center' })), { v: rows.filter(pick).length, bold: true, align: 'center' }]);
    return out;
  };
  const heatSheet = {
    name: 'Heat map', columns: [],        // the grid carries its own headings, row by row
    rows: [[{ v: `${s.name} — second counts by aisle and level`, bold: true }], [{ v: `Shading: more open second counts, deeper colour. ${rows.filter(isOpen).length} open of ${rows.length}, as of ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.` }], [],
      ...grid(isOpen, 'OPEN second counts (still to walk)'), [], ...grid(() => true, 'ALL second counts, open and done')],
  };

  /* ---- the clean list, aisle by aisle */
  const sorted = [...rows].sort((a, b) => nat(a.aisle, b.aisle) || nat(a.bin, b.bin) || a.id - b.id);
  const listSheet = {
    name: 'Second counts', freeze: 1, autofilter: true,
    columns: [{ header: 'Aisle', width: 8 }, { header: 'Bin', width: 11 }, { header: 'Level', width: 7 }, { header: 'Face', width: 8 }, { header: 'State', width: 9 }, { header: 'Round', width: 7 }, { header: 'Team', width: 9 },
      { header: 'Reason', width: 16 }, { header: 'Pallet', width: 14 }, { header: 'Item', width: 14 }, { header: 'Description', width: 32 }, { header: 'Variant', width: 10 }, { header: 'Report qty', width: 10 }, { header: '1st count qty', width: 12 },
      { header: '1st team', width: 9 }, { header: '2nd count', width: 22 }, { header: '3rd count', width: 22 }, { header: 'Detail', width: 36 }, { header: 'Raised', width: 17 }, { header: 'Done', width: 17 }, { header: 'Done by', width: 9 }],
    rows: sorted.map((r) => {
      const f = STATE_FILL[r.status] || '';
      const c = (v) => ({ v, fill: f });
      return [c(r.aisle || ''), c(r.bin), c(r.level || ''), c(r.face || ''), { v: r.status, fill: f, bold: r.status !== 'done' }, c(Number(r.round) === 3 ? '3rd' : '2nd'), c(r.team || ''),
        c(r.reason), c(r.pallet_id || ''), c(r.sku || ''), c(r.description || ''), c(r.variant || ''), c(r.expected_qty == null ? '' : Number(r.expected_qty)), c(r.first_qty == null ? '' : Number(r.first_qty)),
        c(r.first_team || ''), c(r.second_result || ''), c(r.third_result || ''), { v: r.detail || '', fill: f, wrap: true }, c(String(r.created_at || '').slice(0, 16).replace('T', ' ')), c(String(r.done_at || '').slice(0, 16).replace('T', ' ')), c(r.done_by_team || '')];
    }),
  };
  const safe = String(s.name).replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'count';
  return {
    filename: `${safe}-second-counts-by-aisle-${new Date().toISOString().slice(0, 10)}.xlsx`,
    buffer: xlsx([aisleSheet, heatSheet, listSheet]),
    aisles: byAisle.length, rows: rows.length, open: rows.filter(isOpen).length,
  };
}
