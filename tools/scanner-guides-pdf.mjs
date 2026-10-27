/*
 * On the scanner, printed: one sheet for each page under docs/guides/on-the-scanner/,
 * the gun's own screens down the left and what to do on the right, and every page
 * together in one booklet with a contents page in front.
 *
 *   node tools/scanner-guides-pdf.mjs     -> docs/guides/on-the-scanner/<page>.pdf
 *                                            docs/guides/on-the-scanner/on-the-scanner.pdf
 *   node tools/scanner-guides-pdf.mjs --es -> docs/guides/on-the-scanner/es/<page>.pdf
 *                                            docs/guides/on-the-scanner/es/en-el-escaner.pdf
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { markdownToHtml, inline } from './md.mjs';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const ES = process.argv.includes('--es');
const DIR = join(ROOT, 'docs', 'guides', 'on-the-scanner', ...(ES ? ['es'] : []));
const W = ES
  ? { band: 'En el escáner · conteo completo', of: 'de', when: 'Cuándo', pages: 'páginas', title: 'En el escáner', sub: 'Una página para cada cosa de un conteo completo que no es lo normal de rack, tarima, cantidad. Busca la que tienes enfrente y haz lo que dice.', printed: 'impreso', booklet: 'en-el-escaner.pdf', locale: 'es-MX' }
  : { band: 'On the scanner · full count', of: 'of', when: 'When', pages: 'pages', title: 'On the scanner', sub: 'One page for each thing on a full count that is not the plain rack label, pallet label, quantity. Find the one in front of you, and do what it says.', printed: 'printed', booklet: 'on-the-scanner.pdf', locale: 'en-US' };
const IMAGES = join(ROOT, 'docs', 'images');
// the order the app lists them in
const ORDER = (/const ORDER = \[([\s\S]*?)\];/.exec(readFileSync(join(ROOT, 'src', 'routes', 'guides.js'), 'utf8'))[1].match(/'([a-z0-9-]+)'/g) || []).map((x) => x.slice(1, -1));
const names = readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.slice(0, -3))
  .sort((a, b) => ((ORDER.indexOf(a) + 1 || 999) - (ORDER.indexOf(b) + 1 || 999)) || a.localeCompare(b));
const printed = new Date().toLocaleDateString(W.locale, { year: 'numeric', month: 'long', day: 'numeric' });

/** One guide: its title, when, lead, the pictures with their captions, and the sections as HTML. */
function read(name) {
  const md = readFileSync(join(DIR, `${name}.md`), 'utf8');
  const title = /^#\s+(.*)$/m.exec(md)[1].replace(/^(On the scanner|En el escáner) — /, '');
  const when = (/\*\*(?:When|Cuándo):\*\*\s*(.+)$/m.exec(md) || [, , ''])[1].trim();
  const parts = md.split(/^## /m);
  const lead = parts[0].replace(/^#.*$/m, '').replace(/^\*\*(Role|Rol):\*\*.*$/m, '').trim();
  const sections = parts.slice(1).map((p) => ({ head: p.slice(0, p.indexOf('\n')).trim(), body: p.slice(p.indexOf('\n')).trim() }));
  // the first section is the pictures: What you see, Lo que ves
  const see = sections[0];
  const pics = [];
  let note = '';
  if (see) {
    const lines = see.body.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const m = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(lines[i]);
      if (m) { const cap = /^\*(.*)\*$/.exec(lines[i + 1] || ''); pics.push({ src: `file://${IMAGES}/${m[1].replace(/^(\.\.\/)*images\//, '')}`, cap: cap ? cap[1] : '' }); if (cap) i++; }
      else note += lines[i] + '\n';
    }
  }
  const rest = sections.slice(1);
  return { name, title, when, lead, pics, note, rest };
}

const CSS = `
  @page { size: Letter; margin: 12mm 13mm 14mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: #16191d; font: 10pt/1.45 "DejaVu Sans", Arial, sans-serif; }
  .sheet { page-break-after: always; break-after: page; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  .band { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 3px solid #1e4f8f; padding-bottom: 2mm; margin-bottom: 3mm; }
  .band .k { font-size: 8.5pt; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #1e4f8f; }
  .band .n { font-size: 8.5pt; color: #5b6470; }
  h1 { font-size: 20pt; line-height: 1.15; margin: 0 0 1.5mm; letter-spacing: -.01em; }
  .when { font-size: 10pt; color: #5b6470; margin-bottom: 3mm; }
  .when b { color: #16191d; }
  .lead { font-size: 11pt; margin: 0 0 4mm; padding: 3mm 4mm; background: #f2f5f9; border-left: 3px solid #1e4f8f; }
  .lead p { margin: 0; }
  .cols { display: grid; grid-template-columns: 52mm 1fr; gap: 6mm; align-items: start; }
  .pics figure { margin: 0 0 3mm; text-align: center; }
  .pics img { width: 100%; max-height: 74mm; object-fit: contain; border: 1px solid #b9c2cd; border-radius: 3px; display: block; margin: 0 auto; }
  .pics figcaption { font-size: 7.8pt; color: #5b6470; line-height: 1.3; margin-top: 1mm; font-style: italic; }
  .pics .note { font-size: 9pt; color: #5b6470; font-style: italic; border: 1px dashed #b9c2cd; border-radius: 3px; padding: 3mm; }
  .pics.none { display: none; }
  .pics.n3 img { max-height: 52mm; }
  .pics.n3 figure { margin-bottom: 2mm; }
  .cols.nopics { grid-template-columns: 1fr; }
  h2 { font-size: 12pt; color: #1e4f8f; margin: 0 0 1.8mm; padding-bottom: 1mm; border-bottom: 1px solid #d5dae1; }
  .sec { margin-bottom: 3.5mm; }
  .sec.office { background: #f2f5f9; border-radius: 4px; padding: 2.5mm 3.5mm; }
  .sec.dont h2 { color: #a23a3a; }
  p { margin: 0 0 2mm; }
  ol, ul { margin: 0 0 2mm; padding-left: 5.5mm; }
  li { margin-bottom: 1.2mm; }
  li > ul { margin-top: 1mm; }
  strong { font-weight: 700; }
  code { font-family: "DejaVu Sans Mono", monospace; font-size: 8.8pt; }
  .foot { position: fixed; bottom: -8mm; left: 0; right: 0; font-size: 7.5pt; color: #7b8694; display: flex; justify-content: space-between; }
  /* the booklet's front */
  .cover h1 { font-size: 28pt; margin: 6mm 0 4mm; }
  .cover .sub { font-size: 11.5pt; color: #2c3340; max-width: 160mm; margin-bottom: 5mm; }
  .cover table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  .cover td { padding: 1.1mm 2mm; border-bottom: 1px dotted #d5dae1; vertical-align: top; line-height: 1.3; }
  .cover td.p { width: 12mm; color: #5b6470; text-align: right; font-variant-numeric: tabular-nums; }
  .cover td.t { font-weight: 700; width: 70mm; }
  .cover td.w { color: #5b6470; }
`;

function sheet(g, n, total) {
  const cls = (head) => (/office|oficina/i.test(head) ? 'sec office' : /^(Do not|No hagas)/.test(head) ? 'sec dont' : 'sec');
  const pics = g.pics.length
    ? g.pics.map((p) => `<figure><img src="${p.src}"><figcaption>${inline(p.cap)}</figcaption></figure>`).join('')
    : g.note ? `<div class="note">${markdownToHtml(g.note)}</div>` : '';
  return `<section class="sheet">
    <div class="band"><span class="k">${W.band}</span><span class="n">${n ? `${n} ${W.of} ${total}` : ''}</span></div>
    <h1>${inline(g.title)}</h1>
    <div class="when"><b>${W.when}:</b> ${inline(g.when)}</div>
    <div class="lead">${markdownToHtml(g.lead)}</div>
    <div class="cols${pics ? '' : ' nopics'}">
      <div class="pics${pics ? '' : ' none'}${g.pics.length >= 3 ? ' n3' : ''}">${pics}</div>
      <div>${g.rest.map((s) => `<div class="${cls(s.head)}"><h2>${inline(s.head)}</h2>${markdownToHtml(s.body)}</div>`).join('')}</div>
    </div>
  </section>`;
}
const doc = (body, title) => `<!doctype html><html lang="${ES ? 'es' : 'en'}"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const guides = names.map(read);
const dir = mkdtempSync(join(tmpdir(), 'scannerpdf-'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const footer = (label) => `<div style="width:100%;margin:0 13mm;font:7.5pt 'DejaVu Sans',Arial,sans-serif;color:#7b8694;display:flex;justify-content:space-between;border-top:1px solid #d5dae1;padding-top:1.5mm"><span>${label}</span><span>Full Harvest Inventory · ${W.printed} ${printed}</span></div>`;
const opts = (label) => ({ format: 'Letter', printBackground: true, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer(label), margin: { top: '12mm', bottom: '16mm', left: '13mm', right: '13mm' } });
const over = [];
try {
  const tab = await browser.newPage();
  const render = async (html, path, label) => {
    const file = join(dir, 'page.html');
    writeFileSync(file, html);
    await tab.goto(`file://${file}`, { waitUntil: 'load' });
    await tab.evaluate(() => Promise.all(Array.from(document.images).filter((i) => !i.complete).map((i) => i.decode().catch(() => {}))));
    await tab.pdf({ ...opts(label), path });
  };
  /* does a sheet fit one page? measured in the browser, at the printed width */
  await tab.setViewportSize({ width: 816, height: 1056 });
  for (const [i, g] of guides.entries()) {
    const html = doc(sheet(g, 0, 0), g.title);
    await render(html, join(DIR, `${g.name}.pdf`), `${W.title} — ${g.title}`);
    const h = await tab.evaluate(() => document.querySelector('.sheet').getBoundingClientRect().height);
    // Letter less the margins, in CSS pixels at 96 per inch
    if (h > (279.4 - 12 - 16) / 25.4 * 96) over.push(`${g.name} (${Math.round(h)}px)`);
    console.log(`${join(DIR, g.name).replace(ROOT + '/', '')}.pdf written`);
  }
  const cover = `<section class="sheet cover">
    <div class="band"><span class="k">${W.band}</span><span class="n">${guides.length} ${W.pages}</span></div>
    <h1>${W.title}</h1>
    <div class="sub">${W.sub}</div>
    <table>${guides.map((g, i) => `<tr><td class="p">${i + 2}</td><td class="t">${inline(g.title)}</td><td class="w">${inline(g.when)}</td></tr>`).join('')}</table>
  </section>`;
  await render(doc(cover + guides.map((g, i) => sheet(g, i + 1, guides.length)).join(''), W.title), join(DIR, W.booklet), W.title);
  console.log(`${join(DIR, W.booklet).replace(ROOT + '/', '')} written - ${guides.length} pages and the contents`);
  if (over.length) console.log(`\nlonger than one page: ${over.join(', ')}`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
