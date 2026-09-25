import { db, norm } from '../db.js';
import { localDate } from '../util/localtime.js';
import { parseBinCode } from '../util/bincode.js';
import { loadLayout } from '../util/layouts.js';
import { barcodeSvg } from '../util/barcode.js';

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

/*
 * Setup cards for the scanners: one card per handheld, each with the QR of its
 * own enrolment link. Cut them up, tape one to each gun's cradle, and setting a
 * scanner up is "scan this, then Add to Home screen" - no typing a URL with a
 * trigger and a keypad in a freezer.
 *
 * The QR is drawn in the browser from the shipped library, so this stays a
 * dependency-free HTML page the print dialog can handle.
 */
export function scannerCards(devices, origin) {
  const cards = devices.map((d) => `
    <div class="card">
      <div class="name">${esc(d.name)}</div>
      <div class="qr" data-link="${esc(origin)}/?d=${esc(d.uid)}"></div>
      <div class="url">${esc(origin)}/?d=${esc(d.uid)}</div>
      ${d.notes ? `<div class="note">${esc(d.notes)}</div>` : ''}
      <ol class="how"><li>Scan this with the camera, or type the address.</li><li>Chrome menu → <b>Add to Home screen</b>.</li><li>Open it from the home screen from now on.</li></ol>
    </div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Scanner setup cards</title>
<style>
  @page { size: letter portrait; margin: 12mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; padding: 12px; }
  h1 { font-size: 16pt; margin: 0 0 2px; }
  .sub { color: #444; font-size: 9.5pt; margin-bottom: 12px; }
  .sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .card { border: 1.5px dashed #888; border-radius: 8px; padding: 12px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .name { font-size: 15pt; font-weight: 800; letter-spacing: .02em; margin-bottom: 8px; }
  .qr { display: flex; justify-content: center; min-height: 168px; align-items: center; }
  .qr img, .qr canvas { display: block; }
  .url { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7.5pt; word-break: break-all; margin-top: 8px; color: #333; }
  .note { font-size: 9pt; color: #444; margin-top: 4px; font-style: italic; }
  .how { text-align: left; font-size: 8.5pt; color: #333; margin: 8px 0 0; padding-left: 16px; line-height: 1.45; }
  .warn { margin-top: 14px; font-size: 8.5pt; color: #666; border-top: 1px solid #ccc; padding-top: 6px; }
  .none { padding: 30px; text-align: center; color: #666; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<h1>Scanner setup cards</h1>
<div class="sub">${devices.length} scanner${devices.length === 1 ? '' : 's'} · printed ${esc(localDate())} · cut along the dashed lines and tape one to each cradle</div>
<button class="noprint" onclick="window.print()" style="margin-bottom:10px;padding:6px 12px">Print</button>
${devices.length ? `<div class="sheet">${cards}</div>` : '<div class="none">No scanners registered yet — add them under Settings → Scanners.</div>'}
<div class="warn">Each link signs that scanner in, so treat a card like a key: if one goes missing, use <b>Reset link</b> in Settings and print a new card.</div>
<script src="/vendor/qrcode.min.js"></script>
<script>
  for (const box of document.querySelectorAll('.qr')) {
    try { new QRCode(box, { text: box.dataset.link, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { box.textContent = 'QR unavailable — type the address below'; }
  }
</script>
</body></html>`;
}

/*
 * The test book: a printed page of bin and pallet barcodes.
 *
 * Training a crew, or dry-running a count before the real one, needs something
 * to scan that is not the warehouse. This prints real Code 128 labels - the same
 * symbology the racking uses, so a gun that reads the book reads the rack -
 * either from the count's own bins and pallets, or from a spreadsheet somebody
 * filled in with the codes they want to practise on.
 *
 * Laid out to be cut up, taped to a desk or a shelf, and scanned.
 */
export function barcodeBook(rows, { title = 'Barcode test book', note = '', qtyBarcode = false, height = 13 } = {}) {
  const cell = (value, { kind = '', big = false, note = '' } = {}) => {
    if (!value) return `<td class="${kind}"><span class="empty">—</span></td>`;
    let svg = '';
    let bad = '';
    try { svg = barcodeSvg(String(value), { height: big ? height + 2 : height, module: 0.33, showText: false }); }
    catch (err) { bad = err.message; }
    return `<td class="${kind}">${svg || `<div class="bad">${esc(bad)}</div>`}
      <div class="code">${esc(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</td>`;
  };

  const body = rows.map((r, i) => `<tr${i % 2 ? ' class="alt"' : ''}>
      ${cell(r.bin, { kind: 'bin' })}
      ${cell(r.pallet, { kind: 'pallet', big: true, note: r.note })}
      <td class="qty">${r.qty === '' || r.qty == null ? '<span class="empty">—</span>' : `
        <div class="n">${esc(r.qty)}</div>
        ${qtyBarcode ? barcodeSvg(String(r.qty), { height: 8, module: 0.3, showText: false }) : ''}`}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: letter portrait; margin: 10mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; padding: 12px; }
  h1 { font-size: 16pt; margin: 0 0 2px; }
  .sub { color: #444; font-size: 9.5pt; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }            /* the headings repeat on every printed page */
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: .1em; color: #555;
       border-bottom: 1.5px solid #333; padding: 0 8px 5px; }
  th.bin, td.bin, th.pallet, td.pallet { width: 44%; text-align: center; }
  th.qty, td.qty { text-align: center; width: 90px; }
  th.bin, th.pallet { text-align: center; }
  td { padding: 7px 8px; border-bottom: 1px dashed #bbb; vertical-align: middle; break-inside: avoid; page-break-inside: avoid; }
  tr.alt td { background: #f6f6f6; }
  td svg { display: block; margin: 0 auto; }
  .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8.5pt; letter-spacing: .04em; margin-top: 2px; }
  .qty .n { font-size: 15pt; font-weight: 800; line-height: 1; }
  .note { font-size: 7.5pt; color: #666; margin-top: 2px; }
  .empty { color: #999; }
  .bad { font-size: 8pt; color: #a00; }
  .none { padding: 30px; text-align: center; color: #666; }
  .tip { margin-top: 14px; font-size: 8.5pt; color: #555; border-top: 1px solid #ccc; padding-top: 6px; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<h1>${esc(title)}</h1>
<div class="sub">${rows.length} line${rows.length === 1 ? '' : 's'} · Code 128 · printed ${esc(localDate())}${note ? ' · ' + esc(note) : ''}</div>
<button class="noprint" onclick="window.print()" style="margin-bottom:10px;padding:6px 12px">Print</button>
${rows.length ? `<table>
  <thead><tr><th class="bin">Bin</th><th class="pallet">Pallet</th><th class="qty">Qty</th></tr></thead>
  <tbody>${body}</tbody></table>` : '<div class="none">Nothing to print — pick a count, or upload a sheet of codes.</div>'}
<div class="tip">Work down the page the way a counter works down an aisle: scan the pallet, key the quantity, scan the bin.
Print at <b>100%</b> — “fit to page” shrinks the bars and a scanner will refuse them. If a label will not read, print that page
again on plain white paper: a glossy or coloured sheet scatters the beam.</div>
</body></html>`;
}
