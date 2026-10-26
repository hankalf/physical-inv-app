/*
 * Bins that hold more than one pallet, and pallets that carry more than one label.
 *
 * Both came off the floor. A bin with four tags in it was treated as finished
 * after the first one, which put the guide - and the team - a couple of bins out
 * of step. And a pallet wearing two labels had no honest way to be counted: one
 * tag or the other was left looking uncounted.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* A01A001 holds four pallets, A01A003 holds two, A01A005 holds one, and the
   report says nothing at all about A01A007. */
const BINS = 'Bin Location,Zone,Aisle\n'
  + ['A01A001', 'A01A003', 'A01A005', 'A01A007', 'A01A009', 'A01A011'].map((b) => `${b},Dry Dock,A01`).join('\n') + '\n';
const REPORT = `Pallet ID,SKU,Description,Qty,Location
P-1,SKU-1,Peas 12x2lb,40,A01A001
P-2,SKU-2,Corn 20lb,25,A01A001
P-3,SKU-3,Cod 8lb,18,A01A001
P-4,SKU-4,Fries 6x5lb,60,A01A001
P-5,SKU-5,Chicken 40lb,12,A01A003
P-6,SKU-6,Salmon 10lb,30,A01A003
P-7,SKU-7,Blueberry 30lb,22,A01A005
P-8,SKU-8,Fries 6x5lb,35,A01A011
P-9,SKU-9,Peas 12x2lb,17,A01A011
`;

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'multi-tag bins' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: REPORT });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: true, askComments: false, autoRecount: false }) });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '1', aisles: 'A01', levels: 'A-F', force: true }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'MULTI-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
// the team's other scanner, so the two have to agree about what is counted
const dev2 = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'MULTI-02' }) }));
const dtok2 = (await j(await fetch(`${BASE}/api/devices/${dev2.uid}`, { method: 'POST' }))).token;
const D2 = { ...hdr, authorization: 'Device ' + dtok2 };

/* ---------------- what a second scanner on the team is told ---------------- */
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D2, body: JSON.stringify([
  { clientId: 'm1', palletId: 'P-1', qty: 40, location: 'A01A001', aisle: 'A01', team: '1', deviceId: 'MULTI-02' },
  { clientId: 'm2', palletId: 'P-2', qty: 25, location: 'A01A001', aisle: 'A01', team: '1', deviceId: 'MULTI-02' },
]) });
const status = await j(await fetch(`${BASE}/api/sessions/${sess.id}/team-status?team=1`, { headers: D }));
check('...and which of those tags were counted by somebody else',
  status.progress?.binTagsOthers?.A01A001 === 2, JSON.stringify(status.progress?.binTagsOthers || {}));
check('A team is told how many tags are in each bin, not just which bins have a count',
  status.progress?.binTags?.A01A001 === 2, JSON.stringify(status.progress?.binTags || {}));
check('...so the other gun on the team can see a bin is part done', (status.progress?.countedBins || []).includes('A01A001'));

/* ================= on the gun ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);
await gun.selectOption('#fSession', String(sess.id));
// the same team that holds A01: another team would be blocked out of that racking
await gun.fill('#fTeam', '1');
await gun.fill('#fEmployee', 'E2001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(2500);
if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
await gun.waitForSelector('#scrScan.active', { timeout: 90000 }); await gun.waitForTimeout(700);
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(420); };
const banner = async () => clean(await gun.textContent('#nextBin'));
const countOne = async (pallet, qty, bin) => { await scan(pallet); await scan(String(qty)); await scan(bin); await gun.waitForTimeout(500); };

check('Gun: it starts by pointing at the first bin in the aisle, which two tags into four is not finished',
  /Next bin\s*A01A001/i.test(await banner()), (await banner()).slice(0, 60));

await countOne('P-3', 18, 'A01A001');
check('Gun: a tag counted does not finish a bin the report says holds four',
  /Still in this bin\s*A01A001/i.test(await banner()), (await banner()).slice(0, 70));
check('Gun: and it says how many tags are in it, and how many to find',
  /3 of 4 tags/.test(await banner()), (await banner()).slice(0, 90));

await countOne('P-4', 60, 'A01A001');
check('Gun: with all four accounted for it moves on to the next bin',
  /Next bin\s*A01A003/i.test(await banner()), (await banner()).slice(0, 60));

/* ---- a bin where the report is wrong: two expected, one on the floor ---- */
await countOne('P-5', 12, 'A01A003');
check('Gun: still in the bin while the report expects another', /Still in this bin\s*A01A003/i.test(await banner()), (await banner()).slice(0, 70));
check('Gun: "nothing more here" is offered rather than nagging forever', await gun.$('#btnBinDone') !== null);
await gun.click('#btnBinDone'); await gun.waitForTimeout(500);
check('Gun: saying the bin is done moves the guide on', /Next bin\s*A01A005/i.test(await banner()), (await banner()).slice(0, 60));

/* ---- a bin the report does not list stays open until somebody says so ---- */
await countOne('P-7', 22, 'A01A005');
check('Gun: a bin with one pallet on the report is finished by counting it', /Next bin\s*A01A007/i.test(await banner()), (await banner()).slice(0, 60));
await scan('NEW-ARRIVAL-1');
await gun.waitForTimeout(600);
if (await gun.$('#scrOverride.active')) {
  await gun.click('#btnOvYes');
  await gun.waitForTimeout(400);
  await scan('9'); await scan('A01A007');
  await gun.waitForTimeout(600);
}
check('Gun: a bin the report knows nothing about stays open — there may be more in it',
  /Still in this bin\s*A01A007/i.test(await banner()), (await banner()).slice(0, 70));
await gun.screenshot({ path: `${S}screenshots/gun-bin-staying.png` });
await gun.click('#btnBinDone'); await gun.waitForTimeout(500);

/* ---- an empty bin is finished by saying it is empty ---- */
await gun.click('#btnEmpty'); await gun.waitForTimeout(300);
await scan('A01A009'); await gun.waitForTimeout(700);
check('Gun: a bin recorded EMPTY is finished, not left open', /Next bin\s*A01A011/i.test(await banner()), (await banner()).slice(0, 60));

/* ================= another label on a pallet, seen after it was counted ================= */
// two loads on one pallet in A01A003: P-6 is counted, and only then does the counter see the other label
await countOne('P-6', 30, 'A01A003');
await gun.waitForTimeout(400);
check('Gun: once a pallet is counted, Another label on the pallet just counted names it',
  await gun.$eval('#btnSameLabel', (b) => !b.hidden) && /P-6/.test(await gun.textContent('#btnSameLabel')), clean(await gun.textContent('#btnSameLabel')));
await gun.click('#btnSameLabel'); await gun.waitForTimeout(500);
check('Gun: it asks for the next label on that pallet, in its bin, with no bin scan',
  /Scan LABEL 2 on this pallet/i.test(await gun.textContent('#prompt')) && /A01A003/.test(await gun.textContent('#ctx')), clean(await gun.textContent('#prompt')));
await scan('P-6B');
await gun.waitForTimeout(400);
// not on the report: the same yes / no as any pallet the report does not know
if (await gun.isVisible('#btnOvYes')) { await gun.click('#btnOvYes'); await gun.waitForTimeout(400); }
check('Gun: then that label\'s own quantity', /Enter QUANTITY on label 2/i.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await scan('8');
if (await gun.isVisible('#btnSkip')) { await gun.click('#btnSkip'); await gun.waitForTimeout(400); }
await gun.click('#btnMultiDone'); await gun.waitForTimeout(400);
check('Gun: Done says the pallet and its labels', /Pallet with 2 labels counted in A01A003/.test(await gun.textContent('#scanMsg')) && /P-6 · P-6B/.test(await gun.textContent('#scanMsg')), clean(await gun.textContent('#scanMsg')));

/* the line has to reach the server first: the gun sends it on its next sync,
   which on a busy machine can be a few seconds away */
let by = {};
for (let i = 0; i < 30 && !by['P-6B']; i++) {
  await gun.waitForTimeout(500);
  const rows = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=200`, { headers: A }))).rows;
  by = Object.fromEntries(rows.map((r) => [r.pallet_id, r]));
}
check('The other label lands with its own quantity, in the same bin',
  by['P-6B'] && Number(by['P-6B'].counted_qty) === 8 && by['P-6B'].found_location === 'A01A003', JSON.stringify(by['P-6B'] && [by['P-6B'].counted_qty, by['P-6B'].found_location]));
check('…not on the report, so it is stock to add, and says which pallet it shares',
  by['P-6B'].status === 'NOT IN MASTER' && !by['P-6B'].alias_of && /another label on the same pallet as P-6/.test(by['P-6B'].comments || ''), `${by['P-6B'].status} · ${by['P-6B'].comments}`);
check('The pallet counted first is still its own count, untouched',
  by['P-6'].status === 'MATCH' && Number(by['P-6'].counted_qty) === 30 && !by['P-6'].also_tagged, `${by['P-6'].status} · ${by['P-6'].counted_qty}`);

/* scanned as a new pallet instead: the not-on-the-list screen offers the same thing */
await scan('P-6C');
await gun.waitForTimeout(500);
check('A label not on the report, scanned as a pallet, is offered as another label on the pallet just counted',
  await gun.isVisible('#btnOverrideSame') && /another label on the pallet with P-6B/i.test(await gun.textContent('#btnOverrideSame')), clean(await gun.textContent('#btnOverrideSame').catch(() => '')));
await gun.click('#btnOverrideSame'); await gun.waitForTimeout(500);
check('…which goes straight to its quantity, in that bin', /Enter QUANTITY on label/i.test(await gun.textContent('#prompt')) && /A01A003/.test(await gun.textContent('#ctx')), clean(await gun.textContent('#prompt')));
await scan('5');
if (await gun.isVisible('#btnSkip')) { await gun.click('#btnSkip'); await gun.waitForTimeout(400); }
await gun.click('#btnMultiDone'); await gun.waitForTimeout(400);
for (let i = 0; i < 30 && !by['P-6C']; i++) {
  await gun.waitForTimeout(500);
  const rows = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=200`, { headers: A }))).rows;
  by = Object.fromEntries(rows.map((r) => [r.pallet_id, r]));
}
check('…and lands with its quantity in A01A003, flagged as not on the report', by['P-6C'] && Number(by['P-6C'].counted_qty) === 5 && by['P-6C'].found_location === 'A01A003' && by['P-6C'].status === 'NOT IN MASTER',
  JSON.stringify(by['P-6C'] && [by['P-6C'].counted_qty, by['P-6C'].found_location, by['P-6C'].status]));

const raw = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
check('The raw export carries the note on the line', raw.split('\n').some((l) => /P-6B/.test(l) && /another label on the same pallet as P-6/.test(l)));

/* ---- nothing about a scan should invite the browser's own UI in ---- */
{
  // Chrome slides its address bar in when a page scrolls an input into view, so
  // a scan must not move the document or re-focus a box that is already focused
  await gun.evaluate(() => { window.__refocus = 0; const f = document.getElementById('fScan'); f.addEventListener('focus', () => { window.__refocus++; }); });
  const before = await gun.evaluate(() => ({ x: window.scrollX, y: window.scrollY, h: document.documentElement.scrollHeight, v: window.innerHeight }));
  await countOne('P-8', 35, 'A01A011');
  const after = await gun.evaluate(() => ({ x: window.scrollX, y: window.scrollY, refocus: window.__refocus }));
  check('Gun: counting a pallet never scrolls the page', after.x === before.x && after.y === before.y,
    `${before.x},${before.y} -> ${after.x},${after.y}`);
  check('Gun: the page is never taller than the screen, so there is nothing to scroll',
    before.h <= before.v + 1, `${before.h}px of content in ${before.v}px`);
  check('Gun: and the scan box that already has the focus is not focused again',
    after.refocus === 0, `${after.refocus} refocus(es)`);
}

/* ---- the setup card taped to the cradle is not a pallet ---- */
await scan('https://count.example.com/?d=abc123');
check('Gun: scanning the app\'s own setup card says so rather than counting a web address',
  /link, not a pallet/i.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')).slice(0, 90));

/* ---- a wedge that ends a scan with TAB must not tab out of the page ---- */
{
  await gun.fill('#fScan', 'P-9');
  await gun.press('#fScan', 'Tab');          // the other suffix a wedge is set to send
  await gun.waitForTimeout(700);
  check('Gun: a scanner that ends a scan with TAB is taken the same as one that sends ENTER',
    /QUANTITY/i.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
  check('Gun: and the focus stays in the scan box, so the rest of a scan cannot go to the browser',
    await gun.evaluate(() => document.activeElement && document.activeElement.id === 'fScan'),
    await gun.evaluate(() => (document.activeElement || {}).id || 'nothing'));
  await gun.fill('#fScan', '17'); await gun.press('#fScan', 'Tab'); await gun.waitForTimeout(400);
  await gun.fill('#fScan', 'A01A011'); await gun.press('#fScan', 'Tab'); await gun.waitForTimeout(700);
  check('Gun: a whole line can be counted by a TAB-suffix scanner',
    /PALLET/i.test(await gun.textContent('#prompt')) && /Counted P-9/i.test(clean(await gun.textContent('#scanMsg'))),
    clean(await gun.textContent('#scanMsg')).slice(0, 70));
}

/* ---- and it says so when the keyboard is pointed somewhere else ---- */
check('Gun: the "tap here to scan" warning is out of the way while the app has the keyboard',
  await gun.$eval('#armBar', (b) => b.hidden));

/* ---- the scan box keeps the focus, whatever gets tapped ---- */
await gun.click('#btnHistory'); await gun.waitForTimeout(500);
await gun.click('#btnHistoryBack').catch(() => {});   // Back - not the first button on the screen, which is a Void
await gun.waitForTimeout(700);
if (await gun.$('#scrScan.active')) {
  await gun.evaluate(() => document.getElementById('btnKeyboard').focus());
  await gun.keyboard.type('P-7');
  await gun.keyboard.press('Enter');
  await gun.waitForTimeout(500);
  // the scan was taken: the box is empty again and the gun moved on - to the quantity, or to a question about that pallet
  check('Gun: a scan that lands on a button is put in the box, not swallowed by it',
    (await gun.inputValue('#fScan')) === '' && (/QUANTITY/i.test(await gun.textContent('#prompt')) || await gun.isVisible('#scrOverride.active')), `${clean(await gun.textContent('#prompt'))} · ${await gun.isVisible('#scrOverride.active')}`);
}
await gun.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} multi-tag checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
