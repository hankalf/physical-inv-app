/* A small Excel writer, with colour.
 *
 * The browser's Excel library writes plain cells only, and a heat map is
 * nothing without its fills - so the server writes these workbooks itself.
 * An .xlsx is a zip of XML parts: a workbook listing its sheets, one sheet
 * part each, a styles part, and the two files that name them all. Strings go
 * inline, numbers as numbers, and a cell can carry a fill colour, bold, and
 * an alignment; the styles part is built from whatever the cells ask for.
 *
 *   xlsx([{ name, columns: [{ header, width }], rows: [[cell, ...]], freeze: 1, autofilter: true }])
 *
 * A cell is a string, a number, null, or { v, fill: 'FFE0B2', bold, color, align, wrap }.
 */
import { zip } from './docx.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // control characters are not allowed in XML text at all
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** 0 -> A, 25 -> Z, 26 -> AA */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

class Styles {
  constructor() {
    this.fills = ['none', 'gray125'];           // the two Excel insists on, in this order
    this.fonts = ['{}'];
    this.xfs = new Map([['0|0|||0', 0]]);       // fill|bold|color|align|wrap -> index
    this.fontIdx = new Map([['|', 0]]);
  }
  fill(rgb) { const k = String(rgb || '').toUpperCase().replace(/^#/, ''); if (!k) return 0; let i = this.fills.indexOf(k); if (i < 0) { this.fills.push(k); i = this.fills.length - 1; } return i; }
  font(bold, color) {
    const k = `${bold ? 'b' : ''}|${String(color || '').toUpperCase().replace(/^#/, '')}`;
    if (this.fontIdx.has(k)) return this.fontIdx.get(k);
    this.fonts.push(`{${k}}`); const i = this.fonts.length - 1; this.fontIdx.set(k, i); return i;
  }
  xf(cell) {
    const f = this.fill(cell.fill), fo = this.font(cell.bold, cell.color);
    const k = `${f}|${fo}|${cell.align || ''}|${cell.wrap ? 1 : 0}`;
    if (this.xfs.has(k)) return this.xfs.get(k);
    const i = this.xfs.size; this.xfs.set(k, i); return i;
  }
  xml() {
    const fonts = this.fonts.map((f) => {
      const m = /\{(b?)\|([0-9A-F]*)\}/.exec(f) || [];
      return `<font>${m[1] ? '<b/>' : ''}<sz val="11"/>${m[2] ? `<color rgb="FF${m[2]}"/>` : ''}<name val="Calibri"/></font>`;
    });
    const fills = this.fills.map((f, i) => (i < 2 ? `<fill><patternFill patternType="${f}"/></fill>` : `<fill><patternFill patternType="solid"><fgColor rgb="FF${f}"/><bgColor indexed="64"/></patternFill></fill>`));
    const xfs = [...this.xfs.keys()].map((k) => {
      const [fill, font, align, wrap] = k.split('|');
      const al = align || wrap === '1' ? `<alignment${align ? ` horizontal="${align}"` : ''}${wrap === '1' ? ' wrapText="1"' : ''} vertical="top"/>` : '';
      return `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"${Number(fill) ? ' applyFill="1"' : ''}${Number(font) ? ' applyFont="1"' : ''}${al ? ' applyAlignment="1"' : ''}>${al}</xf>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
}

function sheetXml(sh, styles) {
  const cols = sh.columns || [];
  const rows = [];
  const headCell = (text, c) => `<c r="${colName(c)}1" t="inlineStr" s="${styles.xf({ bold: true, fill: 'E7EDF5' })}"><is><t>${esc(text)}</t></is></c>`;
  if (cols.length) rows.push(`<row r="1">${cols.map((c, i) => headCell(c.header ?? c, i)).join('')}</row>`);
  const first = cols.length ? 2 : 1;
  (sh.rows || []).forEach((r, ri) => {
    const cells = r.map((raw, ci) => {
      const cell = raw != null && typeof raw === 'object' ? raw : { v: raw };
      const v = cell.v;
      if (v == null || v === '') return (cell.fill ? `<c r="${colName(ci)}${first + ri}" s="${styles.xf(cell)}"/>` : '');
      const s = (cell.fill || cell.bold || cell.color || cell.align || cell.wrap) ? ` s="${styles.xf(cell)}"` : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${colName(ci)}${first + ri}"${s}><v>${v}</v></c>`;
      return `<c r="${colName(ci)}${first + ri}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    rows.push(`<row r="${first + ri}">${cells}</row>`);
  });
  const lastCol = Math.max(cols.length, ...(sh.rows || []).map((r) => r.length), 1) - 1;
  const lastRow = first + (sh.rows || []).length - 1;
  const ref = `A1:${colName(lastCol)}${Math.max(lastRow, 1)}`;
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(c.width) || 12}" customWidth="1"/>`).join('');
  const freeze = sh.freeze ? `<sheetView workbookViewId="0"><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView>` : '<sheetView workbookViewId="0"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${ref}"/><sheetViews>${freeze}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${widths ? `<cols>${widths}</cols>` : ''}<sheetData>${rows.join('')}</sheetData>${sh.autofilter && cols.length && (sh.rows || []).length ? `<autoFilter ref="${ref}"/>` : ''}</worksheet>`;
}

/** sheets -> a Buffer holding the .xlsx */
export function xlsx(sheets) {
  const styles = new Styles();
  const parts = sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh, styles) }));
  const safeName = (n) => String(n || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${esc(safeName(sh.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    ...parts,
    { name: 'xl/styles.xml', data: styles.xml() },
  ];
  return zip(files);
}

/** A fill for a value on a scale: nothing for zero, pale to deep for the rest. */
export const HEAT = ['FFF3E0', 'FFE0B2', 'FFCC80', 'FFB74D', 'FF9800', 'F57C00', 'E65100'];
export function heat(value, max) {
  if (!(value > 0) || !(max > 0)) return '';
  const i = Math.min(HEAT.length - 1, Math.floor((value / max) * HEAT.length));
  return HEAT[Math.max(0, value >= max ? HEAT.length - 1 : i)];
}
