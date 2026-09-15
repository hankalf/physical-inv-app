import { db, norm } from '../db.js';
import { localDate } from '../util/localtime.js';
import { parseBinCode } from '../util/bincode.js';
import { loadLayout } from '../util/layouts.js';

/*
 * A count sheet for when the scanners are not an option: a battery dies, Wi-Fi
 * is down for the whole freezer, or an auditor wants paper. One row per bin,
 * pre-printed with where it is, and blank boxes for the pallet and the count.
 */

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function binRows(sessionId, { aisle = '', levels = '', batch = '', onlyUncounted = false }) {
  const id = Number(sessionId);
  const where = ['l.session_id = ?'];
  const args = [id];
  if (batch) {
    where.push("EXISTS (SELECT 1 FROM recounts r WHERE r.session_id = l.session_id AND r.bin = l.code AND r.batch_id = ? AND r.status != 'done')");
    args.push(Number(batch));
  }
  if (aisle) {
    const list = String(aisle).split(/[,\s]+/).map(norm).filter(Boolean);
    if (list.length) { where.push(`l.aisle IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (levels) {
    const list = [...norm(levels)].filter((c) => /[A-Z]/.test(c));
    if (list.length) { where.push(`COALESCE(l.level,'') IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (onlyUncounted) {
    where.push("NOT EXISTS (SELECT 1 FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0)");
  }
  return db.prepare(
    `SELECT l.code, l.aisle, l.level, COALESCE(l.zone,'') AS zone,
            (SELECT GROUP_CONCAT(p.pallet_id, ' ') FROM pallets p WHERE p.session_id = l.session_id AND p.expected_location = l.code) AS expected
       FROM locations l WHERE ${where.join(' AND ')}
      ORDER BY l.aisle, l.code LIMIT 4000`
  ).all(...args);
}

/**
 * `blind` (the default) hides what the system expects, so writing down a number
 * is a count and not a transcription.
 */
export function countSheet(sessionId, opts = {}) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(sessionId));
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
  const rows = binRows(sessionId, opts);
  const layout = loadLayout(session.layout);
  const faces = layout?.faces || { odd: 'Front', even: 'Back' };
  const blind = opts.blind !== false;
  const scope = [opts.aisle && `aisle ${opts.aisle}`, opts.levels && `levels ${norm(opts.levels)}`,
    opts.batch && `batch ${opts.batch}`, opts.onlyUncounted && 'bins with no count yet'].filter(Boolean).join(' · ') || 'whole site';

  const body = rows.map((r) => {
    const pos = Number(parseBinCode(r.code).bay);
    const face = Number.isFinite(pos) ? (pos % 2 === 1 ? faces.odd : faces.even) : '';
    return `<tr>
      <td class="bin">${esc(r.code)}</td>
      <td>${esc(r.level || '')}</td>
      <td>${esc(parseBinCode(r.code).bay || '')}</td>
      <td class="face">${esc(face)}</td>
      ${blind ? '' : `<td class="exp">${esc(r.expected || '')}</td>`}
      <td class="write w-pallet"></td>
      <td class="write w-qty"></td>
      <td class="write w-note"></td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Count sheet — ${esc(session.name)}</title>
<style>
  @page { size: letter portrait; margin: 12mm 10mm 14mm; }
  body { font: 12px/1.3 system-ui, sans-serif; color: #000; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
  .head h1 { font-size: 17px; margin: 0; }
  .head .meta { font-size: 11px; text-align: right; }
  .who { display: flex; gap: 16px; font-size: 11px; margin-bottom: 8px; }
  .who div { flex: 1; border-bottom: 1px solid #000; padding-bottom: 2px; }
  .who span { color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 3px 5px; text-align: left; }
  th { background: #eee; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  td.bin { font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
  td.face { font-size: 10px; }
  td.write { background: #fff; }
  .w-pallet { width: 26%; } .w-qty { width: 12%; } .w-note { width: 20%; }
  tbody tr { height: 26px; page-break-inside: avoid; }
  tbody tr:nth-child(5n) td { border-bottom-width: 2px; }
  thead { display: table-header-group; }
  .foot { margin-top: 10px; font-size: 10px; color: #444; display: flex; justify-content: space-between; }
  .noprint { margin: 10px 0; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<div class="noprint">
  <button onclick="print()" style="padding:8px 14px;font:600 14px system-ui">Print this sheet</button>
  <span style="font:12px system-ui;color:#555;margin-left:10px">${rows.length} bins${rows.length >= 4000 ? ' (capped at 4000 — narrow the scope)' : ''}</span>
</div>
<div class="head">
  <div>
    <h1>${esc(session.name)}</h1>
    <div style="font-size:11px">${esc(scope)}${blind ? ' · blind count' : ' · shows expected pallets'}</div>
  </div>
  <div class="meta">Printed ${esc(localDate())}<br>Sheet _____ of _____</div>
</div>
<div class="who">
  <div><span>Team</span><br>&nbsp;</div>
  <div><span>Clock in numbers</span><br>&nbsp;</div>
  <div><span>Date / shift</span><br>&nbsp;</div>
  <div><span>Entered by</span><br>&nbsp;</div>
</div>
<table>
  <thead><tr>
    <th>Bin</th><th>Lvl</th><th>Pos</th><th>Face</th>${blind ? '' : '<th>System says</th>'}
    <th>Pallet ID</th><th>Qty</th><th>Notes</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="8">No bins match that scope.</td></tr>'}</tbody>
</table>
<div class="foot">
  <span>Every bin gets a line — write EMPTY in the quantity box if there is nothing in it.</span>
  <span>Counted by ______________________  Checked by ______________________</span>
</div>
</body></html>`;
}
