import { Docx, barcodePng, EMU_PER_INCH } from './docx.js';
import { widths as barWidths, barcodeSvg } from './barcode.js';

/*
 * Gear box labels: one 4" x 6" label per person, for the box their freezer gear
 * waits in on count day. Their name big enough to read across the room, their
 * clock-in number, shift and team, and their jacket, bibs and boot sizes in
 * three boxes - so whoever packs the boxes reads the size off the label, and the
 * counter finds their box by name. A size not on the crew list prints as an
 * empty box to write in. The clock-in number is a barcode at the bottom too.
 *
 * Two forms of the same label: a print page (4x6 pages, for a label printer or
 * "Save as PDF") and a Word document with 4x6 pages, to edit before printing.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shiftWord = (s) => (String(s) === '1' ? '1st shift' : String(s) === '2' ? '2nd shift' : s ? `Shift ${s}` : '');
const facts = (p) => [p.badge ? `#${p.badge}` : '', shiftWord(p.shift), p.team ? `Team ${p.team}` : ''].filter(Boolean);
const SIZES = [['jacket', 'JACKET'], ['bibs', 'BIBS'], ['boots', 'BOOTS']];

/** The print page: every label its own 4x6 page. */
export function gearLabels(people, { title = 'Gear box labels', scope = '', printed = '' } = {}) {
  const labels = people.map((p) => `
  <section class="label">
    <div class="kicker">COUNT GEAR</div>
    <div class="name"><span>${esc(p.name || p.badge)}</span></div>
    <div class="facts">${facts(p).map(esc).join(' &nbsp;·&nbsp; ')}</div>
    <div class="sizes">${SIZES.map(([k, word]) => `<div class="size"><div class="what">${word}</div><div class="val${p[k] ? '' : ' blank'}">${esc(p[k] || '')}</div></div>`).join('')}</div>
    <div class="bars">${p.badge ? barcodeSvg(String(p.badge), { module: 0.42, height: 13, quiet: 3, showText: false }) : ''}</div>
    <div class="num">${esc(p.badge || '')}</div>
    <div class="note">Back in this box after the count</div>
  </section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #000; background: #e9e9e9; margin: 0; }
  .bar { padding: 10px 14px; font-size: 10pt; background: #fff; border-bottom: 1px solid #ccc; }
  .bar button { margin-left: 10px; padding: 6px 14px; font-weight: 700; }
  .sheet { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; }
  .label { width: 4in; height: 6in; background: #fff; padding: .28in .3in .22in; display: flex; flex-direction: column; align-items: center; text-align: center; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .kicker { font-size: 11pt; font-weight: 800; letter-spacing: .22em; border-bottom: 2.5px solid #000; padding-bottom: 4px; width: 100%; }
  .name { font-size: 34pt; line-height: 1.08; font-weight: 900; margin-top: .2in; height: 1.05in; overflow: hidden; display: flex; align-items: center; justify-content: center; width: 100%; }
  .name span { display: block; }
  .facts { font-size: 13pt; font-weight: 600; margin-top: .1in; }
  .sizes { display: grid; grid-template-columns: repeat(3, 1fr); gap: .1in; width: 100%; margin-top: .24in; }
  .size { border: 3px solid #000; border-radius: 7px; padding: .08in .02in .06in; height: 1.45in; display: flex; flex-direction: column; }
  .what { font-size: 11pt; font-weight: 800; letter-spacing: .12em; }
  .val { font-size: 44pt; font-weight: 900; line-height: 1; flex: 1; display: flex; align-items: center; justify-content: center; white-space: nowrap; }
  .val.blank { flex: 0 0 auto; height: .55in; border-bottom: 2px solid #000; margin: auto .14in .1in; }
  .bars { margin-top: auto; width: 2.3in; }
  .bars svg { display: block; width: 100%; height: auto; }
  .num { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12pt; font-weight: 700; margin-top: 2px; }
  .note { font-size: 9pt; color: #333; margin-top: 4px; }
  .none { padding: 30px; text-align: center; color: #666; }
  @media print {
    body { background: #fff; }
    .bar { display: none; }
    .sheet { display: block; padding: 0; }
    .label { box-shadow: none; break-after: page; page-break-after: always; }
    .label:last-child { break-after: auto; page-break-after: auto; }
  }
</style></head>
<body>
<div class="bar"><b>${esc(title)}</b> · ${people.length} label${people.length === 1 ? '' : 's'}${scope ? ` · ${esc(scope)}` : ''}${printed ? ` · ${esc(printed)}` : ''} · one 4×6 label each: pick the 4×6 label size and <b>Actual size</b> when printing
<button onclick="window.print()">Print</button></div>
${people.length ? `<div class="sheet">${labels}</div>` : '<div class="none">Nobody on the crew list yet — add employees under Teams &amp; crew.</div>'}
<script>
  /* a long name or a wide size gets smaller until it fits: two lines of name, one line of size */
  for (const n of document.querySelectorAll('.name')) { const s = n.firstElementChild; let pt = 34; while (pt > 16 && (s.offsetHeight > n.clientHeight || s.scrollWidth > n.clientWidth)) { pt -= 1; s.style.fontSize = pt + 'pt'; } }
  for (const v of document.querySelectorAll('.val:not(.blank)')) { const s = document.createElement('span'); s.textContent = v.textContent; v.textContent = ''; v.appendChild(s); let pt = 44; while (pt > 14 && s.offsetWidth > v.clientWidth - 6) { pt -= 2; v.style.fontSize = pt + 'pt'; } }
</script>
</body></html>`;
}

/** The same labels as a Word document: 4x6 pages, one label each. */
export function gearLabelsDocx(people, { title = 'Gear box labels' } = {}) {
  const TW = 1440;
  const M = Math.round(0.28 * TW);
  const doc = new Docx({ page: { w: 4 * TW, h: 6 * TW }, margin: { top: M, bottom: Math.round(0.2 * TW), left: Math.round(0.3 * TW), right: Math.round(0.3 * TW) } });
  const inner = 4 * TW - 2 * Math.round(0.3 * TW);
  const col = Math.floor(inner / 3);
  people.forEach((p, i) => {
    doc.paragraph([{ text: 'COUNT GEAR', bold: true, size: 22 }], { align: 'center', after: 120, pageBreakBefore: i > 0 });
    const nm = String(p.name || p.badge);
    doc.paragraph([{ text: nm, bold: true, size: nm.length > 26 ? 48 : nm.length > 18 ? 56 : 64 }], { align: 'center', before: 120, after: 60, line: 250 });
    doc.paragraph([{ text: facts(p).join('   ·   '), bold: true, size: 26 }], { align: 'center', after: 280 });
    doc.table([SIZES.map(([k, word]) => ({
      valign: 'center',
      xml: [
        doc.paragraphXml([{ text: word, bold: true, size: 20 }], { align: 'center', after: 40 }),
        doc.paragraphXml([{ text: p[k] || ' ', bold: true, size: String(p[k] || '').length > 3 ? 60 : 80 }], { align: 'center', after: 0, line: 240 }),
      ],
    }))], { widths: [col, col, col], border: 'single', borderColor: '000000', rowHeight: Math.round(1.5 * TW), cellMargin: { top: 40, bottom: 40, left: 40, right: 40 } });
    doc.paragraph('', { after: 300 });
    if (p.badge) {
      const w = barWidths(String(p.badge));
      const modules = [...w].reduce((a, n) => a + Number(n), 0) + 20;
      doc.body.push(doc.pictureXml(barcodePng(w, { scale: 6, height: 90, quiet: 10 }), { width: Math.round(modules * 0.021 * EMU_PER_INCH), height: Math.round(0.55 * EMU_PER_INCH), name: `Badge ${p.badge}` }));
      doc.paragraph([{ text: String(p.badge), bold: true, size: 24, font: 'Consolas' }], { align: 'center', after: 40 });
    }
    doc.paragraph([{ text: 'Back in this box after the count', size: 18 }], { align: 'center', after: 0 });
  });
  if (!people.length) doc.paragraph('Nobody on the crew list yet.');
  return doc.build({ title });
}
