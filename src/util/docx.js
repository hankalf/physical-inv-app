/*
 * A Word document, written by hand.
 *
 * The app has no dependencies, and a .docx is only a zip of XML parts, so this
 * writes both: a small zip (deflate from node:zlib, the CRC done here) and the
 * handful of parts Word needs - content types, the package relationships, the
 * document, its relationships and the pictures it embeds. Enough for a page of
 * text and tables that somebody can open in Word and edit; nothing more.
 *
 *   const d = new Docx();
 *   d.paragraph([{ text: 'Hello', bold: true }], { size: 28 });
 *   d.table([[cell, cell], [cell, cell]], { widths: [4680, 4680] });
 *   const bytes = d.build();
 */
import { deflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ zip */
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** files: [{ name, data: Buffer|string }] -> a zip, every entry deflated. */
export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const packed = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, end]);
}

/* ------------------------------------------------------------------ png */
/** A black-and-white picture from rows of 0/1 (1 = black), as a PNG. */
export function pngFromBits(rows) {
  const h = rows.length, w = rows[0].length;
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = rows[y][x] ? 0 : 255; }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32LE(0); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit greyscale
  const idat = deflateRawSync(raw);
  // zlib wrapper around the raw deflate stream: header, data, adler32
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  const adler = Buffer.alloc(4); adler.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  const zdata = Buffer.concat([Buffer.from([0x78, 0x9c]), idat, adler]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zdata), chunk('IEND', Buffer.alloc(0))]);
}

/** A Code 128 symbol as a PNG: `widths` is the bar/space run-length string the barcode module gives. */
export function barcodePng(widths, { scale = 4, height = 60, quiet = 10 } = {}) {
  const runs = [...widths].map(Number);
  const total = runs.reduce((a, b) => a + b, 0) * scale + 2 * quiet * scale;
  const row = new Uint8Array(total);
  let x = quiet * scale;
  runs.forEach((n, i) => { for (let k = 0; k < n * scale; k++) row[x++] = i % 2 === 0 ? 1 : 0; });
  return pngFromBits(Array.from({ length: height }, () => row));
}

/** A PNG's pixel size, from its header. */
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
export const EMU_PER_INCH = 914400;
export const TWIP = 635;   // EMU per twip

/* ------------------------------------------------------------------ docx */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class Docx {
  constructor({ landscape = false, margin = 720 } = {}) {
    this.body = [];
    this.media = [];            // { name, data }
    this.lists = 0;             // numbered lists after the first: each starts again at 1
    this.landscape = landscape;
    // one number for every side, or { top, right, bottom, left } - a label sheet has its own
    this.margins = typeof margin === 'object' ? { top: 720, right: 720, bottom: 720, left: 720, ...margin } : { top: margin, right: margin, bottom: margin, left: margin };
  }

  /** Runs: a string, or [{ text, bold, italic, size (half-points), color, font }]. */
  runs(runs, base = {}) {
    const list = typeof runs === 'string' ? [{ text: runs }] : runs;
    return list.map((r) => {
      const o = { ...base, ...r };
      const pr = [
        o.font ? `<w:rFonts w:ascii="${esc(o.font)}" w:hAnsi="${esc(o.font)}" w:cs="${esc(o.font)}"/>` : '',
        o.bold ? '<w:b/>' : '', o.italic ? '<w:i/>' : '', o.color ? `<w:color w:val="${esc(o.color)}"/>` : '',
        o.size ? `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>` : '',
        o.highlight ? `<w:highlight w:val="${esc(o.highlight)}"/>` : '',
      ].join('');
      const text = String(o.text ?? '');
      const pieces = text.split('\n').map((t) => `<w:t xml:space="preserve">${esc(t)}</w:t>`).join('<w:br/>');
      return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}${pieces}</w:r>`;
    }).join('');
  }

  /** A new numbered list: pass what this returns as `numbered` and it counts from 1. */
  newList() { this.lists += 1; return 100 + this.lists; }

  paragraphXml(runs, { align = 'left', before = 0, after = 60, line = 240, numbered = false, bullet = false, keepNext = false, shade = '', pageBreakBefore = false, base = {} } = {}) {
    const ppr = [
      pageBreakBefore ? '<w:pageBreakBefore/>' : '',
      keepNext ? '<w:keepNext/>' : '',
      bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : numbered ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numbered === true ? 2 : numbered}"/></w:numPr>` : '',
      shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${esc(shade)}"/>` : '',
      `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>`,
      `<w:jc w:val="${align === 'center' ? 'center' : align === 'right' ? 'right' : 'left'}"/>`,
    ].join('');
    return `<w:p><w:pPr>${ppr}</w:pPr>${this.runs(runs, base)}</w:p>`;
  }

  paragraph(runs, opts) { this.body.push(this.paragraphXml(runs, opts)); return this; }
  pageBreak() { this.body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); return this; }

  /** A picture, inline in its own paragraph. width/height in EMU (914400 per inch). */
  pictureXml(png, { width, height, align = 'center', name = 'picture' }) {
    const id = this.media.length + 1;
    this.media.push({ name: `image${id}.png`, data: png });
    const rid = `rIdImg${id}`;
    return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="${align}"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${id}" name="${esc(name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }

  /**
   * A table. rows: arrays of cells; a cell is a string, an array of paragraph
   * XML strings (from paragraphXml / pictureXml), or { xml: [...], shade, valign }.
   * widths in twips (1440 per inch). Dashed borders by default: these are cards to cut.
   */
  table(rows, opts) { this.body.push(this.tableXml(rows, opts)); return this; }
  tableXml(rows, { widths, border = 'dashed', borderColor = '888888', cellMargin = 160, rowHeight = 0, keepTogether = true, headerShade = '', indent = null } = {}) {
    // cell padding: one number, or { top, right, bottom, left }
    const pad = typeof cellMargin === 'object' ? { top: 0, right: 0, bottom: 0, left: 0, ...cellMargin } : { top: cellMargin, right: cellMargin, bottom: cellMargin, left: cellMargin };
    const b = (side) => `<w:${side} w:val="${border}" w:sz="8" w:space="0" w:color="${borderColor}"/>`;
    const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b).join('')}</w:tblBorders>`;
    const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    const trs = rows.map((cells, r) => `<w:tr>${rowHeight ? `<w:trPr><w:trHeight w:val="${rowHeight}" w:hRule="exact"/>${keepTogether ? '<w:cantSplit/>' : ''}</w:trPr>` : keepTogether ? '<w:trPr><w:cantSplit/></w:trPr>' : ''}${cells.map((c, i) => {
      const cell = typeof c === 'string' ? { xml: [this.paragraphXml(c, { after: 0, base: r === 0 && headerShade ? { bold: true } : {} })] } : Array.isArray(c) ? { xml: c } : c;
      const shade = cell.shade || (r === 0 && headerShade ? headerShade : '');
      const tcpr = `<w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}${cell.valign ? `<w:vAlign w:val="${cell.valign}"/>` : ''}</w:tcPr>`;
      return `<w:tc>${tcpr}${cell.xml.join('') || '<w:p/>'}</w:tc>`;
    }).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, x) => a + x, 0)}" w:type="dxa"/>${indent == null ? '' : `<w:tblInd w:w="${indent}" w:type="dxa"/>`}<w:tblLayout w:type="fixed"/>${borders}<w:tblCellMar><w:top w:w="${pad.top}" w:type="dxa"/><w:left w:w="${pad.left}" w:type="dxa"/><w:bottom w:w="${pad.bottom}" w:type="dxa"/><w:right w:w="${pad.right}" w:type="dxa"/></w:tblCellMar></w:tblPr>${grid}${trs}</w:tbl>`;
  }

  build({ title = 'Document', creator = 'Full Harvest Inventory' } = {}) {
    const W = this.landscape ? 15840 : 12240, H = this.landscape ? 12240 : 15840;
    const sect = `<w:sectPr><w:pgSz w:w="${W}" w:h="${H}"${this.landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${this.margins.top}" w:right="${this.margins.right}" w:bottom="${this.margins.bottom}" w:left="${this.margins.left}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${this.body.join('')}${sect}</w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="300" w:hanging="200"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="320" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>${Array.from({ length: this.lists }, (_, k) => `<w:num w:numId="${101 + k}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('')}</w:numbering>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${this.media.map((m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator><cp:lastModifiedBy>${esc(creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
    const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Full Harvest Inventory</Application></Properties>`;
    return zip([
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rels },
      { name: 'docProps/core.xml', data: core },
      { name: 'docProps/app.xml', data: app },
      { name: 'word/document.xml', data: document },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/numbering.xml', data: numbering },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      ...this.media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
    ]);
  }
}
