/*
 * docs/SOP.md -> docs/SOP.pdf, the manual as it is meant to be printed.
 *
 *   node tools/sop-pdf.mjs
 *
 * Chromium does the typesetting (it is already here for the tests), so what
 * prints is what the screenshots were taken in. Two passes: the first lays the
 * manual out, the second puts the page numbers it found into the contents.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { markdownToHtml, inline } from './md.mjs';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const SRC = join(ROOT, 'docs', 'SOP.md');
const OUT = join(ROOT, 'docs', 'SOP.pdf');

const md = readFileSync(SRC, 'utf8');
const title = /^#\s+(.*)$/m.exec(md)?.[1] || 'Standard Operating Procedure';
const printed = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/* The manual's own contents list becomes the printed one, so the two can never
   drift apart; the page numbers are filled in after the first pass. */
const contents = [...md.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)$/gm)].map((m) => ({ label: m[1], id: m[2] }));

/* Everything from the first heading after the contents block onwards is the
   body: the cover page and the contents are set separately. */
const bodyStart = md.indexOf('\n## Part 0');
const intro = md.slice(md.indexOf('\n', md.indexOf('# ')), md.indexOf('## Contents')).trim();
const body = markdownToHtml(md.slice(bodyStart));

const CSS = `
  @page { size: Letter; margin: 16mm 14mm 18mm; }
  :root { --ink: #16191d; --soft: #5b6470; --line: #d5dae1; --rule: #b9c2cd; --accent: #1e4f8f; --wash: #f2f5f9; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: var(--ink); background: #fff;
         font: 10.5pt/1.55 "DejaVu Sans", "Helvetica Neue", Arial, sans-serif; }

  /* ---------- cover ---------- */
  .cover { height: 232mm; display: flex; flex-direction: column; justify-content: center;
           page-break-after: always; text-align: left; }
  .cover .kicker { font-size: 11pt; letter-spacing: .22em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
  .cover h1 { font-size: 30pt; line-height: 1.15; margin: 10mm 0 6mm; letter-spacing: -.01em; }
  .cover .site { font-size: 13pt; color: var(--soft); margin: 0 0 12mm; }
  .cover .rule { height: 3px; background: var(--accent); width: 46mm; margin-bottom: 12mm; }
  .cover .lede { font-size: 11pt; max-width: 135mm; color: #2c3340; }
  .cover .lede p { margin: 0 0 4mm; }
  .cover .foot { margin-top: 16mm; font-size: 9.5pt; color: var(--soft); }

  /* ---------- contents ---------- */
  .toc { page-break-after: always; }
  .toc h2 { margin-top: 0; }
  .toc ol { list-style: none; margin: 8mm 0 0; padding: 0; }
  .toc li { display: flex; align-items: baseline; gap: 3mm; padding: 2.4mm 0; border-bottom: 1px dotted var(--line); font-size: 11pt; }
  .toc li .t { flex: 1; }
  .toc li .n { color: var(--soft); font-variant-numeric: tabular-nums; }
  .toc a { color: var(--ink); text-decoration: none; }

  /* ---------- headings ---------- */
  h2 { font-size: 17pt; margin: 0 0 5mm; padding-bottom: 2.5mm; border-bottom: 2px solid var(--accent);
       page-break-before: always; page-break-after: avoid; letter-spacing: -.01em; }
  h2:first-of-type { page-break-before: avoid; }
  h3 { font-size: 12.5pt; margin: 8mm 0 3mm; color: var(--accent); page-break-after: avoid; }
  h4 { font-size: 11pt; margin: 6mm 0 2mm; page-break-after: avoid; }
  p { margin: 0 0 3.4mm; orphans: 2; widows: 2; }
  a { color: var(--accent); }
  hr { display: none; }                      /* the section rules are the headings now */
  strong { font-weight: 700; }
  code { font-family: "DejaVu Sans Mono", Menlo, monospace; font-size: 9pt;
         background: var(--wash); border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }

  ul, ol { margin: 0 0 3.6mm; padding-left: 6.5mm; }
  li { margin-bottom: 1.6mm; page-break-inside: avoid; }
  li > ul { margin-top: 1.6mm; }

  blockquote { margin: 4mm 0; padding: 3.5mm 5mm; background: var(--wash);
               border-left: 3px solid var(--accent); page-break-inside: avoid; }
  blockquote p:last-child { margin-bottom: 0; }

  pre.code { background: var(--wash); border: 1px solid var(--line); border-radius: 4px;
             padding: 3.5mm 4mm; font-size: 9pt; overflow: hidden; page-break-inside: avoid;
             font-family: "DejaVu Sans Mono", Menlo, monospace; white-space: pre-wrap; }

  /* ---------- tables ---------- */
  table.data { width: 100%; border-collapse: collapse; margin: 0 0 5mm; font-size: 9.5pt; }
  table.data th { text-align: left; background: var(--accent); color: #fff; font-size: 8.5pt;
                  letter-spacing: .06em; text-transform: uppercase; padding: 2.2mm 2.6mm; }
  table.data td { border-bottom: 1px solid var(--line); padding: 2.2mm 2.6mm; vertical-align: top; }
  table.data tr { page-break-inside: avoid; }
  table.data tbody tr:nth-child(even) td { background: #fafbfd; }

  /* the manual lays screenshots out side by side in a header-less table */
  table.figures { width: 100%; border-collapse: collapse; margin: 4mm 0 6mm; page-break-inside: avoid; }
  table.figures td { width: 33%; }
  table.figures tr { page-break-inside: avoid; }
  table.figures td { padding: 2mm; vertical-align: top; text-align: center;
                     font-size: 8.5pt; line-height: 1.4; color: var(--soft); }
  /* a strip of handheld screens has to fit on one page, or the sequence reads
     across a page turn */
  table.figures img { max-width: 100%; max-height: 74mm; margin-bottom: 1.5mm;
                      border: 1px solid var(--line); border-radius: 3px; }

  /* ---------- figures ---------- */
  figure { margin: 3.5mm 0 4mm; page-break-inside: avoid; text-align: center; }
  /* a screenshot is never worth a page of its own: cap it so it drops into the
     space left on the page rather than pushing itself onto the next one */
  figure img { max-width: 100%; max-height: 88mm; border: 1px solid var(--rule); border-radius: 3px; }
  p.caption { margin: -2mm 0 5mm; font-size: 8.8pt; color: var(--soft); text-align: center;
              font-style: italic; page-break-before: avoid; }
`;

const tocHtml = (pages) => `
  <section class="toc">
    <h2 style="page-break-before:avoid">Contents</h2>
    <ol>
      ${contents.map((c) => `<li><span class="t"><a href="#${c.id}">${inline(c.label)}</a></span>
        <span class="n">${pages[c.id] ? pages[c.id] : ''}</span></li>`).join('\n')}
    </ol>
  </section>`;

/* The HTML is laid out in a temporary directory, so the manual's relative
   image paths have to be pointed back at docs/images where the pictures live. */
const absolute = (html) => html.replace(/src="images\//g, `src="file://${join(ROOT, 'docs')}/images/`);

const page = (pages) => absolute(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head>
<body>
  <section class="cover">
    <div class="kicker">Standard Operating Procedure</div>
    <h1>Physical Inventory<br>Counting</h1>
    <div class="site">Front Royal, VA cold storage &middot; Zebra MC9000-series handhelds</div>
    <div class="rule"></div>
    <div class="lede">${markdownToHtml(intro.replace(/^\*\*Site:.*$/m, ''))}</div>
    <div class="foot">Printed ${printed}</div>
  </section>
  ${tocHtml(pages)}
  ${body}
</body></html>`);


/*
 * Reading the finished PDF back.
 *
 * pypdfium2 is not a dependency of the app - it is what this machine happens to
 * have for looking inside a PDF. Without it the manual still prints, just with
 * no page numbers against the contents.
 */
function pdfText(path) {
  const py = `
import json, sys
import pypdfium2 as pdfium
doc = pdfium.PdfDocument(sys.argv[1])
out = []
for i in range(len(doc)):
    out.append(doc[i].get_textpage().get_text_range())
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-c', py, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const flat = (s) => s.replace(/\s+/g, ' ').replace(/[\u2013\u2014]/g, '-').trim();

function pageNumbers(path) {
  const text = pdfText(path);
  if (!text) {
    console.warn('  (no page numbers in the contents: python3 with pypdfium2 is not available here)');
    return {};
  }
  const out = {};
  for (const c of contents) {
    const want = flat(c.label);
    const at = text.findIndex((t, n) => n > 1 && flat(t).includes(want));
    if (at >= 0) out[c.id] = at + 1;
  }
  return out;
}

const pageCount = (path) => (pdfText(path) || []).length;

const dir = mkdtempSync(join(tmpdir(), 'soppdf-'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
try {
  const tab = await browser.newPage();
  const pdfOptions = {
    format: 'Letter',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;margin:0 14mm;font:8pt 'DejaVu Sans',Arial,sans-serif;color:#7b8694;
        display:flex;justify-content:space-between;border-top:1px solid #d5dae1;padding-top:2mm">
        <span>Physical Inventory Counting &middot; SOP</span><span class="pageNumber"></span></div>`,
    margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
  };

  // pass 1: lay the manual out
  const render = async (pages, path) => {
    const file = join(dir, 'sop.html');
    writeFileSync(file, page(pages));
    await tab.goto(`file://${file}`, { waitUntil: 'load' });
    await tab.evaluate(() => Promise.all(
      Array.from(document.images).filter((i) => !i.complete).map((i) => i.decode().catch(() => {}))));
    await tab.pdf({ ...pdfOptions, path });
  };
  const draft = join(dir, 'draft.pdf');
  await render({}, draft);

  /* Which printed page each part landed on. Chromium will not say, so read it
     back off the PDF it just made - the only answer that cannot be wrong. */
  const pages = pageNumbers(draft);

  // pass 2: the real thing, with the contents numbered
  await render(pages, OUT);
  const total = Object.keys(pages).length ? pageCount(OUT) : 0;
  console.log(`docs/SOP.pdf written${total ? ` - ${total} pages` : ''}`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
