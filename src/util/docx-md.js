/*
 * The guides' Markdown as a Word document, so a site can edit a guide in its own
 * words. The same slice of Markdown markdown.js renders for the page: headings,
 * paragraphs, both kinds of list, tables, block quotes, fenced code, figures and
 * rules. Pictures come from docs/images, as they do on the page.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Docx, pngSize, EMU_PER_INCH } from './docx.js';

/** Inline markup as runs: **bold**, *italic*, `code`, [text](url) as the text alone. */
export function inlineRuns(text, base = {}) {
  const out = [];
  let s = String(text || '').replace(/<br\s*\/?>/g, '\n').replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  const re = /(`[^`]+`|\*\*[^*]+\*\*|(?:^|(?<=[\s(—-]))\*[^*\n]+\*(?=$|[\s.,;:)—-]))/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ ...base, text: s.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('`')) out.push({ ...base, text: t.slice(1, -1), font: 'Consolas', shade: 'EEEEEE' });
    else if (t.startsWith('**')) out.push({ ...base, text: t.slice(2, -2), bold: true });
    else out.push({ ...base, text: t.slice(1, -1), italic: true });
    last = m.index + t.length;
  }
  if (last < s.length) out.push({ ...base, text: s.slice(last) });
  return out.length ? out : [{ ...base, text: '' }];
}

const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * md -> Docx. `images` is the folder `../images/x.png` resolves against.
 * Returns the Docx, so the caller can build it with its own title.
 */
export function markdownToDocx(md, { images = '', title = '' } = {}) {
  const d = new Docx({ margin: 1080 });
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const para = [];
  const flush = () => {
    if (!para.length) return;
    const text = para.join(' ');
    para.length = 0;
    if (/^\*[^*].*\*$/.test(text)) d.paragraph(inlineRuns(text.slice(1, -1), { italic: true, color: '555555', size: 18 }), { align: 'center', after: 200 });
    else d.paragraph(inlineRuns(text), { after: 140, line: 264 });
  };
  const picture = (src) => {
    const file = join(images, src.replace(/^(\.\.\/)*images\//, ''));
    if (!images || !/\.png$/i.test(file) || !existsSync(file)) return;
    const png = readFileSync(file);
    const sz = pngSize(png);
    if (!sz) return;
    const maxW = 6.3 * EMU_PER_INCH;
    const w = Math.min(maxW, sz.width * 6000), h = Math.round(w * sz.height / sz.width);
    d.body.push(d.pictureXml(png, { width: Math.round(w), height: h, name: src }));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flush(); i++; continue; }
    if (line.startsWith('```')) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      d.paragraph([{ text: body.join('\n'), font: 'Consolas', size: 17 }], { shade: 'F2F2F2', after: 160 });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const text = h[2].replace(/^\*\*(.*)\*\*$/, '$1');
      d.paragraph(inlineRuns(text, { bold: true, size: level === 1 ? 40 : level === 2 ? 30 : level === 3 ? 25 : 22, color: level === 1 ? '000000' : '1E2761' }), { before: level === 1 ? 0 : 280, after: 120, keepNext: true });
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) { flush(); d.paragraph([{ text: '' }], { after: 0 }); i++; continue; }
    const fig = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (fig) { flush(); picture(fig[2]); i++; continue; }
    if (line.startsWith('<')) { flush(); const m = /src="([^"]+)"/.exec(line); if (m) picture(m[1]); i++; continue; }
    if (line.startsWith('>')) {
      flush();
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      d.paragraph(inlineRuns(body.join(' ').trim(), { italic: true }), { shade: 'FFF3C4', after: 160 });
      continue;
    }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].startsWith('|')) { body.push(cells(lines[i])); i++; }
      const n = Math.max(head.length, ...body.map((r) => r.length));
      const total = 12240 - 2 * 1080;
      /* widths by the longest text in each column, within reason */
      const longest = Array.from({ length: n }, (_, c) => Math.max(6, ...[head, ...body].map((r) => (r[c] || '').length)));
      const sum = longest.reduce((a, b) => a + Math.min(b, 60), 0);
      const widths = longest.map((l) => Math.round(total * Math.min(l, 60) / sum));
      const blank = head.every((c) => !c);
      const row = (r, isHead) => Array.from({ length: n }, (_, c) => [d.paragraphXml(inlineRuns(r[c] || '', isHead ? { bold: true, size: 18 } : { size: 19 }), { after: 0 })]);
      const rows = (blank ? [] : [row(head, true)]).concat(body.map((r) => row(r, false)));
      d.body.push(d.tableXml(rows, { widths, border: 'single', borderColor: 'BBBBBB', cellMargin: 80, headerShade: blank ? '' : 'E8EEF6' }));
      d.paragraph([{ text: '' }], { after: 60 });
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const start = i;
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        // an item: at the margin, or the indented bullet this list happens to start with
        if (m && (m[1].length <= 1 || i === start)) {
          const parts = [m[3]];
          i++;
          while (i < lines.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !/^\s*[-*]\s/.test(lines[i])) { parts.push(lines[i].trim()); i++; }
          d.paragraph(inlineRuns(parts.join(' ').replace(/^☐\s*/, '☐ ')), { bullet: !ordered, numbered: ordered, after: 60, line: 252 });
          // nested bullets, each with the lines wrapped under it
          while (i < lines.length && /^\s{2,}[-*]\s/.test(lines[i])) {
            const sub = [lines[i].replace(/^\s*[-*]\s+/, '')];
            i++;
            while (i < lines.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !/^\s*[-*]\s/.test(lines[i])) { sub.push(lines[i].trim()); i++; }
            d.paragraph(inlineRuns('– ' + sub.join(' ')), { after: 40, line: 252 });
          }
          continue;
        }
        break;
      }
      if (i === start) { para.push(line.trim()); i++; }   // never stand still on a line
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return d;
}
