/*
 * The aisle sheet: every aisle on the count's bin list, printed to plan on
 * paper which team does which aisle. What each aisle is - zone, racking block,
 * bins, levels - and room to write the team for each shift, the levels, the
 * times and who checked it. As a print page, Word, or CSV; with the plan as it
 * is now printed in, or blank.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession, openPlanMore } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));
const unzipDoc = async (buf) => {
  const { inflateRawSync } = await import('node:zlib');
  const b = Buffer.from(buf); let at = 0;
  while ((at = b.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at)) >= 0) {
    const method = b.readUInt16LE(at + 8), size = b.readUInt32LE(at + 18), nlen = b.readUInt16LE(at + 26), xlen = b.readUInt16LE(at + 28);
    const name = b.subarray(at + 30, at + 30 + nlen).toString();
    const data = b.subarray(at + 30 + nlen + xlen, at + 30 + nlen + xlen + size);
    if (name === 'word/document.xml') return (method === 8 ? inflateRawSync(data) : data).toString();
    at += 30 + nlen + xlen + size;
  }
  return '';
};
const sheet = async (q = '') => (await fetch(`${BASE}/api/admin/sessions/${S}/print/aisle-sheet?${q}${q ? '&' : ''}t=${encodeURIComponent(tok)}`)).text();

/* before the bin list: the sheet says to upload it */
const S = (await post('/api/admin/sessions', { name: 'Aisle sheet count' })).id;
let html = await sheet();
check('Before the bin list is up, the sheet says to upload it first', /No bin list on this count yet/.test(html));

/* the bin list: freezer aisles F01-F03 on levels A-F, a cooler aisle C10 on A-B */
const rows = [];
for (const a of ['F01', 'F02', 'F03']) for (const lv of 'ABCDEF') for (let n = 1; n <= 3; n++) rows.push(`${a}${lv}00${n},Freezer,${a}`);
for (const lv of 'AB') for (let n = 1; n <= 4; n++) rows.push(`C10${lv}00${n},Cooler,C10`);
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + rows.join('\n') + '\n' });
await post('/api/admin/people/teams', { name: 'S1-DS01', shift: '1' });
await post('/api/admin/people/teams', { name: 'S2-RT05', shift: '2' });
await post(`/api/admin/sessions/${S}/assignments`, { team: 'S1-DS01', aisles: 'F01', levels: 'A-B', force: true });
await post(`/api/admin/sessions/${S}/assignments`, { team: 'S2-RT05', aisles: 'F01', levels: 'C-F', force: true });

html = await sheet();
const ROW = /<tr><td class="a">([^<]+)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td class="n">([^<]+)<\/td><td>([^<]*)<\/td><td class="w">([^<]*)<\/td><td class="w">([^<]*)<\/td>/g;
const trs = [...html.matchAll(ROW)].map((m) => m.slice(1));
check('A row per aisle, in aisle order, zone headings between', trs.map((r) => r[0]).join() === 'C10,F01,F02,F03' && /<tr class="zone"><td colspan="11">cooler<\/td>/i.test(html) && /<tr class="zone"><td colspan="11">freezer<\/td>/i.test(html), trs.map((r) => r[0]).join());
check('…each with its zone, bins and levels', trs[1] && /^freezer$/i.test(trs[1][1]) && trs[1][3] === '18' && trs[1][4] === 'A-F' && trs[0][3] === '8' && trs[0][4] === 'A-B', JSON.stringify(trs[1]));
check('…and the columns to write in: the team for each shift, levels, started, done, checked by', ['1st shift team', '2nd shift team', 'Levels counted', 'Started', 'Done', 'Checked by'].every((c) => html.includes(`<th>${c}</th>`)));
check('…blank team columns unless the plan is asked for', trs.length === 4 && trs.every((r) => !r[5] && !r[6]));
check('…landscape letter, the header row on every printed page', html.includes('@page { size: letter landscape;') && html.includes('thead { display: table-header-group; }'));
html = await sheet('plan=1');
const f01 = [...html.matchAll(ROW)].map((m) => m.slice(1)).find((r) => r[0] === 'F01');
check('With the plan: the teams already queued, by shift, with their levels', f01 && f01[5] === 'S1-DS01 (A-B)' && f01[6] === 'S2-RT05 (C-F)', f01 ? `${f01[5]} | ${f01[6]}` : 'no row');

/* Word and CSV */
let r = await fetch(`${BASE}/api/admin/sessions/${S}/export/aisle-sheet.docx`, { headers: A });
const doc = await unzipDoc(await r.arrayBuffer());
check('As Word: landscape, a row per aisle, the header repeated on each page', r.status === 200 && doc.includes('w:orient="landscape"') && doc.includes('<w:tblHeader/>') && ['C10', 'F01', 'F02', 'F03'].every((a) => doc.includes(`>${a}</w:t>`)) && /aisle-sheet-Aisle-sheet-count\.docx/.test(r.headers.get('content-disposition') || ''));
r = await fetch(`${BASE}/api/admin/sessions/${S}/export/aisle-sheet.csv?plan=1`, { headers: A });
const text = await r.text();
check('As CSV: the same columns, the plan in it when asked', text.startsWith('Aisle,Zone,Racking block,Bins,Levels,1st shift team,2nd shift team,Levels counted,Started,Done,Checked by') && /F01,freezer,[^,]*,18,A-F,S1-DS01 \(A-B\),S2-RT05 \(C-F\)/i.test(text), text.split('\n')[2]);

/* the page */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await pickSession(page, S);
await page.waitForTimeout(800);
const [pop] = await Promise.all([page.waitForEvent('popup', { timeout: 10000 }).catch(() => null), page.click('#btnAisleSheetTop')]);
if (pop) await pop.waitForLoadState().catch(() => {});
check('🖨 Aisle sheet on the team plan opens the sheet to print', pop && /Aisle sheet — Aisle sheet count/.test(await pop.title()) && (await pop.$$('td.a')).length === 4, pop ? await pop.title() : 'no window');
await openPlanMore(page);
await page.click('#btnPlanFileTools');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#btnAisleSheetDocx')]);
check('…⬇ Word under ⇅ Plan file downloads it, named for the count', dl && dl.suggestedFilename() === 'aisle-sheet-Aisle-sheet-count.docx', dl ? dl.suggestedFilename() : 'none');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
