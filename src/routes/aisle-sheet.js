import { db, getSession } from '../db.js';
import { levelsCell } from './assignments.js';
import { listTeams } from './people.js';
import { Docx } from '../util/docx.js';
import { localDate } from '../util/localtime.js';

/*
 * The aisle sheet: every aisle on the count's bin list on one clipboard sheet,
 * to plan on paper which team does which aisle - and to tick off as the day
 * goes. Printed once the bin list is uploaded. Each row says what the aisle is
 * (its zone, its racking block, how many bins, which levels) and leaves room
 * to write: the 1st and 2nd shift team, the levels, when it started and was
 * done, and who checked it. With "the plan in it", the teams already queued
 * are printed in the team columns, the rest left blank.
 *
 * Three forms of the same sheet: a print page, a Word document to edit, and a
 * CSV for a spreadsheet.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nat = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/** One row per aisle: what it is, and - with withPlan - who is on it now, by shift. */
export function aisleRows(sessionId, { withPlan = false } = {}) {
  const id = Number(sessionId);
  const bins = db.prepare(`SELECT aisle, COALESCE(NULLIF(TRIM(zone), ''), '') AS zone, UPPER(TRIM(COALESCE(level, ''))) AS level, COUNT(*) AS n
                             FROM locations WHERE session_id = ? AND TRIM(COALESCE(aisle, '')) != '' GROUP BY aisle, zone, level`).all(id);
  const blocks = new Map(db.prepare('SELECT aisle, block FROM aisles WHERE session_id = ?').all(id).map((r) => [r.aisle, r.block]));
  const by = new Map();
  for (const r of bins) {
    if (!by.has(r.aisle)) by.set(r.aisle, { aisle: r.aisle, zones: new Map(), levels: new Set(), bins: 0 });
    const a = by.get(r.aisle);
    a.bins += r.n;
    if (r.zone) a.zones.set(r.zone, (a.zones.get(r.zone) || 0) + r.n);
    if (r.level) a.levels.add(r.level);
  }
  const shiftOf = new Map(listTeams().map((t) => [t.name, t.shift || '']));
  const plan = new Map();
  if (withPlan) {
    for (const p of db.prepare('SELECT team, aisle, levels, status, position, id FROM assignments WHERE session_id = ? ORDER BY position, id').all(id)) {
      if (!plan.has(p.aisle)) plan.set(p.aisle, { 1: [], 2: [], other: [] });
      const sh = shiftOf.get(p.team) || (/^S1-/i.test(p.team) ? '1' : /^S2-/i.test(p.team) ? '2' : '');
      plan.get(p.aisle)[sh === '1' ? 1 : sh === '2' ? 2 : 'other'].push(`${p.team}${p.levels ? ` (${levelsCell(p.levels)})` : ''}${p.status === 'done' ? ' ✓' : ''}`);
    }
  }
  return [...by.values()].sort((x, y) => nat(x.aisle, y.aisle)).map((a) => {
    const zone = [...a.zones.entries()].sort((x, y) => y[1] - x[1]).map(([z]) => z)[0] || '';
    const block = blocks.get(a.aisle) || '';
    const p = plan.get(a.aisle);
    return {
      aisle: a.aisle, zone, block: block && block !== a.aisle ? block : '', bins: a.bins,
      levels: levelsCell([...a.levels].sort().join('')),
      shift1: p ? [...p[1], ...p.other].join(', ') : '', shift2: p ? p[2].join(', ') : '',
    };
  });
}

export const AISLE_COLUMNS = ['Aisle', 'Zone', 'Racking block', 'Bins', 'Levels', '1st shift team', '2nd shift team', 'Levels counted', 'Started', 'Done', 'Checked by'];
export const aisleCsvRows = (rows) => rows.map((r) => ({ Aisle: r.aisle, Zone: r.zone, 'Racking block': r.block, Bins: r.bins, Levels: r.levels,
  '1st shift team': r.shift1, '2nd shift team': r.shift2, 'Levels counted': '', Started: '', Done: '', 'Checked by': '' }));

/** The print page: landscape letter, the header row on every page, a zone heading where the zone changes. */
export function aisleSheet(sessionId, { withPlan = false } = {}) {
  const s = getSession(sessionId);
  const rows = aisleRows(sessionId, { withPlan });
  const bins = rows.reduce((n, r) => n + r.bins, 0);
  let lastZone = null;
  const body = rows.map((r) => {
    const head = r.zone !== lastZone ? `<tr class="zone"><td colspan="11">${esc(r.zone || 'No zone')}</td></tr>` : '';
    lastZone = r.zone;
    return `${head}<tr><td class="a">${esc(r.aisle)}</td><td>${esc(r.zone)}</td><td>${esc(r.block)}</td><td class="n">${r.bins.toLocaleString()}</td><td>${esc(r.levels)}</td>`
      + `<td class="w">${esc(r.shift1)}</td><td class="w">${esc(r.shift2)}</td><td class="w s"></td><td class="w s"></td><td class="w s"></td><td class="w s"></td></tr>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Aisle sheet — ${esc(s ? s.name : '')}</title>
<style>
  @page { size: letter landscape; margin: 10mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #000; background: #fff; margin: 0; padding: 10px; }
  h1 { font-size: 15pt; margin: 0; }
  .sub { font-size: 9pt; color: #333; margin: 2px 0 8px; }
  .noprint { margin-bottom: 8px; padding: 6px 14px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  thead { display: table-header-group; }
  th { background: #e6e6e6; border: 1px solid #555; padding: 4px 5px; text-align: left; font-size: 8.5pt; }
  td { border: 1px solid #777; padding: 0 5px; height: 26px; }
  td.a { font-weight: 800; font-size: 11pt; white-space: nowrap; }
  td.n { text-align: right; }
  td.w { min-width: 85px; }
  td.s { min-width: 60px; }
  tr.zone td { background: #f3f3f3; font-weight: 800; height: 20px; border-top: 2px solid #000; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .none { padding: 30px; text-align: center; color: #555; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<h1>Aisle sheet — ${esc(s ? s.name : 'count')}</h1>
<div class="sub">${rows.length} aisles · ${bins.toLocaleString()} bins · printed ${esc(localDate())}${withPlan ? ' · the teams already planned are filled in' : ''} · write in the team for each shift, the levels, the times and who checked it</div>
<button class="noprint" onclick="window.print()">Print</button>
${rows.length ? `<table><thead><tr>${AISLE_COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>` : '<div class="none">No bin list on this count yet — upload it first, then print the aisle sheet.</div>'}
</body></html>`;
}

/** The same sheet as Word, landscape, the header row repeated on each page. */
export function aisleSheetDocx(sessionId, { withPlan = false } = {}) {
  const s = getSession(sessionId);
  const rows = aisleRows(sessionId, { withPlan });
  const doc = new Docx({ landscape: true, margin: 560 });
  doc.paragraph([{ text: `Aisle sheet — ${s ? s.name : 'count'}`, bold: true, size: 30 }], { after: 40 });
  doc.paragraph([{ text: `${rows.length} aisles · ${rows.reduce((n, r) => n + r.bins, 0).toLocaleString()} bins · printed ${localDate()}${withPlan ? ' · the teams already planned are filled in' : ''}`, size: 17, color: '444444' }], { after: 120 });
  const W = [900, 1250, 1050, 650, 800, 1700, 1700, 1050, 900, 900, 1150];     // twips: 10 inches across
  const cell = (t, o = {}) => ({ xml: [doc.paragraphXml([{ text: String(t ?? ''), size: o.size || 18, bold: !!o.bold }], { after: 0, align: o.align || 'left' })], valign: 'center', shade: o.shade || '' });
  const table = [AISLE_COLUMNS.map((c) => cell(c, { bold: true, size: 16 }))];
  let lastZone = null;
  for (const r of rows) {
    if (r.zone !== lastZone) { table.push([cell(r.zone || 'No zone', { bold: true, shade: 'F0F0F0' }), ...Array(10).fill(0).map(() => cell('', { shade: 'F0F0F0' }))]); lastZone = r.zone; }
    table.push([cell(r.aisle, { bold: true, size: 20 }), cell(r.zone), cell(r.block), cell(r.bins.toLocaleString(), { align: 'right' }), cell(r.levels), cell(r.shift1), cell(r.shift2), cell(''), cell(''), cell(''), cell('')]);
  }
  if (rows.length) doc.table(table, { widths: W, border: 'single', borderColor: '666666', cellMargin: { top: 20, bottom: 20, left: 70, right: 70 }, rowHeight: 400, headerShade: 'E6E6E6', repeatHeader: true });
  else doc.paragraph('No bin list on this count yet — upload it first.');
  return doc.build({ title: `Aisle sheet — ${s ? s.name : 'count'}` });
}
