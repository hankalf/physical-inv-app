/*
 * The file checked before it is loaded: duplicates, pallets in bins not on
 * the list, quantities that will not read, odd characters, a System column
 * half filled - listed first, each with what it means; load it anyway or fix
 * the file. A fault that stops the load is refused.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const pj = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));
const checkFile = async (S, kind, text, q = '') => j(await fetch(`${BASE}/api/admin/sessions/${S}/master/check?kind=${kind}${q}`, { method: 'POST', headers: csv, body: text }));
const f = (c, key) => c.findings.find((x) => x.key === key);

const S = (await pj('/api/admin/sessions', { name: 'Checked upload' })).id;

/* ---- the bin list ---- */
let c = await checkFile(S, 'bins', 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A001,Freezer,F01\nF01A 003,Freezer,F01\n,Freezer,F01\n');
check('Bins: the same bin twice, a code with a space, a blank row - each named', f(c, 'dupBins')?.n === 1 && f(c, 'dupBins').list[0] === 'F01A001 ×2' && f(c, 'oddBins')?.n === 1 && /F01A 003/.test(f(c, 'oddBins').list[0]) && f(c, 'blankBins')?.n === 1 && c.warns === 2 && c.fails === 0, JSON.stringify(c.findings.map((x) => [x.key, x.n])));
c = await checkFile(S, 'bins', 'Zone,Aisle\nFreezer,F01\n');
check('Bins: no bin column is a fault that stops the load, naming the columns found', c.fails === 1 && f(c, 'noBinColumn').list.join() === 'Zone,Aisle', JSON.stringify(c.findings));
c = await checkFile(S, 'bins', 'Bin Location\n');
check('An empty file is refused', c.fails === 1 && f(c, 'empty'));
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\n' });
c = await checkFile(S, 'bins', 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\n', '&replace=1');
check('Bins with Replace ticked: the bins the file no longer has are named', f(c, 'binsGone')?.n === 2 && f(c, 'binsGone').list.join() === 'F01A002,F01A003', JSON.stringify(f(c, 'binsGone')));

/* ---- the inventory report ---- */
const REPORT = `Bin Code,Container No.,Item No.,Quantity,System
F01A001,P1,S1,10,JustFood
F01A002,P1,S1,10,JustFood
F01A003,P2,S2,,JustFood
F01A003,P3,S3,abc,JustFood
F09Z001,P4,S4,-5,JustFood
F09Z001,P5,S5,2000000,
F01A001,P 6,S6,10,JustFood
F01A001,F01A002,S7,10,Harvest
F01A002,P8,,10,JustFood
F01A002,P8,S8,10,Harvest
F01A003,OPEN-X,S9,10,JustFood
,P10,S10,10,JustFood
F01A002,,,,OPEN
`;
c = await checkFile(S, 'pallets', REPORT);
const keys = Object.fromEntries(c.findings.map((x) => [x.key, x]));
check('Report: a pallet in two bins', keys.dupPallets?.n === 1 && keys.dupPallets.list[0] === 'P1 (F01A001 and F01A002)', JSON.stringify(keys.dupPallets));
check('…a pallet under two systems', keys.dupSystems?.n === 1 && /P8 \(JUSTFOOD, HARVEST\)/.test(keys.dupSystems.list[0]), JSON.stringify(keys.dupSystems));
check('…pallets in bins not on the list, the bin with the most first', keys.binsNotOnList?.n === 2 && keys.binsNotOnList.list[0] === 'F09Z001 (2)', JSON.stringify(keys.binsNotOnList));
check('…a blank quantity, one that will not read, a negative one, one over a million', keys.blankQty?.n === 1 && keys.badQty?.list[0] === 'P3 "abc"' && keys.nonPositive?.n === 1 && keys.hugeQty?.n === 1, JSON.stringify([keys.blankQty, keys.badQty, keys.nonPositive, keys.hugeQty].map((x) => x && x.list)));
check('…a pallet ID with a space, and one that is a bin code', keys.oddIds?.list[0] === 'P 6' && keys.idsLikeBins?.list[0] === 'F01A002', JSON.stringify([keys.oddIds, keys.idsLikeBins]));
check('…a System column half filled, a pallet with no bin, one with no item', keys.noSystem?.n === 1 && keys.noSystem.list[0] === 'P5' && keys.blankBin?.list[0] === 'P10' && keys.noItem?.n === 1, JSON.stringify([keys.noSystem, keys.blankBin, keys.noItem]));
check('…an empty position counted as information, not a fault', keys.openRows?.n === 1 && keys.openRows.level === 'info');
check('…the tally: warnings and information, nothing that stops the load', c.fails === 0 && c.warns >= 8 && c.infos >= 2, `${c.fails} / ${c.warns} / ${c.infos}`);
c = await checkFile(S, 'pallets', REPORT, '&source=NTFF');
check('With a system picked for the upload, the half-filled column says what they take', /take the system picked for the upload: NTFF/.test(f(c, 'noSystem').detail), f(c, 'noSystem').detail);
c = await checkFile(S, 'pallets', 'Item No.,Quantity\nS1,10\n');
check('No pallet column and no bin column: two faults, the load refused', c.fails === 2 && f(c, 'noPalletColumn') && f(c, 'noBinColumn'));
c = await checkFile(S, 'pallets', 'Bin Code,Container No.,Item No.,Quantity\nF01A001,P1,S1,10\n');
check('A clean file: nothing to look at', c.fails === 0 && c.warns === 0, JSON.stringify(c.findings));
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Bin Code,Container No.,Item No.,Quantity\nF01A001,P1,S1,10\n' });
c = await checkFile(S, 'pallets', 'Bin Code,Container No.,Item No.,Quantity\nF01A001,P1,S1,12\nF01A002,P2,S2,5\n');
check('A second file: how many pallets already on the count it updates', f(c, 'updates')?.n === 1 && /1 pallets are loaded; this file adds to them/.test(f(c, 'updates').detail), JSON.stringify(f(c, 'updates')));
check('The upload itself still works as before', (await j(await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: REPORT }))).duplicates === 1);

/* ---------------- the Settings page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#lists`);
await signIn(page);
await page.waitForSelector('#fFile-bins', { timeout: 10000 });
await pickSession(page, S);
await page.setInputFiles('#fFile-bins', { name: 'bins.csv', mimeType: 'text/csv', buffer: Buffer.from('Bin Location,Zone,Aisle\nF01A004,Freezer,F01\nF01A004,Freezer,F01\nF01A005,Freezer,F01\n') });
await page.click('#btnUpload-bins');
await page.waitForSelector('#uploadFindings-bins li[data-finding]', { timeout: 10000 });
check('Settings: the file is checked first and the findings listed, with Load it anyway and Cancel',
  /1 thing to look at before it is loaded/.test(clean(await page.textContent('#uploadMsg-bins'))) && /F01A004 ×2/.test(clean(await page.textContent('#uploadFindings-bins'))) && await page.isVisible('#uploadMsg-bins button[data-load-anyway]') && await page.isVisible('#uploadMsg-bins button[data-cancel-upload]'),
  clean(await page.textContent('#uploadMsg-bins')).slice(0, 200));
const before = (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').bins;
check('…nothing is loaded yet', before === 3, String(before));
await page.click('#uploadMsg-bins button[data-load-anyway]');
await page.waitForFunction(() => /Imported/.test(document.getElementById('uploadMsg-bins').textContent), null, { timeout: 10000 });
check('Load it anyway: the file goes in', (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').bins === 5 && /Imported 3 rows/.test(clean(await page.textContent('#uploadMsg-bins'))), clean(await page.textContent('#uploadMsg-bins')).slice(0, 120));
await page.setInputFiles('#fFile-bins', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('Zone\nFreezer\n') });
await page.click('#btnUpload-bins');
await page.waitForSelector('#uploadFindings-bins li.fail', { timeout: 10000 });
check('A file with no bin column is refused: no Load button, only Cancel', /cannot be loaded as it is/.test(clean(await page.textContent('#uploadMsg-bins'))) && !(await page.$('#uploadMsg-bins button[data-load-anyway]')) && await page.isVisible('#uploadMsg-bins button[data-cancel-upload]'));
await page.click('#uploadMsg-bins button[data-cancel-upload]'); await page.waitForTimeout(200);
check('…Cancel clears it', clean(await page.textContent('#uploadMsg-bins')) === '');
await page.setInputFiles('#fFile-bins', { name: 'clean.csv', mimeType: 'text/csv', buffer: Buffer.from('Bin Location,Zone,Aisle\nF01A006,Freezer,F01\n') });
await page.click('#btnUpload-bins');
await page.waitForFunction(() => /Imported/.test(document.getElementById('uploadMsg-bins').textContent), null, { timeout: 10000 });
check('A clean file loads straight through', (await get(`/api/admin/sessions/${S}/aisles`)).find((a) => a.aisle === 'F01').bins === 6);
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
