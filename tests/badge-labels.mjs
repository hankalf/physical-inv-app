/*
 * Badge labels on Avery 5960: every active person on the crew list, name,
 * clock-in number and its barcode, as a Word document the office can print -
 * one, two or three of each person side by side, one shift or everyone.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';
import { parseBadgeList, badgeLabelsDocx } from '../src/util/badge-labels.js';
import { widths } from '../src/util/barcode.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const unzipText = async (buf) => {
  const { inflateRawSync } = await import('node:zlib');
  const b = Buffer.from(buf); let out = ''; let at = 0;
  while ((at = b.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at)) >= 0) {
    const method = b.readUInt16LE(at + 8), size = b.readUInt32LE(at + 18), nlen = b.readUInt16LE(at + 26), xlen = b.readUInt16LE(at + 28);
    const name = b.subarray(at + 30, at + 30 + nlen).toString();
    const data = b.subarray(at + 30 + nlen + xlen, at + 30 + nlen + xlen + size);
    if (name === 'word/document.xml') out = (method === 8 ? inflateRawSync(data) : data).toString();
    at += 30 + nlen + xlen + size;
  }
  return out;
};

/* the list as pasted from Excel */
const list = parseBadgeList('badge\tname\n999545\tAlexis B Anzora Granados\n999394\tDavid Ortega\n999394\tDavid Ortega\n\n999319\tDennis Ramos\n');
check('A pasted list: header skipped, a repeat kept once, in order', list.length === 3 && list[0].badge === '999545' && list[0].name === 'Alexis B Anzora Granados' && list[2].name === 'Dennis Ramos', JSON.stringify(list));
check('…a CSV reads the same', parseBadgeList('Clock In Number,Name\n999545,Alexis B Anzora Granados').length === 1);

const xml = await unzipText(badgeLabelsDocx(list, { perPerson: 2 }));
check('The sheet is sized to Avery 5960: 1/2" top, 3/16" left, 2 5/8" labels with a 1/8" gap, rows exactly 1"',
  /<w:pgMar w:top="720" w:right="0" w:bottom="0" w:left="270"/.test(xml) && /<w:gridCol w:w="3780"\/><w:gridCol w:w="180"\/><w:gridCol w:w="3780"\/><w:gridCol w:w="180"\/><w:gridCol w:w="3780"\/>/.test(xml)
  && (xml.match(/<w:trHeight w:val="1440" w:hRule="exact"\/>/g) || []).length === 3 && /<w:tblInd w:w="0"/.test(xml));
check('…two of each person side by side, the third label blank', (xml.match(/Alexis B Anzora Granados<\/w:t>/g) || []).length === 2 && (xml.match(/<pic:pic /g) || []).length === 6);
check('…each with the number under the name', (xml.match(/>999545<\/w:t>/g) || []).length === 2);
check('A number goes in Code 128 set C: six digits stay narrow', widths('999545').length < widths('ABCDEF').length, `${widths('999545').length} vs ${widths('ABCDEF').length}`);

/* from the crew list, in the app */
for (const [badge, name, shift] of [['BL101', 'Ana Lima', '1'], ['BL102', 'Ben Cole', '2'], ['BL103', 'Cy Dunn', '1']]) await post('/api/admin/people/employees', { badge, name, shift, equipment: [] });
await post('/api/admin/people/employees', { badge: 'BL104', name: 'Left Already', shift: '1', equipment: [], active: 0 });
let r = await fetch(`${BASE}/api/admin/people/export/badge-labels.docx?per=3&shift=1`, { headers: A });
let body = Buffer.from(await r.arrayBuffer());
let doc = await unzipText(body);
check('Teams & crew: a Word file of badge labels', r.status === 200 && body.subarray(0, 2).toString() === 'PK' && /badge-labels-avery-5960-shift-1\.docx/.test(r.headers.get('content-disposition') || ''), `${r.status} ${r.headers.get('content-disposition')}`);
check('…one shift: its active people only, three of each', (doc.match(/Ana Lima<\/w:t>/g) || []).length === 3 && (doc.match(/Cy Dunn<\/w:t>/g) || []).length === 3 && !/Ben Cole|Left Already/.test(doc));
r = await fetch(`${BASE}/api/admin/people/export/badge-labels.docx?shift=2`, { headers: A });
doc = await unzipText(Buffer.from(await r.arrayBuffer()));
check('…with no choice made, three of each: a full row', (doc.match(/Ben Cole<\/w:t>/g) || []).length === 3);
r = await fetch(`${BASE}/api/admin/people/export/badge-labels.docx?shift=7`, { headers: A });
check('…a shift with nobody says so', r.status === 404 && /nobody active on shift 7/.test((await j(r)).error));
r = await fetch(`${BASE}/api/admin/people/export/badge-labels.docx`);
check('…and it is for a signed-in office user', r.status === 401 || r.status === 403, String(r.status));

/* the button */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/teams`);
await signIn(page); await page.waitForTimeout(600);
await page.selectOption('#fBadgeShift', '2'); await page.selectOption('#fBadgePer', '2');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#btnBadgeLabels')]);
check('The button downloads the labels for the shift chosen', dl && dl.suggestedFilename() === 'badge-labels-avery-5960-shift-2.docx', dl ? dl.suggestedFilename() : 'no download');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
