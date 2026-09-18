/* Lot codes and expiry dates: off by default, and what they buy when they are on. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { expandSubTabs, pickSession } from './helpers.mjs';

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

const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
const REPORT = `Pallet ID,SKU,Description,Qty,Location,Lot Code,Best Before
PLT-A,SKU-1,Peas 12x2lb,40,F01A001,LOT-4471,2027-03-15
PLT-B,SKU-2,Chicken 40lb,25,F01A002,LOT-9000,${past}
PLT-C,SKU-3,Salmon 10lb,60,F01A003,LOT-4471,${soon}
PLT-D,SKU-4,Corn 20lb,12,F01A004,,2028-01-01
PLT-E,SKU-5,Beans 5lb,18,F01A005,LOT-4471,2027-06-01
PLT-F,SKU-6,Cod 8lb,30,F01A006,LOT-9000,${past}
`;
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'lot count' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
const imp = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: REPORT }));
check('The report\'s lot and expiry columns are read, by any of their usual names',
  imp.withLots === 5 && imp.withExpiry === 6, `${imp.withLots} lots, ${imp.withExpiry} dates`);

/* ---------------- off by default ---------------- */
const fresh = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}`, { headers: A }));
check('A count does not ask for them unless it is told to', !fresh.ask_lot && !fresh.ask_expiry);
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'LOT-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
const pub = (await j(await fetch(`${BASE}/api/sessions`, { headers: D }))).find((x) => x.id === sess.id);
check('...and the gun is told so', pub.askLot === false && pub.askExpiry === false);

await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false, askLot: true, askExpiry: true }) });
const on = (await j(await fetch(`${BASE}/api/sessions`, { headers: D }))).find((x) => x.id === sess.id);
check('Turned on, the gun is told that too', on.askLot === true && on.askExpiry === true);
check('The expected lot rides along with the pallet list, so the gun can check it offline',
  (await j(await fetch(`${BASE}/api/sessions/${sess.id}/master`, { headers: D }))).pallets.find((p) => p[0] === 'PLT-A')[4] === 'LOT-4471');

/* ---------------- counting with them ---------------- */
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 'l1', palletId: 'PLT-A', qty: 40, location: 'F01A001', team: '1', deviceId: 'LOT-01', lot: 'LOT-4471', expiry: '2027-03-15' },
  { clientId: 'l2', palletId: 'PLT-B', qty: 25, location: 'F01A002', team: '1', deviceId: 'LOT-01', lot: 'LOT-9000', expiry: past },
  { clientId: 'l3', palletId: 'PLT-C', qty: 60, location: 'F01A003', team: '1', deviceId: 'LOT-01', lot: 'LOT-DIFFERENT', expiry: soon },
  { clientId: 'l4', palletId: 'PLT-D', qty: 12, location: 'F01A004', team: '1', deviceId: 'LOT-01' },
]) });
const rep = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=50`, { headers: A }));
const by = Object.fromEntries(rep.rows.map((r) => [r.pallet_id, r]));
check('A lot that matches the report is recorded as a match', by['PLT-A'].lot_status === 'LOT MATCH', by['PLT-A'].lot_status);
check('A lot that does not is flagged WRONG LOT', by['PLT-C'].lot_status === 'WRONG LOT' && by['PLT-C'].found_lot === 'LOT-DIFFERENT',
  `${by['PLT-C'].found_lot} vs ${by['PLT-C'].expected_lot}`);
check('A pallet counted with no lot, where the report has one, says so', by['PLT-D'].lot_status === '' || by['PLT-D'].lot_status === 'LOT NOT ON REPORT', by['PLT-D'].lot_status);
check('An out-of-date pallet is flagged EXPIRED', by['PLT-B'].expiry_status === 'EXPIRED', `${by['PLT-B'].expiry} → ${by['PLT-B'].expiry_status}`);
check('One expiring within the month is flagged EXPIRES SOON', by['PLT-C'].expiry_status === 'EXPIRES SOON', `${by['PLT-C'].expiry} → ${by['PLT-C'].expiry_status}`);
check('One in date is left alone', by['PLT-A'].expiry_status === 'IN DATE', by['PLT-A'].expiry_status);
check('The quantity status is untouched by any of it — they are different questions',
  by['PLT-C'].status === 'MATCH' && by['PLT-B'].status === 'MATCH', `${by['PLT-C'].status}, ${by['PLT-B'].status}`);

const raw = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
check('The raw export carries lot and expiry', /,lot,expiry,/.test(raw.split('\n')[0]) && /LOT-4471/.test(raw), raw.split('\n')[0].slice(0, 80));

/* ---------------- the recall question ---------------- */
const found = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/lot?q=lot-4471`, { headers: A }));
check('Where is every case of this lot — answered from what was counted',
  found.counted.length === 1 && found.counted[0].pallet_id === 'PLT-A' && found.counted[0].location_code === 'F01A001',
  `${found.counted.length} counted, ${found.expected.length} on the report`);
check('...and from what the report expected, so a pallet nobody found still shows up',
  found.expected.length === 3 && found.expected.some((x) => x.pallet_id === 'PLT-C'), found.expected.map((x) => x.pallet_id).join(','));
check('A partial code is enough', (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/lot?q=4471`, { headers: A }))).counted.length === 1);
check('Searching for a lot is recorded in the log',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'searched for a lot'));
check('An empty search is not an error', (await fetch(`${BASE}/api/admin/sessions/${sess.id}/lot?q=`, { headers: A })).ok);

/* ================= on the gun ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '2'); await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(2500);
if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
await gun.waitForSelector('#scrScan.active', { timeout: 90000 }); await gun.waitForTimeout(600);
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };

await scan('PLT-E'); await scan('18');
check('Gun: it asks for the lot code', /LOT CODE/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await scan('LOT-9999');
check('Gun: a lot that disagrees with the report is called out on the spot',
  /report says this pallet is lot LOT-4471/i.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')).slice(0, 110));
check('Gun: then the expiry', /EXPIRY/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await gun.fill('#fScan', 'not a date'); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(400);
check('Gun: something that is not a date is refused, not stored', /not a date/i.test(await gun.textContent('#scanMsg')) && /EXPIRY/.test(await gun.textContent('#prompt')));
await scan('15/03/2027');
check('Gun: a date typed the other way round is understood', /2027-03-15/.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')).slice(0, 60));
await scan('F01A005');
await gun.waitForTimeout(2000);
const back = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=50`, { headers: A }));
const a2 = back.rows.find((r) => r.pallet_id === 'PLT-E');
check('Gun: the lot and the date it captured reach the report', /LOT-9999/.test(a2.found_lot), a2.found_lot);
await gun.screenshot({ path: `${S}screenshots/gun-lot.png` });

// and an expired one warns the counter where they stand
await scan('PLT-F'); await scan('30'); await scan('LOT-9000'); await scan(past);
check('Gun: an out-of-date pallet warns the counter at the pallet, not a week later in a report',
  /has passed/i.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')).slice(0, 90));
await scan('F01A006'); await gun.waitForTimeout(1200);
await gun.close();

/* ---- and with them off, the gun asks three questions as before ---- */
const plain = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'no lots here' }) }));
await fetch(`${BASE}/api/admin/sessions/${plain.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\n' });
await fetch(`${BASE}/api/admin/sessions/${plain.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
const g2 = await browser.newPage({ viewport: { width: 480, height: 800 } });
g2.on('dialog', (d) => d.accept());
await g2.goto(`${BASE}/?d=${dev.uid}`);
await g2.waitForSelector('#scrSignon.active'); await g2.waitForTimeout(900);
await g2.selectOption('#fSession', String(plain.id));
await g2.fill('#fTeam', '3'); await g2.fill('#fEmployee', 'E1001'); await g2.press('#fEmployee', 'Enter');
await g2.click('#btnStart'); await g2.waitForTimeout(2500);
if (await g2.$('#scrAssign.active')) await g2.click('#btnCount');
await g2.waitForSelector('#scrScan.active', { timeout: 90000 }); await g2.waitForTimeout(500);
check('Gun: a count that does not track lots still asks three questions',
  /1 of 3/.test(await g2.textContent('#stepLabel')), clean(await g2.textContent('#stepLabel')));
await g2.close();

/* ================= on the dashboard ================= */
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/admin');
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(2200);
await pickSession(page, sess.id);
await page.waitForTimeout(2000);
check('Dashboard: the two questions are opt-in toggles on the count',
  await page.$eval('#fAskLot', (b) => b.checked) && await page.$eval('#fAskExpiry', (b) => b.checked));
check('Dashboard: a wrong lot and an out-of-date pallet count as exceptions, even when the quantity is right',
  await page.$eval('#fOnlyExceptions', (b) => b.checked));
check('Dashboard: the pallet report shows a wrong lot and an expired date',
  /wrong lot/.test(await page.textContent('#palletTable')) && /expired/.test(await page.textContent('#palletTable')),
  clean(await page.textContent('#palletTable')).slice(0, 100));
await page.fill('#fLotSearch', 'LOT-4471'); await page.click('#btnFindLot'); await page.waitForTimeout(1200);
check('Dashboard: the lot lookup answers where it is',
  /counted/.test(await page.textContent('#lotMsg')) && (await page.$$('#lotTable tbody tr')).length >= 2,
  clean(await page.textContent('#lotMsg')).slice(0, 80));
await page.screenshot({ path: `${S}screenshots/lot-lookup.png` });
await page.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} lot-expiry checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
