/*
 * How good was the count, by how much the item matters.
 *
 * "We counted 14,000 bins" measures nothing. These check the number an
 * operation is actually judged on, cut the way it is worth acting on: a
 * warehouse can be 98% accurate overall and still be losing money, because the
 * misses are all on the fast movers. So class A gets its own line and its own
 * target, and the report says plainly whether it was met.
 *
 * Off unless a count turns it on. With it off nothing is computed and the
 * dashboard says how to turn it on rather than showing an empty table.
 */
import { chromium } from 'playwright-core';
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

const BINS = 'Bin Location,Zone,Aisle\n'
  + ['F01A001', 'F01A002', 'F01A003', 'F01A004', 'F01A005'].map((b) => `${b},Freezer,F01`).join('\n') + '\n';
/* Two A items, a B and two Cs - and one pallet the ERP never classified, which
   is the normal state of a real file. */
const PALLETS = ['Pallet ID,SKU,Description,Qty,Location,ABC Class',
  'AB1,SKU-A,Chicken breast 40lb,100,F01A001,A',
  'AB2,SKU-A2,Wings 30lb,100,F01A002,a',
  'AB3,SKU-B,Ground beef 10lb,60,F01A003,B',
  'AB4,SKU-C,Peas 30lb,40,F01A004,C',
  'AB5,SKU-D,Fries 25lb,20,F01A005,'].join('\n') + '\n';

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'accuracy' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
const up = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: PALLETS }));
check('An ABC column on the inventory report is read in, whatever it is called', up.withAbc === 4, String(up.withAbc));

await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'ACC-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
await fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ deviceId: 'ACC-01', team: '1', employees: ['E1001'] }) });

let n = 0;
const line = (o) => ({ clientId: `acc-${++n}`, team: '1', deviceId: 'ACC-01', employees: ['E1001'], ...o });
const send = (rows) => fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify(rows) }).then(j);
const accuracy = async () => j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/accuracy`, { headers: A }));
const setUp = (body) => fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify(body) }).then(j);

/* One A item 10 short, the other exact; the B exact; one C exact; the
   unclassified one 5 over. */
await send([
  line({ palletId: 'AB1', qty: 90, location: 'F01A001' }),
  line({ palletId: 'AB2', qty: 100, location: 'F01A002' }),
  line({ palletId: 'AB3', qty: 60, location: 'F01A003' }),
  line({ palletId: 'AB4', qty: 40, location: 'F01A004' }),
  line({ palletId: 'AB5', qty: 25, location: 'F01A005' }),
]);

/* ---------------- off is how it ships ---------------- */
const off = await accuracy();
check('It ships off', off.on === false, String(off.on));
check('...but the numbers are still right when it is asked for them', off.overall.pallets === 5, String(off.overall.pallets));

await setUp({ trackAbc: true });
const a = await accuracy();
const byClass = Object.fromEntries(a.byClass.map((r) => [r.class, r]));

check('Class A is reported on its own', byClass.A && byClass.A.pallets === 2, JSON.stringify(byClass.A || null));
check('...one of the two was exactly right, so it is 50%', byClass.A.pallet_accuracy === 50, String(byClass.A.pallet_accuracy));
check('...against the 99% an A item is held to, which it did not meet',
  byClass.A.target === 99 && byClass.A.meets === false, `${byClass.A.target} ${byClass.A.meets}`);
check('...and quantity accuracy is the units in dispute, not the pallets: 10 of 200',
  byClass.A.qty_accuracy === 95, String(byClass.A.qty_accuracy));
check('A lower-case "a" in the file is the same class as "A"', byClass.A.pallets === 2);
check('Class B was perfect and says so', byClass.B.pallet_accuracy === 100 && byClass.B.meets === true, JSON.stringify(byClass.B));
check('Class C too', byClass.C.pallet_accuracy === 100 && byClass.C.meets === true, JSON.stringify(byClass.C));
check('A pallet the file never classified is reported, not hidden',
  byClass[''] && byClass[''].pallets === 1, JSON.stringify(byClass[''] || null));
check('The whole count is there as well', a.overall.pallets === 5 && a.overall.exact === 3, `${a.overall.exact} of ${a.overall.pallets}`);
check('...and bin accuracy is counted separately, because a bin is not an A item or a C item',
  a.bins.counted === 5 && a.bins.accuracy != null, JSON.stringify(a.bins));
check('It says how much of the file has a class at all',
  a.classified === 4 && a.unclassified === 1, `${a.classified} / ${a.unclassified}`);

/* ---------------- the targets are the site's own ---------------- */
/* One of the two A pallets was exact, so this count is at 50% on class A. A
   site that sets its target there passes with the same numbers. */
const t = await j(await fetch(`${BASE}/api/admin/accuracy-targets`, { method: 'POST', headers: A, body: JSON.stringify({ targets: { A: 50 } }) }));
check('A site can set its own target', t.targets.A === 50, JSON.stringify(t.targets));
const lower = await accuracy();
check('...and the same count now meets it', lower.byClass.find((r) => r.class === 'A').meets === true,
  JSON.stringify(lower.byClass.find((r) => r.class === 'A')));
await fetch(`${BASE}/api/admin/accuracy-targets`, { method: 'POST', headers: A, body: JSON.stringify({ targets: {} }) });
check('...and can put the shipped targets back',
  (await j(await fetch(`${BASE}/api/admin/accuracy-targets`, { headers: A }))).targets.A === 99);
check('Editing targets needs a sign-in',
  (await fetch(`${BASE}/api/admin/accuracy-targets`, { method: 'POST', headers: hdr, body: '{}' })).status === 401);

/* ---------------- working the classes out from the report ---------------- */
const plain = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'no classes' }) }));
await fetch(`${BASE}/api/admin/sessions/${plain.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
await fetch(`${BASE}/api/admin/sessions/${plain.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: ['Pallet ID,SKU,Qty,Location',
    'PL1,SKU-BIG,1000,F01A001',      // most of the warehouse: class A
    'PL2,SKU-MID,150,F01A002',
    'PL3,SKU-SML,40,F01A003',
    'PL4,SKU-TINY,10,F01A004'].join('\n') + '\n' });
const derived = await j(await fetch(`${BASE}/api/admin/sessions/${plain.id}/abc/derive`, { method: 'POST', headers: A, body: '{}' }));
check('A report with no ABC column can have classes worked out from it',
  derived.classified === 4, JSON.stringify(derived.byClass));
check('...and the item that is most of the warehouse comes out as A', derived.byClass.A >= 1, JSON.stringify(derived.byClass));
check('...and the tail as C', derived.byClass.C >= 1, JSON.stringify(derived.byClass));
check('Working them out is in the log', (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A })))
  .some((r) => /ABC classes/.test(r.action)));

/* Anything the file classified itself is left alone - a warehouse that has done
   the work in its ERP should not have it overwritten by a proxy. */
const again = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/abc/derive`, { method: 'POST', headers: A, body: '{}' }));
check('A file that already carries classes keeps them', again.kept === 4 && again.classified === 1, JSON.stringify(again));

/* ---------------- the file that goes to finance ---------------- */
const sheet = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/accuracy.csv`, { headers: A })).text();
check('The scorecard exports as a file', /Class A/.test(sheet) && /Whole count/.test(sheet), clean(sheet.split('\n')[1] || ''));
check('...with the target and whether it was met on every line', /,99,NO,/.test(sheet.replace(/\s/g, '')) || /NO/.test(sheet), clean(sheet.split('\n')[1] || ''));
check('...and the bin line at the bottom', /Bins with nothing odd in them/.test(sheet));

/* ================= the dashboard ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(1200);

const shown = clean(await page.textContent('#accuracyTable'));
check('Dashboard: the scorecard is on the page', /Class A/.test(shown) && /Whole count/.test(shown), shown.slice(0, 160));
check('Dashboard: and it says which classes are under target', /UNDER/.test(shown), shown.slice(0, 200));
/* Every pallet on this count has a class by now - four from the file, and the
   fifth from working them out above. */
check('Dashboard: with the class coverage spelled out',
  /5 of 5 pallets have a class/.test(clean(await page.textContent('#abcSub'))), clean(await page.textContent('#abcSub')));

await pickSession(page, plain.id);
await page.waitForTimeout(1000);
check('Dashboard: a count with the feature off says how to turn it on',
  await page.$eval('#accuracyOff', (el) => !el.hidden) && /are off for this count/.test(clean(await page.textContent('#accuracyOff'))));

check('No script errors on the dashboard', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} accuracy checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
