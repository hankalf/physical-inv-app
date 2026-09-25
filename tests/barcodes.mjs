/*
 * The barcode test book.
 *
 * A page of real Code 128 labels to print, cut up and scan: for training a crew,
 * or for dry-running a count before the real one. The whole thing is worthless
 * if the bars are wrong, and "it looks like a barcode" is not a test - so these
 * read the drawing back: the widths in the SVG are decoded into symbol values,
 * the check character is recomputed, and the text that comes out is compared
 * with what went in. That is the same arithmetic a scanner does.
 *
 * Two hand-computed vectors keep the decoder honest, in case it and the encoder
 * ever agree on the same mistake.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { widths, barcodeSvg, barcodeWidthMm } from '../src/util/barcode.js';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* ---------------- hand-computed, from the Code 128 tables ---------------- */
/* "A": start B (104) + 'A' (33), check = (104 + 33*1) % 103 = 34, then stop. */
check('A one-character symbol is start B, the letter, the check character and stop',
  widths('A') === '211214' + '111323' + '131123' + '2331112', widths('A'));
/* "1234" packs into set C: start C (105) + 12 + 34, check = (105 + 12 + 68) % 103 = 82. */
check('Four digits go in set C, two to a symbol, which is what keeps a numeric ID narrow',
  widths('1234') === '211232' + '112232' + '131123' + '121241' + '2331112', widths('1234'));
check('...and that really is narrower than the same length in letters',
  barcodeWidthMm('12345678') < barcodeWidthMm('ABCDEFGH'),
  `${barcodeWidthMm('12345678').toFixed(1)}mm vs ${barcodeWidthMm('ABCDEFGH').toFixed(1)}mm`);

/* ---------------- read the drawing back, the way a scanner would ---------------- */
const PATTERNS = (() => {
  /* Rebuilt here from the one place they are written down, but used in the
     opposite direction: widths -> value. */
  const src = readFileSync(new URL('../src/util/barcode.js', import.meta.url).pathname, 'utf8');
  const block = src.slice(src.indexOf('const PATTERNS = ['), src.indexOf('];', src.indexOf('const PATTERNS = [')));
  const list = block.match(/'(\d+)'/g).map((x) => x.replace(/'/g, ''));
  const byPattern = new Map(list.map((p, i) => [p, i]));
  return { list, byPattern };
})();

/** Decode an SVG barcode: bar widths -> symbol values -> the text on the label. */
function decodeSvg(svg) {
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)]
    .map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
  if (!rects.length) throw new Error('no bars');
  /* The narrowest bar IS one module - a scanner works it out the same way, which
     is why the same reader copes with a label printed at any size. */
  const module = rects.reduce((n, r) => Math.min(n, r.w), Infinity);
  /* Rebuild the run lengths: a bar is a rect, a space is the gap to the next. */
  const runs = [];
  for (let i = 0; i < rects.length; i++) {
    runs.push(Math.round(rects[i].w / module));
    const next = rects[i + 1];
    if (next) runs.push(Math.round((next.x - (rects[i].x + rects[i].w)) / module));
  }
  const digits = runs.join('');
  const values = [];
  let at = 0;
  while (at < digits.length) {
    const take = digits.length - at === 7 ? 7 : 6;       // the stop pattern is seven
    const value = PATTERNS.byPattern.get(digits.slice(at, at + take));
    if (value === undefined) throw new Error(`unknown pattern at ${at}`);
    values.push(value);
    at += take;
  }
  const stop = values.pop();
  const given = values.pop();
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  const start = values.shift();
  let mode = start === 105 ? 'C' : 'B';
  let text = '';
  for (const v of values) {
    if (v === 99) { mode = 'C'; continue; }
    if (v === 100) { mode = 'B'; continue; }
    text += mode === 'C' ? String(v).padStart(2, '0') : String.fromCharCode(v + 32);
  }
  return { text, checkOk: given === sum % 103, stopOk: stop === 106, start };
}

for (const code of ['F01A001', 'PLT01002A', 'F02-118', 'LOT-4471', '12345678', 'A1-B2/C3 D4']) {
  const d = decodeSvg(barcodeSvg(code));
  check(`A scanner reading the printed label gets back "${code}"`,
    d.text === code && d.checkOk && d.stopOk, `${d.text} · check ${d.checkOk} · stop ${d.stopOk}`);
}
check('The quiet zone is there — bars hard against the edge of a label do not read',
  /<rect x="1.080"/.test(barcodeSvg('F01A001')), barcodeSvg('F01A001').match(/<rect x="[\d.]+"/)[0]);
check('The human-readable code is printed under the bars, for when a scanner will not',
  />F01A001<\/text>/.test(barcodeSvg('F01A001')));
let refused = '';
try { barcodeSvg('CAFÉ-1'); } catch (err) { refused = err.message; }
check('A character Code 128 cannot carry is refused rather than quietly dropped',
  /cannot go in a Code 128/.test(refused), refused);

/* ================= the printed book ================= */
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'book test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF02A001,Freezer,F02\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nBK-001,SKU-4120,Chicken breast IQF 40lb,40,F01A001\nBK-002,SKU-2210,Peas petite,33,F02A001\n' });

const book = (q) => fetch(`${BASE}/api/admin/print/barcode-book?${q}`, { headers: A }).then((r) => r.text());
/* Every barcode on the page, in the order they are printed - which is the order
   a trainee works down it. */
const codesOn = (html) => [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => decodeSvg(m[0]).text);
const rowsOn = (html) => [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].filter((m) => /<td/.test(m[0])).map((m) => m[0]);

const lines = await book(`session=${sess.id}`);
check('The book is a line per pallet: the bin, the pallet in it, and the quantity',
  /<th class="bin">Bin<\/th>/.test(lines) && /<th class="pallet">Pallet<\/th>/.test(lines) && /<th class="qty">Qty<\/th>/.test(lines));
check('...one row per pallet on the count', rowsOn(lines).length === 2, String(rowsOn(lines).length));
check('...with the bin and the pallet both scannable, in that order',
  codesOn(lines).join(' ') === 'F01A001 BK-001 F02A001 BK-002', codesOn(lines).join(' '));
check('...and the quantity printed as a number to key in', /<div class="n">40<\/div>/.test(lines) && /<div class="n">33<\/div>/.test(lines));
check('...which is not a barcode unless somebody asks for one', codesOn(lines).every((c) => !/^\d+$/.test(c)));
check('...and what is on the pallet, so a demo means something', /SKU-4120/.test(lines));

const withQty = await book(`session=${sess.id}&qty=1`);
check('The quantity can be scannable too, for a scan-everything demo',
  codesOn(withQty).join(' ') === 'F01A001 BK-001 40 F02A001 BK-002 33', codesOn(withQty).join(' '));

const oneAisle = await book(`session=${sess.id}&aisle=F02`);
check('An aisle can be picked, so a trainer prints one rack rather than the warehouse',
  rowsOn(oneAisle).length === 1 && /BK-002/.test(oneAisle), String(rowsOn(oneAisle).length));
const binsOnly = await book(`session=${sess.id}&kind=bins`);
check('Bins can be printed on their own — an empty bay is worth practising too',
  rowsOn(binsOnly).length === 3 && codesOn(binsOnly).join(' ') === 'F01A001 F01A002 F02A001',
  codesOn(binsOnly).join(' '));
check('...and those rows have nothing in the pallet or quantity columns',
  (binsOnly.match(/<span class="empty">—<\/span>/g) || []).length >= 6,
  String((binsOnly.match(/<span class="empty">—<\/span>/g) || []).length));
const few = await book(`session=${sess.id}&limit=1`);
check('How many is a choice — a 14,000-bin warehouse is not a print job', rowsOn(few).length === 1, String(rowsOn(few).length));

const uploaded = await (await fetch(`${BASE}/api/admin/print/barcode-book`, { method: 'POST', headers: A,
  body: JSON.stringify({ rows: [
    { bin: 'TRAIN-A1', pallet: 'TRAIN-P1', qty: 12, note: 'a practice line' },
    { bin: 'TRAIN-A2', pallet: '', qty: '' },
    { bin: '', pallet: '' },
  ] }) })).text();
check('A sheet of codes that exist nowhere can be printed — that is the point of practising',
  rowsOn(uploaded).length === 2 && codesOn(uploaded).join(' ') === 'TRAIN-A1 TRAIN-P1 TRAIN-A2',
  codesOn(uploaded).join(' '));
check('...an empty row is dropped rather than printed blank', !/TRAIN-A3/.test(uploaded) && rowsOn(uploaded).length === 2);
check('...and a bin with no pallet prints as a bay with nothing in it', /TRAIN-A2/.test(uploaded) && /<span class="empty">—<\/span>/.test(uploaded));
check('Printing is in the log',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'printed a barcode test book'));
check('The book needs a supervisor sign-in', (await fetch(`${BASE}/api/admin/print/barcode-book?session=${sess.id}`)).status === 401);

/* ================= the spreadsheet ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/settings');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(800);

check('The card is on the Settings page', await page.$('#btnBookTemplate') !== null);
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('#btnBookTemplate'),
]);
check('The template downloads as a real Excel file', /\.xlsx$/.test(download.suggestedFilename()), download.suggestedFilename());
const tmp = `/tmp/${download.suggestedFilename()}`;
await download.saveAs(tmp);
const bytes = readFileSync(tmp);
check('...and it is a workbook, not a renamed CSV', bytes.subarray(0, 2).toString() === 'PK', bytes.subarray(0, 2).toString());
/* Upload a CSV of codes and check the printable page that opens carries them. */
await page.setInputFiles('#fBookFile', {
  name: 'my-codes.csv', mimeType: 'text/csv',
  buffer: Buffer.from('Bin,Pallet,Qty,Note\nPRACTICE-A1,PRACTICE-P1,25,a line to practise on\n'),
});
const [printed] = await Promise.all([
  page.context().waitForEvent('page', { timeout: 20000 }),
  page.click('#btnBookUpload'),
]);
await printed.waitForTimeout(800);
const printedHtml = await printed.content();
check('Uploading a filled-in sheet opens the printable book', /PRACTICE-A1/.test(printedHtml) && /PRACTICE-P1/.test(printedHtml));
check('...as one line: bin, pallet, quantity',
  [...printedHtml.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => decodeSvg(m[0]).text).join(' ') === 'PRACTICE-A1 PRACTICE-P1'
  && /<div class="n">25<\/div>/.test(printedHtml),
  [...printedHtml.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => decodeSvg(m[0]).text).join(' '));
await printed.close();
check('And the page says how many lines came off the sheet',
  /1 line from my-codes\.csv/.test(clean(await page.textContent('#bookMsg'))), clean(await page.textContent('#bookMsg')));

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} barcode checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
