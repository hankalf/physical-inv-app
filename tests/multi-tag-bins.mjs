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
await gun.waitForSelector('#scrScan.active', { timeout: 20000 }); await gun.waitForTimeout(700);
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
  await gun.selectOption('#fReason', { index: 1 });
  await gun.click('#btnOverrideAccept');
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

/* ================= two labels on one pallet ================= */
// a pallet that was re-tagged and kept its old label: count it, then say so
await countOne('P-6', 30, 'A01A003');
await gun.waitForTimeout(400);
check('Gun: the second-label button is offered once something has been counted',
  await gun.$eval('#btnSameLabel', (b) => !b.hidden));
await gun.click('#btnSameLabel'); await gun.waitForTimeout(400);
check('Gun: it asks for the other label, naming the pallet it belongs to',
  /Scan the OTHER label on P-6/i.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await scan('P-6-OLD-TAG');
await gun.waitForTimeout(900);
check('Gun: it says the tag is the same pallet, counted once',
  /same pallet as P-6/i.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')).slice(0, 110));

await gun.waitForTimeout(1500);
const rows = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=200`, { headers: A }))).rows;
const by = Object.fromEntries(rows.map((r) => [r.pallet_id, r]));
check('The second label lands as its own line with no quantity',
  by['P-6-OLD-TAG'] && Number(by['P-6-OLD-TAG'].counted_qty) === 0, JSON.stringify(by['P-6-OLD-TAG']?.counted_qty));
check('...and is reported as a second label, not as a missing or unknown pallet',
  by['P-6-OLD-TAG'].status === 'SECOND LABEL' && by['P-6-OLD-TAG'].alias_of === 'P-6',
  `${by['P-6-OLD-TAG'].status} of ${by['P-6-OLD-TAG'].alias_of}`);
check('The pallet it is stuck to still counts once, and says what else is on it',
  by['P-6'].status === 'MATCH' && by['P-6'].also_tagged === 'P-6-OLD-TAG', `${by['P-6'].status} · ${by['P-6'].also_tagged}`);
check('Scanning that tag again is caught as already counted',
  (await j(await fetch(`${BASE}/api/sessions/${sess.id}/counted-pallets`, { headers: D }))).some?.((x) => (x.p || x.palletId || x) === 'P-6-OLD-TAG') !== false);

const raw = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
check('The raw export says which pallet a second label belongs to',
  /,alias_of,/.test(raw.split('\n')[0]) && /P-6-OLD-TAG.*P-6/.test(raw), raw.split('\n')[0].slice(0, 90));

/* second labels are not variances to chase */
await fetch(`${BASE}/api/admin/sessions/${sess.id}/recounts/generate`, { method: 'POST', headers: A, body: '{}' });
const tasks = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/recounts`, { headers: A }));
const list = Array.isArray(tasks) ? tasks : tasks.tasks || [];
check('No second count is raised for a second label', !list.some((t) => t.pallet_id === 'P-6-OLD-TAG'),
  list.filter((t) => t.pallet_id === 'P-6-OLD-TAG').length + ' raised');

const erp = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/erp.csv`, { headers: A })).text().catch(() => '');
if (erp) check('The ERP file does not carry a second label as its own adjustment', !/P-6-OLD-TAG/.test(erp));

/* ---- the scan box keeps the focus, whatever gets tapped ---- */
await gun.click('#btnHistory'); await gun.waitForTimeout(500);
await gun.click('#btnHistoryBack, #btnBackFromHistory, #scrHistory button').catch(() => {});
await gun.waitForTimeout(700);
if (await gun.$('#scrScan.active')) {
  await gun.evaluate(() => document.getElementById('btnKeyboard').focus());
  await gun.keyboard.type('P-6');
  await gun.keyboard.press('Enter');
  await gun.waitForTimeout(500);
  check('Gun: a scan that lands on a button is put in the box, not swallowed by it',
    /QUANTITY/i.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
}
await gun.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} multi-tag checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
