import { Docx, barcodePng, EMU_PER_INCH } from './docx.js';
import { widths as barWidths } from './barcode.js';

/*
 * Badge labels on Avery 5960 (the same sheet as 5160 and 8160): Letter, three
 * columns of 2 5/8" x 1" labels, ten rows, 30 to a sheet. Each label has the
 * person's name, their clock-in number, and the number as a Code 128 barcode at
 * the bottom - what the scanner's sign-on screen reads.
 *
 * The sheet is a Word table sized to the label stock exactly: 1/2" top margin,
 * 3/16" left, the columns 2 5/8" with a 1/8" gap, every row exactly 1". The
 * cells have no side padding, so the table lands in the same place whichever
 * way a version of Word measures a table's indent.
 *
 * perPerson puts that many copies of one person side by side on a row (1-3);
 * a row's spare labels stay blank, so every row is one person.
 */

const TW = 1440;                                // twips to the inch
const LABEL_W = Math.round(2.625 * TW), GAP = Math.round(0.125 * TW), ROW_H = TW;
const MODULE_IN = 0.0145;                       // narrowest bar: 0.37mm, read easily by a Zebra
const QUIET = 10;                               // modules of white either side
const BAR_H_IN = 0.4;

export function badgeLabelsDocx(people, { perPerson = 3, title = 'Badge labels' } = {}) {
  const per = Math.min(3, Math.max(1, Number(perPerson) || 1));
  const doc = new Docx({ margin: { top: Math.round(0.5 * TW), left: Math.round(0.1875 * TW), right: 0, bottom: 0 } });
  const label = (p) => {
    const w = barWidths(p.badge);
    const modules = [...w].reduce((a, n) => a + Number(n), 0) + 2 * QUIET;
    const png = barcodePng(w, { scale: 6, height: 90, quiet: QUIET });
    return {
      valign: 'center',
      xml: [
        doc.paragraphXml([{ text: p.name, bold: true, size: 21 }], { align: 'center', after: 0, line: 240 }),
        doc.paragraphXml([{ text: p.badge, size: 18 }], { align: 'center', after: 40, line: 240 }),
        doc.pictureXml(png, { width: Math.round(modules * MODULE_IN * EMU_PER_INCH), height: Math.round(BAR_H_IN * EMU_PER_INCH), name: `Badge ${p.badge}` }),
      ],
    };
  };
  const blank = { xml: [doc.paragraphXml('', { after: 0, base: { size: 2 } })] };
  const rows = people.map((p) => {
    const one = () => label(p);
    const cells = [per >= 1 ? one() : blank, blank, per >= 2 ? one() : blank, blank, per >= 3 ? one() : blank];
    return cells;
  });
  doc.table(rows, {
    widths: [LABEL_W, GAP, LABEL_W, GAP, LABEL_W], border: 'none', rowHeight: ROW_H,
    cellMargin: { top: 0, bottom: 0, left: 0, right: 0 }, indent: 0,
  });
  // Word needs a paragraph after a table: a 1pt one, so it never pushes a blank page out
  doc.paragraph([{ text: '', size: 2 }], { after: 0, line: 20 });
  return doc.build({ title });
}

/** "badge<TAB>name" lines, a CSV, or a pasted two-column list: the people, in order, without repeats. */
export function parseBadgeList(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : line.split(/\s+(.+)/);
    const badge = (parts[0] || '').trim().replace(/^"|"$/g, '');
    const name = (parts[1] || '').trim().replace(/^"|"$/g, '');
    if (!badge || /^(badge|clock|employee|number)/i.test(badge)) continue;   // the header row
    if (seen.has(badge)) continue;
    seen.add(badge);
    out.push({ badge, name });
  }
  return out;
}
